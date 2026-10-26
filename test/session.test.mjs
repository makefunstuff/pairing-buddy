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
