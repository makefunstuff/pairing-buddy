// The /gen brief (see brief.mjs): what it is made of, and how the model's answers about it are kept only when they
// hold up: a quote that is a real line of the brief, a place that is a real line of the code proposed.
import assert from 'node:assert/strict';
import {mkdirSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {
  briefEmpty, briefLine, briefSync, briefText, exceptionKey, findQuote, handoffBrief, inSync, parseCheck, parseConflict, readBrief, syncLines, syncTell,
} from '../src/brief.mjs';
import {scratch} from './temp.mjs';

const NOTES = '# Orders\n\nThe store: SQLite, one file next to the binary. No server.\nStatuses: new, paid, shipped.\n';

function project() {
  const root = realpathSync(scratch('pair-brief-'));
  writeFileSync(join(root, 'NOTES.md'), NOTES);
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'orders.md'), 'Admin is read-only for now.\n');
  return root;
}
const read = async path => (await import('node:fs/promises')).readFile(path, 'utf8');

test('the brief is the goal, the board task and one note: the pinned one, else gen.brief\'s, or none', async () => {
  const root = project();
  const task = {id: 'shop/12', title: 'Orders API', state: 'working'};
  let brief = await readBrief({root, goal: 'orders API', task, read});
  assert.deepEqual(brief.note.lines, ['# Orders', '', 'The store: SQLite, one file next to the binary. No server.', 'Statuses: new, paid, shipped.']);
  assert.equal(briefLine(brief), 'NOTES.md + goal "orders API" + board task shop/12');
  assert.equal(briefText(brief), 'The brief: the user\'s own idea in their words. Follow it; never edit it.\nGoal: orders API\nBoard task shop/12: Orders API\n'
    + 'Note NOTES.md:\n1: # Orders\n2: \n3: The store: SQLite, one file next to the binary. No server.\n4: Statuses: new, paid, shipped.');
  brief = await readBrief({root, pin: 'docs/orders.md', read});
  assert.equal(briefLine(brief), 'docs/orders.md (pinned)');
  brief = await readBrief({root, pin: false, goal: 'orders API', read});
  assert.equal(briefLine(brief), 'goal "orders API"', '/brief off: no note');
  brief = await readBrief({root, fallback: null, read});
  assert.ok(briefEmpty(brief), 'gen.brief null, no goal, no task');
  brief = await readBrief({root, pin: '../outside.md', read});
  assert.equal(brief.note, null, 'a note outside the project is none');
  // The note as the editor has it, unsaved changes and all.
  brief = await readBrief({root, read: async () => 'Unsaved: Postgres after all.'});
  assert.deepEqual(brief.note.lines, ['Unsaved: Postgres after all.']);
});

test('a quote counts only when the brief has those words; one on another line is moved there', async () => {
  const brief = await readBrief({root: project(), goal: 'orders API, one binary', read});
  assert.deepEqual(findQuote(brief, 'note', 3, 'SQLite, one file'), {source: 'note', line: 3, text: 'The store: SQLite, one file next to the binary. No server.'});
  assert.equal(findQuote(brief, 'note', 1, '"sqlite,  ONE file"').line, 3, 'case, quotes and spaces do not matter; the line is corrected');
  assert.equal(findQuote(brief, 'note', 3, 'Postgres only'), null, 'words the brief does not have');
  assert.equal(findQuote(brief, 'note', 3, 'No'), null, 'too short to be a quote');
  assert.deepEqual(findQuote(brief, 'goal', null, 'one binary'), {source: 'goal', line: null, text: 'orders API, one binary'});
  assert.equal(findQuote(brief, 'task', null, 'orders'), null, 'no board task');
});

