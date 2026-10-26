// Newline-delimited JSON over a Unix socket, the daemon's only protocol (Neovim, chat pane, shell hook).
import {createInterface} from 'node:readline';

/** Calls `onMessage(object)` for every JSON line read from `stream`; bad lines are skipped. */
export function readMessages(stream, onMessage) {
  const lines = createInterface({input: stream, crlfDelay: Infinity});
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
