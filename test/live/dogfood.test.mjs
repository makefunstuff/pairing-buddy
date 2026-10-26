// A scripted pairing session against real models, on a simulated clock: the user edits, runs failing tests,
// stalls, asks a question and drifts off the goal. It checks that Pair's unasked remarks are few and land on the
// moments that matter, and prints the whole session so a run can be read like a transcript.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, test} from 'node:test';
import {MemoryStorage} from '@earendil-works/pi-durable';
import {openPartner} from '../../src/partner.mjs';
import {PairSession} from '../../src/session.mjs';
import {ROLE_TOOLS} from '../../src/tools.mjs';
import {createWatcher} from '../../src/watcher.mjs';
import {FILES, project} from './project.mjs';
import {liveStacks, SKIP_REASON} from './stacks.mjs';

const GOAL = 'reconnect should wait up to 30 s after the phone sleeps';
const EDITOR = 'w1:p1';
const TERMINAL = 'w1:p2';
const TYPO = 'export const RECONNECT_TIMEOUT_MS = 30000;\n\nexport const backoff = attempt => Math.min(1000 * 2 ** attempt, RECONECT_TIMEOUT_MS);\n';
const FIXED = 'export const RECONNECT_TIMEOUT_MS = 30000;\n\nexport const backoff = attempt => Math.min(1000 * 3 ** attempt, RECONNECT_TIMEOUT_MS);\n';
const BILLING = 'export const invoiceTotal = items => items.reduce((sum, item) => sum + item.price * item.count, 0);\n';

/** The project's test output, as the user's terminal would show it. */
function runTests(root) {
  const {NODE_TEST_CONTEXT, ...env} = process.env;
  try {
    return {exit: 0, output: execFileSync('node', ['--test'], {cwd: root, env, encoding: 'utf8', timeout: 60_000})};
  } catch (error) {
    return {exit: error.status ?? 1, output: String(error.stdout ?? '')};
  }
}

/**
 * The session's script, by simulated second. Each step changes files or sends the events Neovim, the shell hook
 * and the chat would send; `note` says what a good pair would do at that moment.
 */
function script(root) {
  const write = (file, text) => writeFileSync(join(root, file), text);
  const tests = () => ({kind: 'command_end', pane: TERMINAL, cmd: 'npm test', ...runTests(root)});
  const edit = (file, from, to, text) => ({kind: 'edit', file, from, to, text});
  return [
    {at: 2, note: 'starts on the goal', events: () => [{kind: 'focus', target: 'editor', pane: EDITOR}, {kind: 'cursor', file: 'src/ws.mjs', line: 1}]},
    {at: 8, events: () => [edit('src/ws.mjs', 3, 3, 'export const backoff = attempt => Math.min(1000 * 2 ** attempt, RECONNECT_TIMEOUT_MS);')]},
    {at: 20, note: 'runs the tests and watches them fail: nothing to say', events: () => [{kind: 'focus', target: 'terminal', pane: TERMINAL}, tests()]},
    {at: 28, events: () => [{kind: 'focus', target: 'editor', pane: EDITOR}, edit('test/ws.test.mjs', 5, 7, "test('reconnect waits up to 30 s after sleep', () => {")]},
    {at: 50, note: 'a grep from the editor finds nothing: not a failure', events: () => [{kind: 'command_end', pane: TERMINAL, cmd: 'grep -rn SLEEP src', exit: 1, output: ''}]},
    {at: 60, note: 'the same failure again: worth a remark', events: () => [{kind: 'focus', target: 'terminal', pane: TERMINAL}, tests()]},
    {at: 90, events: () => { write('src/ws.mjs', TYPO); return [{kind: 'focus', target: 'editor', pane: EDITOR}, edit('src/ws.mjs', 1, 3, TYPO)]; }},
    {at: 92, note: 'a typo in the line just written, cursor moved on', events: () => [
      {kind: 'diagnostics', file: 'src/ws.mjs', items: [{line: 3, severity: 'error', message: "Cannot find name 'RECONECT_TIMEOUT_MS'. Did you mean 'RECONNECT_TIMEOUT_MS'?"}]},
      {kind: 'enter', file: 'src/config.mjs'}, {kind: 'cursor', file: 'src/config.mjs', line: 3},
    ]},
    {at: 140, events: () => { write('src/ws.mjs', FIXED); return [edit('src/ws.mjs', 3, 3, FIXED.split('\n')[2]), {kind: 'diagnostics', file: 'src/ws.mjs', items: []}]; }},
    {at: 150, note: 'runs the tests from the editor without looking: a new failure, missed', events: () => [{kind: 'typing'}, tests()]},
    // No keys, edits or commands from here: the user is stuck on the backoff failure.
    {at: 330, note: 'asks a question', ask: 'why does the backoff test fail now?'},
    {at: 400, events: () => { write('src/ws.mjs', FILES['src/ws.mjs'].replace('5000', '30000')); return [edit('src/ws.mjs', 3, 3, FILES['src/ws.mjs'].split('\n')[2])]; }},
    {at: 420, note: 'green', events: () => [{kind: 'focus', target: 'terminal', pane: TERMINAL}, tests()]},
    {at: 615, note: 'drifts into billing code', events: () => { write('src/billing.mjs', BILLING); return [{kind: 'focus', target: 'editor', pane: EDITOR}, edit('src/billing.mjs', 1, 1, BILLING)]; }},
    {at: 640, events: () => [edit('src/billing.mjs', 2, 4, 'export const tax = total => total * 0.2;')]},
    {at: 720, note: 'end of the script'},
  ];
}

