import assert from 'node:assert/strict';
import {chmodSync, mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {AgentRelay, agentListLines, newsLine, SETTLED_LINE_MS} from '../src/agent-relay.mjs';
import {AgentBoard, agentItems, agentNews, agentStatus, boardDir, taskStatus} from '../src/agents.mjs';
import {parseConfig} from '../src/config.mjs';
import {fakeHerdr} from './fake-herdr.mjs';
import {scratch} from './temp.mjs';

const task = (n, state, stage, more = {}) => ({id: `shop/${n}`, title: `Task ${n}`, state, stage, msg: '', ...more});

test('a board task\'s state says what it means for you', () => {
  assert.equal(taskStatus(task(1, 'blocked', 'asks')), 'needs');
  assert.equal(taskStatus(task(1, 'working', 'reviewneeds')), 'needs', 'the reviewer shows a dialog');
  assert.equal(taskStatus(task(1, 'blocked', 'approval')), 'approve');
  assert.equal(taskStatus(task(1, 'error', 'failed')), 'failed');
  assert.equal(taskStatus(task(1, 'done', 'done')), 'done');
  assert.equal(taskStatus(task(1, 'working', 'reviewing')), 'working');
  assert.equal(taskStatus(task(1, 'working', 'after')), 'waiting');
  assert.equal(taskStatus(task(1, 'idle', 'stopped')), 'waiting');
  assert.equal(agentStatus({agent_status: 'blocked'}), 'needs');
  assert.equal(agentStatus({agent_status: 'working'}), 'working');
  assert.equal(agentStatus({agent_status: 'idle'}), 'done');
});

test('one list: the board\'s tasks with their panes, then the herdr agents that belong to no task', () => {
  const items = agentItems({
    tasks: [task(1, 'working', 'working'), task(2, 'done', 'done', {archivedAt: 1})],
    files: {'shop/1': {worktree: '/wt/1', link: {pane: 'w2:p1'}}},
    agents: [
      {pane_id: 'w2:p1', cwd: '/wt/1', agent: 'claude', agent_status: 'working'}, // the task's agent
      {pane_id: 'w2:p2', cwd: '/wt/1', agent: 'claude', agent_status: 'idle'}, // its reviewer
      {pane_id: 'w3:p1', cwd: '/home/me/notes', agent: 'pi', agent_status: 'blocked', terminal_title_stripped: 'Allow edit?'},
    ],
  });
  assert.deepEqual(items.map(item => [item.key, item.status, item.pane]), [
    ['task:shop/1', 'working', 'w2:p1'],
    ['agent:w3:p1', 'needs', 'w3:p1'],
  ], 'the archived task and the task\'s own agents are left out');
  assert.equal(items[1].title, 'pi in notes');
  assert.equal(agentItems({tasks: [task(1, 'working', 'working')], files: {'shop/1': {link: {pane: 'w9:p9'}}}})[0].pane, null,
    'a pane herdr no longer has is not one to go to');
});

test('news is a change into needs you, approve, failed or done; leaving one takes its line back', () => {
  const before = agentItems({tasks: [task(1, 'working', 'working'), task(2, 'blocked', 'asks'), task(3, 'working', 'working')]});
  const after = agentItems({tasks: [task(1, 'blocked', 'approval'), task(2, 'working', 'working'), task(3, 'working', 'working'), task(4, 'done', 'done')]});
  const {news, gone} = agentNews(before, after);
  assert.deepEqual(news.map(item => item.key), ['task:shop/1'], 'a task new to the list is no news: it may be an old one');
  assert.deepEqual(gone, ['task:shop/2'], 'its question was answered');
});


const item = (n, status, more = {}) => ({key: `task:shop/${n}`, kind: 'task', id: `shop/${n}`, title: `Task ${n}`, status, note: '', pane: `w${n}:p1`, where: `/wt/${n}`, ...more});

test('the relay waits for your next breakpoint and shows one line, the most urgent first', () => {
  let now = 100_000;
  let breakpoint = 90_000; // a save before the news came
  let typing = false;
  const sent = [];
  const pair = new AgentRelay({root: '/src/shop', send: message => sent.push(message), breakpoint: () => breakpoint, wait: () => typing, now: () => now});
  pair.hear({news: [item(4, 'done'), item(2, 'needs', {note: 'Should the old file go?'}), item(3, 'approve')], gone: []});
  pair.tick();
  assert.deepEqual(sent, [], 'no breakpoint since the news came');
  now = 102_000;
  breakpoint = 101_000;
  typing = true;
  pair.tick();
  assert.deepEqual(sent, [], 'you saved, but type again');
  typing = false;
  pair.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, '#2 needs you: Should the old file go?');
  assert.equal(sent[0].more, 2);
  pair.tick();
  assert.equal(sent.length, 1, 'the others wait in the list, not on a second line');
});

