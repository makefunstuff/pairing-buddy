import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {codeFor, codeNames, jsonList, noteInput, parseMarks, parseTasks} from '../src/note-reading.mjs';

const NOTE = readFileSync(new URL('../docs/captures/notes/dead-letters.md', import.meta.url), 'utf8');
const exists = async file => file === 'internal/delivery/worker.go';

test('the names a note gives code: in backticks, and camel or snake words outside them; not inside a code block', () => {
  assert.deepEqual(codeNames(NOTE), ['Deliver', 'ErrBudget', 'dead_letters']);
  assert.deepEqual(codeNames('Set `cfg.MaxAttempts` and ring_buffer_push.\n\n```c\nint hidden_name;\n```\nSee `Arena::alloc` and `make all`.'),
    ['MaxAttempts', 'alloc', 'ring_buffer_push']);
});

test('the code a note names is found where it is defined, in C as in Go, and shown with line numbers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pair-note-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'ring.c'), '#include "ring.h"\n\nstatic int used;\n\nint ring_push(struct ring *r, int v) {\n  return used++;\n}\n');
  writeFileSync(join(root, 'src', 'main.c'), 'int main(void) { return ring_push(0, 1); }\n');
  writeFileSync(join(root, 'notes.md'), 'ring_push is called by `main`.\n');
  execFileSync('git', ['init', '-q'], {cwd: root});
  execFileSync('git', ['add', '-A'], {cwd: root});
  const [ring, main] = await codeFor(root, 'Does `ring_push` grow? And `main`? And `nowhere`?');
  assert.equal(ring.file, 'src/ring.c');
  assert.equal(ring.line, 5);
  assert.match(ring.text, /^src\/ring\.c:3: static int used;\n/);
  assert.equal(main.file, 'src/main.c');
  assert.deepEqual(await codeFor(mkdtempSync(join(tmpdir(), 'pair-nogit-')), 'about `x_y`'), []);
});

test('the model reads the note numbered, with the code it names', () => {
  const input = noteInput('docs/dead-letters.md', NOTE, [{text: 'internal/delivery/worker.go:24: func Deliver(cfg Config, send func() error) (int, error) {'}], 'dead letters');
  assert.match(input, /^Note: docs\/dead-letters\.md \("Dead letters"\)\nThe session's goal: dead letters\n\n1: # Dead letters\n/);
  assert.match(input, /\n14: Keep at most 5 attempts/);
  assert.match(input, /Code the note names:\ninternal\/delivery\/worker\.go:24: func Deliver/);
});

test('only marks that hold up are kept: a known kind on a written line, five at most, one per line', async () => {
  const answer = `Here they are:\n\`\`\`json\n${JSON.stringify([
    {kind: 'contradiction', line: 14, text: 'Line 14 says 5 attempts, line 20 says 6.', other_line: 20},
    {kind: 'code', line: 4, text: 'Deliver returns ErrBudget at worker.go:36.', file: 'internal/delivery/worker.go', file_line: 36},
    {kind: 'code', line: 3, text: 'A made-up place.', file: 'nowhere.go', file_line: 1},
    {kind: 'question', line: 1, text: 'A heading?'},
    {kind: 'praise', line: 8, text: 'Nice.'},
    {kind: 'question', line: 99, text: 'Past the end?'},
    {kind: 'question', line: 14, text: 'Same line again?'},
    {kind: 'question', line: 17, text: 'Does the cap apply again?'},
    {kind: 'question', line: 20, text: 'Six attempts inside 15 s?'},
    {kind: 'question', line: 25, text: 'One too many?'},
  ])}\n\`\`\``;
  const marks = await parseMarks(answer, NOTE, exists);
  assert.deepEqual(marks.map(mark => [mark.kind, mark.line]), [['contradiction', 14], ['code', 4], ['code', 3], ['question', 17], ['question', 20]]);
  assert.equal(marks[0].other, 20);
  assert.deepEqual([marks[1].file, marks[1].fileLine], ['internal/delivery/worker.go', 36]);
  assert.equal(marks[2].file, undefined); // the mark stays, without a link to a file that is not there
  assert.deepEqual(await parseMarks('I have nothing to add.', NOTE, exists), []);
});

test('tasks: titles of at most 60 characters, cut at a word, with the lines they come from', () => {
  const tasks = parseTasks(JSON.stringify([
    {title: 'Park failed webhooks in dead_letters after the last attempt', lines: 'lines 3-4, line 8'},
    {title: 'Decide how long dead letters are kept', lines: 'line 25', open: true},
    {title: ''},
    {title: 'x'.repeat(80)},
  ]));
  assert.deepEqual(tasks.map(task => [task.title, task.open]), [
    ['Park failed webhooks in dead_letters after the last attempt', false],
    ['Decide how long dead letters are kept', true],
    [`${'x'.repeat(59)}…`, false],
  ]);
  assert.equal(parseTasks('[{"title": "Allow operators to view and replay dead letters on the admin page"}]')[0].title, 'Allow operators to view and replay dead letters on the…');
  assert.deepEqual(jsonList('[{"a": 1}, 2, null'), []);
});
