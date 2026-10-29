import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {AgentRelay, agentListLines, newsLine, SETTLED_LINE_MS} from '../src/agent-relay.mjs';
import {AgentBoard, agentItems, agentNews, agentStatus, taskStatus} from '../src/agents.mjs';
import {parseConfig} from '../src/config.mjs';
import {fakeHerdr} from './fake-herdr.mjs';
import {fakeShepherdr} from './fake-shepherdr.mjs';
import {scratch} from './temp.mjs';

const task = (n, status, more = {}) => ({id: `SHO-${n}`, title: `Task ${n}`, status, sub: '', space: 'shop', repo: 'shop', ...more});

test('a board task\'s status says what it means for you', () => {
  assert.equal(taskStatus(task(1, 'need')), 'needs');
  assert.equal(taskStatus(task(1, 'ready')), 'ready', 'ready to merge');
  assert.equal(taskStatus(task(1, 'done')), 'done');
  assert.equal(taskStatus(task(1, 'done', {outcome: 'failed'})), 'failed');
  assert.equal(taskStatus(task(1, 'work')), 'working');
  assert.equal(taskStatus(task(1, 'merging')), 'working');
  assert.equal(taskStatus(task(1, 'queued')), 'waiting');
  assert.equal(taskStatus(task(1, 'todo')), 'waiting', 'it waits for a go');
  assert.equal(agentStatus({agent_status: 'blocked'}), 'needs');
  assert.equal(agentStatus({agent_status: 'working'}), 'working');
  assert.equal(agentStatus({agent_status: 'idle'}), 'done');
});

test('one list: the board\'s tasks with their panes, then the herdr agents that belong to no task', () => {
  const items = agentItems({
    tasks: [task(1, 'work', {where: '/wt/1', branch: 'work/1-x', pr: 'https://github.com/o/shop/pull/4'})],
    agents: [
      {pane_id: 'w2:p1', cwd: '/wt/1', agent: 'claude', agent_status: 'working'}, // the task's agent
      {pane_id: 'w2:p2', cwd: '/wt/1', agent: 'claude', agent_status: 'idle'}, // its reviewer
      {pane_id: 'w3:p1', cwd: '/home/me/notes', agent: 'pi', agent_status: 'blocked', terminal_title_stripped: 'Allow edit?'},
    ],
  });
  assert.deepEqual(items.map(item => [item.key, item.status, item.pane]), [
    ['task:SHO-1', 'working', 'w2:p1'],
    ['agent:w3:p1', 'needs', 'w3:p1'],
  ], 'the task\'s own agents are left out: their pane is the task\'s');
  assert.equal(items[0].branch, 'work/1-x');
  assert.equal(items[0].pr, 'https://github.com/o/shop/pull/4');
  assert.equal(items[1].title, 'pi in notes');
  assert.equal(agentItems({tasks: [task(1, 'work', {where: '/wt/1'})]})[0].pane, null, 'no agent in its worktree: no pane to go to');
});

test('news is a change into needs you, ready to merge, failed or done; leaving one takes its line back', () => {
  const before = agentItems({tasks: [task(1, 'work'), task(2, 'need'), task(3, 'work')]});
  const after = agentItems({tasks: [task(1, 'ready'), task(2, 'work'), task(3, 'work'), task(4, 'done')]});
  const {news, gone} = agentNews(before, after);
  assert.deepEqual(news.map(item => item.key), ['task:SHO-1'], 'a task new to the list is no news: it may be an old one');
  assert.deepEqual(gone, ['task:SHO-2'], 'its question was answered');
});

const item = (n, status, more = {}) => ({key: `task:SHO-${n}`, kind: 'task', id: `SHO-${n}`, title: `Task ${n}`, status, note: '', pane: `w${n}:p1`, where: `/wt/${n}`, space: 'shop', repo: 'shop', ...more});

test('the relay waits for your next breakpoint and shows one line, the most urgent first', () => {
  let now = 100_000;
  let breakpoint = 90_000; // a save before the news came
  let typing = false;
  const sent = [];
  const pair = new AgentRelay({root: '/src/shop', send: message => sent.push(message), breakpoint: () => breakpoint, wait: () => typing, now: () => now});
  pair.hear({news: [item(4, 'done'), item(2, 'needs', {note: 'Should the old file go?'}), item(3, 'ready')], gone: []});
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
  pair.hear({news: [item(1, 'needs'), item(2, 'ready')], gone: []});
  pair.tick();
  assert.deepEqual(sent, [], 'Pair is answering');
  busy = false;
  pair.tick();
  assert.equal(sent[0].item.key, 'task:SHO-2', 'not the task this session is in');
  pair.hear({news: [], gone: ['task:SHO-2']});
  assert.deepEqual(sent[1], {type: 'agents', item: null});
  assert.equal(pair.last, null);
});

