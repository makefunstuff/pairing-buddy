import assert from 'node:assert/strict';
import {test} from 'node:test';
import {boardContext, boardLaunch, branchNumber} from '../src/board.mjs';

const TASKS = [
  {id: 'herdr-android/20', state: 'done', title: 'Adopt the web UI look', msg: 'Merged'},
  {id: 'pairing-buddy/20', state: 'working', title: 'Research: pleasant sessions', msg: 'Recording scenes', pr: 'https://github.com/o/pairing-buddy/pull/16'},
  {id: 'pairing-buddy/21', state: 'working', title: 'See crashes', msg: ''},
  {id: 'pairing-buddy/22', state: 'blocked', title: 'Exploration loop', msg: 'Should the old file go?'},
  {id: 'slopbot/20', state: 'done', title: 'Container image', msg: ''},
];

test('a branch names its task number: work/20-research, 20-fix; main names none', () => {
  assert.equal(branchNumber('work/20-research-make-ai-assisted-sess'), 20);
  assert.equal(branchNumber('20-fix'), 20);
  assert.equal(branchNumber('feature/v2'), null);
  assert.equal(branchNumber('main'), null);
  assert.equal(branchNumber(null), null);
});

test('the board task is matched by repo and number, not by number alone', () => {
  const board = boardContext(TASKS, {repos: ['pairing-buddy'], branch: 'work/20-research'});
  assert.equal(board.task.id, 'pairing-buddy/20', 'not herdr-android/20, which comes first');
  assert.equal(board.task.pr, 'https://github.com/o/pairing-buddy/pull/16');
  assert.equal(board.working, 1, 'the repo\'s other working tasks');
  assert.deepEqual(board.waiting, [{id: 'pairing-buddy/22', title: 'Exploration loop'}], 'and the ones waiting for the user');

  assert.equal(boardContext(TASKS, {repos: ['other-repo'], branch: 'work/20-x'}).task, null, 'another repo\'s #20 is not ours');
  assert.equal(boardContext(TASKS, {repos: ['pairing-buddy'], branch: 'main'}).task, null);
  assert.equal(boardContext(null, {repos: ['pairing-buddy'], branch: 'work/20-x'}), null, 'no board, no source');
});

test('the board\'s agent launches are told apart from the user\'s commands', () => {
  assert.equal(boardLaunch('claude --session-id 1 --settings /home/u/.herdr-projects/data/tasks/x/settings.json'), true);
  assert.equal(boardLaunch('claude'), false);
  assert.equal(boardLaunch('make test'), false);
});
