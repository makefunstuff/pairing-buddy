import assert from 'node:assert/strict';
import {test} from 'node:test';
import {contextCard, contextLines, goalFromContext} from '../src/context-card.mjs';
import {describeState} from '../src/describe.mjs';
import {fold, initialState} from '../src/fold.mjs';

const ROOT = '/work/probe';
const board = {task: {id: 'probe/7', title: 'Faster hash', state: 'working', msg: 'trying fibonacci', pr: null}, working: 2, waiting: []};

function state(events) {
  return events.reduce((current, event, i) => fold(current, {at: 1000 * (i + 1), ...event}), initialState({root: ROOT}));
}

const busy = () => state([
  {kind: 'context', branch: 'work/7-faster-hash', git: {last: 'abc1234 probe: count the worst case', changed: 2, pr: ''}, board},
  {kind: 'command_end', cmd: 'make && ./probe', exit: 0, output: 'avg probe 23.7'},
  {kind: 'command_end', cmd: 'claude --settings /home/u/.herdr-projects/data/tasks/probe/8/settings.json', exit: 0, output: ''},
  {kind: 'places', buffers: [`${ROOT}/probe.c`, `${ROOT}/main.c`, '/etc/hosts', ...'abcdefg'.split('').map(name => `${ROOT}/${name}.h`)],
    jumps: [{file: `${ROOT}/main.c`, line: 12}, {file: `${ROOT}/probe.c`, line: 3}]},
  {kind: 'search', tool: 'Live Grep', query: 'hash', results: 11, file: `${ROOT}/probe.c`, line: 3},
]);

test('the card shows each source\'s rows, what a budget cut, and the board\'s launches as not sent', () => {
  const card = contextCard(busy(), 10_000);
  assert.deepEqual(card.map(section => section.source), ['board', 'git', 'terminal', 'editor']);
  const [boardSection, git, terminal, editor] = card;
  assert.deepEqual(boardSection.rows.map(row => row.text), ['probe/7 · Faster hash', 'working · trying fibonacci', '2 other tasks working; none needs you']);
  assert.deepEqual(git.rows.map(row => `${row.label} ${row.text}`), ['branch work/7-faster-hash', 'last abc1234 probe: count the worst case', 'tree 2 changed', 'PR none yet']);
  assert.deepEqual(terminal.rows.map(row => row.text), ['`make && ./probe` ok, 8 s ago'], 'the launch is not one of your commands');
  assert.deepEqual(terminal.notSent, [{label: 'not sent', text: '1 agent launch from the board, not yours'}]);
  const buffers = editor.rows.find(row => row.label === 'buffers');
  assert.equal(buffers.text, 'probe.c  main.c  a.h  b.h  c.h  d.h', 'project files, relative, as many as the budget allows');
  assert.equal(buffers.cut, 3);
  assert.equal(editor.rows.find(row => row.label === 'jumps').text, 'main.c:12  ←  probe.c:3');
  assert.equal(editor.rows.find(row => row.label === 'searched').text, 'Live Grep "hash" · 11 results · opened probe.c:3');
});

test('what the Partner gets is what the card shows, and a hidden source goes nowhere', () => {
  const now = busy();
  const described = describeState(now, 10_000);
  assert.match(described, /^Board: task probe\/7 · Faster hash; state working · trying fibonacci; others 2 other tasks working; none needs you$/m);
  assert.match(described, /^Git: branch work\/7-faster-hash; last abc1234 probe: count the worst case; tree 2 changed; PR none yet$/m);
  assert.match(described, /^Editor: buffers probe\.c {2}main\.c.*; jumps main\.c:12 {2}← {2}probe\.c:3; searched Live Grep "hash"/m);
  assert.match(described, /Recent commands:\n- `make && \.\/probe` ok/);
  assert.doesNotMatch(described, /herdr-projects/, 'the board\'s launch is not sent');

  const hidden = fold(fold(now, {kind: 'hide', source: 'git', hidden: true}), {kind: 'hide', source: 'terminal', hidden: true});
  assert.doesNotMatch(describeState(hidden, 10_000), /Git:|Recent commands/);
  assert.deepEqual(contextCard(hidden, 10_000).filter(section => section.hidden).map(section => section.source), ['git', 'terminal'], 'the card still shows them, hidden');
  assert.equal(contextLines(fold(hidden, {kind: 'hide', source: 'git', hidden: false})).length, 3, 'x again brings it back');
});

test('a session takes its goal from the board task, else the branch name; on main it asks', () => {
  assert.deepEqual(goalFromContext(busy()), {text: 'Faster hash', from: 'the board task probe/7'});
  assert.deepEqual(goalFromContext({branch: 'work/25-context-card-and-no-ceremony', board: {task: null}}), {text: 'context card and no ceremony', from: 'the branch work/25-context-card-and-no-ceremony'});
  assert.equal(goalFromContext({branch: 'main', board: null}), null);
  assert.equal(goalFromContext({branch: null, board: null}), null);
});

test('without a board there is no board source', () => {
  assert.deepEqual(contextCard(initialState({root: ROOT}), 0).map(section => section.source), ['git', 'terminal', 'editor']);
});
