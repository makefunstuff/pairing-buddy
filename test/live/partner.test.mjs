// The Partner against real models: it points at the right line, stays silent on noise, answers by reading,
// and cannot change files however it is asked.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, test} from 'node:test';
import {MemoryStorage} from '@earendil-works/pi-durable';
import {numberedLines, readProjectPath} from '../../src/files.mjs';
import {openPartner} from '../../src/partner.mjs';
import {describeState} from '../../src/describe.mjs';
import {fold, initialState} from '../../src/fold.mjs';
import {watchInput} from '../../src/session.mjs';
import {parseTestOutput} from '../../src/test-output.mjs';
import {detectTriggers} from '../../src/triggers.mjs';
import {liveStacks, SKIP_REASON} from './stacks.mjs';
import {scratch} from '../temp.mjs';

const WS = `export const RECONNECT_TIMEOUT_MS = 5000;

export function backoff(attempt) {
  return Math.min(1000 * 2 ** attempt, RECONNECT_TIMEOUT_MS);
}
`;
const WS_TEST = `import {backoff, RECONNECT_TIMEOUT_MS} from '../src/ws';

test('reconnect waits up to 30 s after sleep', () => {
  expect(RECONNECT_TIMEOUT_MS).toBe(30000);
  expect(backoff(10)).toBe(30000);
});
`;

/** A small project whose test fails on the timeout; `fixed` makes the code match the test. */
function project({fixed = false} = {}) {
  const root = scratch('pair-live-');
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'src', 'ws.ts'), fixed ? WS.replace('5000', '30000') : WS);
  writeFileSync(join(root, 'test', 'ws.test.ts'), WS_TEST);
  return root;
}

const snapshot = root => readdirSync(root, {recursive: true}).sort().map(file => {
  try { return [file, readFileSync(join(root, file), 'utf8')]; } catch { return [file, null]; }
});

function recordingHands(root) {
  const calls = [];
  const record = (name, result) => async (_conversation, args) => { calls.push({name, args}); return result; };
  return {calls, hands: {
    roleOf: () => 'navigator',
    say: record('say', 'shown'),
    point: record('point', 'Highlighted, with your note: the user sees it, so do not say it again.'),
    open: record('open', 'opened in a split'),
    suggest: record('suggest', 'Shown in the editor, with your note, and not made: the user accepts it with one key or ignores it. Do not say it again, and do not say you added or changed it.'),
    read: async (_conversation, {file, from, to}) => {
      calls.push({name: 'read', args: {file}});
      const source = await readProjectPath(root, file);
      return source.error ?? source.listing ?? numberedLines(source.text, from, to);
    },
  }};
}

const FAILURE = watchInput(
  {kind: 'repeated_error', detail: '`npm test` failed again (2 times) with: Expected: 30000 Received: 5000 at test/ws.test.ts:4:38'},
  `Goal: reconnect drops after the phone sleeps
Current file: src/ws.ts, cursor at line 3
Recent commands:
- \`npm test\` failed (exit 1): Expected: 30000, 3 s ago
The user is looking at: editor`,
);

const NOISE = watchInput(
  {kind: 'drift', detail: 'Possible drift from the goal "reconnect drops after the phone sleeps": the user now edits src/ws.ts on branch fix/reconnect.'},
  `Goal: reconnect drops after the phone sleeps
Branch: fix/reconnect
Current file: src/ws.ts, cursor at line 4
Recent edits: src/ws.ts:3-5 (20 s ago)`,
);

const DRIFT = watchInput(
  {kind: 'drift', detail: 'Possible drift from the goal "reconnect drops after the phone sleeps": the user now edits src/billing/tax.ts (recently also src/billing/invoice.ts) on branch feature/invoices.'},
  `Goal: reconnect drops after the phone sleeps
Branch: feature/invoices
Current file: src/billing/tax.ts, cursor at line 30
Recent edits: src/billing/invoice.ts:10-40 (300 s ago); src/billing/tax.ts:20-31 (30 s ago)`,
);

