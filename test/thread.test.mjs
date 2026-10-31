// The thread of the session: the goal as steps, "done: X; next: Y" at a break once a step lands, and the lines the
// user changed since the Partner's last turn, so it never answers from a stale read.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {parseInput} from '../src/chat.mjs';
import {describeState} from '../src/describe.mjs';
import {PairSession} from '../src/session.mjs';
import {DONE_PROMPT, parseDone, parseSteps, PLAN_PROMPT, Thread} from '../src/thread.mjs';
import {scratch} from './temp.mjs';

const MIN = 60_000;

test('steps come from the model\'s lines or the user\'s semicolons; fewer than two are no plan', () => {
  assert.deepEqual(parseSteps('- the cart tests pass\n2. the bogo code works\n\nthe suite is green.'), ['the cart tests pass', 'the bogo code works', 'the suite is green']);
  assert.deepEqual(parseSteps('fix the red tests; add bogo;  run it all'), ['fix the red tests', 'add bogo', 'run it all']);
  assert.deepEqual(parseSteps('NONE'), []);
  const thread = new Thread();
  assert.equal(thread.set(['only one']), false);
  assert.equal(thread.set(['a', 'b', 'c', 'd', 'e']), true);
  assert.equal(thread.steps.length, 4, 'at most four');
});

test('a landing marks steps done and says what is next; the last says so; none done says nothing', () => {
  const thread = new Thread();
  thread.set(['the cart tests pass', 'the bogo code works']);
  assert.equal(thread.summary(), '→ 1 the cart tests pass (next) · ○ 2 the bogo code works');
  thread.land('`npm test` passes again', 1000);
  assert.equal(thread.due(2000).what, '`npm test` passes again');
  assert.deepEqual(parseDone('done: 1, 7', 2), [1], 'only steps the plan has');
  assert.equal(thread.done([]), null);
  assert.equal(thread.due(2000), null, 'the landing is spent');
  thread.land('again', 3000);
  assert.equal(thread.done([1]), 'done: the cart tests pass; next: the bogo code works');
  assert.equal(thread.summary(), '✓ 1 the cart tests pass · → 2 the bogo code works (next)');
  thread.land('a commit', 4000);
  assert.equal(thread.done([1, 2]), 'done: the bogo code works; that was the last step.');
  thread.land('more', 5000);
  assert.equal(thread.due(5000), null, 'nothing left to land');
});

test('the chat\'s /plan sets, drops or shows the steps', () => {
  assert.deepEqual(parseInput('/plan a; b'), {type: 'plan', text: 'a; b'});
  assert.deepEqual(parseInput('/plan off'), {type: 'plan_off'});
  assert.deepEqual(parseInput('/plan'), {type: 'plan_show'});
});

test('the models\' "Now" lines carry the plan', () => {
  const state = {goal: 'g', plan: '✓ 1 a · → 2 b (next)', edits: [], diagnostics: {}, commands: [], hidden: [], runs: [], focus: {target: 'unknown'}, lastKeyAt: 0, buffers: [], jumps: [], searches: [], tasks: []};
  assert.match(describeState(state, 0), /^Goal: g\nPlan \(✓ done, → next, ○ open\): ✓ 1 a · → 2 b \(next\)$/m);
});

function session({plan = 'the cart tests pass\nthe bogo code works', done = 'done: 1', buffer = null} = {}) {
  let clock = 10 * MIN;
  const sent = [];
  const asked = [];
  const models = [];
  const actions = [];
  const store = {
    addMessage() {}, setGoal() {}, lastRemark: () => null, showRemark() {}, addRemark: () => 1, dropRemark() {},
    addAction: action => actions.push(action) && actions.length, updateAction() {}, actions: () => [],
  };
  const pair = new PairSession({
    record: {id: 1, root: scratch('thread-'), conversation_id: 7, goal: null, level: 'normal', started_at: 0},
    store, score: async () => ({value: 0}), typingPauseMs: 2000,
    partner: {thinkingOf: () => 'off', ask: async (_id, input) => { asked.push(input); return 'Fine.'; }},
    askModel: async (prompt, content) => { models.push({prompt, content}); return prompt === PLAN_PROMPT ? plan : done; },
    notify: (role, message) => sent.push({role, ...message}),
    requestEditor: async message => (message.type === 'read' && buffer ? {text: buffer} : null),
    now: () => clock,
  });
  pair.health = {ok: () => true};
  const said = () => sent.filter(message => message.type === 'message' && message.sender === 'pair').map(message => message.text);
  return {pair, sent, asked, models, actions, said, advance: ms => { clock += ms; }, at: () => clock};
}

const settle = () => new Promise(resolve => setImmediate(resolve));
/** Until the running plan proposal or done check is over: it reads git, so it takes a few turns of the loop. */
async function checked(pair) {
  await settle();
  for (let i = 0; i < 200 && pair.threading; i++) await new Promise(resolve => setTimeout(resolve, 5));
}

