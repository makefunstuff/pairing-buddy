import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Budget, BUDGETS} from '../src/budget.mjs';
import {initialState} from '../src/fold.mjs';
import {decide} from '../src/gate.mjs';

const MIN = 60_000;
const trigger = {kind: 'failed_command', key: 'k', detail: 'npm test failed'};

function gate({score = 9, lastKeyAt = 0, budget = new Budget('normal'), now = 10 * MIN} = {}) {
  const asked = [];
  const scorer = async t => { asked.push(t); return {value: score, reason: 'test'}; };
  return {asked, run: () => decide({trigger, state: {...initialState(), lastKeyAt}, now, budget, score: scorer, typingPauseMs: 2000})};
}

test('the budget allows one remark per minimum gap', () => {
  const budget = new Budget('normal');
  assert.equal(budget.allows(0).ok, true);
  budget.spend(0);
  assert.equal(budget.allows(BUDGETS.normal.minGapMs - 1).ok, false);
  assert.equal(budget.allows(BUDGETS.normal.minGapMs).ok, true);
});

test('the budget caps remarks per hour, and frees them an hour later', () => {
  const budget = new Budget('chatty');
  const {minGapMs, perHour} = BUDGETS.chatty;
  for (let i = 0; i < perHour; i++) budget.spend(i * minGapMs);
  const after = perHour * minGapMs;
  assert.deepEqual(budget.allows(after), {ok: false, reason: `${perHour} remarks in the last hour`});
  assert.equal(budget.allows(60 * MIN + minGapMs).ok, true);
});

test('levels order from quiet to chatty', () => {
  assert.ok(BUDGETS.quiet.minGapMs > BUDGETS.normal.minGapMs && BUDGETS.normal.minGapMs > BUDGETS.chatty.minGapMs);
  assert.ok(BUDGETS.quiet.perHour < BUDGETS.normal.perHour && BUDGETS.normal.perHour < BUDGETS.chatty.perHour);
  assert.ok(BUDGETS.quiet.bar > BUDGETS.normal.bar && BUDGETS.normal.bar > BUDGETS.chatty.bar);
  assert.throws(() => new Budget('loud'));
});

test('the gate waits while the user types, without asking the Watcher', async () => {
  const now = 10 * MIN;
  const {asked, run} = gate({lastKeyAt: now - 500, now});
  assert.deepEqual(await run(), {verdict: 'wait', reason: 'typing'});
  assert.equal(asked.length, 0);
});

test('the gate drops a remark when the budget is spent, without asking the Watcher', async () => {
  const budget = new Budget('normal');
  budget.spend(10 * MIN - 1000);
  const {asked, run} = gate({budget});
  assert.equal((await run()).verdict, 'drop');
  assert.equal(asked.length, 0);
});

test('the gate drops what the prefilter knows for noise, without asking the Watcher', async () => {
  const asked = [];
  const grep = {kind: 'failed_command', key: 'g', detail: '`rg x` failed', command: {cmd: 'rg x', exit: 1}};
  const decision = await decide({trigger: grep, state: initialState(), now: 10 * MIN, budget: new Budget('normal'), score: async t => { asked.push(t); return {value: 9}; }, typingPauseMs: 2000});
  assert.equal(decision.verdict, 'drop');
  assert.match(decision.reason, /an answer, not a failure/);
  assert.equal(asked.length, 0);
});

test('the gate speaks only above the level bar', async () => {
  assert.equal((await gate({score: BUDGETS.normal.bar}).run()).verdict, 'speak');
  const low = await gate({score: BUDGETS.normal.bar - 1}).run();
  assert.equal(low.verdict, 'drop');
  assert.match(low.reason, /score 5 < 6/);
  assert.equal((await gate({score: 7, budget: new Budget('quiet')}).run()).verdict, 'drop');
  assert.equal((await gate({score: 4, budget: new Budget('chatty')}).run()).verdict, 'speak');
});

test('the gate does not spend the budget; delivering the remark does', async () => {
  const budget = new Budget('normal');
  await gate({budget}).run();
  assert.equal(budget.allows(10 * MIN).ok, true);
});

test('a tuned trigger needs its own bar, and the tuned budget allows more or fewer remarks', async () => {
  const budget = new Budget('normal', {offsets: {failed_command: 2}, factor: 0.5});
  assert.equal(budget.barFor('failed_command'), 8);
  assert.equal(budget.barFor('stall'), BUDGETS.normal.bar);
  assert.equal((await gate({score: 7, budget}).run()).verdict, 'drop');
  assert.deepEqual(budget.limits(), {perHour: 3, minGapMs: 6 * MIN});
  budget.spend(0);
  assert.equal(budget.allows(BUDGETS.normal.minGapMs).ok, false, 'the gap doubled');
  assert.equal(budget.allows(6 * MIN).ok, true);
});

test('a tuning outside the safe bounds is held within them', () => {
  const budget = new Budget('quiet', {offsets: {drift: 7, stall: -5}, factor: 10});
  assert.equal(budget.barFor('drift'), 9, 'never above 9, so a trigger is never silenced');
  assert.equal(budget.barFor('stall'), 7);
  assert.deepEqual(budget.limits(), {perHour: 3, minGapMs: 10 * MIN});
  budget.tune({offsets: {}, factor: 0});
  assert.deepEqual(budget.limits(), {perHour: 1, minGapMs: 30 * MIN});
});
