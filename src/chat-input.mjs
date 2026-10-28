// What you type in the full-screen chat pane: the text, with line breaks, and the cursor in it. A small editor with
// the keys a shell has (Ctrl-A, Ctrl-E, Ctrl-W, Ctrl-U, Ctrl-K, Alt-B, Alt-F) and a history of what you sent, which
// Up and Down walk from the first and the last line. It knows nothing of the terminal: chat.mjs hands it keys.
import {charWidth} from './chat-style.mjs';

const WORD = /[\p{L}\p{N}_]/u;

/** The index of the code point before `i` in `text`. */
function before(text, i) {
  if (i <= 0) return 0;
  const code = text.charCodeAt(i - 1);
  return code >= 0xdc00 && code <= 0xdfff && i >= 2 ? i - 2 : i - 1;
}

/** The index of the code point after `i` in `text`. */
function after(text, i) {
  if (i >= text.length) return text.length;
  const code = text.charCodeAt(i);
  return code >= 0xd800 && code <= 0xdbff ? i + 2 : i + 1;
}

export class LineEditor {
  /** `history`: what was sent before, oldest first; the editor adds to it. */
  constructor({history = [], max = 200} = {}) {
    this.text = '';
    this.cursor = 0; // an index into text
    this.history = [...history];
    this.max = max;
    this.back = null; // which history entry shows, counting from the newest; null: your own draft
    this.draft = '';
  }

  set(text, cursor = text.length) {
    this.text = text;
    this.cursor = cursor;
  }

  clear() {
    this.set('');
    this.back = null;
  }

  get empty() {
    return this.text === '';
  }

  insert(chars) {
    this.text = this.text.slice(0, this.cursor) + chars + this.text.slice(this.cursor);
    this.cursor += chars.length;
  }

  backspace() {
    const from = before(this.text, this.cursor);
    this.text = this.text.slice(0, from) + this.text.slice(this.cursor);
    this.cursor = from;
  }

  delete() {
    this.text = this.text.slice(0, this.cursor) + this.text.slice(after(this.text, this.cursor));
  }

  left() {
    this.cursor = before(this.text, this.cursor);
  }

  right() {
    this.cursor = after(this.text, this.cursor);
  }

  /** The start of the line the cursor is on, and its end. */
  lineBounds(at = this.cursor) {
    const start = this.text.lastIndexOf('\n', at - 1) + 1;
    const end = this.text.indexOf('\n', at);
    return [start, end === -1 ? this.text.length : end];
  }

  home() {
    this.cursor = this.lineBounds()[0];
  }

  end() {
    this.cursor = this.lineBounds()[1];
  }

  wordLeft() {
    let i = this.cursor;
    while (i > 0 && !WORD.test(this.text[before(this.text, i)])) i = before(this.text, i);
    while (i > 0 && WORD.test(this.text[before(this.text, i)])) i = before(this.text, i);
    this.cursor = i;
  }

  wordRight() {
    let i = this.cursor;
    while (i < this.text.length && !WORD.test(this.text[i])) i = after(this.text, i);
    while (i < this.text.length && WORD.test(this.text[i])) i = after(this.text, i);
    this.cursor = i;
  }

  /** Ctrl-W, Alt-Backspace: the word before the cursor, and the spaces after it. */
  deleteWordBack() {
    const end = this.cursor;
    let i = end;
    while (i > 0 && /\s/.test(this.text[i - 1]) && this.text[i - 1] !== '\n') i -= 1;
    while (i > 0 && !/\s/.test(this.text[i - 1])) i -= 1;
    if (i === end && i > 0) i -= 1; // at a line's start: the line break
    this.text = this.text.slice(0, i) + this.text.slice(end);
    this.cursor = i;
  }

  /** Ctrl-U: from the line's start to the cursor. */
  killToStart() {
    const [start] = this.lineBounds();
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor);
    this.cursor = start;
  }

  /** Ctrl-K: from the cursor to the line's end. */
  killToEnd() {
    const [, end] = this.lineBounds();
    this.text = this.text.slice(0, this.cursor) + this.text.slice(end === this.cursor ? after(this.text, end) : end);
  }

  /** Moves the cursor a line up (`by` -1) or down (1), at the same column; false on the first or last line. */
  vertical(by) {
    const [start, end] = this.lineBounds();
    const column = this.cursor - start;
    if (by < 0) {
      if (start === 0) return false;
      const [prevStart] = this.lineBounds(start - 1);
      this.cursor = Math.min(prevStart + column, start - 1);
    } else {
      if (end === this.text.length) return false;
      const [, nextEnd] = this.lineBounds(end + 1);
      this.cursor = Math.min(end + 1 + column, nextEnd);
    }
    return true;
  }

  /** Up: a line up, else the older line sent. */
  up() {
    if (this.vertical(-1)) return;
    if (!this.history.length) return;
    if (this.back === null) {
      this.draft = this.text;
      this.back = 0;
    } else if (this.back < this.history.length - 1) {
      this.back += 1;
    } else {
      return;
    }
    this.set(this.history[this.history.length - 1 - this.back]);
  }

  /** Down: a line down, else the newer line sent, and after the newest your draft again. */
  down() {
    if (this.vertical(1)) return;
    if (this.back === null) return;
    if (this.back === 0) {
      this.back = null;
      return this.set(this.draft);
    }
    this.back -= 1;
    this.set(this.history[this.history.length - 1 - this.back]);
  }

  /** Takes the text to send: it goes into the history (not twice in a row) and the editor empties. */
  take() {
    const text = this.text;
    if (text.trim() && this.history.at(-1) !== text) {
      this.history.push(text);
      if (this.history.length > this.max) this.history.shift();
    }
    this.clear();
    return text;
  }

  /** The word the cursor is in or just after, with where it starts and ends: what Tab completes. */
  word() {
    let start = this.cursor;
    while (start > 0 && !/\s/.test(this.text[start - 1])) start -= 1;
    let end = this.cursor;
    while (end < this.text.length && !/\s/.test(this.text[end])) end += 1;
    return {start, end, text: this.text.slice(start, end)};
  }

  /** Puts `text` in place of the word the cursor is in (see word). */
  replaceWord(text) {
    const {start, end} = this.word();
    this.text = this.text.slice(0, start) + text + this.text.slice(end);
    this.cursor = start + text.length;
  }

  /**
   * The text as rows at most `width` columns wide, its own line breaks kept, and where the cursor is among them:
   * {rows, row, column}.
   */
  layout(width) {
    const rows = [''];
    let used = 0;
    let row = 0;
    let column = 0;
    const w = Math.max(1, width);
    let i = 0;
    for (const char of this.text) {
      if (i === this.cursor) [row, column] = [rows.length - 1, used];
      i += char.length;
      if (char === '\n') {
        rows.push('');
        used = 0;
        continue;
      }
      const cw = charWidth(char.codePointAt(0));
      if (used + cw > w) {
        rows.push('');
        used = 0;
      }
      rows[rows.length - 1] += char;
      used += cw;
    }
    if (this.cursor >= this.text.length) {
      if (used >= w) {
        rows.push('');
        used = 0;
      }
      [row, column] = [rows.length - 1, used];
    }
    return {rows, row, column};
  }
}
