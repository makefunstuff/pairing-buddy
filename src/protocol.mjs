// Newline-delimited JSON over a Unix socket, the daemon's only protocol (Neovim, chat pane, shell hook).
import {connect} from 'node:net';
import {createInterface} from 'node:readline';

/** Calls `onMessage(object)` for every JSON line read from `stream`; bad lines are skipped. */
export function readMessages(stream, onMessage) {
  const lines = createInterface({input: stream, crlfDelay: Infinity});
  // readline passes the stream's errors on; the stream's owner handles them (a reset client must not crash the daemon).
  lines.on('error', () => {});
  lines.on('line', line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    onMessage(message);
  });
}

export function sendMessage(stream, message) {
  if (!stream.destroyed && stream.writable) stream.write(`${JSON.stringify(message)}\n`);
}

/** Sends `message` to the daemon at `socketPath` and resolves with its first answer. */
export function requestDaemon(socketPath, message, {timeoutMs = 3000} = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('the daemon did not answer')); }, timeoutMs);
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('connect', () => sendMessage(socket, message));
    readMessages(socket, answer => { clearTimeout(timer); socket.destroy(); resolve(answer); });
  });
}
