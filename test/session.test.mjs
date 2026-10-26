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
