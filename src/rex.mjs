// Rex (https://rex.dev's terminal multiplexer) as a source of panes (src/pane-watch.mjs), a host for Pair's own pane
// and a place to open the chat. Rex has no per-pane event stream, but one control connection (a WebSocket on its unix
// socket, src/rex-ws.mjs) attached to a session pushes everything that matters here: blocks coming and going, focus
// and layout changing (`session_view_changed`, a revision only), and each terminal's foreground process. A terminal
// block's text comes from `com.superlogical.terminal.format`; typing is `…write`, which leaves the line at the prompt.
// Rex says nothing of scrolling, keys or commands starting and ending: the shell hook reports commands (see
// shell-hook.mjs), and PaneWatch looks at the focused terminal as it does with herdr.
import {connectWebSocket} from './rex-ws.mjs';
import {VERSION} from './version.mjs';

export const PREFIX = 'rex:';
export const rexPane = blockId => `${PREFIX}${blockId}`;
export const blockOf = pane => pane.slice(PREFIX.length);

const API_REVISION = 10;
const RETRY_MS = 2000;
const READ_BYTES = 64 * 1024; // of a terminal's text asked for at once: 1000 lines are well within it
const TERMINAL = 'com.superlogical.terminal.';
const SCOUT = 'pair scout';
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'nu']);

/**
 * Which Rex the environment `env` is in: `{server, session, block}`, the server being the path of its unix socket
 * (`REX_SERVER` is `unix://` and the percent-encoded path), or null unless all three variables are set and the server
 * is local.
 */
export function rexOf(env = process.env) {
  const {REX_SERVER: url, REX_SESSION: session, REX_BLOCK: block} = env;
  if (!url?.startsWith('unix://') || !session || !block) return null;
  try {
    return {server: decodeURIComponent(url.slice('unix://'.length)), session, block};
  } catch {
    return null;
  }
}

const failure = (message, code) => Object.assign(new Error(message), {code});

/**
 * One control connection to the Rex server at `socketPath`, attached to `session`. `request(method, payload)` resolves
 * with the result and rejects with an Error whose `code` is Rex's (`not_found`, `conflict`, …; `timeout` and
 * `not_connected` are ours). `start()` keeps it open: `onStart()` after each (re)attach, `onError(error)` when it fails
 * or drops, then another try every RETRY_MS; `onEvent({type, payload, blockId?, name?})` for the session's events.
 * `connect()` is one try, for a one-off request.
 */
export class RexClient {
  constructor({socketPath, session, onEvent = () => {}, onStart = () => {}, onError = () => {}}) {
    Object.assign(this, {socketPath, session, onEvent, onStart, onError});
    this.conn = null;
    this.view = null; // the session's view when last attached
    this.looping = false;
    this.retry = null;
  }

  start() {
    this.looping = true;
    this.open();
  }

  stop() {
    this.looping = false;
    clearTimeout(this.retry);
    this.retry = null;
    const {conn} = this;
    this.conn = null;
    if (conn) this.end(conn, failure('rex client stopped', 'not_connected'));
  }

  async open() {
    this.retry = null;
    try {
      await this.connect();
    } catch {
      return; // connect() has told onError and scheduled the next try, through end()
    }
    if (this.looping) this.onStart();
  }

  /** Connects, says hello and attaches to the session; resolves with the session's view. */
  async connect() {
    const conn = {ws: null, pending: new Map(), next: 1, open: false, attached: false, dead: false, welcome: null};
    conn.welcome = new Promise((resolve, reject) => Object.assign(conn, {welcomed: resolve, refused: reject}));
    conn.welcome.catch(() => {}); // an unhandled rejection when it fails before anyone waits
    this.conn = conn;
    try {
      conn.ws = await connectWebSocket(this.socketPath, '/api/control', {
        subprotocol: 'rex.control.v1',
        onText: text => this.message(conn, text),
        onClose: code => this.end(conn, failure(`rex closed the control connection (${code})`, 'closed')),
        onError: error => this.end(conn, error),
      });
      if (conn.dead) { conn.ws.close(); throw failure('rex closed the control connection', 'closed'); } // stopped meanwhile
      conn.ws.sendText(JSON.stringify({type: 'hello', api_revision: API_REVISION, client: {kind: 'agent', name: 'pairing-buddy', version: VERSION}}));
      const timer = setTimeout(() => conn.refused(failure('rex did not welcome the connection', 'timeout')), 3000);
      await conn.welcome.finally(() => clearTimeout(timer));
      conn.open = true;
      const {view} = await this.request('session.attach', {session_id: this.session});
      conn.attached = true;
      this.view = view;
      return view;
    } catch (error) {
      this.end(conn, error);
      throw error;
    }
  }

