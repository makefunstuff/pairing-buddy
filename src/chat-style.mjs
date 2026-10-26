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
 * as you typed it.
 */
export function formatMessage(sender, text, {accent = null, width = 0, color = true} = {}) {
  const paint = (ink, words) => (color ? `${ink}${words}${RESET}` : words);
  const ink = accent ? trueColor(accent) : CYAN;
  const name = NAMES[sender] ?? sender;
  const head = paint(sender === 'pair' ? ink : DIM, name);
  if (sender === 'user') return `${head} ${text}`;
  const indent = ' '.repeat(name.length + 1);
  const lines = wrap(text, width > indent.length + 20 ? width - indent.length : Infinity);
  // Code shows in the accent, without its backticks; without colours the backticks stay, to mark it.
  const code = word => (color ? paint(ink, word) : `\`${word}\``);
  const body = lines.map(line => line.map(token => token.space + (token.code ? code(token.text) : token.text)).join(''));
  return `${head} ${body.join(`\n${indent}`)}`;
}

/** Dim text, such as the keys that rate a remark. */
export const dim = (text, {color = true} = {}) => (color ? `${DIM}${text}${RESET}` : text);
