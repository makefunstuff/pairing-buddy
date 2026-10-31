// The Watcher and the speak gate against real models: worth-it moments score above the normal bar, noise below.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {Budget, BUDGETS} from '../../src/budget.mjs';
import {fold, initialState} from '../../src/fold.mjs';
import {decide} from '../../src/gate.mjs';
import {detectTriggers} from '../../src/triggers.mjs';
import {createWatcher} from '../../src/watcher.mjs';
import {liveStacks, SKIP_REASON} from './stacks.mjs';

const NOW = 1_000_000;
const sec = s => NOW - s * 1000;
const scenario = events => events.reduce(fold, initialState({root: '/project', goal: 'reconnect drops after the phone sleeps'}));

const failingTest = {kind: 'command_end', pane: 'w1:p2', cmd: 'npm test', exit: 1,
  output: ' FAIL  test/ws.test.ts\n  ● reconnect › retries after sleep\n    expect(received).toBe(expected)\n    Expected: 30000\n    Received: 5000\n      at test/ws.test.ts:14:28\nTests: 1 failed, 11 passed'};

const SCENARIOS = {
  worth: {
    'the same test failure twice in a row': scenario([
      {kind: 'focus', target: 'terminal', pane: 'w1:p2', at: sec(200)},
      {...failingTest, at: sec(120)},
      {kind: 'edit', file: 'src/ws.ts', from: 40, to: 41, at: sec(60)},
      {...failingTest, at: sec(5)},
    ]),
    'a failed test run the user did not look at': scenario([
      {kind: 'focus', target: 'editor', pane: 'w1:p1', at: sec(30)},
      {...failingTest, at: sec(10)},
      {kind: 'edit', file: 'src/ws.ts', from: 12, to: 12, at: sec(8)},
    ]),
    'an undefined name in the line just written, cursor moved on': scenario([
      {kind: 'edit', file: 'src/ws.ts', from: 52, to: 53, text: '  const delay = backof(attempt)\n  setTimeout(connect, delay)', at: sec(20)},
      {kind: 'diagnostics', file: 'src/ws.ts', items: [{line: 52, severity: 'error', message: "Cannot find name 'backof'. Did you mean 'backoff'?"}], at: sec(17)},
      {kind: 'cursor', file: 'src/ws.ts', line: 90, at: sec(10)},
    ]),
    'a wrong turn: editing the backoff while the failure names the worker test': scenario([
      {kind: 'focus', target: 'terminal', pane: 'w1:p2', at: sec(90)},
      {kind: 'command_end', pane: 'w1:p2', cmd: 'npm test', exit: 1, at: sec(60),
        output: '✖ retries five times within the 15 s budget (1.2ms)\n  AssertionError [ERR_ASSERTION]: 4 !== 5\n      at test/worker.test.js:7:10\nℹ tests 1\nℹ fail 1'},
      {kind: 'edit', file: 'src/backoff.js', from: 4, to: 4, at: sec(20)},
    ]),
    'a regression: the tests Pair ran on save fail in another file than the one saved': scenario([
      {kind: 'test_run', cmd: 'node --test', saved: 'src/backoff.js', files: [], at: sec(90),
        tests: {runner: 'node', failed: [], passed: 2, failedCount: 0, firstError: null}},
      {kind: 'edit', file: 'src/worker.js', from: 10, to: 10, at: sec(30)},
      {kind: 'save', file: 'src/worker.js', at: sec(20)},
      {kind: 'test_run', cmd: 'node --test', saved: 'src/worker.js', files: ['test/queue.test.js'], at: sec(5),
        tests: {runner: 'node', failed: ['no webhook is delivered twice'], passed: 1, failedCount: 1,
          firstError: 'AssertionError [ERR_ASSERTION]: attempt at 15000 ms: a second worker takes evt_42'}},
    ]),
    'a session about reconnects spent editing billing code': scenario([
      {kind: 'branch', name: 'feature/invoices', at: sec(900)},
      {kind: 'edit', file: 'src/billing/invoice.ts', from: 10, to: 40, at: sec(300)},
      {kind: 'edit', file: 'src/billing/tax.ts', from: 20, to: 31, at: sec(30)},
    ]),
  },
  noise: {
    'editing the very file the goal is about': scenario([
      {kind: 'branch', name: 'fix/reconnect', at: sec(900)},
      {kind: 'edit', file: 'src/ws.ts', from: 40, to: 44, text: 'function backoff(attempt) {', at: sec(60)},
      {kind: 'edit', file: 'test/ws.test.ts', from: 10, to: 16, at: sec(30)},
    ]),
  },
};

// Drift judged by what a file does (its gist, see gist.mjs), where the words of its path mislead: a path word in
// common with an unrelated goal, and an on-goal file with none.
const DRIFT_BY_MEANING = [
  {goal: 'better search ranking for product queries', file: 'src/billing/ranking.ts', drifted: true,
    gist: 'Ranks overdue invoices for the dunning run, oldest debt first. It defines rankOverdueInvoices, DUNNING_LEVELS.'},
  {goal: 'better search ranking for product queries', file: 'src/catalog/scoring.ts', drifted: false,
    gist: 'BM25 scoring of products against a query, title boosted over description. It defines scoreProduct, tokenize.'},
  {goal: 'reconnect waits 30 s after the phone sleeps', file: 'src/net/backoff.ts', drifted: false,
    gist: 'The delay before the next connection attempt, doubling up to a cap. It defines nextDelay, MAX_DELAY_MS.'},
  {goal: 'reconnect waits 30 s after the phone sleeps', file: 'src/sleep/sheep-counter.ts', drifted: true,
    gist: 'Counts sheep for the bedtime story screen and plays the animation. It defines countSheep, SheepAnimation.'},
];