  /** The connection is over, for `error`: fails its requests, closes it, and has `start()` try again. Once. */
  end(conn, error) {
    if (conn.dead) return;
    conn.dead = true;
    conn.refused?.(error);
    for (const {reject} of conn.pending.values()) reject(error);
    conn.pending.clear();
    conn.ws?.close();
    if (this.conn !== conn) return;
    this.conn = null;
    if (!this.looping) return;
    this.onError(error);
    this.retry = setTimeout(() => this.open(), RETRY_MS);
  }

  message(conn, text) {
    let message;
    try { message = JSON.parse(text); } catch { return this.end(conn, failure('rex sent something that is not JSON', 'protocol')); }
    if (message.type === 'welcome') {
      if (message.protocol !== 'rex.control.v1') return conn.refused(failure(`rex speaks ${message.protocol}`, 'protocol'));
      return conn.welcomed(message);
    }
    if (message.type === 'response') {
      const waiting = conn.pending.get(message.id);
      conn.pending.delete(message.id);
      if (!waiting) return;
      if (message.error) waiting.reject(failure(message.error.message ?? message.error.code, message.error.code));
      else waiting.resolve(message.payload ?? {});
      return;
    }
    if (message.type !== 'event' || !conn.attached) return; // what happened before the attach is in the view it returned
    const {type, payload} = message.payload ?? {};
    if (type !== 'session_event') return this.onEvent({type, payload});
    if (payload.session_id !== this.session) return;
    const event = payload.event;
    if (event.type === 'block_event') this.onEvent({type: 'block_event', blockId: event.payload.block_id, name: event.payload.name, payload: event.payload.payload ?? {}});
    else this.onEvent({type: event.type, payload: event.payload ?? {}});
  }

  request(method, payload = {}, {timeoutMs = 3000} = {}) {
    const {conn} = this;
    if (!conn?.open || conn.dead) return Promise.reject(failure(`rex ${method}: not connected`, 'not_connected'));
    return new Promise((resolve, reject) => {
      const id = String(conn.next++);
      const timer = setTimeout(() => { conn.pending.delete(id); reject(failure(`rex ${method} timed out`, 'timeout')); }, timeoutMs);
      conn.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      conn.ws.sendText(JSON.stringify({type: 'request', id, method, payload}));
    });
  }

  /** `request` for a method of the session. */
  call(method, payload = {}, options) {
    return this.request(method, {session_id: this.session, ...payload}, options);
  }

  /** `request` for a method of terminal block `blockId`. */
  terminal(blockId, method, args = {}, options) {
    return this.call(`${TERMINAL}${method}`, {block_id: blockId, args}, options);
  }
}

/** Runs `use(client)` on a connection of its own, attached to `session`, and closes it after. */
async function once({socketPath, session}, use) {
  const client = new RexClient({socketPath, session});
  try {
    await client.connect();
    return await use(client);
  } finally {
    client.stop();
  }
}

/** The blocks in the windows of a session's `view`, each with its `window_id`. */
function placedBlocks(view) {
  return (view.windows ?? []).flatMap(window => (window.layers ?? []).flatMap(layer => (layer.blocks ?? []).map(block => ({...block, window_id: window.window_id}))));
}

/**
 * The pid of the shell of a terminal, from a `process` result, or null: the nearest ancestor that is a shell while a
 * command runs (not the ones above it, nor `login`), the foreground itself at the prompt.
 */
function shellPid(info) {
  const shell = (info.ancestors ?? []).find(process => SHELLS.has(process.name)) ?? (SHELLS.has(info.foreground?.name) ? info.foreground : null);
  return shell?.pid ?? null;
}

/**
 * The command a terminal runs, or null when its shell waits at the prompt, from a `process` result. At the prompt the
 * foreground process is the shell itself; running a command it is the command, with the shell among its ancestors. A
 * shell below another shell is a command too, labelled with the script it runs (`bash build.sh`): Rex's `script`, or
 * else an `argv0` that is not the shell's own name (`-zsh` is).
 */