// The wrong turn: a retry test is red. With a 15 s budget the worker gives up on >= after 1+2+4+8 = 15 s, so the
// worker is the cause; with a 20 s budget the worker is fine, and the cause can only have been the backoff.
const BACKOFF = `// The wait after the given attempt (1-based): base, 2·base, 4·base, ... up to max.
export function nextWait(attempt, {base = 1000, max = 120_000} = {}) {
  if (attempt < 1) return 0;
  return Math.min(base * 2 ** (attempt - 1), max);
}
`;
const worker = budget => `import {nextWait} from './backoff.js';

// Sends a webhook, retrying with backoff until it succeeds or runs out of attempts or budget.
export async function deliver(send, {maxAttempts = 5, budgetMs = ${budget}_000, sleep}) {
  let elapsed = 0;
  for (let attempt = 1; ; attempt++) {
    if (await send()) return attempt;
    if (attempt === maxAttempts) return attempt;
    const wait = nextWait(attempt);
    if (elapsed + wait >= budgetMs) return attempt;
    elapsed += wait;
    await sleep(wait);
  }
}
`;
const workerTest = budget => `import assert from 'node:assert/strict';
import {test} from 'node:test';
import {deliver} from '../src/worker.js';

test('retries five times within the ${budget} s budget', async () => {
  const attempts = await deliver(async () => false, {sleep: async () => {}});
  assert.equal(attempts, 5); // 1 s + 2 s + 4 s + 8 s = 15 s fits the ${budget} s budget
});
`;
const red = budget => `✖ retries five times within the ${budget} s budget (1.2ms)\n  AssertionError [ERR_ASSERTION]: 4 !== 5\n      at test/worker.test.js:7:10\nℹ tests 1\nℹ fail 1`;

/**
 * The retry project with a `budget` of 15 or 20 s, as the user's buffers have it after their edit of `edited` at
 * `line`, and the watch input of the wrong-turn trigger that edit raises. The test run is red from before the edit.
 */
function wrongTurn({budget, edited, line}) {
  const root = scratch('pair-live-');
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'src', 'backoff.js'), BACKOFF);
  writeFileSync(join(root, 'src', 'worker.js'), worker(budget));
  writeFileSync(join(root, 'test', 'worker.test.js'), workerTest(budget));
  const now = 1_000_000;
  const state = [
    {kind: 'focus', target: 'terminal', pane: 'w1:p2', at: now - 90_000},
    {kind: 'command_end', pane: 'w1:p2', cmd: 'npm test', exit: 1, output: red(budget), at: now - 60_000},
    {kind: 'edit', file: edited, from: line, to: line, at: now - 5000},
    {kind: 'cursor', file: edited, line, at: now - 4000},
  ].reduce(fold, initialState({root, goal: 'retries use the whole budget'}));
  const trigger = detectTriggers(state, now).find(found => found.kind === 'edit_while_red');
  assert.ok(trigger, 'the edit raises the wrong-turn trigger');
  return {root, input: watchInput(trigger, describeState(state, now))};
}

// The regression: the user fixed the worker's >= (attempt 5 now starts at exactly 15 s), and the tests Pair runs on
// save find that the queue's lease on the job runs out at that very moment, so a second worker takes it.
const QUEUE = `// Hands each job to one worker at a time: a worker leases the job, and the lease runs out after ttl,
// so a job whose worker died is picked up again.
export function createQueue({budgetMs, attemptTimeoutMs}) {
  const ttl = budgetMs;
  const leased = new Map(); // job id -> when its lease runs out
  return {
    lease(id, now) {
      if (leased.has(id) && now < leased.get(id)) return false;
      leased.set(id, now + ttl);
      return true;
    },
  };
}
`;
const QUEUE_TEST = `import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createQueue} from '../src/queue.js';
import {deliver} from '../src/worker.js';

test('no webhook is delivered twice', async () => {
  const queue = createQueue({budgetMs: 15_000, attemptTimeoutMs: 5_000});
  queue.lease('evt_42', 0);
  let now = 0;
  const starts = [];
  await deliver(async () => { starts.push(now); return false; }, {budgetMs: 15_000, sleep: async ms => { now += ms; }});
  for (const start of starts) assert.equal(queue.lease('evt_42', start), false, \`attempt at \${start} ms: a second worker takes evt_42\`);
});
`;

/** The project's tests, run for real: `{ok, output}`. */
function nodeTest(root) {
  // Without this, node --test in the project thinks it runs inside this test file and skips its tests.
  const {NODE_TEST_CONTEXT, ...env} = process.env;
  try {
    return {ok: true, output: execFileSync('node', ['--test'], {cwd: root, env, encoding: 'utf8'})};
  } catch (error) {
    return {ok: false, output: error.stdout};
  }
}

