// A stand-in for Rex's control API, just enough for Pair (src/rex.mjs): an HTTP server on a unix socket whose
// `GET /api/control` upgrades to a WebSocket speaking `rex.control.v1` (welcome, request/response, pushed events) over
// an in-memory session of terminal blocks. `listenWebSocket` is the WebSocket server half on its own, written by hand
// like the client under test, so one does not vouch for the other's mistakes.
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const SESSION = 'session:s1';
export const WINDOW = 'window:w1';
const LIMIT = 1048576; // max_message_bytes, as the welcome says
const STATUS = {not_found: 404, session_not_found: 404, method_not_found: 404, conflict: 409, bad_request: 400, refused: 403, too_large: 413, internal: 500, timeout: 504};
const SHELL_FLAVOR = 'com.superlogical.terminal.shell';

/**
 * What Rex's blob_read gives of `text` (a Buffer of UTF-8) from byte `offset`, as measured on a live Rex: the offset
 * may fall inside a character, and each continuation byte met there comes back as one U+FFFD; `budget` counts bytes of
 * the JSON-encoded reply (a newline, a quote or a backslash costs 2, a control character 6, the rest what it weighs in
 * UTF-8; a stray byte weighs 1, as measured), not of the source; a reply never ends inside a character (it rounds
 * down) but always holds one: a first character wider than the budget is returned whole, a genuine U+FFFD (3 bytes)
 * as much as a euro sign.
 * Returns the decoded `data` and the `length` of source bytes it covers.
 */
function chunk(text, offset, budget) {
  let end = offset;
  let data = '';
  let spent = 0;
  const cost = s => Buffer.byteLength(JSON.stringify(s)) - 2;
  while (end < text.length && (text[end] & 0xc0) === 0x80 && (spent < budget || end === offset)) { data += '\ufffd'; spent++; end++; } // as measured, a stray weighs one
  while (end < text.length && (text[end] & 0xc0) !== 0x80) {
    const width = text[end] >= 0xf0 ? 4 : text[end] >= 0xe0 ? 3 : text[end] >= 0xc0 ? 2 : 1;
    const character = text.subarray(end, end + width).toString();
    if (end > offset && spent + cost(character) > budget) break;
    data += character;
    spent += cost(character);
    end += width;
  }
  return {data, length: end - offset};
}

/** An unmasked server frame. */
function frame(opcode, payload) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 0xff]) : Buffer.alloc(10);
  if (n >= 65536) { head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, payload]);
}

/**
 * A WebSocket server on the unix socket `socketPath`. `onConnection(ws, request)` gets each upgraded connection:
 * `ws.sendText/sendBinary/ping(data)/close(code)`, and the handlers `ws.onText/onBinary/onPong/onClose(code)` to set.
 * `fragment` (a number) splits the text messages it sends into frames of that many bytes. Resolves with `{sockets, close()}`.
 */