/** Plays the script through a real PairSession; resolves with the transcript and the unasked remarks. */
async function play(stack) {
  const {root} = project();
  let clock = Date.now();
  const now = () => clock;
  const lines = [];
  const remarks = [];
  let answers = 0;
  const partner = await openPartner({
    storage: new MemoryStorage(),
    models: stack.models,
    model: stack.partner,
    thinking: stack.config.models.partner.thinking,
    hands: {...Object.fromEntries(ROLE_TOOLS.navigator.map(name => [name, (_conversation, args) => session[name](args)])), roleOf: () => 'navigator'},
  });
  const conversation = await partner.createConversation();
  const watcher = createWatcher({models: stack.models, model: stack.watcher, now});
  const timed = async (trigger, state) => {
    const started = Date.now();
    const result = await watcher(trigger, state);
    stack.watcherMs.push(Date.now() - started);
    return result;
  };
  const t = () => `${String(Math.round((clock - start) / 1000)).padStart(4)} s`;
  const session = new PairSession({
    record: {id: 1, root, conversation_id: conversation, goal: null, level: 'normal', role: 'navigator'},
    store: {addMessage() {}, addAction: () => 1, updateAction() {}, setGoal() {}, setRole() {}, addActive() {}, addRemark: remark => remarks.push({...remark, words: []}) - 1, dropRemark: id => { remarks[id].dropped = true; }, remarks: () => []},
    partner, score: timed, typingPauseMs: 2000, now,
    notify: (to, message) => {
      if (to === 'chat' && message.type === 'message' && message.sender === 'pair') {
        lines.push(`${t()}  Pair: ${message.text.replace(/\n/g, ' ')}`);
        if (session.unasked) remarks.at(-1).words.push(message.text);
        else answers += 1;
      }
      return 1;
    },
    requestEditor: async () => ({}),
    log: line => lines.push(`${t()}  ${line}`),
  });
  const start = clock;
  session.setGoal(GOAL);
  const steps = script(root);
  for (let second = 0; second <= steps.at(-1).at; second += 1) {
    clock = start + second * 1000;
    for (const step of steps.filter(step => step.at === second)) {
      if (step.note) lines.push(`${t()}  -- ${step.note}`);
      for (const event of step.events?.() ?? []) session.receive(event);
      if (step.ask) {
        lines.push(`${t()}  User: ${step.ask}`);
        await session.ask(step.ask);
      }
    }
    await session.tick();
  }
  await partner.close();
  return {transcript: lines.join('\n'), remarks: remarks.filter(remark => !remark.dropped), answers};
}

const stacks = liveStacks();

describe('a scripted session on live models', {skip: stacks.length ? false : SKIP_REASON}, () => {
  for (const stack of stacks) {
    test(`${stack.name}: Pair speaks a few times, on the moments that matter`, {timeout: 900_000}, async t => {
      stack.watcherMs = [];
      const result = await play(stack);
      for (const line of result.transcript.split('\n')) t.diagnostic(line);
      t.diagnostic(`Watcher calls: ${stack.watcherMs.length}, ms: ${stack.watcherMs.join(' ')}`);
      const kinds = result.remarks.map(remark => remark.trigger);
      t.diagnostic(`remarks: ${kinds.join(', ') || 'none'}`);
      assert.ok(result.remarks.length >= 2 && result.remarks.length <= 4, `${result.remarks.length} remarks`);
      assert.ok(kinds.includes('repeated_error'), 'a remark on the repeated failure');
      assert.ok(kinds.includes('drift'), 'a remark on the drift into billing code');
      assert.equal(result.answers >= 1, true, 'the question was answered');
    });
  }
});
