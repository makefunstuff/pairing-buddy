// The decision model in the daemon, end to end over its socket: a fake decision model in front of scripted Watcher and
// Partner models. It lets a failure through without the Watcher, and when it stops answering Pair says so once and
// goes on by the Watcher's score.
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {test} from 'node:test';
import {createModels, fauxAssistantMessage, fauxProvider, fauxText} from '@earendil-works/pi-ai';
import {parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {requestDaemon} from '../src/protocol.mjs';
import {openStore} from '../src/store.mjs';
import {client} from './daemon-client.mjs';
import {scratch} from './temp.mjs';

function scriptedModels() {
  const watcher = fauxProvider({provider: 'faux-watcher'});
  const partner = fauxProvider({provider: 'faux-partner'});
  const models = createModels();
  models.setProvider(watcher.provider);
  models.setProvider(partner.provider);
  return {watcher, partner, pairModels: {models, watcher: watcher.getModel(), partner: partner.getModel()}};
}

/** A fake decision model: `answer(context)` is what `classify` resolves; `asked` keeps each request. */
function fakeDecision(answer) {
  const asked = [];
  const models = {classify: async (_model, context) => { asked.push(context); return answer(context); }};
  return {asked, decisionFor: config => (config.decision ? {models, model: {type: 'classifier', id: 'fake-jev', api: 'typesafe-system-one', provider: 'fake'}} : null)};
}

const worth = {
  stopReason: 'stop',
  answers: {moment: {type: 'choice', choice: 'worth', probabilities: {noise: 0.02, worth: 0.95, ask: 0.03}, confidence: 0.95}, speak: {type: 'bool', probability: 0.9}},
};
const probed = context => Object.keys(context.questions).join() === 'speak' && context.state.moment.kind === 'probe';

async function until(check, what) {
  for (const started = Date.now(); !check(); await new Promise(resolve => setTimeout(resolve, 20))) {
    if (Date.now() - started > 10_000) throw new Error(`timed out waiting for ${typeof what === 'function' ? what() : what}`);
  }
}

test('the decision model lets a failure through without the Watcher, logs it, and when it goes down Pair says so once and asks the Watcher', {timeout: 30_000}, async () => {
  const project = scratch('pair-project-');
  const dataDir = scratch('pair-data-');
  const config = parseConfig({
    dataDir, socket: join(dataDir, 'pair.sock'), typingPauseMs: 50, agents: false, keepWarm: false,
    models: {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'w'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'p'}},
    decision: {api: 'system-one', baseUrl: 'http://unused', model: 'fake-jev', timeoutMs: 500},
  });
  const {watcher, partner, pairModels} = scriptedModels();
  let down = false;
  const decision = fakeDecision(context => (down && !probed(context) ? {stopReason: 'error', errorMessage: 'connect ECONNREFUSED', answers: {}} : probed(context)
    ? {stopReason: 'stop', answers: {speak: {type: 'bool', probability: 0.5}}} : worth));
  const logged = [];
  const daemon = await startDaemon(config, {pairModels, decisionFor: decision.decisionFor, probe: async () => ({ok: true}), log: line => logged.push(line)});
  const editor = client(config.socket, {type: 'hello', role: 'editor', cwd: project});
  const chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project});
  let other = null;
  try {
    await chat.next(message => message.type === 'welcome');
    chat.send({type: 'goal', text: 'fix reconnect'});
    await chat.next(message => message.text === 'Goal: fix reconnect');

    partner.setResponses([fauxAssistantMessage([fauxText('npm test fails twice the same way: the timeout.')])]);
    for (let n = 0; n < 2; n++) editor.send({type: 'command', cwd: project, pane: null, cmd: 'npm test', exit: 1});
    await chat.next(message => message.text === 'npm test fails twice the same way: the timeout.');
    assert.equal(watcher.state.callCount, 0, 'the Watcher was not asked');
    const sorted = decision.asked.find(context => context.questions.moment);
    assert.equal(sorted.state.moment.kind, 'repeated_error');
    assert.equal(sorted.state.user.goal, 'fix reconnect');
    assert.ok(logged.some(line => /repeated_error: speak \(the decision model: worth a remark \(95%\), worth interrupting for now 90%\)/.test(line)), logged.join('\n'));

    // The model goes down: one notice, and the next failure goes by the Watcher's score. In another project, whose
    // budget the remark above did not spend.
    down = true;
    watcher.setResponses([fauxAssistantMessage([fauxText('2')])]);
    const elsewhere = scratch('pair-other-');
    other = client(config.socket, {type: 'hello', role: 'editor', cwd: elsewhere});
    await other.next(message => message.type === 'welcome');
    for (let n = 0; n < 2; n++) other.send({type: 'command', cwd: elsewhere, pane: null, cmd: 'cargo build', exit: 1});
    const notice = await chat.next(message => message.type === 'health' && /decision model/.test(message.text));
    assert.match(notice.text, /^The decision model is not answering \(connect ECONNREFUSED\)\. Pair decides by its own rules until it answers again; `pair doctor` checks it\.$/);
    await until(() => watcher.state.callCount === 1, 'the Watcher to score the failure');
    await until(() => logged.some(line => /repeated_error: drop \(score 2 < 6/.test(line)), () => logged.join('\n'));
    const status = await requestDaemon(config.socket, {type: 'status'});
    assert.equal(status.decision.down, 'connect ECONNREFUSED');
    assert.equal(chat.received.filter(message => /decision model/.test(message.text ?? '')).length, 1, 'said once');
  } finally {
    other?.close();
    editor.close();
    chat.close();
    await daemon.close();
  }
  const store = openStore(join(dataDir, 'sessions.sqlite'));
  const [fellBack, spoke] = store.decisions(0);
  assert.deepEqual([spoke.sort, spoke.sortP, spoke.speakP, spoke.decided, spoke.remarkId !== null, spoke.score], ['worth', 0.95, 0.9, 'speak', true, null]);
  assert.deepEqual([fellBack.fallback, fellBack.score, fellBack.rule, fellBack.decided], ['down', 2, 'drop', 'drop']);
  store.close();
});

test('without a decision entry the daemon builds no decision model and the gate is as it was', {timeout: 20_000}, async () => {
  const project = scratch('pair-project-');
  const dataDir = scratch('pair-data-');
  const config = parseConfig({
    dataDir, socket: join(dataDir, 'pair.sock'), typingPauseMs: 50, agents: false, keepWarm: false,
    models: {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'w'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'p'}},
  });
  const {watcher, pairModels} = scriptedModels();
  const decision = fakeDecision(() => worth);
  const logged = [];
  const daemon = await startDaemon(config, {pairModels, decisionFor: decision.decisionFor, probe: async () => ({ok: true}), log: line => logged.push(line)});
  const editor = client(config.socket, {type: 'hello', role: 'editor', cwd: project});
  try {
    await editor.next(message => message.type === 'welcome');
    watcher.setResponses([fauxAssistantMessage([fauxText('1')])]);
    for (let n = 0; n < 2; n++) editor.send({type: 'command', cwd: project, pane: null, cmd: 'npm test', exit: 1});
    await until(() => logged.some(line => /repeated_error: drop \(score 1 < 6\)/.test(line)), () => logged.join('\n'));
    assert.equal(decision.asked.length, 0);
    assert.equal((await requestDaemon(config.socket, {type: 'status'})).decision, null);
  } finally {
    editor.close();
    await daemon.close();
  }
  const store = openStore(join(dataDir, 'sessions.sqlite'));
  assert.deepEqual(store.decisions(0), []);
  store.close();
});