test('a goal gets its steps in one line of Pair\'s, which costs the talk budget; p can edit them', async () => {
  const {pair, sent, said} = session();
  pair.setGoal('make the cart tests pass, then add buy N get one free');
  await settle();
  assert.deepEqual(said(), ['Steps: 1 the cart tests pass · 2 the bogo code works']);
  assert.equal(pair.budget.allows(pair.now()).ok, false, 'paid for like a remark');
  assert.deepEqual(sent.filter(message => message.type === 'plan').map(({steps, proposed}) => ({steps, proposed})), [{steps: 'the cart tests pass; the bogo code works', proposed: true}]);
  assert.match(pair.state.plan, /→ 1 the cart tests pass/);
});

test('with the budget spent, the steps are kept unsaid; a goal too small for steps gets none', async () => {
  const spent = session();
  spent.pair.budget.spend(spent.at());
  spent.pair.setGoal('a goal');
  await settle();
  assert.deepEqual(spent.said(), []);
  assert.equal(spent.pair.planSteps(), 'the cart tests pass; the bogo code works');
  const small = session({plan: 'NONE'});
  small.pair.setGoal('rename a variable');
  await settle();
  assert.deepEqual(small.said(), []);
  assert.equal(small.pair.planSteps(), null);
});

test('going green says done and next at the next break, from the session\'s facts', async () => {
  const {pair, models, said, advance, at} = session();
  pair.setGoal('cart');
  await settle();
  pair.receive({kind: 'command_end', cmd: 'npm test', exit: 1, output: 'fail', at: at()});
  advance(4 * MIN); // past the budget's gap since the steps line
  pair.receive({kind: 'typing', at: at()});
  pair.receive({kind: 'command_end', cmd: 'npm test', exit: 0, output: 'ok', at: at()});
  await pair.tick();
  assert.equal(models.length, 1, 'not while they type');
  advance(3000);
  await pair.tick();
  await checked(pair);
  const check = models.at(-1);
  assert.equal(check.prompt, DONE_PROMPT);
  assert.match(check.content, /Just now: `npm test` passes again/);
  assert.match(check.content, /Commands that pass again after failing: `npm test`/);
  assert.deepEqual(said().slice(1), ['done: the cart tests pass; next: the bogo code works']);
  assert.match(pair.state.plan, /✓ 1 the cart tests pass · → 2 the bogo code works/);
  await pair.tick();
  assert.equal(models.length, 2, 'said once');
});

test('a landing that finished no step says nothing; one the budget holds back waits for it', async () => {
  const none = session({done: 'NONE'});
  none.pair.setPlan('a; b');
  none.pair.thread.land('a commit', none.at());
  none.advance(4 * MIN);
  await none.pair.tick();
  await checked(none.pair);
  assert.equal(none.models.length, 1);
  assert.deepEqual(none.said(), []);
  assert.ok(none.actions.some(action => action.kind === 'quiet' && /no step done yet/.test(JSON.stringify(action))));

  const held = session();
  held.pair.setPlan('a; b');
  held.pair.budget.spend(held.at());
  held.pair.thread.land('a commit', held.at());
  held.advance(MIN);
  await held.pair.tick();
  assert.equal(held.models.length, 0, 'the budget holds it');
  held.advance(3 * MIN);
  await held.pair.tick();
  await checked(held.pair);
  assert.deepEqual(held.said(), ['done: a; next: b']);
});

test('your own steps replace Pair\'s, and /plan off drops them: nothing lands after', async () => {
  const {pair, sent, models} = session();
  pair.setPlan('fix it; ship it');
  assert.equal(pair.planSteps(), 'fix it; ship it');
  pair.dropPlan();
  assert.equal(pair.planSteps(), null);
  assert.equal(pair.state.plan, null);
  assert.equal(sent.filter(message => message.type === 'plan').at(-1).steps, null);
  pair.thread.land('a commit', pair.now());
  await pair.tick();
  assert.equal(models.length, 0);
});

test('a question after the user changed lines gets those lines as they are now, so no stale read', async () => {
  const buffer = ['function total(lines) {', '  return lines.reduce((sum, line) => sum + line.price * line.qty, 0);', '}', ''].join('\n');
  const {pair, asked, advance, at} = session({buffer});
  writeFileSync(join(pair.root, 'cart.js'), buffer);
  pair.setGoal('later');
  await pair.ask('what does total do?');
  assert.doesNotMatch(asked[0], /changed these lines/, 'nothing changed yet');
  advance(1000);
  pair.receive({kind: 'edit', file: 'cart.js', from: 2, to: 2, text: buffer.split('\n')[1], at: at()});
  advance(1000);
  await pair.ask('write the bogo branch');
  assert.match(asked[1], /The user changed these lines since your last turn; they are now as below, and any earlier read of them is stale:\ncart\.js:1-3\n1: function total\(lines\) \{\n2:   return lines\.reduce\(\(sum, line\) => sum \+ line\.price \* line\.qty, 0\);\n3: \}/);
  await pair.ask('and now?');
  assert.doesNotMatch(asked[2], /changed these lines/, 'told once');
});