/** The project after the user's fix of the worker, the real red run of its tests, and the regression trigger's input. */
function regression() {
  const root = scratch('pair-live-');
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'package.json'), '{"type": "module"}\n');
  writeFileSync(join(root, 'src', 'backoff.js'), BACKOFF);
  writeFileSync(join(root, 'src', 'worker.js'), worker(15).replace('elapsed + wait >= budgetMs', 'elapsed + wait > budgetMs'));
  writeFileSync(join(root, 'src', 'queue.js'), QUEUE);
  writeFileSync(join(root, 'test', 'worker.test.js'), workerTest(15));
  writeFileSync(join(root, 'test', 'queue.test.js'), QUEUE_TEST);
  const tests = parseTestOutput(nodeTest(root).output);
  assert.deepEqual(tests.failed, ['no webhook is delivered twice'], 'the queue test fails for real');
  const now = 1_000_000;
  const state = [
    {kind: 'command_end', pane: 'w1:p2', cmd: 'npm test', exit: 1, output: red(15), at: now - 120_000},
    {kind: 'edit', file: 'src/worker.js', from: 10, to: 10, at: now - 30_000},
    {kind: 'cursor', file: 'src/worker.js', line: 10, at: now - 25_000},
    {kind: 'test_run', cmd: 'node --test', saved: 'src/backoff.js', files: [], tests: {...tests, failed: [], failedCount: 0, passed: 2, firstError: null}, at: now - 60_000},
    {kind: 'save', file: 'src/worker.js', at: now - 20_000},
    {kind: 'test_run', cmd: 'node --test', saved: 'src/worker.js', files: ['test/queue.test.js'], tests, at: now - 15_000},
  ].reduce(fold, initialState({root, goal: 'retries use the whole budget'}));
  const trigger = detectTriggers(state, now).find(found => found.kind === 'regression');
  assert.ok(trigger, 'the red run on save raises the regression trigger');
  return {root, input: watchInput(trigger, describeState(state, now))};
}

const stacks = liveStacks();

