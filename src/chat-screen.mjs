// The terminal under the full-screen chat pane: the keys as they come in (escape sequences, pastes, the mouse
// wheel), and the frame going out, only the lines that changed. It also copies text to the clipboard the terminal
// way (OSC 52), which reaches your clipboard through herdr, tmux and ssh where they pass it on.

const MODS = m => ({shift: Boolean((m - 1) & 1), meta: Boolean((m - 1) & 2), ctrl: Boolean((m - 1) & 4)});
const CSI_LETTERS = {A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'tab', P: 'f1'};
const CSI_TILDE = {1: 'home', 2: 'insert', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end', 11: 'f1'};
const PASTE_END = '\x1b[201~';

/** A key: its `name` (a character for printable ones), and which of ctrl, meta (Alt) and shift were held. */
const key = (name, mods = {}) => ({name, ctrl: false, meta: false, shift: false, ...mods});

/** The key of one byte that is no escape sequence. */
function plainKey(char) {
  if (char === '\r') return key('enter');
  if (char === '\n') return key('j', {ctrl: true});
  if (char === '\t') return key('tab');
  if (char === '\x7f' || char === '\b') return key('backspace');
  if (char === '\x00') return key('space', {ctrl: true});
  const code = char.charCodeAt(0);
  if (code < 27) return key(String.fromCharCode(code + 96), {ctrl: true});
  if (code < 32) return key(char, {ctrl: true});
  return key(char);
}

/**
 * Turns what the terminal sends into keys, pastes (`{paste: text}`) and mouse events (`{mouse: 'wheelup' |
 * 'wheeldown' | 'press', x, y}`). Feed it each chunk; an escape sequence split across chunks waits for its rest.
 */
export class KeyDecoder {
  constructor() {
    this.rest = '';
    this.pasting = null; // the text of a paste that has not ended yet
  }

  feed(chunk) {
    let data = this.rest + chunk;
    this.rest = '';
    const out = [];
    while (data) {
      if (this.pasting !== null) {
        const end = data.indexOf(PASTE_END);
        if (end === -1) {
          this.pasting += data;
          return out;
        }
        out.push({paste: (this.pasting + data.slice(0, end)).replace(/\r\n?/g, '\n')});
        this.pasting = null;
        data = data.slice(end + PASTE_END.length);
        continue;
      }
      if (data[0] !== '\x1b') {
        const char = String.fromCodePoint(data.codePointAt(0));
        out.push(plainKey(char));
        data = data.slice(char.length);
        continue;
      }
      if (data.length === 1) {
        out.push(key('escape'));
        break;
      }
      const parsed = this.escape(data);
      if (!parsed) { // the rest of the sequence is still on its way
        this.rest = data;
        break;
      }
      if (parsed.event) out.push(parsed.event);
      data = data.slice(parsed.length);
    }
    return out;
  }

  /** One escape sequence at the start of `data`: {event, length}, or null when it is not complete yet. */
  escape(data) {
    const second = data[1];
    if (second === '[') {
      const match = /^\x1b\[([<?]?)([\d;:]*)([\x40-\x7e])/.exec(data);
      if (!match) return data.length > 16 ? {event: null, length: 2} : null;
      const [all, lead, params, final] = match;
      const numbers = params.split(';').map(n => Number.parseInt(n, 10) || 0);
      return {event: this.csi(lead, numbers, final), length: all.length};
    }
    if (second === 'O') {
      if (data.length < 3) return null;
      const name = CSI_LETTERS[data[2]];
      return {event: name ? key(name) : null, length: 3};
    }
    if (second === '\x1b') return {event: key('escape'), length: 1};
    // Alt and a key: the key, with meta.
    const char = String.fromCodePoint(data.codePointAt(1));
    const inner = plainKey(char);
    return {event: {...inner, meta: true}, length: 1 + char.length};
  }

  csi(lead, numbers, final) {
    if (lead === '<' && (final === 'M' || final === 'm')) {
      const [button, x, y] = numbers;
      if (button === 64) return {mouse: 'wheelup', x, y};
      if (button === 65) return {mouse: 'wheeldown', x, y};
      return final === 'M' && button === 0 ? {mouse: 'press', x, y} : null;
    }
    if (final === '~') {
      const [code, mods = 1, other] = numbers;
      if (code === 200) {
        this.pasting = '';
        return null;
      }
      if (code === 27 && other) return {...plainKey(String.fromCharCode(other)), ...MODS(mods)}; // xterm's modifyOtherKeys
      const name = CSI_TILDE[code];
      return name ? key(name, MODS(mods)) : null;
    }
    if (final === 'u') { // the kitty keyboard protocol and CSI u: Shift-Enter, Alt-Enter
      const [code, mods = 1] = numbers;
      return {...plainKey(String.fromCharCode(code)), ...MODS(mods)};
    }
    const name = CSI_LETTERS[final];
    if (!name) return null;
    const mods = numbers.length > 1 ? MODS(numbers[1]) : {};
    return key(name, final === 'Z' ? {shift: true} : mods);
  }
}

/** The OSC 52 sequence that puts `text` on the clipboard; inside tmux, wrapped so that tmux passes it on. */
export function clipboardSequence(text, {tmux = false} = {}) {
  const osc = `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
  return tmux ? `\x1bPtmux;${osc.replaceAll('\x1b', '\x1b\x1b')}\x1b\\` : osc;
}

/**
 * The alternate screen the pane draws on: `draw(lines, cursor)` writes the lines that changed since the last frame
 * and puts the cursor where you type (null hides it).
 */
export class Screen {
  constructor(output, {mouse = true, tmux = false} = {}) {
    this.output = output;
    this.mouse = mouse;
    this.tmux = tmux;
    this.last = [];
    this.on = false;
  }

  start() {
    this.on = true;
    this.output.write(`\x1b[?1049h\x1b[?2004h${this.mouse ? '\x1b[?1000h\x1b[?1006h' : ''}\x1b[2J`);
    this.last = [];
  }

  stop() {
    if (!this.on) return;
    this.on = false;
    this.output.write('\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l');
  }

  /** Turns the mouse wheel's scrolling on or off; off, the terminal selects text with the mouse again. */
  setMouse(on) {
    this.mouse = on;
    if (this.on) this.output.write(on ? '\x1b[?1000h\x1b[?1006h' : '\x1b[?1000l\x1b[?1006l');
  }

  /** Draws everything again on the next frame, after a resize. */
  invalidate() {
    this.last = [];
    if (this.on) this.output.write('\x1b[2J');
  }

  draw(lines, cursor) {
    let out = '\x1b[?25l';
    lines.forEach((line, i) => {
      if (this.last[i] === line) return;
      // Cleared first: after a line as wide as the pane the cursor waits on its last column, where an erase after
      // it would take that column's character too.
      out += `\x1b[${i + 1};1H\x1b[0m\x1b[K${line}\x1b[0m`;
    });
    for (let i = lines.length; i < this.last.length; i++) out += `\x1b[${i + 1};1H\x1b[K`;
    this.last = lines;
    if (cursor) out += `\x1b[${cursor.row + 1};${cursor.column + 1}H\x1b[?25h`;
    this.output.write(out);
  }

  copy(text) {
    this.output.write(clipboardSequence(text, {tmux: this.tmux}));
  }
}
