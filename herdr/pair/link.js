// The panel's line to Pair's daemon: Herdr's mods have TCP but no Unix sockets, so it reads the port and token the
// daemon wrote beside its socket (src/herdr-panel.mjs), connects to 127.0.0.1, gives the token, says hello, and reads
// the daemon's NDJSON. When the daemon goes (a restart) it tries again, and says hello with `resume` once it is back.
// Plain JavaScript with no imports: Node's tests and Herdr's mod runtime hand it their own TCP, file and sleep.

const NEWLINE = 10;

/** The panel file's `{port, token}`, or null when it is missing or not one. */
export function panelOf(text) {
  try {
    const found = JSON.parse(text ?? '');
    return Number.isInteger(found?.port) && typeof found.token === 'string' ? found : null;
  } catch {
    return null;
  }
}

/** Splits bytes into lines: `push(bytes)` returns the whole lines so far, keeping a part line for the next push. */
export function lineReader(decode) {
  let rest = new Uint8Array(0);
  return bytes => {
    const all = new Uint8Array(rest.length + bytes.length);
    all.set(rest);
    all.set(bytes, rest.length);
    const lines = [];
    let start = 0;
    for (let i = 0; i < all.length; i++) {
      if (all[i] !== NEWLINE) continue;
      lines.push(decode(all.subarray(start, i)));
      start = i + 1;
    }
    rest = all.slice(start);
    return lines;
  };
}

/**
 * Runs the line until `closed()`: `connect(host, port)` gives a socket with `write(text)`, `read()` (bytes, null at
 * the end) and `close()`; `readText(path)` reads the panel file; `sleep(ms)` waits; `decode(bytes)` makes text.
 * `hello(resume)` is the hello to say; `onMessage(message)` hears each message; `onState(state)` hears 'connecting',
 * 'up' (welcomed), 'away' (the daemon went; trying again) or 'down' (no daemon answers yet); `onError(error, message)`
 * hears a message `onMessage` failed on, which leaves the line open. Returns `{send}`,
 * which writes a message while the line is up (false when it is not).
 */
export function openLink({connect, readText, sleep, decode, file, hello, onMessage, onState = () => {}, onError = () => {}, closed = () => false, retryMs = 1000, downMs = 3000}) {
  let socket = null;
  let welcomed = false; // once: the next hello resumes
  let up = false;
  const line = message => `${JSON.stringify(message)}\n`;
  const link = {
    send(message) {
      if (!socket || !up) return false;
      socket.write(line(message)).catch(() => {});
      return true;
    },
    close() {
      socket?.close();
    },
  };
  link.done = (async () => {
    onState('connecting');
    while (!closed()) {
      const panel = panelOf(await readText(file).catch(() => null));
      const opened = panel && await connect('127.0.0.1', panel.port).catch(() => null);
      if (!opened) {
        onState(welcomed ? 'away' : 'down');
        await sleep(welcomed ? retryMs : downMs);
        continue;
      }
      socket = opened;
      const reader = lineReader(decode);
      try {
        await socket.write(line({type: 'auth', token: panel.token}) + line(hello(welcomed)));
        for (;;) {
          const bytes = await socket.read();
          if (bytes === null || closed()) break;
          for (const text of reader(bytes)) {
            let message;
            try { message = JSON.parse(text); } catch { continue; }
            if (message.type === 'welcome') {
              up = true;
              message.reconnected = welcomed;
              welcomed = true;
              onState('up');
            }
            // A message the panel fails on is its own trouble: the line stays.
            try { onMessage(message); } catch (error) { onError(error, message); }
          }
        }
      } catch {}
      up = false;
      try { socket.close(); } catch {}
      socket = null;
      if (closed()) break;
      onState(welcomed ? 'away' : 'down');
      await sleep(retryMs);
    }
  })();
  return link;
}