// Fresh code: a hunk the user just wrote and saved, read for a bug. Only the bugs reach the normal bar: correct code,
// and code that is only untidy, stay under it, so reading along does not make Pair chatty.
const written = (code, file = 'src/cart.js') => scenario([
  {kind: 'edit', file, from: 20, to: 19 + code.length, text: code.join('\n'), at: sec(12)},
  {kind: 'cursor', file, line: 21 + code.length, at: sec(12)},
  {kind: 'save', file, at: sec(10)},
]);
const FRESH_CODE = [
  {name: 'a share of the discount by price, not price times quantity', bug: true, state: written([
    'export function lineShares(lines, discount) {',
    '  const total = lines.reduce((sum, line) => sum + line.price * line.qty, 0);',
    '  return lines.map(line => discount * line.price / total);',
    '}',
  ])},
  {name: 'a loop that reads one past the end', bug: true, state: written([
    'export function cheapest(lines) {',
    '  let best = lines[0];',
    '  for (let i = 1; i <= lines.length; i++) if (lines[i].price < best.price) best = lines[i];',
    '  return best;',
    '}',
  ])},
  {name: 'a correct subtotal', bug: false, state: written([
    'export function subtotal(lines) {',
    '  return lines.reduce((sum, line) => sum + line.price * line.qty, 0);',
    '}',
  ])},
  {name: 'correct money formatting', bug: false, state: written([
    'export function formatMoney(cents) {',
    "  const sign = cents < 0 ? '-' : '';",
    '  const abs = Math.abs(cents);',
    "  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;",
    '}',
  ])},
  {name: 'untidy but correct', bug: false, state: written([
    'export function calc(a,b){',
    '  var x=a*b',
    '  return x',
    '}',
  ])},
];

function triggerOf(state) {
  const [trigger] = detectTriggers(state, NOW);
  assert.ok(trigger, 'the scenario raises a trigger');
  return trigger;
}

const stacks = liveStacks();

describe('Watcher on live models', {skip: stacks.length ? false : SKIP_REASON}, () => {
  for (const stack of stacks) {
    const score = createWatcher({models: stack.models, model: stack.watcher, now: () => NOW});

    for (const [name, state] of Object.entries(SCENARIOS.worth)) {
      test(`${stack.name}: worth a remark: ${name}`, async t => {
        const trigger = triggerOf(state);
        const started = Date.now();
        const result = await score(trigger, state);
        t.diagnostic(`${trigger.kind} scored ${result.value} in ${Date.now() - started} ms`);
        assert.ok(result.value >= BUDGETS.normal.bar, `score ${result.value} below the normal bar`);
      });
    }

    for (const [name, state] of Object.entries(SCENARIOS.noise)) {
      test(`${stack.name}: not worth a remark: ${name}`, async t => {
        const trigger = triggerOf(state);
        const result = await score(trigger, state);
        t.diagnostic(`${trigger.kind} scored ${result.value}`);
        assert.ok(result.value < BUDGETS.normal.bar, `score ${result.value} reaches the normal bar`);
      });
    }

    for (const {goal, file, gist, drifted} of DRIFT_BY_MEANING) {
      test(`${stack.name}: drift by what ${file} does, under "${goal}": ${drifted ? 'other work' : 'on the goal'}`, async t => {
        const state = scenario([{kind: 'edit', file, from: 1, to: 4, at: sec(20)}]);
        const result = await score({...triggerOf({...state, goal}), gist}, {...state, goal});
        t.diagnostic(`drift scored ${result.value}`);
        assert.equal(result.value >= BUDGETS.normal.bar, drifted, `score ${result.value}`);
      });
    }

    for (const {name, bug, state} of FRESH_CODE) {
      test(`${stack.name}: fresh code, ${bug ? 'a bug' : 'no bug'}: ${name}`, async t => {
        const trigger = detectTriggers(state, NOW).find(found => found.kind === 'fresh_code');
        assert.ok(trigger, 'the saved hunk is fresh code');
        const result = await score(trigger, state);
        t.diagnostic(`fresh_code scored ${result.value}`);
        assert.equal(result.value >= BUDGETS.normal.bar, bug, `score ${result.value}`);
      });
    }

    test(`${stack.name}: the keep-warm ping answers, within 3 s`, async t => {
      const started = Date.now();
      const result = await score.warm();
      t.diagnostic(`warm-up in ${Date.now() - started} ms`);
      assert.equal(result.ok, true, result.error);
      assert.ok(Date.now() - started < 3000);
    });

    test(`${stack.name}: the speak gate speaks for a repeated failure and stays quiet for noise`, async () => {
      const worth = SCENARIOS.worth['the same test failure twice in a row'];
      const noise = SCENARIOS.noise['editing the very file the goal is about'];
      const gate = state => decide({trigger: triggerOf(state), state, now: NOW, budget: new Budget('normal'), score, typingPauseMs: 2000});
      assert.equal((await gate(worth)).verdict, 'speak');
      assert.equal((await gate(noise)).verdict, 'drop');
    });
  }
});
