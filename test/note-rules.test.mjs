import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {decisionOf, decisions, isNote, noteTitle, paragraphs, repeats} from '../src/note-rules.mjs';

const NOTE = readFileSync(new URL('../docs/captures/notes/dead-letters.md', import.meta.url), 'utf8');

test('the repeat the model missed is found by a rule: the last line says again what line 9 says', () => {
  assert.deepEqual(repeats(NOTE), [{line: 26, other: 9, text: 'Says again what line 9 says.'}]);
});

test('lines that share a few words are no repeat: a question about the dead letters is not line 14 again', () => {
  const marks = repeats(NOTE).map(mark => mark.line);
  assert.ok(!marks.includes(25));
  assert.deepEqual(repeats('# A\n\nThe worker parks a webhook after its last attempt.\n\nThe admin page lists parked webhooks.\n'), []);
});

test('a decision is no paragraph of its own and repeats nothing, even when it restates its question', () => {
  const note = NOTE.replace('We park after 6', 'Decision: replay keeps the attempt cap; it gets the budget back, not new attempts\nWe park after 5');
  assert.deepEqual(repeats(note).map(mark => mark.line), [27]);
  assert.ok(paragraphs(note).every(block => !block.text.startsWith('Decision')));
});

test('decisions: "Decision:" lines, also as list items and in bold, with their section', () => {
  assert.equal(decisionOf('- **Decision:** keep 30 days'), 'keep 30 days');
  assert.equal(decisionOf('decision: one queue'), 'one queue');
  assert.equal(decisionOf('We made a decision: none'), null);
  const note = '# T\n\n## How\n\nDecision: park after 5\n\n```\nDecision: not in code\n```\n';
  assert.deepEqual(decisions(note), [{line: 5, text: 'park after 5', section: '## How'}]);
});

test('a note is a Markdown file, and its title its first top-level heading or its name', () => {
  assert.ok(isNote('docs/x.md') && isNote('ideas/A.markdown') && !isNote('main.c'));
  assert.equal(noteTitle(NOTE, 'docs/dead-letters.md'), 'Dead letters');
  assert.equal(noteTitle('## Only a section\n', 'ideas/context-rot.md'), 'context-rot');
});

test('parallel paragraphs, each about its own thing, are no repeats; a rewording is one', () => {
  const allocators = '# Allocators\n\n## Arena\n\nThe arena allocator hands out memory from one big block and frees it all at once.\n\n'
    + '## Pool\n\nThe pool allocator hands out memory in fixed size blocks and frees each block on its own.\n';
  assert.deepEqual(repeats(allocators), []);
  const targets = '# Build\n\n- `debug`: builds the game with -O0 -g and the address sanitizer, for stepping through in gdb.\n'
    + '- `release`: builds the game with -O2 and no sanitizer, for playing and timing it.\n'
    + '- `profile`: builds the game with -O2 -pg, for timing it with gprof.\n';
  assert.deepEqual(repeats(targets), []);
  const plain = '# Build\n\n- The debug build compiles the game with -O0 -g and the address sanitizer.\n'
    + '- The release build compiles the game with -O2 and without the address sanitizer.\n';
  assert.deepEqual(repeats(plain), []);
  const options = '# Saving\n\nOption A: save the world state to one binary file on every quit.\n\n'
    + 'Option B: save the world state as text files per chunk on every quit.\n';
  assert.deepEqual(repeats(options), []);
  const ports = '# Ports\n\nOdin port: the renderer moves to Odin with raylib bindings and the same frame loop.\n\n'
    + 'Zig port: the renderer moves to Zig with raylib bindings and the same frame loop.\n';
  assert.deepEqual(repeats(ports), []);
  const reworded = '# Loop\n\nThe frame loop runs physics at a fixed 60 Hz step and renders as fast as it can.\n\n'
    + '## Later\n\nPhysics steps at a fixed 60 Hz in the frame loop, while rendering runs as fast as possible.\n';
  assert.deepEqual(repeats(reworded), [{line: 7, other: 3, text: 'Says again what line 3 says.'}]);
});

test('a repeat is still one when only one of the two paragraphs has a label', () => {
  const note = '# Replay\n\nOperators can see the failed webhooks on the admin page and replay them.\n\n'
    + '- Admin page: operators see failed webhooks there and can replay them.\n';
  assert.deepEqual(repeats(note), [{line: 5, other: 3, text: 'Says again what line 3 says.'}]);
});