export function commandIn(info) {
  const foreground = info?.foreground;
  if (!foreground) return null;
  if (!SHELLS.has(foreground.name)) return foreground.name;
  const insideShell = (info.ancestors ?? []).some(process => SHELLS.has(process.name));
  if (!insideShell) return null;
  const {name, script, argv0} = foreground;
  return [name, script ?? (argv0 && argv0.replace(/^-/, '') !== name ? argv0 : null)].filter(Boolean).join(' ');
}

/**
 * A byte of a blob, at or after `from` and before `limit` (the end of the window), that certainly starts a character
 * (0 for the start of the blob). `blob(offset, max_bytes)` is Rex's blob_read. `from` itself
 * may be inside a character: a read there starts with one U+FFFD for each stray continuation byte (k of them, 0 to 3), standing for 1 byte each, and then the first character `ch`; a genuine
 * U+FFFD in the run stands for 3. So with c leading U+FFFD, `ch` starts at from + 3c - 2k for one k. A 1-byte read at a
 * character start returns that character, at a stray always U+FFFD; so the first candidate that answers anything else
 * starts a character, with certainty (one that answers U+FFFD is a stray, or a genuine U+FFFD that the next candidate
 * or the next window reads whole).
 *
 * When the probe is all U+FFFD (a binary dump), nothing tells strays from genuine ones, so the probe doubles, with no
 * cap, until a character that is not U+FFFD shows. If none does by the end of the blob or of the window, the answer is
 * 0, a certain boundary whatever the blob holds: so there is no known limitation left, and no guess. A boundary at or
 * past `limit` would also be no use (the window would make no progress), so it is 0 as well. The window then reads
 * from 0, at a cost proportional to the run and bounded by the blob's `total`. A reply stops short of its budget only
 * for a next character that does not fit, and one costs at most 6 encoded bytes (a control character), so a reply
 * 6 bytes or more under its budget, or an empty one, has reached the end of the blob.
 * Requests per window: probes <= log2(total / 256) + 4 (the budget doubles until it passes the window, at most
 * `total`), then at most 4 candidates.
 */
async function boundaryNear(blob, from, limit) {
  if (from === 0) return 0;
  for (let budget = 256; ; budget *= 2) {
    const probe = await blob(from, budget);
    const lead = probe.match(/^\uFFFD*/)[0].length;
    if (lead === probe.length) {
      if (Buffer.byteLength(probe) + 6 <= budget || from + budget >= limit) return 0; // nothing but U+FFFD to the end of the blob or the window
      continue; // all U+FFFD: look further
    }
    for (let strays = 0; strays <= Math.min(3, lead); strays++) {
      const offset = from + 3 * lead - 2 * strays;
      const answer = await blob(offset, 1);
      if (answer !== '' && answer !== '\uFFFD') return offset < limit ? offset : 0; // past the window: only 0 is certain
    }
    return 0; // not expected: no candidate starts a character; the start of the blob is certain all the same
  }
}

/** The terminals of one Rex session, for PaneWatch (`chatPane` and the like are Pair's own to leave out, which the watch does). */
export class RexPanes {
  name = 'rex';

  constructor({socketPath, session}) { // the daemon also passes `chatPane`, which the watch leaves out itself
    Object.assign(this, {socketPath, session});
    this.client = new RexClient({
      socketPath, session,
      onEvent: event => this.heard(event),
      onStart: () => this.attached(),
      onError: error => this.failure(error),
    });
    this.revision = -1; // of the newest session view seen
    this.processes = new Map(); // block id -> its last `process` result, kept up to date by process_changed
    this.shells = new Map(); // shell pid -> pane, from the last list
    this.look = () => {};
    this.failure = () => {};
  }

  owns(id) {
    return id.startsWith(PREFIX);
  }

  start(look, scrolled, failed) {
    Object.assign(this, {look, failure: failed});
    this.client.start();
  }

  stop() {
    this.client.stop();
  }

  /** Attached (again): what the cache holds may be older than what happened while Pair was away. */
  attached() {
    this.revision = this.client.view?.revision ?? -1;
    this.processes.clear();
    this.look();
  }

