// Scout's commands and the user's unsaved buffers: a run on the saved files says which buffers it did not see, and
// `unsaved: true` runs it on them, in the scratch copy of the project.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {PairSession} from '../src/session.mjs';
import {scratch} from './temp.mjs';

function scoutIn(buffers) {
  const root = realpathSync(scratch('pair-scout-unsaved-'));
  const runs = scratch('pair-scout-runs-');
  writeFileSync(join(root, 'total.txt'), 'saved\n');
  execFileSync('git', ['init', '-q'], {cwd: root});
  const ran = [];
  const pane = {
    close: async () => {},
    // As the pane would: the command really runs, and its output comes back.
    run: async command => { ran.push(command); return {exit: 0, output: execFileSync('bash', ['-c', command], {cwd: root, encoding: 'utf8'}).trim(), timedOut: false}; },
  };
  const pair = new PairSession({
    record: {id: 4, root, conversation_id: 7, goal: 'totals', level: 'normal', role: 'scout'},
    store: {addMessage() {}, addAction: () => 1, updateAction() {}, lastRemark: () => null, setRole() {}},
    partner: {thinkingOf: () => 'off', ask: async () => 'ok', setRole: async () => {}},
    score: async () => ({value: 9, reason: 'worth it'}),
    typingPauseMs: 2000,
    checkOutput: join(runs, '4.check.out'),
    notify: () => 1,
    requestEditor: async message => (message.type === 'buffers' ? {buffers: buffers(root)} : null),
    now: () => 100_000,
  });
  pair.scout = pane;
  return {pair, root, ran};
}

test('a run on the saved files names the unsaved buffers; unsaved: true runs on them in the copy', async () => {
  const {pair, root, ran} = scoutIn(root => [{file: join(root, 'total.txt'), text: 'unsaved\n'}, {file: '/elsewhere/x.sh', text: 'outside\n'}]);
  const saved = await pair.run({command: 'cat total.txt'});
  assert.match(saved, /^exit 0\nsaved\n\nUnsaved in the editor: total\.txt\. This ran on the saved files; with unsaved: true it runs on the buffers\.$/);

  const onBuffers = await pair.run({command: 'cat total.txt', unsaved: true});
  assert.match(onBuffers, /^exit 0\nunsaved\n\nThis ran on the unsaved buffers \(total\.txt\), in a scratch copy of the project\.$/);
  assert.match(ran[1], /^\(cd '[^']+\/trees\/[\da-f]{16}' && cat total\.txt\)$/, 'in a subshell: the pane stays in the project');
  assert.equal(readFileSync(join(root, 'total.txt'), 'utf8'), 'saved\n', 'nothing was saved');
});

test('without unsaved buffers a run says nothing of them, and unsaved: true runs in the project as it is', async () => {
  const {pair, ran} = scoutIn(() => []);
  assert.equal(await pair.run({command: 'cat total.txt', unsaved: true}), 'exit 0\nsaved');
  assert.deepEqual(ran, ['cat total.txt']);
});
