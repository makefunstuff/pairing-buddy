// What you type in the full-screen chat pane, and the keys the terminal sends for it.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {LineEditor} from '../src/chat-input.mjs';
import {clipboardSequence, KeyDecoder, Screen} from '../src/chat-screen.mjs';
import {openHistory} from '../src/chat-history.mjs';
import {join} from 'node:path';
import {scratch} from './temp.mjs';

const typed = (editor, text) => {
  editor.insert(text);
  return editor;
};

test('the editor moves and deletes as a shell does, by letters, words and lines', () => {
  const editor = typed(new LineEditor(), 'why does attempt 5 fail');
  editor.wordLeft();
  assert.equal(editor.cursor, 'why does attempt 5 '.length);
  editor.deleteWordBack();
  assert.equal(editor.text, 'why does attempt fail');
  editor.home();
  editor.right();
  editor.backspace();
  assert.equal(editor.text, 'hy does attempt fail');
  editor.end();
  editor.killToStart();
  assert.equal(editor.text, '');
  typed(editor, 'a ✓ b');
  editor.left();
  editor.left();
  editor.backspace();
  assert.equal(editor.text, 'a  b', 'one character at a time, also a wide one');
  editor.home();
  editor.killToEnd();
  assert.equal(editor.text, '');
});

test('several lines: Up and Down move between them, then through what was sent, and back to your draft', () => {
  const editor = new LineEditor({history: ['first question', 'second question']});
  typed(editor, 'line one\nline two');
  editor.up();
  assert.equal(editor.text, 'line one\nline two', 'from the second line, Up goes to the first');
  assert.equal(editor.cursor, 'line two'.length);
  editor.up();
  assert.equal(editor.text, 'second question', 'from the first line, Up goes to the history');
  editor.up();
  assert.equal(editor.text, 'first question');
  editor.up();
  assert.equal(editor.text, 'first question', 'the oldest stays');
  editor.down();
  editor.down();
  assert.equal(editor.text, 'line one\nline two', 'the draft comes back');
  assert.equal(editor.take(), 'line one\nline two');
  assert.deepEqual(editor.history.at(-1), 'line one\nline two');
  assert.equal(editor.text, '');
});

test('the layout wraps what you type into rows and knows where the cursor is', () => {
  const editor = typed(new LineEditor(), 'abcdefgh\nij');
  assert.deepEqual(editor.layout(5), {rows: ['abcde', 'fgh', 'ij'], row: 2, column: 2});
  editor.set('abcde');
  assert.deepEqual(editor.layout(5), {rows: ['abcde', ''], row: 1, column: 0}, 'a full row: the cursor goes on the next');
  editor.set('ab', 1);
  assert.deepEqual(editor.layout(5), {rows: ['ab'], row: 0, column: 1});
});

test('the word under the cursor is what Tab completes, and its replacement keeps the rest', () => {
  const editor = typed(new LineEditor(), 'look at @que please');
  editor.cursor = 'look at @que'.length;
  assert.deepEqual(editor.word(), {start: 8, end: 12, text: '@que'});
  editor.replaceWord('@internal/queue/queue.go ');
  assert.equal(editor.text, 'look at @internal/queue/queue.go  please');
});

test('the keys: letters, Ctrl and Alt, arrows with their modifiers, Enter with Shift or Alt, pastes and the wheel', () => {
  const keys = new KeyDecoder();
  const names = data => keys.feed(data).map(k => k.paste !== undefined ? `paste:${k.paste}` : k.mouse ?? `${k.ctrl ? 'C-' : ''}${k.meta ? 'M-' : ''}${k.shift ? 'S-' : ''}${k.name}`);
  assert.deepEqual(names('hi\r'), ['h', 'i', 'enter']);
  assert.deepEqual(names('\x01\x05\x17\x15\n\x7f\t'), ['C-a', 'C-e', 'C-w', 'C-u', 'C-j', 'backspace', 'tab']);
  assert.deepEqual(names('\x1b[A\x1b[B\x1b[1;3A\x1b[1;5D\x1b[5~\x1b[6~\x1b[3~\x1bOH\x1b[F'), ['up', 'down', 'M-up', 'C-left', 'pageup', 'pagedown', 'delete', 'home', 'end']);
  assert.deepEqual(names('\x1b\r\x1b[13;2u\x1b[27;2;13~\x1bb\x1b\x7f'), ['M-enter', 'S-enter', 'S-enter', 'M-b', 'M-backspace']);
  assert.deepEqual(names('\x1b'), ['escape'], 'Esc alone');
  assert.deepEqual(names('\x1b[200~two\r\nlines'), [], 'a paste waits for its end');
  assert.deepEqual(names(' here\x1b[201~x'), ['paste:two\nlines here', 'x']);
  assert.deepEqual(names('\x1b[<64;10;5M\x1b[<65;10;5M\x1b[<0;3;7M\x1b[<0;3;7m'), ['wheelup', 'wheeldown', 'press']);
  assert.deepEqual(names('\x1b[1;'), [], 'half a sequence waits');
  assert.deepEqual(names('3B'), ['M-down']);
  assert.deepEqual(names('é漢'), ['é', '漢']);
});

test('copying goes through OSC 52, wrapped for tmux inside tmux', () => {
  assert.equal(clipboardSequence('hi'), '\x1b]52;c;aGk=\x07');
  assert.equal(clipboardSequence('hi', {tmux: true}), '\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\');
});

test('the history of what you sent is kept per project, the newest last, without repeats', () => {
  const file = join(scratch('pair-history-'), 'chat-history.json');
  const history = openHistory(file, {max: 3});
  for (const line of ['a', 'b', 'a', 'c', 'd']) history.add('/p', line);
  history.add('/q', 'other');
  assert.deepEqual(openHistory(file).of('/p'), ['a', 'c', 'd']);
  assert.deepEqual(openHistory(file).of('/q'), ['other']);
  assert.deepEqual(openHistory(join(file, 'nowhere')).of('/p'), [], 'none to read: empty');
});

test('the screen clears a line before it writes it, so a line as wide as the pane keeps its last column', () => {
  let out = '';
  const screen = new Screen({write: data => { out += data; }});
  screen.draw(['── rule ──', 'short'], null);
  // Erasing after a full-width line would erase the column the cursor waits on: its last character.
  assert.equal(out, '\x1b[?25l\x1b[1;1H\x1b[0m\x1b[K── rule ──\x1b[0m\x1b[2;1H\x1b[0m\x1b[Kshort\x1b[0m');
  out = '';
  screen.draw(['── rule ──', 'other'], null);
  assert.equal(out, '\x1b[?25l\x1b[2;1H\x1b[0m\x1b[Kother\x1b[0m', 'only what changed');
});