  heard({type, payload, blockId, name}) {
    if (type === 'session_view_changed') {
      if (!(payload.revision > this.revision)) return;
      this.revision = payload.revision;
      return this.look();
    }
    if (type === 'block_closed') this.processes.delete(payload.block_id);
    if (type === 'block_event') {
      if (name === 'process_changed') this.remember(blockId, payload);
      else if (name !== 'title_changed' && name !== 'pwd_changed') return;
      return this.look();
    }
    if (['block_created', 'block_closed', 'active_window_changed'].includes(type)) this.look();
  }

  /** The process_changed event's `payload` is the cached `process` result when it carries the foreground. */
  remember(blockId, payload) {
    const held = this.processes.get(blockId);
    if (!payload.foreground) return this.processes.delete(blockId);
    if (held?.generation !== undefined && payload.generation < held.generation) return;
    this.processes.set(blockId, payload);
  }

  async list() {
    const view = await this.client.call('session.view');
    this.revision = Math.max(this.revision, view.revision ?? -1);
    const terminals = placedBlocks(view).filter(block => block.flavor?.startsWith(TERMINAL));
    const ids = new Set(terminals.map(block => block.block_id));
    for (const id of this.processes.keys()) if (!ids.has(id)) this.processes.delete(id);
    // A terminal whose foreground has not been heard of yet is asked once; process_changed keeps it current after.
    // Only a block that closed meanwhile (`not_found`) may go unanswered: any other failure fails the list, so the
    // shells of the last good one stay and the watch hears that Rex is failing.
    await Promise.all(terminals.filter(block => !this.processes.has(block.block_id)).map(async block => {
      const info = await this.client.terminal(block.block_id, 'process').catch(error => {
        if (error.code === 'not_found') return null;
        throw error;
      });
      if (info && !this.processes.has(block.block_id)) this.processes.set(block.block_id, info);
    }));
    const shells = new Map();
    for (const {block_id: id} of terminals) {
      const pid = shellPid(this.processes.get(id) ?? {});
      if (pid !== null) shells.set(pid, rexPane(id));
    }
    this.shells = shells;
    const active = (view.windows ?? []).find(window => window.window_id === view.active_window_id);
    return terminals.map(block => ({pane: rexPane(block.block_id), focused: block.block_id === active?.focused_block_id, scrolled: false, weight: 1}));
  }

  paneOfShell(pid) {
    return this.shells.get(pid) ?? null;
  }

  async commandOf(pane) {
    const id = blockOf(pane);
    if (!this.processes.has(id)) {
      const info = await this.client.terminal(id, 'process');
      if (!this.processes.has(id)) this.processes.set(id, info); // a process_changed that came meanwhile is newer
    }
    return commandIn(this.processes.get(id));
  }

  /**
   * The last `lines` complete lines of what the terminal shows, whatever their length. The scrollback can be larger than
   * a control message (1 MiB), so Rex is asked for at most READ_BYTES; when there is more it keeps the whole as a blob,
   * and the tail is read from there, a window of READ_BYTES at a time from the end, until it holds enough lines.
   *
   * What Rex's blob_read guarantees, and all this relies on (measured on a live Rex, API rev 10): `offset` and the
   * returned text are in bytes of the source, but `max_bytes` is a budget of JSON-encoded bytes (a newline or quote
   * costs 2), so a reply is shorter than `max_bytes` source bytes in general, and any shortfall is normal. A reply
   * never ends inside a character. At an offset inside a character, each stray continuation byte comes back as one
   * U+FFFD, and a genuine U+FFFD (3 bytes) looks the same; but `max_bytes: 1` at a character start returns that whole
   * character, and at a stray byte always U+FFFD. So the length of a reply says nothing of how many source bytes it
   * covers, except that the bytes of a reply that starts at a character boundary are the bytes of its text.
   *
   * Hence: keep `start`, a known boundary (first the total), and `tail`, the text from there to the end. For each
   * window, find a boundary `b` near its start `from` that is certain, read from `b` to `start` in parts that each begin
   * at a boundary (so advancing by the bytes received is exact), and continue from `b`. Nothing is computed from the
   * length of a reply other than what advances the offset.
   */
  async read(pane, lines) {
    if (!(lines > 0)) return '';
    const id = blockOf(pane);
    const reply = await this.client.terminal(id, 'format', {format: 'text', trim: true, unwrap: true, max_bytes: READ_BYTES});
    let text = reply.content;
    if (reply.id !== undefined && reply.total !== undefined) {
      const blob = (offset, max_bytes) => this.client.terminal(id, 'blob_read', {id: reply.id, offset, max_bytes}).then(part => part.data);
      let start = reply.total;
      let tail = Buffer.alloc(0);
      while (start > 0) {
        const boundary = await boundaryNear(blob, Math.max(0, start - READ_BYTES), start);
        const chunks = [];
        let at = boundary;
        while (at < start) {
          const data = await blob(at, READ_BYTES);
          if (data === '') break; // Rex has less than it said: what was read is all there is
          chunks.push(Buffer.from(data));
          at += chunks.at(-1).length;
        }
        tail = Buffer.concat([Buffer.concat(chunks).subarray(0, start - boundary), tail]); // `start` is a boundary: the cut is clean
        if (at < start) break;
        start = boundary;
        if (tail.toString().replace(/\s+$/, '').split('\n').length > lines) break; // its first line may be a part: it is not one asked for
      }
      text = tail.toString();
    }
    return text.replace(/\s+$/, '').split('\n').slice(-lines).join('\n');
  }

