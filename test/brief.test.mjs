// The /gen brief (see brief.mjs): what it is made of, and how the model's answers about it are kept only when they
// hold up: a quote that is a real line of the brief, a place that is a real line of the code proposed.
import assert from 'node:assert/strict';
import {mkdirSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {briefEmpty, briefLine, briefText, exceptionKey, findQuote, parseCheck, parseConflict, readBrief} from '../src/brief.mjs';
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
