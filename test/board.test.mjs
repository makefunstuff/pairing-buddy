import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {artifactIds, Board, boardContext, boardLaunch, boardTitle, branchNumber, commandLine, madeBy, parseSpaces, spaceFor} from '../src/board.mjs';
import {projectContext} from '../src/project-context.mjs';
import {fakeShepherdr} from './fake-shepherdr.mjs';
import {scratch} from './temp.mjs';

const TASKS = [
  {id: 'BDY-20', status: 'work', title: 'Research: pleasant sessions', sub: 'Recording scenes', pr: 'https://github.com/o/pairing-buddy/pull/16'},
  {id: 'BDY-21', status: 'merging', title: 'See crashes', sub: ''},
  {id: 'BDY-22', status: 'need', title: 'Exploration loop', sub: 'Should the old file go?'},
  {id: 'BDY-23', status: 'todo', title: 'Later', sub: ''},
];

test('a branch names its task number: work/20-research, 20-fix; main names none', () => {
  assert.equal(branchNumber('work/20-research-make-ai-assisted-sess'), 20);
  assert.equal(branchNumber('20-fix'), 20);
  assert.equal(branchNumber('feature/v2'), null);
  assert.equal(branchNumber('main'), null);
  assert.equal(branchNumber('release/2.0'), null, 'a version is not a task number');
  assert.equal(branchNumber('3.x'), null);
  assert.equal(branchNumber(null), null);
});

test('the board task is the space\'s task of the branch\'s number; the others count as working or needing you', () => {
  const board = boardContext(TASKS, {space: 'pairing-buddy', branch: 'work/20-research'});
  assert.deepEqual(board.task, {id: 'BDY-20', title: 'Research: pleasant sessions', state: 'working', msg: 'Recording scenes', pr: 'https://github.com/o/pairing-buddy/pull/16'});
  assert.equal(board.space, 'pairing-buddy');
  assert.equal(board.working, 1, 'the space\'s other working tasks, merging among them');
  assert.deepEqual(board.waiting, [{id: 'BDY-22', title: 'Exploration loop'}], 'and the ones waiting for the user');
  assert.equal(boardContext(TASKS, {space: 'pairing-buddy', branch: 'main'}).task, null);
  assert.equal(boardContext(TASKS, {space: null, branch: 'work/20-x'}), null, 'a repo the board does not know has no board');
  assert.equal(boardContext(null, {space: 'pairing-buddy', branch: 'work/20-x'}), null, 'no board, no source');
});

test('a repo\'s space is the one of its checkout\'s folder, else the one named as the repo', () => {
  const spaces = parseSpaces('~  (home space)  /home/me\npairing-buddy  BDY  /src/pairing-buddy  github:o/pairing-buddy\nshop  SHO  /src/my-shop\n');
  assert.deepEqual(spaces, [
    {name: 'pairing-buddy', key: 'BDY', path: '/src/pairing-buddy', github: 'o/pairing-buddy'},
    {name: 'shop', key: 'SHO', path: '/src/my-shop', github: null},
  ], 'the home space holds no repo');
  assert.equal(spaceFor(spaces, {repos: ['x'], checkout: '/src/my-shop'}).name, 'shop');
  assert.equal(spaceFor(spaces, {repos: ['my-shop']}).name, 'shop', 'by its folder\'s name');
  assert.equal(spaceFor(spaces, {repos: ['pairing-buddy']}).name, 'pairing-buddy');
  assert.equal(spaceFor(spaces, {repos: ['other']}), null);
});

