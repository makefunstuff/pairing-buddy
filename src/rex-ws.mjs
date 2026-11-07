// A minimal WebSocket client (RFC 6455) over a unix socket, for Rex's control connection (src/rex.mjs). Node's global
// WebSocket cannot dial a unix socket without a dependency, and the client side is small: the upgrade, masked text
// and binary frames, fragments joined, ping answered with pong, and the close handshake.
import {createHash, randomBytes} from 'node:crypto';
import {connect} from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** One masked frame (clients must mask), final, of `opcode` with `payload`. */
function frame(opcode, payload) {
  const n = payload.length;
  const head = Buffer.from([0x80 | opcode, 0x80 | (n < 126 ? n : n < 65536 ? 126 : 127)]);
  const length = n < 126 ? Buffer.alloc(0) : n < 65536 ? Buffer.alloc(2) : Buffer.alloc(8);
  if (n >= 65536) length.writeBigUInt64BE(BigInt(n));
  else if (n >= 126) length.writeUInt16BE(n);
  const mask = randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < n; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, length, mask, body]);
}

/**
 * Opens a WebSocket to `path` on the unix socket `socketPath`, asking for `subprotocol`. Resolves once the server
 * upgraded, with `{sendText(text), sendBinary(buffer), close(code = 1000)}`; rejects when it did not, within
 * `timeoutMs`. `onText(text)` and `onBinary(buffer)` get each message; `onClose(code, reason)` once when the
 * connection ends (1006 when it dropped without a close frame), `onError(error)` for a socket error after the upgrade.
 */
export function connectWebSocket(socketPath, path, {subprotocol, onText = () => {}, onBinary = () => {}, onClose = () => {}, onError = () => {}, timeoutMs = 3000}) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const key = randomBytes(16).toString('base64');
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let closed = false;
    let sentCode = null;
    let fragments = null; // {opcode, parts} of a message still arriving
    const timer = setTimeout(() => socket.destroy(new Error(`WebSocket upgrade on ${path} timed out`)), timeoutMs);

    const send = (opcode, payload = Buffer.alloc(0)) => { if (socket.writable) socket.write(frame(opcode, payload)); };
    const finish = (code, reason = '') => {
      if (closed) return;
      closed = true;
      onClose(code, reason);
    };
    const api = {
      sendText: text => send(1, Buffer.from(text)),
      sendBinary: data => send(2, Buffer.from(data)),
      close(code = 1000) {
        sentCode ??= code;
        send(8, Buffer.from([code >> 8, code & 0xff]));
        socket.end();
        setTimeout(() => socket.destroy(), 1000).unref(); // the server did not close its side
      },
    };

    function dispatch(opcode, fin, payload) {
      if (opcode === 9) return send(10, payload);
      if (opcode === 10) return;
      if (opcode === 8) {
        finish(payload.length >= 2 ? payload.readUInt16BE(0) : 1005, payload.subarray(2).toString());
        send(8, payload.subarray(0, 2));
        socket.end();
        return false;
      }
      if (opcode !== 0) fragments = {opcode, parts: []};
      fragments?.parts.push(payload);
      if (!fin || !fragments) return;
      const {opcode: kind, parts} = fragments;
      fragments = null;
      if (kind === 1) onText(Buffer.concat(parts).toString('utf8'));
      else onBinary(Buffer.concat(parts));
    }

    function readFrames() {
      while (buffer.length >= 2) {
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (!Number.isSafeInteger(length)) return socket.destroy(new Error('WebSocket frame too long'));
        const mask = masked ? buffer.subarray(offset, offset + 4) : null;
        if (masked) offset += 4;
        if (buffer.length < offset + length) return;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (mask) for (let i = 0; i < length; i++) payload[i] ^= mask[i & 3];
        const fin = (buffer[0] & 0x80) !== 0;
        const opcode = buffer[0] & 0xf;
        buffer = buffer.subarray(offset + length);
        if (dispatch(opcode, fin, payload) === false) return (buffer = Buffer.alloc(0));
      }
    }

    socket.on('connect', () => socket.write([
      `GET ${path} HTTP/1.1`, 'Host: localhost', 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', ...(subprotocol ? [`Sec-WebSocket-Protocol: ${subprotocol}`] : []), '', '',
    ].join('\r\n')));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString('latin1');
        buffer = buffer.subarray(end + 4);
        const header = name => new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(head)?.[1].trim();
        const accepted = createHash('sha1').update(key + GUID).digest('base64');
        if (!/^HTTP\/1\.1 101 /.test(head) || header('sec-websocket-accept') !== accepted || (subprotocol && header('sec-websocket-protocol') !== subprotocol)) {
          return socket.destroy(new Error(`WebSocket upgrade refused: ${head.split('\r\n')[0]}`));
        }
        upgraded = true;
        clearTimeout(timer);
        resolve(api);
      }
      readFrames();
    });
    socket.on('error', error => { clearTimeout(timer); if (upgraded) onError(error); else reject(error); });
    socket.on('close', () => {
      clearTimeout(timer);
      if (!upgraded) return reject(new Error(`WebSocket on ${path} closed during the upgrade`));
      finish(sentCode ?? 1006);
    });
  });
}
