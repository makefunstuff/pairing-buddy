// What the board's working tasks change, and the overlap moment: the diff parsed, the tasks read through the fake
// board (Shepherdr's command, faked) and real git worktrees, read only, and the trigger on the user's own edits.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {fold, initialState} from '../src/fold.mjs';
import {stillTrue} from '../src/held.mjs';
import {diffPath, parseTaskDiff, TaskChanges, taskFiles, touched} from '../src/overlap.mjs';
import {detectTriggers} from '../src/triggers.mjs';
import {momentOf} from '../src/watcher.mjs';
import {fakeShepherdr} from './fake-shepherdr.mjs';
import {scratch} from './temp.mjs';

const DIFF = `diff --git a/src/chat.mjs b/src/chat.mjs
index 1111111..2222222 100644
--- a/src/chat.mjs
+++ b/src/chat.mjs
@@ -3,2 +3,3 @@ function render() {
-  old();
-  older();
+  fold();
+  footer();
+  more();
@@ -10,0 +12,1 @@ more
+  added();
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
`;

test('a branch\'s diff: its files and the lines of the base it changes, with what it writes there', () => {
  assert.deepEqual(parseTaskDiff(DIFF), [
    {file: 'src/chat.mjs', ranges: [{from: 3, to: 4, added: ['  fold();', '  footer();', '  more();']}, {from: 10, to: 10, added: ['  added();']}]},
    {file: 'gone.txt', ranges: [{from: 1, to: 2, added: []}]},
    {file: 'new.txt', ranges: [{from: 1, to: 1, added: ['hello']}]},
  ]);
  assert.deepEqual(parseTaskDiff(''), []);
  assert.equal(diffPath('a/my file.js\t'), 'my file.js', 'a name with a space has a tab after it');
  assert.equal(diffPath('"b/\\303\\274n\\303\\257 \\"q\\".js"'), 'ünï "q".js', 'a quoted name, unquoted');
  assert.equal(diffPath('/dev/null'), null);
  assert.deepEqual(parseTaskDiff('diff --git a/x y.js b/x y.js\n--- a/x y.js\t\n+++ b/x y.js\t\n@@ -2 +2 @@\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n'),
    [{file: 'x y.js', ranges: [{from: 2, to: 2, added: ['c']}]}], 'no newline at the end is no line');
  assert.deepEqual(parseTaskDiff('diff --git a/m.lua b/m.lua\n--- a/m.lua\n+++ b/m.lua\n@@ -3 +2,0 @@\n--- the old comment\n@@ -40,2 +39,2 @@\n-a\n-b\n+++x\n+y\n'),
    [{file: 'm.lua', ranges: [{from: 3, to: 3, added: []}, {from: 40, to: 41, added: ['++x', 'y']}]}], 'in a hunk, a removed `-- comment` is a line, not a file');
  const ranges = parseTaskDiff(DIFF)[0].ranges;
  assert.deepEqual(touched(ranges, 5, 5).map(range => range.from), [3], 'the line next to a change touches it');
  assert.deepEqual(touched(ranges, 6, 8), [], 'lines between the changes do not');
  assert.deepEqual(touched(ranges, 1, 20).map(range => range.from), [3, 10]);
  assert.deepEqual(taskFiles([{id: 'SHO-7', title: 'Fold', branch: 'work/7-fold', files: [{file: 'src/chat.mjs', ranges}]}, {id: 'SHO-8', title: 'Two', branch: 'work/8-two', files: [{file: 'src/chat.mjs', ranges}]}], '/p'), [
    {file: '/p/src/chat.mjs', tasks: [{id: 'SHO-7', title: 'Fold', branch: 'work/7-fold'}, {id: 'SHO-8', title: 'Two', branch: 'work/8-two'}]},
  ], 'the editors get each file once, with every task that changes it');
});

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {encoding: 'utf8', stdio: 'pipe'});