test('a task\'s report: the list names the space it is kept in, and only show says the task\'s agent made it', () => {
  // As Shepherdr 2 prints them (server/live/source.ts: artifact list, artifact show).
  const list = 'a7  v2  BDY-7 research report  · pairing-buddy · 1h\na3  v1  Plan  · pairing-buddy · 2h\n';
  assert.deepEqual(artifactIds(list), ['a7', 'a3']);
  assert.deepEqual(artifactIds('No artifacts here yet.'), []);
  const show = 'a7 “BDY-7 research report” in pairing-buddy: v2, 1h ago by BDY-7 agent. Its Send and notes go to BDY-7 agent.\n'
    + 'HTML: /home/me/.shepherdr/artifacts/a7/2.html\nData: none\nCopy them to edit; shepherdr artifact update a7 makes the new version.\n'
    + 'Versions:\n  v2  1h  BDY-7 agent  fixed the chart\n  v1  2h  BDY-7 agent';
  assert.equal(madeBy(show, 'BDY-7'), true);
  assert.equal(madeBy(show, 'BDY-70'), false, 'not another task\'s');
  assert.equal(madeBy(show.replaceAll('BDY-7 agent', 'BDY-70 agent'), 'BDY-7'), false);
  assert.equal(madeBy(show.replaceAll('BDY-7 agent', 'BDY-7 reviewer'), 'BDY-7'), true, 'its reviewer\'s too');
  assert.equal(madeBy(show.replaceAll('BDY-7 agent', 'pairing-buddy'), 'BDY-7'), false, 'the coordinator\'s is no task\'s report');
});

test('a title the board takes is one line of at most 32 characters, cut at a word', () => {
  assert.equal(boardTitle('a CSV export'), 'a CSV export');
  assert.equal(boardTitle('the whole billing module: invoices, PDF export, Stripe webhooks'), 'the whole billing module:…');
  assert.ok(boardTitle('x'.repeat(50)).length <= 32);
  assert.equal(boardTitle('two\n  lines'), 'two lines');
  assert.equal(boardTitle('--branch the CSV export'), 'branch the CSV export', 'no leading dash: it would read as a flag');
});

test('a command line is the words as a shell reads them, each quoted where it has to be', () => {
  assert.equal(commandLine(['shepherdr', 'task', 'add', 'CSV export', "--brief=it's done", '--later']), `shepherdr task add 'CSV export' --brief='it'\\''s done' --later`);
  const words = new Board('shepherdr').addWords({title: 'CSV export', brief: 'b', space: 'shop'});
  assert.deepEqual(words, ['shepherdr', 'task', 'add', 'CSV export', '--brief=b', '--space=shop', '--later'], 'add only: for later; each option one word');
  assert.deepEqual(new Board('shepherdr').addWords({title: 't', brief: 'b', later: false}), ['shepherdr', 'task', 'add', 't', '--brief=b']);
  assert.deepEqual(new Board('shepherdr').tellWords('BDY-7', 'go'), ['shepherdr', 'task', 'tell', 'BDY-7', 'go']);
});

