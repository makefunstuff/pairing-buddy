// pi-ai's login interaction in a terminal: its questions on one line each, a typed key not echoed, its links printed
// and the sign-in page opened in the browser.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';

/** Opens `url` in the desktop's browser when there is a desktop; the printed link is the fallback either way. */
export function openInBrowser(url) {
  const opener = process.platform === 'darwin' ? 'open' : (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) ? 'xdg-open' : null;
  if (!opener) return;
  spawn(opener, [url], {detached: true, stdio: 'ignore'}).on('error', () => {}).unref();
}

/** An `AuthInteraction` (see pi-ai) on `input` and `output`; `close()` it when the login is done. */
export function terminalInteraction({input = process.stdin, output = process.stdout, openUrl = openInBrowser} = {}) {
  let muted = false;
  // readline echoes what is typed to its output: while a key is typed, nothing gets through.
  const echo = new Writable({write(chunk, _encoding, done) { if (!muted) output.write(chunk); done(); }});
  const lines = createInterface({input, output: echo, terminal: Boolean(input.isTTY)});
  const ask = async (message, {secret = false, signal} = {}) => {
    // readline writes the question at once, then redraws the line as keys come: muted after the question, a typed
    // key shows nothing while the question stays.
    const answer = lines.question(`${message} `, signal ? {signal} : {});
    muted = secret;
    try {
      return (await answer).trim();
    } finally {
      if (secret) { muted = false; output.write('\n'); }
    }
  };
  return {
    async prompt(prompt) {
      if (prompt.type !== 'select') return ask(prompt.message, {secret: prompt.type === 'secret', signal: prompt.signal});
      output.write(`${prompt.message}\n${prompt.options.map((option, index) => `  ${index + 1}. ${option.label}${option.description ? ` (${option.description})` : ''}`).join('\n')}\n`);
      for (;;) {
        const answer = await ask(`Choose 1-${prompt.options.length} [1]:`, {signal: prompt.signal});
        const option = prompt.options[(answer ? Number(answer) : 1) - 1];
        if (option) return option.id;
      }
    },
    notify(event) {
      if (event.type === 'auth_url') {
        output.write(`${event.instructions ?? 'Sign in in your browser:'}\n  ${event.url}\n`);
        openUrl(event.url);
      } else if (event.type === 'device_code') {
        output.write(`Open ${event.verificationUri} and enter the code ${event.userCode}\n`);
        openUrl(event.verificationUri);
      } else {
        output.write(`${event.message}\n${(event.links ?? []).map(link => `  ${link.label ?? 'More'}: ${link.url}\n`).join('')}`);
      }
    },
    close: () => lines.close(),
  };
}
