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
