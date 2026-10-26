// What the editor is sent besides the chat: where Pair reads (its gaze), its words under your line with the
// place it points at, and what became of the remark. With a real store in memory and a scratch project.
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {PairSession} from '../src/session.mjs';
import {openStore} from '../src/store.mjs';

const BACKOFF = 'package retry\n\nfunc Next(attempt int) int {\n\treturn 1 << attempt\n}\n';
const WORKER = 'package delivery\n\nfunc Run() {\n\tif elapsed+wait >= budget {\n\t\treturn\n\t}\n}\n';

/** A session in a scratch project; its Partner runs `turns` in order, each with the session to call tools on. */
function pairSession(turns = []) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pair-remark-')));
  writeFileSync(join(root, 'backoff.go'), BACKOFF);
  writeFileSync(join(root, 'worker.go'), WORKER);
  const store = openStore(':memory:');
  const clock = {now: 1_000_000};
  const sent = [];
  const asked = [];
  const pair = new PairSession({
    record: store.createSession({root, conversationId: 'c1', goal: 'retries pass', level: 'normal', at: clock.now}),
    store,
    partner: {ask: async (_id, input) => { asked.push(input); return turns.shift()?.(pair) ?? 'SILENT'; }, setRole: async () => {}},
    score: async () => ({value: 9, reason: 'test'}),
    typingPauseMs: 2000,
    notify: (to, message) => { sent.push({via: to, ...message}); return 1; },
    requestEditor: async () => null,
    now: () => clock.now,
  });
  return {root, pair, store, clock, sent, asked};
}

const RED = '--- FAIL: TestRetries (0.00s)\n    worker_test.go:35: attempts = 4, want 5\nFAIL\texample.com/delivery\t0.001s';

test('the wrong turn: Pair reads, says why under your line, and points at the real cause for the jump key', async () => {
  const {root, pair, store, clock, sent, asked} = pairSession([async pair => {
    await pair.read({file: 'backoff.go'});
    await pair.read({file: 'worker.go', from: 3, to: 5});
    await pair.point({file: 'worker.go', line: 4, endLine: 4, note: '7s + 8s = 15s: still inside the budget', code: '>='});
    return 'The shift is fine: 1s 2s 4s 8s.\nAttempt 5 lands at exactly 15s, and `worker.go:4` gives up on `>=`.';
  }]);
  pair.receive({kind: 'focus', target: 'terminal', pane: 'w1:p2', at: clock.now - 40_000}); // the user watched it fail
  pair.receive({kind: 'command_end', pane: 'w1:p2', cmd: 'go test ./...', exit: 1, output: RED, at: clock.now - 30_000});
  pair.receive({kind: 'edit', file: join(root, 'backoff.go'), from: 4, to: 4, at: clock.now - 5000});
  await pair.tick();

  assert.match(asked[0], /^\[watch\] edit_while_red: The user edits backoff\.go:4-4 while `go test \.\/\.\.\.` is red/);
  assert.match(asked[0], /point at the real cause \(file, line and the exact code\)/);
  const editor = sent.filter(message => message.via === 'editor');
  assert.deepEqual(editor.map(message => message.type), ['look', 'look', 'point', 'remark']);
  assert.deepEqual(editor.slice(0, 2).map(({file, from, to}) => [file, from, to]), [[join(root, 'backoff.go'), 1, 6], [join(root, 'worker.go'), 3, 5]],
    'the gaze covers the lines read: the whole file, or the range asked for');
  const target = {file: join(root, 'worker.go'), line: 4, endLine: 4, note: '7s + 8s = 15s: still inside the budget', code: '>='};
  assert.deepEqual(editor[2], {via: 'editor', type: 'point', ...target});
  const [remark] = store.remarks(0);
  assert.equal(remark.trigger, 'edit_while_red');
  assert.deepEqual(editor[3], {
    via: 'editor', type: 'remark', id: remark.id, target,
    text: 'The shift is fine: 1s 2s 4s 8s.\nAttempt 5 lands at exactly 15s, and `worker.go:4` gives up on `>=`.',
  });

  pair.seen(remark.id);
  assert.equal(store.remarks(0)[0].verdict, 'seen', 'editing on after it: seen');
  pair.feedback({useful: true, id: remark.id});
  pair.seen(remark.id);
  assert.equal(store.remarks(0)[0].verdict, 'useful', 'a verdict wins over seen, also when seen comes later');
});

test('the words of a remark are what Pair said, also through say; a turn starts with no words and no target', async () => {
  const {pair, clock, sent} = pairSession([
    async pair => { pair.say('Two places changed.'); return ''; },
  ]);
  pair.receive({kind: 'command_end', cmd: 'npm test', exit: 1, output: 'Error: boom', at: clock.now - 10_000});
  pair.receive({kind: 'command_end', cmd: 'npm test', exit: 1, output: 'Error: boom', at: clock.now - 5000});
  await pair.tick();
  const remark = sent.find(message => message.via === 'editor' && message.type === 'remark');
  assert.deepEqual([remark.text, remark.target], ['Two places changed.', null]);
});

test('a question about selected lines gives the Partner those lines, as the editor has them', async () => {
  const {root, pair, sent, asked} = pairSession([async () => 'It doubles each time.']);
  await pair.ask('what does this do?', {file: join(root, 'backoff.go'), from: 3, to: 5});
  assert.match(asked[0], /^\[user\] what does this do\?\n\nAbout lines 3-5 of backoff\.go, which the user selected:\n3: func Next\(attempt int\) int \{\n4: \treturn 1 << attempt\n5: \}\n\(1 more lines; ask for start_line 6\)\n\nNow:/);
  assert.ok(sent.some(message => message.type === 'message' && message.text === 'what does this do? (backoff.go:3-5)'));
  assert.ok(sent.some(message => message.text === 'It doubles each time.'));
});
