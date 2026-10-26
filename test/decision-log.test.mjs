import assert from 'node:assert/strict';
import {test} from 'node:test';
import {entries, logDecision, logged} from '../src/decision-log.mjs';

const first = {date: '2026-10-27', text: 'replay keeps the attempt cap', file: 'docs/dead-letters.md', line: 20, section: '## How', asked: 'Does the 5-attempt cap apply again?'};

test('the first decision starts the log: your words, where they stand and the question that led to them', () => {
  const {text, line, superseded} = logDecision('', first);
  assert.equal(text, '# Decisions\n\n## 2026-10-27 · replay keeps the attempt cap\n\n- Status: decided\n'
    + '- Where: docs/dead-letters.md:20 (## How)\n- Asked: "Does the 5-attempt cap apply again?"\n- Consequences:\n');
  assert.equal(text.split('\n')[line - 1], '## 2026-10-27 · replay keeps the attempt cap');
  assert.deepEqual(superseded, []);
});

test('a later decision about the same thing supersedes the old one, which stays', () => {
  const log = logDecision('', first).text;
  const next = logDecision(log, {...first, date: '2026-10-28', text: 'replay keeps the attempt cap and resets the budget', asked: null});
  assert.deepEqual(next.superseded, ['replay keeps the attempt cap']);
  assert.match(next.text, /## 2026-10-27 · replay keeps the attempt cap\n\n- Status: superseded by 2026-10-28 · replay keeps the attempt cap and resets the budget\n/);
  assert.match(next.text, /## 2026-10-28 · replay keeps the attempt cap and resets the budget\n\n- Status: decided\n- Where: docs\/dead-letters.md:20 \(## How\)\n- Consequences:\n$/);
  assert.equal(entries(next.text).length, 2);
});

test('a decision in another section or note supersedes nothing; one logged already is not logged again', () => {
  const log = logDecision('', first).text;
  assert.deepEqual(logDecision(log, {...first, text: 'replay keeps the attempt cap, always', section: '## Open'}).superseded, []);
  assert.deepEqual(logDecision(log, {...first, text: 'replay keeps the attempt cap, always', file: 'docs/other.md'}).superseded, []);
  assert.equal(logDecision(log, first), null);
  assert.ok(logged(log, 'docs/dead-letters.md', 'replay keeps the attempt cap'));
});

test('a log you wrote yourself keeps everything in it, and gets the entry at its end', () => {
  const mine = '# What we decided\n\nSome words of mine.\n\n\n';
  const {text, line} = logDecision(mine, first);
  assert.ok(text.startsWith('# What we decided\n\nSome words of mine.\n\n## 2026-10-27'));
  assert.equal(line, 5);
});

test('going back to a decision that was superseded logs it again, and supersedes the one in between', () => {
  const capAndReset = {...first, text: 'replay keeps the attempt cap and budget reset'};
  const capNoReset = {...first, date: '2026-10-28', text: 'replay keeps the attempt cap but no budget reset'};
  let log = logDecision('', capAndReset).text;
  log = logDecision(log, capNoReset).text;
  assert.ok(!logged(log, first.file, capAndReset.text));
  const back = logDecision(log, {...capAndReset, date: '2026-10-29'});
  assert.deepEqual(back.superseded, ['replay keeps the attempt cap but no budget reset']);
  assert.equal(entries(back.text).filter(entry => entry.decided).map(entry => entry.title).join(), 'replay keeps the attempt cap and budget reset');
  assert.equal(entries(back.text).length, 3);
});
