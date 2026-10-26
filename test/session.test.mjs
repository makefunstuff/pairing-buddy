import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PairSession} from '../src/session.mjs';

function session({score = async () => ({value: 9, reason: 'worth it'}), answer = 'Line 2 is off.'} = {}) {
  const asked = [];
  const sent = [];
  const store = {addMessage() {}, setGoal() {}, setLevel() {}, endSession() {}};
  const partner = {ask: async (_id, input) => { asked.push(input); return answer; }};
  const pair = new PairSession({
    record: {id: 1, root: '/project', conversation_id: 7, goal: 'fix it', level: 'normal'},
    store, partner, score, typingPauseMs: 2000,
    notify: (role, message) => sent.push({role, ...message}),
    requestEditor: async () => null,
    now: () => 100_000,
  });
  return {pair, asked, sent};
}

const failTwice = pair => {
  for (const at of [90_000, 95_000]) pair.receive({kind: 'command_end', cmd: 'npm test', exit: 1, output: 'Error: boom', at});
};

test('overlapping ticks raise one remark, and its trigger fires once', async () => {
  let release;
  const slowScore = () => new Promise(resolve => { release = () => resolve({value: 9, reason: 'worth it'}); });
  const {pair, asked} = session({score: slowScore});
  failTwice(pair);
  const first = pair.tick();
  const second = pair.tick(); // while the Watcher still thinks about the first
  release();
  await Promise.all([first, second]);
  await pair.tick();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^\[watch\] repeated_error:/);
});

test('a SILENT answer reaches nobody and costs no budget', async () => {
  const {pair, sent} = session({answer: 'SILENT'});
  failTwice(pair);
  await pair.tick();
  assert.deepEqual(sent.filter(message => message.role === 'chat'), []);
  assert.equal(pair.budget.allows(100_000).ok, true);
});

test('a delivered remark spends the budget', async () => {
  const {pair, sent} = session();
  failTwice(pair);
  await pair.tick();
  assert.ok(sent.some(message => message.text === 'Line 2 is off.'));
  assert.equal(pair.budget.allows(100_000).ok, false);
});

test('a say of SILENT is silence', async () => {
  const {pair, sent} = session();
  assert.equal(pair.say('SILENT'), 'shown');
  assert.deepEqual(sent, []);
});

test('an unasked remark that arrives while the user types again waits for their next pause', async () => {
  let clock = 100_000;
  const sent = [];
  const pair = new PairSession({
    record: {id: 1, root: process.cwd(), conversation_id: 7, goal: 'fix it', level: 'normal'},
    store: {addMessage() {}},
    // The Partner takes 6 s; the user types again half a second before it answers.
    partner: {ask: async () => {
      clock += 5500;
      pair.receive({kind: 'typing'});
      clock += 500;
      await pair.point({file: 'package.json', line: 1, note: 'look here'});
      return 'The name is wrong.';
    }},
    score: async () => ({value: 9, reason: 'worth it'}),
    typingPauseMs: 2000,
    notify: (role, message) => sent.push({role, at: clock, ...message}),
    requestEditor: async () => null,
    now: () => clock,
  });
  pair.receive({kind: 'typing', at: 90_000});
  pair.receive({kind: 'command_end', cmd: 'npm test', exit: 1, output: 'Error: boom', at: 95_000});
  pair.receive({kind: 'command_end', cmd: 'npm test', exit: 1, output: 'Error: boom', at: 96_000});

  await pair.tick();
  clock += 1000; // still within the typing pause
  await pair.tick();
  assert.deepEqual(sent, [], 'nothing is shown while the user types');

  clock += 2000;
  await pair.tick();
  const lastKey = 105_500;
  assert.deepEqual(sent.map(message => [message.role, message.type, message.text]), [
    ['editor', 'point', undefined],
    ['chat', 'message', 'package.json:1 look here'],
    ['chat', 'message', 'The name is wrong.'],
  ]);
  assert.ok(sent.every(message => message.at - lastKey >= 2000), 'everything waited for a 2 s pause');
});

test('an answer to the user\'s own question is shown at once, even while they type', async () => {
  const {pair, sent} = session();
  pair.receive({kind: 'typing', at: 99_900});
  await pair.ask('what is wrong?');
  assert.ok(sent.some(message => message.text === 'Line 2 is off.'));
});

/** A session in the Scout role with a stand-in for Pair's pane that records what it was asked to run. */
function scoutSession({results = {}, chat = true} = {}) {
  const ran = [];
  const sent = [];
  const roles = [];
  const pane = {
    opened: false,
    open: async () => { pane.opened = true; },
    close: async () => { pane.opened = false; },
    run: async command => { ran.push(command); return {exit: 0, output: '', timedOut: false, ...results[command]}; },
  };
  const pair = new PairSession({
    record: {id: 1, root: process.cwd(), conversation_id: 7, goal: 'fix it', level: 'normal', role: 'scout'},
    store: {addMessage() {}, setRole: (_id, role) => roles.push(role)},
    partner: {ask: async () => 'ok', setRole: async () => {}},
    score: async () => ({value: 9, reason: 'worth it'}),
    typingPauseMs: 2000,
    notify: (to, message) => { sent.push({to, ...message}); return to === 'chat' && !chat ? 0 : 1; },
    requestEditor: async () => null,
    now: () => 100_000,
  });
  pair.scout = pane;
  return {pair, pane, ran, sent, roles};
}