/** A repo with a main branch, the owner's checkout on it, and branches of tasks 7 (in a worktree) and 8 (none). */
function repo() {
  const home = realpathSync(scratch('pair-overlap-'));
  const root = join(home, 'shop');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'chat.mjs'), Array.from({length: 20}, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  writeFileSync(join(root, 'other.mjs'), 'x\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  const worktree = join(home, 'wt-7');
  git(root, 'worktree', 'add', '-q', '-b', 'work/7-fold', worktree);
  const lines = readFileSync(join(worktree, 'chat.mjs'), 'utf8').split('\n');
  lines[9] = 'line 10, folded';
  writeFileSync(join(worktree, 'chat.mjs'), lines.join('\n'));
  git(worktree, 'commit', '-q', '-am', 'fold');
  writeFileSync(join(worktree, 'other.mjs'), 'x\ny\n'); // not committed yet: its agent is still at it
  git(root, 'branch', 'work/8-two');
  git(root, 'checkout', '-q', 'work/8-two');
  writeFileSync(join(root, 'other.mjs'), 'z\n');
  git(root, 'commit', '-q', '-am', 'two');
  git(root, 'checkout', '-q', 'main');
  return {home, root, worktree};
}

const SPACE = root => ({name: 'shop', key: 'SHO', path: root});
const TASK = (n, status, more = {}) => ({id: `SHO-${n}`, title: `Task ${n}`, status, place: 'p:here:shop', ...more});

test('the working tasks of the repo\'s space: their branches\' files and lines, uncommitted work in a worktree too; read only', async () => {
  const {home, root, worktree} = repo();
  mkdirSync(join(home, 'board'));
  const fake = fakeShepherdr(join(home, 'board'), {spaces: [SPACE(root)], tasks: [
    TASK(7, 'work', {branch: 'work/7-fold'}),
    TASK(8, 'merging', {branch: 'work/8-two'}),
    TASK(9, 'todo', {branch: 'work/9-later'}), // waits for a go: not at work
    TASK(10, 'work', {branch: 'work/10-own'}), // the session's own
    TASK(11, 'work'), // no branch yet
    {...TASK(12, 'work', {branch: 'work/7-fold'}), place: 'p:here:other'}, // another space
  ]});
  const head = git(root, 'rev-parse', 'HEAD');
  const changes = new TaskChanges({board: fake.command});
  const read = await changes.read({root, space: 'shop', own: 'SHO-10'});
  assert.deepEqual(read.map(task => [task.id, task.branch, task.files.map(file => [file.file, file.ranges.map(range => [range.from, range.to])])]), [
    ['SHO-7', 'work/7-fold', [['chat.mjs', [[10, 10]]], ['other.mjs', [[1, 1]]]]],
    ['SHO-8', 'work/8-two', [['other.mjs', [[1, 1]]]]],
  ], 'task 7 in its worktree, with what its agent has not committed; task 8 from its branch alone');
  assert.equal(git(root, 'rev-parse', 'HEAD'), head, 'git is only read');
  assert.equal(git(root, 'status', '--short'), '');
  const calls = fake.calls();
  assert.ok(calls.every(args => ['list', 'show'].includes(args[1])), 'the board is only read');
  const shows = calls.filter(args => args[1] === 'show').length;
  await changes.read({root, space: 'shop', own: 'SHO-10'});
  assert.equal(fake.calls().filter(args => args[1] === 'show').length - shows, 1, 'a branch once known is not asked again; one not made yet is');

  // Your own work is no task's: the branch you are on, or a task's worktree you work in.
  assert.deepEqual((await changes.read({root, space: 'shop', branch: 'work/8-two'})).map(task => task.id), ['SHO-7', 'SHO-10']);
  assert.deepEqual((await changes.read({root: worktree, space: 'shop'})).map(task => task.id), ['SHO-8', 'SHO-10'], 'its number not found in the branch: its worktree says it');

  // A local main behind origin's: what was merged since is no task's change.
  const ahead = git(root, 'rev-parse', 'work/8-two').trim();
  git(root, 'update-ref', 'refs/remotes/origin/main', ahead);
  git(root, 'branch', '-q', 'work/12-later', ahead);
  fake.set({spaces: [SPACE(root)], tasks: [TASK(12, 'work', {branch: 'work/12-later'})]});
  assert.deepEqual((await changes.read({root, space: 'shop'}))[0].files, [], 'branched from origin\'s main, it changes nothing yet');
  fake.set({spaces: [SPACE(root)], tasks: [TASK(7, 'work', {branch: 'work/7-fold'}), TASK(8, 'merging', {branch: 'work/8-two'}), TASK(10, 'work', {branch: 'work/10-own'})]});

  // A session in a folder of the repo sees that folder's files, by its own paths.
  mkdirSync(join(root, 'sub'));
  assert.deepEqual(await changes.read({root: join(root, 'sub'), space: 'shop'}).then(tasks => tasks.map(task => task.files)), [[], [], []]);
  assert.deepEqual(await new TaskChanges({board: null}).read({root, space: 'shop'}), [], 'no board: nothing');
  assert.deepEqual(await changes.read({root, space: null}), [], 'a repo the board does not know: nothing');
  fake.set({down: true});
  const logged = [];
  const down = new TaskChanges({board: fake.command, log: line => logged.push(line)});
  assert.equal(await down.read({root, space: 'shop'}), null, 'a board that does not answer keeps what was read last');
  await down.read({root, space: 'shop'});
  assert.equal(logged.length, 1, 'and says so once');
});

const tasksEvent = {kind: 'task_changes', tasks: [{id: 'SHO-71', title: 'Chat remarks', branch: 'work/71-chat', files: [{file: 'src/chat.mjs', ranges: [{from: 900, to: 912, added: ['  if (folded) footer();']}]}]}], at: 0};
const edit = (from, to, at, origin) => ({kind: 'edit', file: 'src/chat.mjs', from, to, text: 'x', at, ...(origin ? {origin} : {})});

test('the overlap: your own edit on lines a working task changes, once per task and change; Pair\'s edits are not yours', () => {
  let state = fold(initialState(), tasksEvent);
  assert.deepEqual(detectTriggers(fold(state, edit(100, 101, 1000)), 2000).filter(trigger => trigger.kind === 'overlap'), [], 'lines it does not change');
  assert.deepEqual(detectTriggers(fold(state, edit(905, 907, 1000, 'pair')), 2000).filter(trigger => trigger.kind === 'overlap'), [], 'Pair\'s edit');
  state = fold(state, edit(905, 907, 1000));
  const [trigger] = detectTriggers(state, 2000).filter(each => each.kind === 'overlap');
  assert.equal(trigger.key, 'overlap:SHO-71:src/chat.mjs:900');
  assert.deepEqual([trigger.file, trigger.line, trigger.task.id, trigger.ranges], ['src/chat.mjs', 905, 'SHO-71', [{from: 900, to: 912}]]);
  assert.match(trigger.detail, /Board task SHO-71 \("Chat remarks"\).*work\/71-chat.*src\/chat\.mjs:900-912.*\n  {3}if \(folded\) footer\(\);\nWhichever of the two is merged second meets a conflict/s);
  assert.match(momentOf(trigger, state), /changes 900-912 of that file on its own branch/);
  assert.deepEqual(detectTriggers(fold(state, edit(906, 906, 1500)), 2000, new Set([trigger.key])).filter(each => each.kind === 'overlap'), [], 'once');
  assert.deepEqual(detectTriggers(state, 1000 + 121_000).filter(each => each.kind === 'overlap'), [], 'an old edit is history');
  assert.equal(stillTrue(trigger, state), true);
  assert.equal(stillTrue(trigger, fold(state, {kind: 'task_changes', tasks: [], at: 3000})), false, 'a held remark about a task that stopped changing it is dropped');
});
