// What the editor is sent besides the chat: where Pair reads (its gaze), its words under your line with the
// place it points at, and what became of the remark. With a real store in memory and a scratch project.
import assert from 'node:assert/strict';
import {realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {PairSession} from '../src/session.mjs';
import {openStore} from '../src/store.mjs';
import {scratch} from './temp.mjs';

const BACKOFF = 'package retry\n\nfunc Next(attempt int) int {\n\treturn 1 << attempt\n}\n';
const WORKER = 'package delivery\n\nfunc Run() {\n\tif elapsed+wait >= budget {\n\t\treturn\n\t}\n}\n';

/** A session in a scratch project; its Partner runs `turns` in order, each with the session to call tools on. */
function pairSession(turns = []) {
  const root = realpathSync(scratch('pair-remark-'));
  writeFileSync(join(root, 'backoff.go'), BACKOFF);
  writeFileSync(join(root, 'worker.go'), WORKER);
  const store = openStore(':memory:');
  const clock = {now: 1_000_000};
  const sent = [];
  const asked = [];
  const options = []; // what each turn asked of the Partner besides its input
  const pair = new PairSession({
    record: store.createSession({root, conversationId: 'c1', goal: 'retries pass', level: 'normal', at: clock.now}),
    store,
    partner: {thinkingOf: (_id, kind) => (kind === 'remark' ? 'low' : 'off'), ask: async (_id, input, opts) => { asked.push(input); options.push(opts); return turns.shift()?.(pair) ?? 'SILENT'; }, setRole: async () => {}},
    score: async () => ({value: 9, reason: 'test'}),
    typingPauseMs: 2000,
    notify: (to, message) => { sent.push({via: to, ...message}); return 1; },
    requestEditor: async () => null,
    now: () => clock.now,
  });
  return {root, pair, store, clock, sent, asked, options};
}

const RED = '--- FAIL: TestRetries (0.00s)\n    worker_test.go:35: attempts = 4, want 5\nFAIL\texample.com/delivery\t0.001s';

test('the wrong turn: Pair reads, says why under your line, and points at the real cause for the jump key', async () => {
  const {root, pair, store, clock, sent, asked, options} = pairSession([async pair => {
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
  assert.match(asked[0], /trace the test through the code as it is now/);
  assert.equal(options[0].kind, 'remark', 'it thinks as remarks do');
  assert.deepEqual(sent.filter(message => message.type === 'thinking').map(message => [message.via, message.on]), [['editors', true], ['editors', false]],
    'the statusline says Pair thinks while the turn runs');
  const editor = sent.filter(message => message.via === 'editor');
  assert.deepEqual(editor.map(message => message.type), ['look', 'look', 'point', 'remark', 'earcon']);
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

/** The wrong turn's remark, made while the user was in their terminal: the words never showed under their line. */
async function pointedRemark() {
  const session = pairSession([async pair => {
    await pair.point({file: 'worker.go', line: 4, endLine: 4, note: '7s + 8s = 15s: still inside the budget', code: '>='});
    return 'Attempt 5 lands at exactly 15s, and `worker.go:4` gives up on `>=`.';
  }]);
  const {root, pair, clock} = session;
  pair.receive({kind: 'focus', target: 'terminal', pane: 'w1:p2', at: clock.now - 40_000});
  pair.receive({kind: 'command_end', pane: 'w1:p2', cmd: 'go test ./...', exit: 1, output: RED, at: clock.now - 30_000});
  pair.receive({kind: 'edit', file: join(root, 'backoff.go'), from: 4, to: 4, at: clock.now - 5000});
  await pair.tick();
  return {...session, remark: session.store.remarks(0)[0]};
}

test('an edit where a remark pointed counts it useful, wherever its words showed; the ledger and the chat say so', async () => {
  const {root, pair, store, clock, sent, remark} = await pointedRemark();
  assert.equal(remark.verdict, null);
  clock.now += 3 * 60_000;
  pair.receive({kind: 'edit', file: join(root, 'backoff.go'), from: 4, to: 4, origin: 'user'});
  assert.equal(store.remarks(0)[0].verdict, null, 'an edit elsewhere says nothing');
  pair.receive({kind: 'edit', file: join(root, 'worker.go'), from: 4, to: 4, origin: 'pair'});
  assert.equal(store.remarks(0)[0].verdict, null, 'nor does an edit Pair made');
  pair.receive({kind: 'edit', file: join(root, 'worker.go'), from: 5, to: 5, origin: 'user'});
  assert.equal(store.remarks(0)[0].verdict, 'useful', 'the user changed the line it pointed at');
  assert.ok(sent.some(message => message.via === 'chat' && message.type === 'acted' && message.remark === remark.id), 'the chat marks it useful');
  const acted = store.actions(root, 0).filter(action => action.kind === 'acted');
  assert.equal(acted.length, 1);
  assert.match(acted[0].text, /^worker\.go:4, you edited where a remark pointed$/);
  pair.feedback({useful: false, id: remark.id});
  assert.equal(store.remarks(0)[0].verdict, 'dismissed', 'a - afterwards still wins');
});

test('an edit where a remark pointed leaves your own verdict alone, and counts only within ten minutes', async () => {
  const dismissed = await pointedRemark();
  dismissed.pair.feedback({useful: false, id: dismissed.remark.id});
  dismissed.pair.receive({kind: 'edit', file: join(dismissed.root, 'worker.go'), from: 4, to: 4, origin: 'user'});
  assert.equal(dismissed.store.remarks(0)[0].verdict, 'dismissed', 'the user\'s - wins over the guess');
  assert.ok(!dismissed.sent.some(message => message.type === 'acted'));

  const seen = await pointedRemark();
  seen.pair.seen(seen.remark.id);
  seen.pair.receive({kind: 'edit', file: join(seen.root, 'worker.go'), from: 3, to: 4, origin: 'user'});
  assert.equal(seen.store.remarks(0)[0].verdict, 'useful', 'seen, then acted on: useful');

  const late = await pointedRemark();
  late.clock.now += 11 * 60_000;
  late.pair.receive({kind: 'edit', file: join(late.root, 'worker.go'), from: 4, to: 4, origin: 'user'});
  assert.equal(late.store.remarks(0)[0].verdict, null, 'past ten minutes it is no longer the next edit');

  const whole = await pointedRemark();
  whole.pair.receive({kind: 'edit', file: join(whole.root, 'worker.go'), from: 1, to: 40, origin: 'user'});
  assert.equal(whole.store.remarks(0)[0].verdict, null, 'a format of the whole file acts on nothing');
});

test('an edit where you were editing already, or on a suggestion\'s lines, does not count a remark useful', async () => {
  const there = pairSession([async pair => {
    await pair.point({file: 'backoff.go', line: 4, endLine: 4, note: 'the shift', code: '<<'});
    return 'The shift doubles: `backoff.go:4`.';
  }]);
  there.pair.receive({kind: 'command_end', pane: 'w1:p2', cmd: 'go test ./...', exit: 1, output: RED, at: there.clock.now - 30_000});
  there.pair.receive({kind: 'edit', file: join(there.root, 'backoff.go'), from: 4, to: 4, at: there.clock.now - 5000});
  await there.pair.tick();
  there.pair.receive({kind: 'edit', file: join(there.root, 'backoff.go'), from: 4, to: 4, origin: 'user'});
  assert.equal(there.store.remarks(0)[0].verdict, null, 'it pointed where the user was typing: editing on there is no answer');

  const suggested = pairSession([async pair => {
    await pair.suggest({file: 'worker.go', line: 4, endLine: 4, note: 'give up after the budget', text: '\tif elapsed+wait > budget {'});
    return 'Attempt 5 lands at exactly 15s: `>` keeps it.';
  }]);
  suggested.pair.receive({kind: 'command_end', pane: 'w1:p2', cmd: 'go test ./...', exit: 1, output: RED, at: suggested.clock.now - 30_000});
  suggested.pair.receive({kind: 'edit', file: join(suggested.root, 'backoff.go'), from: 4, to: 4, at: suggested.clock.now - 5000});
  await suggested.pair.tick();
  assert.ok(suggested.store.remarks(0).length, 'the remark was made');
  suggested.pair.receive({kind: 'edit', file: join(suggested.root, 'worker.go'), from: 4, to: 4, origin: 'user'});
  assert.equal(suggested.store.remarks(0)[0].verdict, null, 'typing over a suggestion ignores it');
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

test('the statusline says Pair thinks while its model works, not while one of its tools runs', async () => {
  const {pair, clock, sent} = pairSession([async pair => {
    await pair.useTool('read', {file: 'backoff.go'});
    return 'SILENT';
  }]);
  pair.receive({kind: 'command_end', cmd: 'npm test', exit: 1, output: 'Error: boom', at: clock.now - 10_000});
  pair.receive({kind: 'command_end', cmd: 'npm test', exit: 1, output: 'Error: boom', at: clock.now - 5000});
  await pair.tick();
  const shown = sent.filter(message => message.type === 'thinking' || message.type === 'look').map(message => message.type === 'look' ? 'look' : message.on);
  assert.deepEqual(shown, [true, false, 'look', true, false]);
});