export async function listenWebSocket(socketPath, onConnection, {subprotocol = null, fragment = 0} = {}) {
  const sockets = new Set();
  const server = createServer((request, response) => { response.statusCode = 404; response.end(); });
  server.on('upgrade', (request, socket) => {
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + GUID).digest('base64');
    const wanted = request.headers['sec-websocket-protocol'];
    if (subprotocol && wanted !== subprotocol) return socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${wanted ? `Sec-WebSocket-Protocol: ${wanted}\r\n` : ''}\r\n`);
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let parts = [];
    let kind = 0;
    const ws = {
      socket, onText() {}, onBinary() {}, onPong() {}, onClose() {},
      sendText(text) {
        const data = Buffer.from(text);
        if (!fragment || data.length <= fragment) return socket.write(frame(1, data));
        for (let at = 0; at < data.length; at += fragment) {
          const piece = frame(at ? 0 : 1, data.subarray(at, at + fragment));
          if (at + fragment < data.length) piece[0] &= 0x7f; // not the last
          socket.write(piece);
        }
      },
      sendBinary: data => socket.write(frame(2, Buffer.from(data))),
      ping: data => socket.write(frame(9, Buffer.from(data))),
      close(code = 1000) { socket.write(frame(8, Buffer.from([code >> 8, code & 0xff]))); socket.end(); },
    };
    socket.on('close', () => { sockets.delete(socket); ws.onClose(ws.closeCode ?? 1006); });
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        let length = buffer[1] & 0x7f;
        let at = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); at = 4; }
        else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); at = 10; }
        if (buffer.length < at + 4 + length) return;
        const mask = buffer.subarray(at, at + 4);
        const payload = Buffer.from(buffer.subarray(at + 4, at + 4 + length));
        for (let i = 0; i < length; i++) payload[i] ^= mask[i & 3];
        const fin = (buffer[0] & 0x80) !== 0;
        const opcode = buffer[0] & 0xf;
        buffer = buffer.subarray(at + 4 + length);
        if (opcode === 8) { ws.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005; socket.end(frame(8, payload.subarray(0, 2))); continue; }
        if (opcode === 9) { socket.write(frame(10, payload)); continue; }
        if (opcode === 10) { ws.onPong(payload); continue; }
        if (opcode) { kind = opcode; parts = []; }
        parts.push(payload);
        if (!fin) continue;
        const message = Buffer.concat(parts);
        if (kind === 1) ws.onText(message.toString('utf8')); else ws.onBinary(message);
      }
    });
    onConnection(ws, request);
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  return {
    sockets,
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise(resolve => server.close(resolve));
    },
  };
}

const shell = pid => ({pid, user_id: 502, user: 'u', name: 'zsh', path: '/bin/zsh', argv0: '-zsh', cwd: '/'});
const login = {pid: 1, user_id: 0, user: 'root', name: 'login', path: '/usr/bin/login'};

/**
 * Session `session:s1` in window `window:w1`. `blocks` are the terminals in it: ids, or `{id, label, detached}`; the
 * first has focus unless `focused` names another. Each shows `$ ` and has a zsh at its prompt, pid 100 + its index.
 * `calls` records every request as `{method, payload}` and `typed` every `write` as [block id, text]. Change what a
 * block shows in `blocks.get(id).lines`; `focus(id)`, `created(block)`, `closed(id)`, `process(id, foreground,
 * ancestors)` and `viewChanged(revision)` push the events Rex would; `drop()` cuts every connection;
 * `fail(method, code)` and `hang(method)` make a method fail or never answer.
 */
export async function fakeRex(socketPath, {blocks = ['block:b1'], focused = null} = {}) {
  const model = new Map();
  const calls = [];
  const typed = [];
  const failing = new Map();
  const hanging = new Set();
  const connections = new Set(); // {ws, attached, seq}
  let revision = 1;
  let focus = null;
  let activeWindow = WINDOW;
  let serial = 0;
  const blobs = new Map(); // id -> the output of a format with max_bytes that did not fit
  let blob = 0;

  function add(spec, window_id = WINDOW) {
    const {id, label = 'shell', detached = false, flavor = SHELL_FLAVOR, options = null} = typeof spec === 'string' ? {id: spec} : spec;
    const index = serial++;
    model.set(id, {
      block_id: id, label, flavor, options, window_id: detached ? null : window_id, lines: ['$ '],
      process: {foreground: shell(100 + index), ancestors: [login]},
    });
    return model.get(id);
  }
  for (const spec of blocks) add(spec);
  focus = focused ?? [...model.values()].find(block => block.window_id)?.block_id ?? null;

  const placed = () => [...model.values()].filter(block => block.window_id);
  const view = () => ({
    revision, session_id: SESSION, label: 'fake', active_window_id: activeWindow,
    windows: [{window_id: WINDOW, label: 'Window', focused_block_id: focus, layers: [{layer_id: 'layer:l1', kind: 'tiled', blocks: placed().map(({block_id, label, flavor}) => ({block_id, label, flavor, creator_name: 'com.superlogical.terminal'}))}]}],
  });
  const block = id => {
    const found = model.get(id);
    if (!found) throw Object.assign(new Error('block not found'), {code: 'not_found'});
    return found;
  };

  function push(event) {
    for (const connection of connections) {
      if (!connection.attached) continue;
      connection.ws.sendText(JSON.stringify({type: 'event', seq: ++connection.seq, payload: {type: 'session_event', payload: {session_id: SESSION, event}}}));
    }
  }
  const changed = () => { revision++; push({type: 'session_view_changed', payload: {revision}}); };

  const methods = {
    'server.version': () => ({rex_version: '9.9.9-fake', api_revision: 10, platform: 'fake', dirty: false}),
    'session.view': () => view(),
    'session.list_blocks': () => ({blocks: [...model.values()].map(({block_id, label, flavor, window_id}) => ({block_id, label, flavor, creator_name: 'com.superlogical.terminal', placement: window_id ? 'placed' : 'detached', ...(window_id ? {window_id} : {})}))}),
    'session.new_split': ({anchor_id, direction, side, layout}) => {
      if (!block(anchor_id).window_id) throw Object.assign(new Error('the anchor is not placed in a window'), {code: 'not_found'});
      if (!['horizontal', 'vertical'].includes(direction)) throw Object.assign(new Error(`direction ${direction}`), {code: 'bad_request'});
      if (!['before', 'after'].includes(side)) throw Object.assign(new Error(`side ${side}`), {code: 'bad_request'});
      const {flavor, label = '', options = null} = layout.block;
      const id = `block:n${serial}`;
      add({id, label, flavor, options});
      push({type: 'block_created', payload: {block_id: id}});
      changed();
      return {anchor_id, block_ids: [id], split_ids: ['split:s'], revision, direction, side};
    },
    'block.close': ({block_id}) => {
      block(block_id);
      model.delete(block_id);
      if (focus === block_id) focus = placed()[0]?.block_id ?? null;
      push({type: 'block_closed', payload: {block_id}});
      changed();
      return {block_id, revision};
    },
    'com.superlogical.terminal.write': ({block_id, args}) => { block(block_id); typed.push([block_id, args.data]); return {bytes_written: args.data.length}; },
    'com.superlogical.terminal.format': ({block_id, args}) => {
      // The screen as Rex trims it, with the blank rows of the screen below the cursor.
      const text = Buffer.from(`${block(block_id).lines.join('\n')}\n\n\n`);
      const max = Math.min(args.max_bytes ?? 0, 983040);
      if (!max) {
        if (text.length > LIMIT) throw Object.assign(new Error('the output does not fit in one message'), {code: 'too_large'});
        return {content: text.toString()};
      }
      const first = chunk(text, 0, max);
      if (first.length === text.length) return {content: text.toString(), eof: true, total: text.length};
      blobs.set(++blob, text); // the rest is read with blob_read
      return {content: first.data, eof: false, id: blob, total: text.length};
    },
    'com.superlogical.terminal.blob_read': ({block_id, args: {id, offset = 0, max_bytes = 49152}}) => {
      block(block_id);
      const text = blobs.get(id ?? blob);
      if (!text) throw Object.assign(new Error('no such result'), {code: 'not_found'});
      const data = chunk(text, offset, Math.min(max_bytes || 49152, 983040));
      return {id: id ?? blob, data: data.data, total: text.length, eof: offset + data.length >= text.length};
    },
    'com.superlogical.terminal.process': ({block_id}) => ({last_exit: null, child: login, home: '/', ...block(block_id).process}),
  };

  function serve(ws) {
    const connection = {ws, attached: false, seq: 0, hello: false};
    connections.add(connection);
    ws.onClose = () => connections.delete(connection);
    ws.onText = async text => {
      const message = JSON.parse(text);
      if (message.type === 'hello') {
        connection.hello = true;
        return ws.sendText(JSON.stringify({type: 'welcome', protocol: 'rex.control.v1', limits: {max_message_bytes: LIMIT}, client: {id: 'client:c1', reconnect_token: 'secret'}, api_revision: 10}));
      }
      const {id, method, payload = {}} = message;
      const reply = body => ws.sendText(JSON.stringify({type: 'response', id, seq: connection.seq, ...body}));
      calls.push({method, payload});
      if (hanging.has(method)) return;
      try {
        if (failing.has(method)) throw Object.assign(new Error(`${method} refused`), {code: failing.get(method)});
        if (method === 'session.attach') {
          if (payload.session_id !== SESSION) throw Object.assign(new Error('no such session'), {code: 'session_not_found'});
          connection.attached = true;
          return reply({payload: {client_id: 'client:c1', view: view()}});
        }
        if (!methods[method]) throw Object.assign(new Error('no such method'), {code: 'method_not_found'});
        if (!method.startsWith('server.') && payload.session_id !== SESSION) throw Object.assign(new Error('no such session'), {code: 'session_not_found'});
        if (!method.startsWith('server.') && !connection.attached) throw Object.assign(new Error('not attached'), {code: 'conflict'});
        reply({payload: methods[method](payload)});
      } catch (error) {
        const code = error.code ?? 'internal';
        if (!STATUS[code]) throw new Error(`the fake has no status for the error code ${code}`);
        reply({error: {code, message: error.message, status: STATUS[code]}});
      }
    };
  }

  const server = await listenWebSocket(socketPath, serve, {subprotocol: 'rex.control.v1'});
  return {
    blocks: model, calls, typed,
    /** The requests of `method`, their payloads. */
    requests: method => calls.filter(call => call.method === method).map(call => call.payload),
    get revision() { return revision; },
    get clients() { return [...connections].filter(connection => connection.attached).length; },
    fail: (method, code = 'conflict') => failing.set(method, code),
    hang: method => hanging.add(method),
    focus(id) {
      focus = id;
      changed();
    },
    activate() { // another window comes forward
      activeWindow = 'window:w2';
      push({type: 'active_window_changed', payload: {window_id: activeWindow}});
      changed();
    },
    created(spec) {
      const {block_id} = add(spec);
      push({type: 'block_created', payload: {block_id}});
      changed();
    },
    closed(id) {
      model.delete(id);
      if (focus === id) focus = placed()[0]?.block_id ?? null;
      push({type: 'block_closed', payload: {block_id: id}});
      changed();
    },
    /** A bare `session_view_changed` with `value`, as the server may send them out of order. */
    viewChanged: value => push({type: 'session_view_changed', payload: {revision: value}}),
    /** Block `id` now runs `foreground` (a process, or null at the prompt for its shell) below `ancestors`. */
    process(id, foreground, ancestors) {
      const held = block(id);
      held.process = {foreground, ancestors};
      push({type: 'block_event', payload: {block_id: id, creator_name: 'com.superlogical.terminal', name: 'process_changed', payload: {generation: ++serial, foreground, ancestors}}});
    },
    /** Any session event, as `{type, payload}`. */
    event: (type, payload = {}) => push({type, payload}),
    blockEvent: (id, name, payload = {}) => push({type: 'block_event', payload: {block_id: id, creator_name: 'com.superlogical.terminal', name, payload}}),
    drop() { for (const connection of connections) connection.ws.socket.destroy(); },
    close: () => server.close(),
  };
}

export {shell, login};