test('the conflict before generating: one, quoting the brief, with both sides, unless the user chose the request over that line', async () => {
  const brief = await readBrief({root: project(), read});
  const answer = 'Here: [{"source": "note", "line": 3, "quote": "SQLite, one file next to the binary", "brief_says": "SQLite", "asked": "Postgres"}]';
  const conflict = parseConflict(answer, brief);
  assert.deepEqual(conflict, {source: 'note', line: 3, text: 'The store: SQLite, one file next to the binary. No server.', says: 'SQLite', asked: 'Postgres'});
  assert.equal(parseConflict('[]', brief), null);
  assert.equal(parseConflict('no idea', brief), null);
  assert.equal(parseConflict('[{"source": "note", "line": 3, "quote": "Postgres is fine", "brief_says": "SQLite", "asked": "Postgres"}]', brief), null, 'an invented quote');
  assert.equal(parseConflict('[{"source": "note", "line": 3, "quote": "SQLite, one file", "asked": "Postgres"}]', brief), null, 'one side missing');
  assert.equal(parseConflict(answer, brief, new Set([exceptionKey(conflict)])), null, 'the user went against that line already');
});

test('the check after: at most three ≠ brief at real lines of the code, and three ? guessed', async () => {
  const brief = await readBrief({root: project(), read});
  const pieces = [{file: '/p/db.go', line: 10, insert: true, text: 'a\nb\nc'}, {file: '/p/db.go', line: 20, insert: false, text: 'x\ny'}];
  const item = (extra) => JSON.stringify({kind: 'contradicts', source: 'note', line: 4, quote: 'new, paid, shipped', piece: 1, piece_line: 2, text: 'adds cancelled', ...extra});
  const answer = `[${[
    item(),
    item({quote: 'Statuses: new'}), // the same line again
    item({quote: 'SQLite', line: 3, piece: 2, piece_line: 1, text: 'opens a Postgres pool'}),
    item({quote: 'made up words'}),
    item({quote: 'No server', piece: 3}),
    item({quote: 'No server', piece_line: 9}),
    item({quote: 'No server', text: ''}),
    '{"kind": "guessed", "text": "the default status is new."}',
    '{"kind": "guessed", "text": "The default status is new"}',
    '{"kind": "guessed", "text": "rows sorted newest first"}',
    '{"kind": "guessed", "text": "cursor paging"}',
    '{"kind": "guessed", "text": "one more"}',
    '{"kind": "guessed", "text": ""}',
  ].join(',')}]`;
  const {contradicts, guessed} = parseCheck(answer, brief, pieces);
  assert.deepEqual(contradicts.map(({line, piece, pieceLine, fileLine, why}) => ({line, piece, pieceLine, fileLine, why})), [
    {line: 4, piece: 0, pieceLine: 2, fileLine: 12, why: 'adds cancelled'}, // inserted under line 10: its second line is 12
    {line: 3, piece: 1, pieceLine: 1, fileLine: 20, why: 'opens a Postgres pool'}, // over line 20: its first line is 20
  ]);
  assert.deepEqual(guessed, ['the default status is new', 'rows sorted newest first', 'cursor paging']);
  const asAsked = findQuote(brief, 'note', 3, 'SQLite');
  assert.equal(parseCheck(answer, brief, pieces, new Set([exceptionKey(asAsked)])).contradicts.length, 1, 'the line the user went against is no news');
});

test('on a task\'s branch, its brief on the board is part of the brief: the model reads it, a quote may come from it', async () => {
  const root = project();
  const task = {id: 'SHO-74', title: 'Orders API', brief: 'Build the orders API.\nUse cents for money.'};
  const brief = await readBrief({root, task, read});
  assert.equal(briefLine(brief), 'NOTES.md + board task SHO-74 with its brief');
  assert.match(briefText(brief), /Board task SHO-74: Orders API\nIts brief on the board:\nBuild the orders API\.\nUse cents for money\.\nNote NOTES\.md:/);
  assert.deepEqual(findQuote(brief, 'task', null, 'cents for money'), {source: 'task', line: null, text: 'Use cents for money.'});
  assert.equal((await readBrief({root, task: {...task, brief: '  '}, read})).task.brief, null, 'an empty brief is none');
});