test('Scout runs allowed commands at once and reports exit, parsed tests and output', async () => {
  const output = 'FAIL src/ws.test.js\n  ● reconnect › waits\n\n    Expected: 30000\n\nTests:       1 failed, 2 passed, 3 total';
  const {pair, ran} = scoutSession({results: {'npm test': {exit: 1, output}}});
  const report = await pair.run({command: 'npm test'});
  assert.deepEqual(ran, ['npm test']);
  assert.match(report, /^exit 1\nTests \(jest\): 1 failed \(reconnect › waits\): Expected: 30000\nFAIL src/);
  assert.equal(pair.state.tests.by, 'pair');
  assert.equal(pair.state.tests.failedCount, 1);
  assert.deepEqual(pair.state.commands, [], 'Pair\'s own runs are not the user\'s commands, so they raise no remark');
});

test('Scout never runs a refused command and tells the user why', async () => {
  const {pair, ran, sent} = scoutSession();
  assert.match(await pair.run({command: 'git commit -am wip'}), /^Refused: git commit changes git history/);
  assert.deepEqual(ran, []);
  assert.ok(sent.some(message => /may not run `git commit -am wip`/.test(message.text)));
});

test('a command that writes asks the user in the chat and runs only on yes', async () => {
  const {pair, ran, sent} = scoutSession();
  const denied = pair.run({command: 'rm -rf build'});
  await Promise.resolve();
  const question = sent.find(message => message.type === 'confirm');
  assert.match(question.text, /`rm -rf build`.*rm writes or deletes files/);
  pair.answer(question.id, false);
  assert.match(await denied, /did not allow/);
  assert.deepEqual(ran, []);

  const allowed = pair.run({command: 'rm -rf build'});
  await Promise.resolve();
  pair.answer(sent.filter(message => message.type === 'confirm').at(-1).id, true);
  assert.match(await allowed, /^exit 0/);
  assert.deepEqual(ran, ['rm -rf build']);
});

test('a declined delete cannot be done another way through a read-only program', async () => {
  const {pair, ran, sent} = scoutSession();
  for (const command of ['rm precious.txt', 'fd precious -x rm', 'sort -onew.txt package.json']) {
    const reply = pair.run({command});
    await Promise.resolve();
    pair.answer(sent.filter(message => message.type === 'confirm').at(-1).id, false);
    assert.match(await reply, /did not allow/, command);
  }
  assert.deepEqual(ran, []);
});

test('without a chat pane to ask in, a command that writes does not run', async () => {
  const {pair, ran} = scoutSession({chat: false});
  assert.match(await pair.run({command: 'npm install'}), /did not allow/);
  assert.deepEqual(ran, []);
});

test('a remark nobody asked for may search but not run commands', async () => {
  const {pair, ran} = scoutSession({results: {"rg --line-number --no-heading --color never --max-columns 200 --max-count 20 -- 'TIMEOUT' '.'": {output: 'src/ws.ts:1:TIMEOUT'}}});
  pair.unasked = true;
  assert.match(await pair.run({command: 'npm test'}), /^Not now/);
  assert.equal(await pair.search({pattern: 'TIMEOUT'}), 'src/ws.ts:1:TIMEOUT\n\nName these places (file:line) in your answer.');
  assert.equal(ran.length, 1);
});

test('search quotes the pattern, stays in the project and says when nothing matched', async () => {
  const {pair, ran} = scoutSession({results: {"rg --line-number --no-heading --color never --max-columns 200 --max-count 20 -- 'it'\\''s' 'src'": {exit: 1}}});
  assert.equal(await pair.search({pattern: "it's", path: 'src'}), 'No matches.');
  assert.match(await pair.search({pattern: 'x', path: '..'}), /not inside the project/);
  assert.equal(ran.length, 1);
});

test('switching to Scout opens Pair\'s pane and tells the editor and the chat; switching back closes it', async () => {
  const {pair, pane, sent, roles} = scoutSession();
  pair.role = 'navigator';
  await pair.setRole('scout');
  assert.equal(pane.opened, true);
  assert.deepEqual(sent.filter(message => message.type === 'role').map(message => [message.to, message.role]), [['editor', 'scout'], ['chat', 'scout']]);
  await pair.setRole('navigator');
  assert.equal(pane.opened, false);
  assert.deepEqual(roles, ['scout', 'navigator']);
  assert.equal(pair.role, 'navigator');
});

test('without herdr there is no pane, so the role stays Navigator', async () => {
  const {pair, sent} = scoutSession();
  pair.role = 'navigator';
  pair.scout = null;
  await pair.setRole('scout');
  assert.equal(pair.role, 'navigator');
  assert.ok(sent.some(message => /Scout needs its own herdr pane/.test(message.text)));
});

test('a question gets at most four searches or commands; the next turn starts again', async () => {
  const {pair, ran} = scoutSession();
  for (let i = 0; i < 4; i++) await pair.run({command: 'git log -1'});
  await assert.rejects(pair.search({pattern: 'x'}), /That is 4 commands for this question/);
  assert.equal(ran.length, 4);
  await pair.talk('[user] again');
  await pair.run({command: 'git log -1'});
  assert.equal(ran.length, 5);
});

test('after a switch back to Navigator, a call still in flight does not reopen Pair\'s pane', async () => {
  const {pair, pane, ran} = scoutSession();
  await pair.setRole('navigator');
  await assert.rejects(pair.run({command: 'npm test'}), /need the Scout role/);
  assert.deepEqual(ran, []);
  assert.equal(pane.opened, false);
});