test('the relay skips this session\'s own task, waits while Pair is busy, and takes back a line that is no longer true', () => {
  let busy = true;
  const sent = [];
  const pair = new AgentRelay({root: '/wt/1', send: message => sent.push(message), breakpoint: () => 200_000, wait: () => busy, now: () => 200_000});
  pair.hear({news: [item(1, 'needs'), item(2, 'approve')], gone: []});
  pair.tick();
  assert.deepEqual(sent, [], 'Pair is answering');
  busy = false;
  pair.tick();
  assert.equal(sent[0].item.key, 'task:shop/2', 'not the task this session is in');
  pair.hear({news: [], gone: ['task:shop/2']});
  assert.deepEqual(sent[1], {type: 'agents', item: null});
  assert.equal(pair.last, null);
});

test('the line names a task of this repo by number, another repo\'s by id, and an agent by its name', () => {
  assert.equal(newsLine(item(19, 'approve', {title: 'Single model'}), 'shop'), '#19 ready to approve: Single model');
  assert.equal(newsLine(item(3, 'done', {id: 'notes/3', title: 'Tidy'}), 'shop'), 'notes/3 done: Tidy');
  assert.equal(newsLine({kind: 'agent', title: 'pi in notes', status: 'done', note: 'π notes'}, 'shop'), 'pi in notes finished');
  const lines = agentListLines({items: [{...item(2, 'needs', {note: 'Need a login'}), name: '#2'}, {kind: 'agent', status: 'done', name: 'pi in notes', title: 'pi in notes', note: 'π notes'}]});
  assert.match(lines[0], /needs you  #2 {11}Task 2 .*· Need a login/);
  assert.match(lines[1], /idle {7}pi in notes {2}π notes/);
});

test('agents in the config: on by default, false turns it off; the board is the config\'s board', () => {
  const models = {watcher: {api: 'anthropic', model: 'w'}, partner: {api: 'anthropic', model: 'p'}};
  assert.equal(parseConfig({models}).agents, true);
  assert.equal(parseConfig({models, agents: false}).agents, false);
  assert.throws(() => parseConfig({models, agents: {board: null}}), /agents must be true or false/);
  assert.equal(boardDir({HERDR_PROJECTS_HOME: '/b'}), '/b/data');
  assert.equal(boardDir({HERDR_PROJECTS_DATA_DIR: '/d', HERDR_PROJECTS_HOME: '/b'}), '/d');
});

test('the board is read through its command and task files, herdr through agent.list; focus goes to the pane', async () => {
  const dir = scratch('pair-board-');
  const tasks = join(dir, 'list.json');
  const board = join(dir, 'board');
  writeFileSync(board, `#!/bin/sh\n[ "$1 $2" = "list --json" ] && cat '${tasks}'\n`);
  chmodSync(board, 0o755);
  mkdirSync(join(dir, 'tasks', 'shop', '7'), {recursive: true});
  writeFileSync(join(dir, 'tasks', 'shop', '7', 'task.json'), JSON.stringify({worktree: '/wt/7', link: {pane: 'w7:p1'}}));
  mkdirSync(join(dir, 'tasks', 'shop', '6'), {recursive: true});
  writeFileSync(join(dir, 'tasks', 'shop', '6', 'task.json'), JSON.stringify({worktree: '/wt/6', link: {pane: 'w6:p1'}}));
  const herdr = await fakeHerdr(join(dir, 'herdr.sock'), {agents: [
    {pane_id: 'w7:p1', cwd: '/wt/7', agent: 'claude', agent_status: 'working'},
    {pane_id: 'w6:p1', cwd: '/wt/6', agent: 'claude', agent_status: 'idle'}, // the agent of a finished task, still open
  ]});
  const changes = [];
  const logged = [];
  const agents = new AgentBoard({board, dir, onChange: change => changes.push(change), log: line => logged.push(line), pollMs: 60_000});
  try {
    writeFileSync(tasks, JSON.stringify([task(7, 'working', 'working'), task(6, 'done', 'done')]));
    agents.useHerdr(join(dir, 'herdr.sock'));
    await agents.poll();
    assert.deepEqual(agents.items.map(item => item.key), ['task:shop/7', 'task:shop/6'], 'a finished task\'s agent shows as the task');
    assert.deepEqual(agents.list().map(item => item.key), ['task:shop/7'], 'a task finished before you looked is not listed');
    writeFileSync(tasks, JSON.stringify([task(7, 'blocked', 'approval'), task(6, 'done', 'done')]));
    await agents.poll();
    assert.deepEqual(changes.map(change => change.news.map(news => [news.key, news.status, news.pane])), [[['task:shop/7', 'approve', 'w7:p1']]]);
    await agents.focus('task:shop/7');
    assert.deepEqual(herdr.focused, ['w7:p1']);

    writeFileSync(tasks, 'not json');
    await agents.poll();
    await agents.poll();
    assert.equal(changes.length, 1, 'a board that fails changes nothing');
    assert.equal(logged.filter(line => line.startsWith('agents: board:')).length, 1, 'and is logged once');
  } finally {
    await herdr.close();
  }
});

test('without a board, herdr\'s agents are still read and relayed; a board that comes and goes keeps its last list', async () => {
  const dir = scratch('pair-board-');
  const herdr = await fakeHerdr(join(dir, 'herdr.sock'), {agents: [{pane_id: 'w2:p1', cwd: '/home/me/notes', agent: 'pi', agent_status: 'working'}]});
  const changes = [];
  const logged = [];
  const agents = new AgentBoard({board: join(dir, 'no-such-board'), dir, onChange: change => changes.push(change), log: line => logged.push(line)});
  try {
    agents.useHerdr(join(dir, 'herdr.sock'));
    await agents.poll();
    herdr.agents[0].agent_status = 'idle';
    await agents.poll();
    assert.deepEqual(agents.list().map(item => [item.key, item.status]), [['agent:w2:p1', 'done']]);
    assert.deepEqual(changes.map(change => change.news.map(item => item.key)), [['agent:w2:p1']]);
    assert.equal(logged.filter(line => line.startsWith('agents: board:')).length, 1, 'the missing board is logged once');
  } finally {
    await herdr.close();
  }
});

test('while no session listens there is no baseline: what changed meanwhile is no news for the next session', async () => {
  const dir = scratch('pair-board-');
  const herdr = await fakeHerdr(join(dir, 'herdr.sock'), {agents: [{pane_id: 'w2:p1', cwd: '/n', agent: 'pi', agent_status: 'working'}]});
  let wanted = true;
  const changes = [];
  const agents = new AgentBoard({board: null, dir, wanted: () => wanted, onChange: change => changes.push(change)});
  try {
    agents.useHerdr(join(dir, 'herdr.sock'));
    await agents.poll();
    wanted = false; // the last session ended
    await agents.poll();
    herdr.agents[0].agent_status = 'idle';
    await agents.poll();
    wanted = true; // a new session, hours later
    await agents.poll();
    await agents.poll();
    assert.deepEqual(changes, []);
  } finally {
    await herdr.close();
  }
});

test('a line that asks nothing of you goes by itself after a while; one that needs you stays', () => {
  let now = 100_000;
  const sent = [];
  const pair = new AgentRelay({root: '/src/shop', send: message => sent.push(message), breakpoint: () => now, now: () => now});
  pair.hear({news: [item(22, 'done', {pane: null})], gone: []});
  pair.tick();
  assert.equal(pair.shown.key, 'task:shop/22');
  now += SETTLED_LINE_MS;
  pair.tick();
  assert.equal(pair.shown, null, 'old news, with no pane to go to');
  assert.deepEqual(sent.at(-1), {type: 'agents', item: null});
  pair.hear({news: [item(21, 'needs')], gone: []});
  pair.tick();
  now += 10 * SETTLED_LINE_MS;
  pair.tick();
  assert.equal(pair.shown.key, 'task:shop/21', 'still waiting for you');
});

test('finished work whose merge failed or whose sync is blocked needs you, not your approval', () => {
  assert.equal(taskStatus(task(1, 'blocked', 'approval'), {failure: {stage: 'merge'}}), 'needs');
  assert.equal(taskStatus(task(1, 'blocked', 'approval'), {syncBlocked: true}), 'needs');
  assert.equal(taskStatus(task(1, 'blocked', 'approval'), {failure: null}), 'approve');
});
