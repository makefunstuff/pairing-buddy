// How the chat pane prints: Pair's name and the `code` in its words in Pair's accent, the same true colour as in
// Neovim once an editor has sent it, the terminal's own cyan before that. A long line wraps under the words, not
// under the name. With NO_COLOR set, or when the output is no terminal, there are no colours at all.

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const NAMES = {pair: 'pair', user: 'you', system: '··'};

/** The escape that writes in `hex` (#rrggbb). */
export function trueColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${n >> 16};${(n >> 8) & 255};${n & 255}m`;
}

/** The words of one line, each {text, code, space}: a `code` span is one word; `space` is the spaces before it. */
function tokens(line) {
  const out = [];
  for (const [, space, code, word] of line.matchAll(/(\s*)(?:`([^`]+)`|(\S+))/g)) {
    out.push({text: code ?? word, code: code !== undefined, space});
  }
  return out;
}

/** `text` as lines of tokens at most `width` wide. Its own line breaks stay, and an indented line is code: as it is. */
function wrap(text, width) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    if (/^\s/.test(paragraph)) {
      lines.push([{text: paragraph, code: false, space: ''}]);
      continue;
    }
    let line = [];
    let used = 0;
    for (const token of tokens(paragraph)) {
      if (used > 0 && used + token.space.length + token.text.length > width) {
        lines.push(line);
        line = [];
        used = 0;
      }
      const space = used > 0 ? token.space : ''; // a wrapped line starts at its word
      line.push({...token, space});
      used += space.length + token.text.length;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * One message as the pane prints it: the sender's name, then the text, wrapped to `width` columns (0: no wrap).
 * `accent` is the editor's accent (#rrggbb), or null; `color` false prints plain text. What you typed is printed
 * as you typed it, wrapped at its words like the rest.
 */
export function formatMessage(sender, text, {accent = null, width = 0, color = true} = {}) {
  const paint = (ink, words) => (color ? `${ink}${words}${RESET}` : words);
  const ink = accent ? trueColor(accent) : CYAN;
  const name = NAMES[sender] ?? sender;
  const head = paint(sender === 'pair' ? ink : DIM, name);
  const indent = ' '.repeat(name.length + 1);
  const lines = wrap(text, width > indent.length + 20 ? width - indent.length : Infinity);
  // Code shows in the accent, without its backticks; without colours the backticks stay, to mark it.
  const code = word => (color && sender !== 'user' ? paint(ink, word) : `\`${word}\``);
  const body = lines.map(line => line.map(token => token.space + (token.code ? code(token.text) : token.text)).join(''));
  return `${head} ${body.join(`\n${indent}`)}`;
}

/** Dim text, such as the keys that rate a remark. */
export const dim = (text, {color = true} = {}) => (color ? `${DIM}${text}${RESET}` : text);

// The full-screen pane (chat-render.mjs) builds its lines from segments, {text, style}, and paints them last. The
// colours are the terminal's own 16, so its theme applies, and Pair's accent; no background fills: a selected
// message has a bar in the accent, and a search match is underlined.

const SGR = {
  plain: '',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  under: '\x1b[4m',
  reverse: '\x1b[7m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

/**
 * What each style of the pane is drawn with: SGR names, or `accent` for Pair's accent (the editor's colour, cyan
 * before one is known).
 */
export const STYLES = {
  plain: [],
  text: [],
  bold: ['bold'],
  dim: ['dim'],
  accent: ['accent'],
  accentBold: ['accent', 'bold'],
  code: ['accent'],
  you: ['bold'],
  pair: ['accent', 'bold'],
  watch: ['yellow', 'bold'],
  watchMeta: ['yellow'],
  system: ['dim'],
  error: ['red'],
  errorBold: ['red', 'bold'],
  warn: ['yellow'],
  add: ['green'],
  del: ['red'],
  hunk: ['cyan'],
  rule: ['dim'],
  match: ['under', 'bold'],
  chosen: ['reverse'],
  bar: ['accent'],
  ok: ['green'],
};

/** The escape that starts `style` (see STYLES); '' for plain text or without colours. */
export function sgr(style, {accent = null, color = true} = {}) {
  if (!color) return '';
  return (STYLES[style] ?? []).map(name => (name === 'accent' ? (accent ? trueColor(accent) : SGR.cyan) : SGR[name])).join('');
}

/** How many columns a code point takes: two for the wide ones (CJK, most emoji), none for combining marks. */
export function charWidth(cp) {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

/** The columns `text` takes on screen (no escapes in it). */
export function textWidth(text) {
  let width = 0;
  for (const char of text) width += charWidth(char.codePointAt(0));
  return width;
}

/** The longest start of `text` that fits in `width` columns. */
export function fitText(text, width) {
  let used = 0;
  let out = '';
  for (const char of text) {
    const w = charWidth(char.codePointAt(0));
    if (used + w > width) break;
    used += w;
    out += char;
  }
  return out;
}

/** One line of segments: its width. */
export const lineWidth = line => line.reduce((sum, seg) => sum + textWidth(seg.text), 0);

/** `line` cut to `width` columns, with … when something was cut. */
export function clipLine(line, width) {
  if (lineWidth(line) <= width) return line;
  const out = [];
  let left = width - 1;
  for (const seg of line) {
    if (left <= 0) break;
    const text = fitText(seg.text, left);
    if (text) out.push({...seg, text});
    left -= textWidth(text);
  }
  const last = out.at(-1);
  out.push({text: '…', style: last?.style ?? 'dim'});
  return out;
}

/** A line of segments as the terminal gets it: painted, or plain without colours. */
export function paintLine(line, look = {}) {
  if (!look.color) return line.map(seg => seg.text).join('');
  return line.map(seg => {
    const start = sgr(seg.style, look);
    return start ? `${start}${seg.text}${RESET}` : seg.text;
  }).join('');
}