test('/brief sync: the note\'s lines the task\'s brief lacks, the quotes the note no longer has, the decisions since', async () => {
  const root = project();
  const old = await readBrief({root, read: async () => '# Orders\n\nThe store: SQLite, one file next to the binary. No server.\nStatuses: new, paid.\n'});
  // The task's brief as /gen board wrote it, from the note as it was then.
  const written = handoffBrief({words: 'Build the orders API.', brief: old});
  const brief = await readBrief({root, task: {id: 'SHO-74', title: 'Orders API', brief: written}, read});
  const log = '# Decisions\n\n## 2026-10-28 · Admin is read-only for now\n\n- Status: decided\n- Where: NOTES.md:4\n- Consequences:\n\n'
    + '## 2026-10-27 · Build the orders API\n\n- Status: decided\n- Where: NOTES.md:1\n- Consequences:\n\n'
    + '## 2026-10-26 · Use MySQL\n\n- Status: superseded by 2026-10-27 · SQLite\n- Where: NOTES.md:3\n- Consequences:\n';
  const sync = briefSync(brief, log, {since: '2026-10-27'});
  assert.deepEqual(sync, {
    since: '2026-10-27',
    added: [{line: 4, text: 'Statuses: new, paid, shipped.'}],
    gone: ['Statuses: new, paid.'],
    decided: [{date: '2026-10-28', title: 'Admin is read-only for now'}],
    more: 0,
  }, 'what the brief has is not said again; a superseded decision is none');
  assert.deepEqual(syncLines(brief, sync), [
    '+ Statuses: new, paid, shipped. (NOTES.md:4)',
    '- Statuses: new, paid. (no longer in NOTES.md)',
    '+ decided 2026-10-28: Admin is read-only for now',
  ]);
  const tell = syncTell(brief, sync);
  assert.match(tell, /^The brief in Pair \(NOTES\.md\) changed since your brief was written\. Take this in:\n\nIt says now:\n- Statuses: new, paid, shipped\. \(NOTES\.md:4\)\n\nIt no longer says:\n- Statuses: new, paid\.\n\nDecided since your branch left the base branch on 2026-10-27 \(decisions\.md\):\n- 2026-10-28: Admin is read-only for now$/);
  // Only decisions from the day the task's branch left the base on: one from before, its brief had to hand.
  const before = '# Decisions\n\n## 2020-01-01 · Old decision\n\n- Status: decided\n- Where: NOTES.md:4\n- Consequences:\n';
  assert.deepEqual(briefSync(brief, before, {since: '2026-10-27'}).decided, []);
  // Without that day (no git), every decision it lacks, said so: not "since".
  const undated = briefSync(brief, before);
  assert.deepEqual(syncLines(brief, undated).at(-1), '+ decided 2020-01-01, not in its brief: Old decision');
  assert.match(syncTell(brief, undated), /\n\nDecided, and not in your brief \(decisions\.md\):\n- 2020-01-01: Old decision$/);
  assert.match(syncTell(brief, sync, {waiting: true}), /\n\nThis is no go: keep waiting for mine\.$/, 'a task that waits is not given its go by it');
  assert.ok(inSync(briefSync(await readBrief({root, task: {id: 'SHO-74', title: 'x', brief: handoffBrief({words: 'x', brief})}, read}))), 'a brief written from the note now has all of it');
  assert.equal(briefSync(await readBrief({root, read})), null, 'no board task: nothing to sync with');

  // A fence, the code in it, a table's rule row and a line too short to say anything are no instructions.
  const noisy = await readBrief({root, task: {id: 'SHO-74', title: 'x', brief: 'Build it.'}, read: async () => [
    '# Orders', '', '```js', 'const a = 1', '```', '~~~', 'b = 2', '~~~', '| status | meaning |', '|---|:-:|', '| --- | --- |', 'ok', '- [ ]', '---', 'Money in cents.',
  ].join('\n')});
  assert.deepEqual(briefSync(noisy).added, [{line: 9, text: '| status | meaning |'}, {line: 15, text: 'Money in cents.'}]);
});