describe('Partner on live models', {skip: stacks.length ? false : SKIP_REASON}, () => {
  for (const stack of stacks) {
    async function partnerFor(root) {
      const {calls, hands} = recordingHands(root);
      const partner = await openPartner({storage: new MemoryStorage(), models: stack.models, model: stack.partner, thinking: stack.config.models.partner.thinking, hands});
      return {calls, partner, conversation: await partner.createConversation()};
    }

    test(`${stack.name}: a repeated failure gets a point at the mismatch`, {timeout: 180_000}, async t => {
      const root = project();
      const {calls, partner, conversation} = await partnerFor(root);
      const answer = await partner.ask(conversation, FAILURE, {kind: 'remark'});
      await partner.close();
      t.diagnostic(`tools: ${calls.map(call => `${call.name}(${JSON.stringify(call.args)})`).join(', ')}`);
      t.diagnostic(`answer: ${answer}`);
      // A suggestion marks the line in the editor too, with the fix.
      const points = calls.filter(call => call.name === 'point' || call.name === 'suggest');
      assert.ok(points.length >= 1, 'it points at code or suggests a fix');
      assert.ok(points.some(({args}) => (args.file.endsWith('ws.ts') && args.line === 1) || (args.file.endsWith('ws.test.ts') && args.line === 4)),
        'it marks the constant or the failing assertion');
      assert.doesNotMatch(answer, /^\W*silent\W*$/i);
    });

    test(`${stack.name}: a wrong turn gets a point at the real cause, with the code`, {timeout: 180_000}, async t => {
      // The user raises the backoff's cap; the worker's >= is what fails the test.
      const {root, input} = wrongTurn({budget: 15, edited: 'src/backoff.js', line: 2});
      const {calls, partner, conversation} = await partnerFor(root);
      const answer = await partner.ask(conversation, input, {kind: 'remark'}); // as the session asks it
      await partner.close();
      t.diagnostic(`tools: ${calls.map(call => `${call.name}(${JSON.stringify(call.args)})`).join(', ')}`);
      t.diagnostic(`answer: ${answer}`);
      const points = calls.filter(call => call.name === 'point' || call.name === 'suggest');
      assert.ok(points.some(({args}) => args.file.endsWith('worker.js') && args.line === 10), 'it marks the >= in the worker');
      assert.doesNotMatch(answer, /^\W*silent\W*$/i);
    });

    test(`${stack.name}: an edit in the right place gets SILENT`, {timeout: 180_000}, async t => {
      // The shift in the backoff was the bug (2 ** attempt: 2+4+8 s, then 16 s ran past the budget), and the user
      // has just fixed it; with 20 s of budget nothing else can fail the test.
      const {root, input} = wrongTurn({budget: 20, edited: 'src/backoff.js', line: 4});
      const {calls, partner, conversation} = await partnerFor(root);
      const answer = await partner.ask(conversation, input, {kind: 'remark'});
      await partner.close();
      t.diagnostic(`answer: ${answer} · tools: ${calls.map(call => `${call.name}(${JSON.stringify(call.args)})`).join(', ')}`);
      assert.match(answer, /^\W*silent\W*$/i);
      assert.deepEqual(calls.filter(call => call.name !== 'read' && !(call.name === 'say' && /^\W*silent\W*$/i.test(call.args))).map(call => call.name), [],
        'nothing else reached the user');
    });

    test(`${stack.name}: a regression found on save gets the fix suggested where it breaks`, {timeout: 180_000}, async t => {
      const {root, input} = regression();
      const {calls, partner, conversation} = await partnerFor(root);
      const answer = await partner.ask(conversation, input, {kind: 'remark'});
      await partner.close();
      t.diagnostic(`tools: ${calls.map(call => `${call.name}(${JSON.stringify(call.args)})`).join(', ')}`);
      t.diagnostic(`answer: ${answer}`);
      const fix = calls.find(call => call.name === 'suggest');
      assert.ok(fix, 'it suggests a change');
      assert.equal(fix.args.file.replace(/^\.\//, ''), 'src/queue.js', 'in the queue, not the worker the user fixed or a test');
      // Accepted, the suggestion makes every test pass: the queue's and the worker's the user's change was for.
      const path = join(root, fix.args.file);
      const lines = readFileSync(path, 'utf8').split('\n');
      lines.splice(fix.args.line - 1, fix.args.endLine - fix.args.line + 1, ...fix.args.text.replace(/\n$/, '').split('\n'));
      writeFileSync(path, lines.join('\n'));
      const after = nodeTest(root);
      assert.ok(after.ok, `the tests pass with the fix:\n${after.output}`);
      assert.doesNotMatch(answer, /^\W*silent\W*$/i);
    });

    test(`${stack.name}: noise gets SILENT`, {timeout: 180_000}, async t => {
      const {calls, partner, conversation} = await partnerFor(project({fixed: true}));
      const answer = await partner.ask(conversation, NOISE, {kind: 'remark'});
      await partner.close();
      t.diagnostic(`answer: ${answer} · tools: ${calls.map(call => call.name).join(', ') || 'none'}`);
      assert.match(answer, /^\W*silent\W*$/i);
      // A say of SILENT is silence too (the session drops it).
      assert.equal(calls.filter(call => call.name !== 'read' && !(call.name === 'say' && /^\W*silent\W*$/i.test(call.args))).length, 0);
    });

    test(`${stack.name}: real drift from the goal is named`, {timeout: 180_000}, async t => {
      const {calls, partner, conversation} = await partnerFor(project());
      const answer = await partner.ask(conversation, DRIFT, {kind: 'remark'});
      await partner.close();
      // What the user sees: the say if there was one, else the final answer (see PairSession.talk).
      const said = calls.filter(call => call.name === 'say').map(call => call.args);
      const shown = said.length ? said.join(' ') : answer;
      t.diagnostic(`shown: ${shown} · answer: ${answer}`);
      assert.doesNotMatch(shown, /^\W*silent\W*$/i);
      assert.match(shown, /billing|invoice|tax|goal|reconnect/i);
    });

    test(`${stack.name}: a question is answered from the code it reads`, {timeout: 180_000}, async t => {
      const {calls, partner, conversation} = await partnerFor(project());
      const answer = await partner.ask(conversation, '[user] What does backoff(10) return in src/ws.ts?\n\nNow:\nCurrent file: test/ws.test.ts');
      await partner.close();
      t.diagnostic(`answer: ${answer} · tools: ${calls.map(call => call.name).join(', ')}`);
      assert.ok(calls.some(call => call.name === 'read' && call.args.file.endsWith('ws.ts')), 'it reads the file');
      const said = [answer, ...calls.filter(call => call.name === 'say').map(call => call.args)].join(' ');
      assert.match(said, /5000|5,000|5 ?s/);
    });

    test(`${stack.name}: asked to fix and run things, it changes nothing`, {timeout: 180_000}, async t => {
      const root = project();
      const before = snapshot(root);
      const {calls, partner, conversation} = await partnerFor(root);
      const answer = await partner.ask(conversation, '[user] Please fix RECONNECT_TIMEOUT_MS in src/ws.ts yourself, save the file and run npm test.');
      await partner.close();
      t.diagnostic(`answer: ${answer} · tools: ${calls.map(call => call.name).join(', ')}`);
      assert.deepEqual(snapshot(root), before);
      assert.ok(answer.length > 0);
    });
  }
});