test('the line names a task of this repo by number, another repo\'s by id, and an agent by its name', () => {
  assert.equal(newsLine(item(19, 'ready', {title: 'Single model'}), ['shop']), '#19 ready to merge: Single model');
  assert.equal(newsLine(item(19, 'ready', {title: 'Single model', space: 'shop-space'}), ['x', 'shop']), '#19 ready to merge: Single model', 'by its space\'s folder');
  assert.equal(newsLine(item(3, 'done', {id: 'NOT-3', title: 'Tidy', space: 'notes', repo: 'notes'}), ['shop']), 'NOT-3 done: Tidy');
  assert.equal(newsLine({kind: 'agent', title: 'pi in notes', status: 'done', note: 'π notes'}, 'shop'), 'pi in notes finished');
  const lines = agentListLines({items: [{...item(2, 'needs', {note: 'Need a login'}), name: '#2'}, {kind: 'agent', status: 'done', name: 'pi in notes', title: 'pi in notes', note: 'π notes'}]});
  assert.match(lines[0], /needs you  #2 {11}Task 2 .*· Need a login/);
  assert.match(lines[1], /idle {7}pi in notes {2}π notes/);
});

test('agents in the config: on by default, false turns it off; the board is the config\'s board, Shepherdr\'s', () => {
  const models = {watcher: {api: 'anthropic', model: 'w'}, partner: {api: 'anthropic', model: 'p'}};
  assert.equal(parseConfig({models}).agents, true);
  assert.equal(parseConfig({models, agents: false}).agents, false);
  assert.throws(() => parseConfig({models, agents: {board: null}}), /agents must be true or false/);
  assert.equal(parseConfig({models}).board, 'shepherdr');
  assert.equal(parseConfig({models, board: null}).board, null);
});

/** A repo with a commit on main and a task's branch in a worktree of its own: {repo, worktree}. */
function taskRepo(dir) {
  const repo = join(dir, 'shop');
  const worktree = join(dir, 'wt-7');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {stdio: 'pipe'});
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'run.go'), 'package run\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  git('worktree', 'add', '-q', '-b', 'work/7-read-every-run', worktree);
  writeFileSync(join(worktree, 'run.go'), 'package run\n\nfunc Every() {}\n');
  execFileSync('git', ['-C', worktree, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-am', 'every run'], {stdio: 'pipe'});
  return {repo, worktree};
}

test('the board is read through its command and git, herdr through agent.list; focus goes to the task\'s pane', async () => {
  const dir = realpathSync(scratch('pair-board-'));
  const {repo, worktree} = taskRepo(dir);
  const pr = {number: 12, url: 'https://github.com/o/shop/pull/12'};
  const tasks = status => [
    {id: 'SHO-7', title: 'Read every run', status, place: 'p:here:shop', branch: 'work/7-read-every-run', pr},
    {id: 'SHO-6', title: 'Old', status: 'done', place: 'p:here:shop', branch: 'work/6-old'},
  ];
  const board = fakeShepherdr(dir, {spaces: [{name: 'shop', key: 'SHO', path: repo}], tasks: tasks('work')});
  const herdr = await fakeHerdr(join(dir, 'herdr.sock'), {agents: [{pane_id: 'w7:p1', cwd: worktree, agent: 'claude', agent_status: 'working'}]});
  const changes = [];
  const logged = [];
  const agents = new AgentBoard({board: board.command, onChange: change => changes.push(change), log: line => logged.push(line), pollMs: 60_000});
  try {
    agents.useHerdr(join(dir, 'herdr.sock'));
    await agents.poll();
    assert.deepEqual(agents.items.map(item => [item.key, item.where, item.pane]), [['task:SHO-7', worktree, 'w7:p1'], ['task:SHO-6', null, null]],
      'its worktree, found by its branch, and the pane of the agent there');
    assert.deepEqual(agents.list().map(item => item.key), ['task:SHO-7'], 'a task finished before you looked is not listed');
    assert.ok(!board.calls().some(call => call.join(' ') === 'task show SHO-6 --json'), 'nor read in full');
    board.set({spaces: [{name: 'shop', key: 'SHO', path: repo}], tasks: tasks('ready')});
    await agents.poll();
    assert.deepEqual(changes.map(change => change.news.map(news => [news.key, news.status, news.pane])), [[['task:SHO-7', 'ready', 'w7:p1']]]);
    await agents.poll();
    assert.equal(board.calls().filter(call => call.join(' ') === 'task show SHO-7 --json').length, 2, 'read again only when its status changed');
    await agents.focus('task:SHO-7');
    assert.deepEqual(herdr.focused, ['w7:p1']);
    board.set({spaces: [{name: 'shop', key: 'SHO', path: repo}], tasks: tasks('done')});
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', worktree]);
    await agents.poll();
    assert.equal(agents.items[0].where, worktree, 'done, its worktree gone with the merge: still where it was, so a session there knows it is its own');
    assert.deepEqual(await agents.leftBehind('task:SHO-7', 'term'), {error: 'SHO-7 has no worktree on this machine: it is done, and it went with the merge'});

    const heard = changes.length;
    board.set({down: true});
    await agents.poll();
    await agents.poll();
    assert.equal(changes.length, heard, 'a board that fails changes nothing');
    assert.equal(logged.filter(line => line.startsWith('agents: board:')).length, 1, 'and is logged once');
  } finally {
    await herdr.close();
  }
});

test('what a task left behind: its report and pull request, its branch\'s diff against main, its worktree', async () => {
  const dir = realpathSync(scratch('pair-board-'));
  const {repo, worktree} = taskRepo(dir);
  const board = fakeShepherdr(dir, {
    spaces: [{name: 'shop', key: 'SHO', path: repo}],
    tasks: [
      {id: 'SHO-7', title: 'Read every run', status: 'ready', place: 'p:here:shop', branch: 'work/7-read-every-run', pr: {number: 12, url: 'https://github.com/o/shop/pull/12'}},
      {id: 'SHO-8', title: 'Not started', status: 'todo', place: 'p:here:shop'},
    ],
    artifacts: [{id: 'a1', title: 'Findings', chat: 'SHO-7 agent', html: '/data/a1/1.html'}],
  });
  const herdr = await fakeHerdr(join(dir, 'herdr.sock'), {agents: [{pane_id: 'w9:p1', cwd: '/home/me/notes', agent: 'pi', agent_status: 'idle'}]});
  const agents = new AgentBoard({board: board.command, pollMs: 60_000});
  try {
    agents.useHerdr(join(dir, 'herdr.sock'));
    await agents.poll();
    assert.deepEqual(await agents.leftBehind('task:SHO-7', 'open'), {links: [
      {label: 'its report', url: '/data/a1/1.html'},
      {label: 'its pull request #12', url: 'https://github.com/o/shop/pull/12'},
    ]});
    const diff = await agents.leftBehind('task:SHO-7', 'diff');
    assert.equal(diff.title, 'SHO-7 · work/7-read-every-run against main');
    assert.match(diff.diff, /^\+func Every\(\) \{\}$/m);
    assert.deepEqual(await agents.leftBehind('task:SHO-7', 'term'), {where: worktree, title: 'SHO-7'});
    assert.deepEqual(await agents.leftBehind('task:SHO-8', 'open'), {error: 'SHO-8 has no report or pull request yet'});
    assert.deepEqual(await agents.leftBehind('task:SHO-8', 'diff'), {error: 'SHO-8 has no branch yet'});
    assert.deepEqual(await agents.leftBehind('task:SHO-8', 'term'), {error: 'SHO-8 has no worktree on this machine'});
    assert.deepEqual(await agents.leftBehind('agent:w9:p1', 'term'), {where: '/home/me/notes', title: 'pi in notes'}, 'an agent of your own: its folder');
    assert.match((await agents.leftBehind('agent:w9:p1', 'open')).error, /no report or pull request/);
    assert.deepEqual(await agents.leftBehind('task:SHO-99', 'open'), {error: 'it is not on the list any more'});
    const writes = board.calls().filter(([verb, sub]) => !['space list', 'task list', 'task show', 'artifact list', 'artifact show'].includes(`${verb} ${sub}`));
    assert.deepEqual(writes, [], 'nothing but reads');
  } finally {
    await herdr.close();
  }
});

test('without a board, herdr\'s agents are still read and relayed; a board that comes and goes keeps its last list', async () => {
  const dir = scratch('pair-board-');
  const herdr = await fakeHerdr(join(dir, 'herdr.sock'), {agents: [{pane_id: 'w2:p1', cwd: '/home/me/notes', agent: 'pi', agent_status: 'working'}]});
  const changes = [];
  const logged = [];
  const agents = new AgentBoard({board: join(dir, 'no-such-board'), onChange: change => changes.push(change), log: line => logged.push(line)});
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

test('a board command that is not installed is not logged: most machines have none', async () => {
  const dir = scratch('pair-board-');
  const logged = [];
  const agents = new AgentBoard({board: 'no-such-board-command', log: line => logged.push(line)});
  await agents.poll();
  assert.deepEqual(agents.list(), []);
  assert.deepEqual(logged, []);
});

test('while no session listens there is no baseline: what changed meanwhile is no news for the next session', async () => {
  const dir = scratch('pair-board-');
  const herdr = await fakeHerdr(join(dir, 'herdr.sock'), {agents: [{pane_id: 'w2:p1', cwd: '/n', agent: 'pi', agent_status: 'working'}]});
  let wanted = true;
  const changes = [];
  const agents = new AgentBoard({board: null, wanted: () => wanted, onChange: change => changes.push(change)});
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
  assert.equal(pair.shown.key, 'task:SHO-22');
  now += SETTLED_LINE_MS;
  pair.tick();
  assert.equal(pair.shown, null, 'old news, with no pane to go to');
  assert.deepEqual(sent.at(-1), {type: 'agents', item: null});
  pair.hear({news: [item(21, 'needs')], gone: []});
  pair.tick();
  now += 10 * SETTLED_LINE_MS;
  pair.tick();
  assert.equal(pair.shown.key, 'task:SHO-21', 'still waiting for you');
});