test('the board is read through its command: spaces, tasks of a space, a task in full, its report; add for later', async () => {
  const dir = scratch('pair-board-');
  const board = fakeShepherdr(dir, {
    spaces: [{name: 'shop', key: 'SHO', path: '/src/shop'}],
    tasks: [
      {id: 'SHO-7', title: 'Read every run', status: 'ready', place: 'p:here:shop', branch: 'work/7-read', pr: {number: 12, url: 'https://github.com/o/shop/pull/12'}},
      {id: 'SHO-6', title: 'Old', status: 'done', place: 'p:here:shop', archived: 1},
      {id: 'WEB-1', title: 'Site', status: 'work', place: 'p:here:web'},
    ],
    artifacts: [
      {id: 'a2', title: 'Plan', space: 'shop', by: 'shop', html: '/data/a2/1.html'}, // the coordinator's
      {id: 'a1', title: 'Report', space: 'shop', by: 'SHO-7 agent', html: '/data/a1/1.html'},
    ],
  });
  const shepherdr = new Board(board.command);
  assert.deepEqual((await shepherdr.spaces()).map(space => space.name), ['shop']);
  assert.deepEqual((await shepherdr.tasks()).map(task => task.id), ['SHO-7', 'WEB-1'], 'not the archived one');
  assert.deepEqual((await shepherdr.tasks({space: 'shop'})).map(task => task.id), ['SHO-7']);
  assert.deepEqual(await shepherdr.show('SHO-7'), {
    id: 'SHO-7', title: 'Read every run', status: 'ready', sub: '', machine: null, space: 'shop', branch: 'work/7-read', pr: 'https://github.com/o/shop/pull/12', outcome: null,
  });
  assert.equal(await shepherdr.report('SHO-7', {space: 'shop'}), '/data/a1/1.html');
  assert.equal(await shepherdr.report('SHO-7', {space: 'web'}), null, 'kept in its own space');
  assert.equal(await shepherdr.report('WEB-1'), null);
  await assert.rejects(shepherdr.show('SHO-99'), /No task SHO-99/, 'what the board says is the error');
  const added = await shepherdr.add(shepherdr.addWords({title: 'CSV export', brief: 'Export the orders as CSV.', space: 'shop'}));
  assert.equal(added.id, 'SHO-90');
  assert.match(added.said, /for later/);
  assert.deepEqual(board.calls().at(-1), ['task', 'add', 'CSV export', '--brief=Export the orders as CSV.', '--space=shop', '--later']);
  assert.equal(board.state().tasks.at(-1).desc, 'Export the orders as CSV.', 'the board took the brief');
  // A request that starts with -- keeps its brief: the board reads `--brief --x` as a flag without its value.
  const dashed = await shepherdr.add(shepherdr.addWords({title: '--force push guard', brief: '--force push guard: refuse when branch=main', space: 'shop'}));
  assert.equal(dashed.id, 'SHO-91');
  assert.deepEqual(board.state().tasks.at(-1), {id: 'SHO-91', title: 'force push guard', status: 'todo', place: 'p:here:shop', desc: '--force push guard: refuse when branch=main'});
  assert.ok(board.calls().every(([verb, sub]) => ['space list', 'task list', 'task show', 'artifact list', 'artifact show', 'task add'].includes(`${verb} ${sub}`)), 'read, and the one add');
});

test('the context card\'s board: the space of the repo, the branch\'s task with its pull request, the others counted', async () => {
  const dir = scratch('pair-board-');
  const repo = join(dir, 'shop');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], {stdio: 'pipe'});
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'first');
  git('checkout', '-q', '-b', 'work/7-read-every-run');
  const board = fakeShepherdr(join(dir), {
    spaces: [{name: 'shop', key: 'SHO', path: repo}],
    tasks: [
      {id: 'SHO-7', title: 'Read every run', status: 'work', sub: 'Reading', place: 'p:here:shop', branch: 'work/7-read-every-run', pr: {number: 3, url: 'https://github.com/o/shop/pull/3'}},
      {id: 'SHO-8', title: 'Search trail', status: 'need', sub: 'Which file?', place: 'p:here:shop'},
      {id: 'SHO-9', title: 'Third', status: 'work', place: 'p:here:shop'},
    ],
  });
  const event = await projectContext({board: board.command})(repo);
  assert.deepEqual(event.board, {
    space: 'shop', task: {id: 'SHO-7', title: 'Read every run', state: 'working', msg: 'Reading', pr: 'https://github.com/o/shop/pull/3'},
    working: 1, waiting: [{id: 'SHO-8', title: 'Search trail'}],
  });
  assert.equal(event.git.pr, '#3', 'the board names the pull request: gh is not asked');
  board.set({down: true});
  assert.equal((await projectContext({board: board.command})(repo)).board, null, 'a board that does not answer is no source');
});

test('the board\'s agent launches are told apart from the user\'s commands', () => {
  assert.equal(boardLaunch('claude --session-id 1 --settings /home/u/.shepherdr/hooks/BDY-7-agent.settings.json'), true);
  assert.equal(boardLaunch('claude --append-system-prompt-file /home/u/.shepherdr/box/prompts/BDY-7.md'), true);
  assert.equal(boardLaunch('claude'), false);
  assert.equal(boardLaunch('make test'), false);
  assert.equal(boardLaunch('shepherdr task tell BDY-25 go'), false, 'the user working the board is the user');
  assert.equal(boardLaunch('cat ~/.shepherdr/notes.md'), false, 'reading a file of the board\'s is not a launch');
});