  async send(pane, text) {
    await this.client.terminal(blockOf(pane), 'write', {data: text});
  }

  focused() {} // Rex has no subscription per pane

  canType() {
    return true;
  }
}

/** Pair's pane in Rex: a terminal block split below `besidePane` (the chat's), labelled so a later daemon finds it. */
export class RexPaneHost {
  constructor({socketPath, session, besidePane, root}) {
    Object.assign(this, {socketPath, session, besidePane, root});
    this.key = `rex:${session}`; // with the project, names the pane's folder: the same after a restart
    this.hidden = [socketPath]; // a command in the sandbox must not reach Rex's API
  }

  async blocks() {
    return once(this, client => client.call('session.list_blocks')).then(({blocks}) => blocks ?? []);
  }

  async has(id) {
    return (await this.blocks()).some(block => rexPane(block.block_id) === id);
  }

  /** The pane an earlier daemon opened, or null. */
  async find() {
    const scout = (await this.blocks()).find(block => block.label === SCOUT && block.window_id);
    return scout ? rexPane(scout.block_id) : null;
  }

  /** Opens a pane in `cwd` whose shell runs `line`; its id. */
  async open({cwd, line}) {
    const layout = {block: {flavor: `${TERMINAL}shell`, label: SCOUT, options: {cwd, shell: 'none', command: ['sh', '-c', line]}}};
    const {block_ids: [block]} = await once(this, client => client.call('session.new_split', {
      anchor_id: blockOf(this.besidePane), direction: 'vertical', side: 'after', ratio: 0.5, focus: false, layout,
    }));
    if (!block) throw failure('Rex made no block for Pair\'s pane', 'internal');
    return rexPane(block);
  }

  send(id, text) {
    return once(this, client => client.terminal(blockOf(id), 'write', {data: text}));
  }

  close(id) {
    return once(this, client => client.call('block.close', {block_id: blockOf(id)}));
  }
}

/**
 * `pair` in Rex terminal `rex.block`: starts `argv` (the chat) in a terminal block of its own beside this one. `env`
 * holds the PAIR_* overrides the chat needs: Rex has no environment option, so env(1) carries them. False when Rex
 * refuses or does not answer: the chat then runs right here.
 */
export async function openRexChat(rex, {argv, cwd, env = {}}) {
  const command = ['env', ...Object.entries(env).map(([name, value]) => `${name}=${value}`), ...argv];
  const layout = {block: {flavor: `${TERMINAL}shell`, label: 'pair chat', options: {cwd, shell: 'none', command}}};
  try {
    await once({socketPath: rex.server, session: rex.session}, client => client.call('session.new_split', {
      anchor_id: rex.block, direction: 'horizontal', side: 'after', ratio: 0.7, focus: false, layout,
    }));
    return true;
  } catch {
    return false;
  }
}

/** What `pair doctor` says of Rex: its version, the session's label and its terminals, and how long it took. */
export async function rexStatus(rex) {
  const start = Date.now();
  return once({socketPath: rex.server, session: rex.session}, async client => {
    const {rex_version: version} = await client.request('server.version');
    const view = await client.call('session.view');
    return {
      version, label: view.label,
      terminals: placedBlocks(view).filter(block => block.flavor?.startsWith(TERMINAL)).length,
      ms: Date.now() - start,
    };
  });
}
