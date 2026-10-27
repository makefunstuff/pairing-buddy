// The decision model: its config, the questions through pi-ai, and the gate with fake decision models that answer
// fixed probabilities, slowly, not at all, or nonsense. No real provider: the one HTTP test talks to a fake server.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {test} from 'node:test';
import {providerDecisionModels, providerModels} from '../src/auth.mjs';
import {Budget} from '../src/budget.mjs';
import {decisionConfig, parseConfig} from '../src/config.mjs';
import {createDecider, DecisionModel, momentState, pastVerdicts, probeDecision, QUESTIONS, SURE} from '../src/decision.mjs';
import {decisionCheck} from '../src/doctor.mjs';
import {initialState} from '../src/fold.mjs';
import {decide} from '../src/gate.mjs';
import {Ledger, today} from '../src/ledger.mjs';
import {createDecisionModel} from '../src/models.mjs';
import {Pace} from '../src/pace.mjs';
import {configChanges} from '../src/reload.mjs';
import {keyVariables} from '../src/service-env.mjs';
import {decisionLines, statsReport} from '../src/stats.mjs';
import {openStore} from '../src/store.mjs';
import {scratch} from './temp.mjs';

const MIN = 60_000;
const credentials = {read: async () => null};
const model = {type: 'classifier', id: 'fake-jev', api: 'typesafe-system-one', provider: 'fake'};

/** A pi-ai `models` whose `classify` answers `answer(context)` after `ms`, and counts its calls. */
function fakeModels(answer, {ms = 0} = {}) {
  const asked = [];
  return {
    asked,
    classify: async (_model, context, options) => {
      asked.push(context);
      if (ms) await new Promise(resolve => setTimeout(resolve, ms));
      if (options?.signal?.aborted) return {stopReason: 'aborted', errorMessage: 'aborted', answers: {}};
      return answer(context);
    },
  };
}

const answers = (moment, p, speak) => ({
  stopReason: 'stop',
  answers: {
    moment: {type: 'choice', choice: moment, probabilities: {noise: 0, worth: 0, ask: 0, [moment]: p}, confidence: p},
    speak: {type: 'bool', probability: speak},
  },
});

test('the decision entry: none is null; a provider and its model, or an api at a baseUrl, with a timeout', () => {
  assert.equal(decisionConfig(undefined), null);
  assert.deepEqual(decisionConfig({provider: 'openrouter', model: 'typesafe/jev-1.14'}), {contextWindow: 32768, provider: 'openrouter', model: 'typesafe/jev-1.14', timeoutMs: 1500});
  assert.equal(decisionConfig({api: 'openai', baseUrl: 'http://gateway.example/v1', model: 'd', timeoutMs: 800}).timeoutMs, 800);
  assert.throws(() => decisionConfig({api: 'anthropic', baseUrl: 'http://x', model: 'd'}), /"openai", "system-one", "llama-cpp"/);
  assert.throws(() => decisionConfig({api: 'system-one', model: 'd'}), /decision.baseUrl is missing/);
  assert.throws(() => decisionConfig({provider: 'typesafe'}), /decision.model is missing/);
  assert.throws(() => decisionConfig({provider: 'typesafe', model: 'jev-latest', apiKey: 'k'}), /pair auth login typesafe/);
  assert.throws(() => decisionConfig({api: 'openai', baseUrl: 'http://x', model: 'd', timeoutMs: 0}), /timeoutMs/);
  const config = parseConfig({model: {api: 'openai', baseUrl: 'http://x/v1', model: 'm'}, decision: {api: 'openai', baseUrl: 'http://x/v1', model: 'd', apiKeyEnv: 'GATEWAY_KEY'}});
  assert.equal(config.decision.model, 'd');
  assert.deepEqual(keyVariables(config), ['GATEWAY_KEY']);
  assert.equal(parseConfig({model: {api: 'openai', baseUrl: 'http://x/v1', model: 'm'}}).decision, null);
  assert.deepEqual(configChanges(parseConfig({model: {api: 'openai', baseUrl: 'http://x/v1', model: 'm'}}), config), ['decision']);
});

test('the decision model comes from pi-ai: a provider\'s catalog, or a classifier API at a baseUrl', () => {
  const jev = createDecisionModel({decision: decisionConfig({provider: 'openrouter', model: 'typesafe/jev-1.14'})}, {credentials});
  assert.deepEqual([jev.model.type, jev.model.provider, jev.model.api], ['classifier', 'openrouter', 'typesafe-system-one']);
  assert.throws(() => createDecisionModel({decision: decisionConfig({provider: 'typesafe', model: 'jev-0'})}, {credentials}), /not a typesafe decision model; it has jev-latest/);
  assert.throws(() => createDecisionModel({decision: decisionConfig({provider: 'nowhere', model: 'x'})}, {credentials}), /not a provider pi-ai knows/);
  for (const [api, wire] of [['openai', 'openai-decisions'], ['system-one', 'typesafe-system-one'], ['llama-cpp', 'llama-cpp-classify']]) {
    const gateway = createDecisionModel({decision: decisionConfig({api, baseUrl: 'http://gateway.example/v1', model: 'd'})}, {credentials});
    assert.deepEqual([gateway.model.api, gateway.model.baseUrl], [wire, 'http://gateway.example/v1']);
  }
  assert.equal(createDecisionModel({decision: null}), null);
  // `pair auth models` lists them after the chat models.
  assert.deepEqual(providerDecisionModels('typesafe'), ['jev-latest']);
  assert.ok(providerDecisionModels('openrouter').includes('typesafe/jev-1.14'));
  assert.ok(!providerModels('openrouter').includes('typesafe/jev-1.14'));
  assert.deepEqual(providerDecisionModels('anthropic'), []);
});

test('a decision with fixed probabilities: both questions in one request, with the state', async () => {
  const models = fakeModels(() => answers('worth', 0.9, 0.7));
  const ask = createDecider({models, model, timeoutMs: 500});
  const result = await ask(['moment', 'speak'], {moment: {kind: 'failed_command'}});
  assert.equal(result.ok, true);
  assert.equal(result.answers.moment.choice, 'worth');
  assert.equal(result.answers.speak.probability, 0.7);
  assert.deepEqual(Object.keys(models.asked[0].questions), ['moment', 'speak']);
  assert.deepEqual(models.asked[0].questions.moment, QUESTIONS.moment);
  assert.deepEqual(models.asked[0].state, {moment: {kind: 'failed_command'}});
});

test('a slow decision model is given up at its timeout, whatever the provider does with the signal', async () => {
  const never = {classify: () => new Promise(() => {})}; // ignores the signal and never answers
  const started = Date.now();
  const result = await createDecider({models: never, model, timeoutMs: 100})(['speak'], {});
  assert.deepEqual([result.ok, result.why], [false, 'timeout']);
  assert.ok(Date.now() - started < 400, `gave up after ${Date.now() - started} ms`);
  const slow = await createDecider({models: fakeModels(() => answers('ask', 1, 1), {ms: 300}), model, timeoutMs: 50})(['speak'], {});
  assert.equal(slow.why, 'timeout');
});

test('a decision model that is down, throws, or answers nonsense gives no answer to go by', async () => {
  const down = await createDecider({models: fakeModels(() => ({stopReason: 'error', errorMessage: 'connect ECONNREFUSED', answers: {}})), model, timeoutMs: 500})(['speak'], {});
  assert.deepEqual([down.ok, down.why, down.error], [false, 'error', 'connect ECONNREFUSED']);
  const thrown = await createDecider({models: {classify: async () => { throw new Error('boom'); }}, model, timeoutMs: 500})(['speak'], {});
  assert.deepEqual([thrown.why, thrown.error], ['error', 'boom']);
  const timedOut = await createDecider({models: fakeModels(() => ({stopReason: 'error', errorMessage: 'Request timed out after 500ms', answers: {}})), model, timeoutMs: 500})(['speak'], {});
  assert.equal(timedOut.why, 'timeout');
  const malformed = [
    {speak: {type: 'choice', choice: 'yes', probabilities: {}}}, // the wrong type
    {speak: {type: 'bool', probability: 1.5}}, // no probability
    {speak: {type: 'bool', probability: Number.NaN}},
    {}, // no answer at all
  ];
  for (const given of malformed) {
    const result = await createDecider({models: fakeModels(() => ({stopReason: 'stop', answers: given})), model, timeoutMs: 500})(['speak'], {});
    assert.deepEqual([result.ok, result.why], [false, 'malformed'], JSON.stringify(given));
  }
  for (const name of ['constructor', 'toString', '__proto__']) {
    const inherited = await createDecider({models: fakeModels(() => answers(name, 0.9, 0.5)), model, timeoutMs: 500})(['moment', 'speak'], {});
    assert.equal(inherited.why, 'malformed', `"${name}" is no choice offered`);
  }
  const offList = await createDecider({models: fakeModels(() => answers('maybe', 0.9, 0.5)), model, timeoutMs: 500})(['moment', 'speak'], {});
  assert.equal(offList.why, 'malformed');
});

test('a decision model that fails is down at once, said once, not waited for, and comes back on a probe', async () => {
  let failing = true;
  let calls = 0;
  const ask = async () => { calls += 1; return failing ? {ok: false, why: 'timeout', error: 'no answer within 1500 ms', ms: 1500} : {ok: true, answers: {speak: {type: 'bool', probability: 0.5}}, ms: 40}; };
  const changes = [];
  const decision = new DecisionModel({ask, onChange: reason => changes.push(reason)});
  assert.equal((await decision.decide(['speak'], {})).why, 'timeout');
  assert.deepEqual(changes, ['too slow: no answer within 1500 ms']);
  for (let i = 0; i < 3; i++) assert.equal((await decision.decide(['speak'], {})).why, 'down');
  assert.equal(calls, 1, 'not asked while down');
  failing = false;
  await decision.check();
  assert.deepEqual(changes, ['too slow: no answer within 1500 ms', null]);
  assert.equal((await decision.decide(['speak'], {})).ok, true);
  assert.deepEqual(decision.snapshot(), {down: null, calls: 2, fallbacks: 4});
});

test('a malformed answer costs that decision only, and is logged once', async () => {
  const logged = [];
  const changes = [];
  const decision = new DecisionModel({ask: async () => ({ok: false, why: 'malformed', error: 'the answer to "speak" is not a bool answer'}), log: line => logged.push(line), onChange: reason => changes.push(reason)});
  for (let i = 0; i < 3; i++) assert.equal((await decision.decide(['speak'], {})).why, 'malformed');
  assert.equal(logged.length, 1);
  assert.deepEqual(changes, []);
  assert.equal(decision.down, null);
});

// The gate with a decider, as the session builds it on the decision model.
const failure = {kind: 'failed_command', key: 'k', detail: 'npm test failed'};
function run({sort, speak = async () => ({p: 0.9}), score = 7, level = 'normal', pace = null, trigger = failure} = {}) {
  const scored = [];
  const spoken = [];
  const decider = {sort: async () => sort, speak: async (...args) => { spoken.push(args[2]); return speak(...args); }};
  const watcher = async t => { scored.push(t); return {value: score, reason: ''}; };
  return decide({trigger, state: initialState(), now: 10 * MIN, budget: new Budget(level), score: watcher, typingPauseMs: 2000, pace, decider})
    .then(decision => ({decision, scored, spoken}));
}

test('the gate drops a moment the decision model is sure is noise, without the Watcher', async () => {
  const {decision, scored} = await run({sort: {choice: 'noise', p: 0.93, speak: 0.9}});
  assert.deepEqual([decision.verdict, decision.reason, decision.byModel], ['drop', 'the decision model: noise (93%)', true]);
  assert.deepEqual(decision.decided, {sort: 'noise', sortP: 0.93, fallback: null});
  assert.equal(scored.length, 0);
});

test('a moment plainly worth it goes by the speak probability against the bar, without the Watcher', async () => {
  const spoke = await run({sort: {choice: 'worth', p: 0.9, speak: 0.65}});
  assert.equal(spoke.decision.verdict, 'speak');
  assert.match(spoke.decision.reason, /worth a remark \(90%\), worth interrupting for now 65%/);
  assert.equal(spoke.decision.score, undefined);
  assert.equal(spoke.scored.length, 0);
  // At quiet the bar is 8: 65% is not enough.
  const quiet = await run({sort: {choice: 'worth', p: 0.9, speak: 0.65}, level: 'quiet'});
  assert.equal(quiet.decision.verdict, 'drop');
  assert.match(quiet.decision.reason, /65% < 80%/);
});

test('an unsure sort asks the Watcher, then the model again with its score; the rule is logged beside it', async () => {
  const asked = await run({sort: {choice: 'ask', p: 0.7, speak: 0.2}, speak: async () => ({p: 0.4}), score: 7});
  assert.equal(asked.scored.length, 1);
  assert.deepEqual(asked.spoken, [{score: 7, bar: 6}]);
  assert.equal(asked.decision.verdict, 'drop', '40% < 60%, though the score passes the bar');
  assert.deepEqual(asked.decision.decided, {sort: 'ask', sortP: 0.7, fallback: null, speakP: 0.4, score: 7, rule: 'speak'});
  assert.equal(asked.decision.score, 7);
  // Noise the model is not SURE of is the Watcher's to judge too.
  const unsure = await run({sort: {choice: 'noise', p: SURE - 0.1, speak: 0.1}, speak: async () => ({p: 0.8})});
  assert.deepEqual([unsure.scored.length, unsure.decision.verdict], [1, 'speak']);
});

test('without an answer the gate goes by the Watcher\'s score and the bar, as without a decision model', async () => {
  const fallback = await run({sort: {fallback: 'timeout'}, speak: async () => ({fallback: 'down'}), score: 7});
  assert.equal(fallback.decision.verdict, 'speak');
  assert.equal(fallback.decision.reason, 'score 7');
  assert.equal(fallback.decision.decided.fallback, 'timeout', 'the first cause: the sort timed out, then the model was down');
  assert.equal(fallback.decision.decided.rule, 'speak');
  const low = await run({sort: {fallback: 'down'}, speak: async () => ({fallback: 'down'}), score: 3});
  assert.equal(low.decision.reason, 'score 3 < 6');
  const plain = await decide({trigger: failure, state: initialState(), now: 10 * MIN, budget: new Budget('normal'), score: async () => ({value: 7, reason: ''}), typingPauseMs: 2000});
  assert.deepEqual(plain, {verdict: 'speak', reason: 'score 7', score: 7}, 'no decider: the decision is what it always was');
});

test('the Watcher\'s pace still holds back what goes to the Watcher, and only that', async () => {
  const pace = new Pace();
  for (let i = 0; i < 6; i++) pace.hear(3500);
  const drift = {kind: 'drift', key: 'd', detail: '', file: 'billing.ts', lasting: true};
  const skipped = await run({sort: {choice: 'ask', p: 0.9, speak: 0.9}, pace, trigger: drift});
  assert.deepEqual([skipped.decision.verdict, skipped.decision.skipped, skipped.scored.length], ['drop', true, 0]);
  const sorted = await run({sort: {choice: 'worth', p: 0.9, speak: 0.9}, pace, trigger: drift});
  assert.equal(sorted.decision.verdict, 'speak', 'sorted without the Watcher, so the pace does not hold it back');
});

test('the state the model judges: the moment, the score, typing, the last remark, recent work and past verdicts', () => {
  const now = 100 * MIN;
  const state = {
    ...initialState({goal: 'fix reconnect'}),
    file: 'src/ws.js',
    lastKeyAt: now - 3000,
    typed: [now - 50 * 1000, now - 40 * 1000, now - 3000, now - 2 * MIN],
    edits: [{file: 'src/ws.js', from: 1, to: 2, at: now - 4000}],
    commands: [{cmd: 'npm test', exit: 1, endedAt: now - 5000}],
    tests: {passed: 10, failedCount: 2, by: 'you', at: now - 5000},
  };
  const remarks = [
    {id: 3, trigger: 'failed_command', score: 8, verdict: 'useful', at: now - MIN},
    {id: 2, trigger: 'failed_command', score: 6, verdict: null, at: now - 30 * MIN}, // never judged: ignored
    {id: 1, trigger: 'drift', score: 7, verdict: 'dismissed', at: now - 40 * MIN},
    {id: 0, trigger: 'failed_command', score: 6, verdict: null, at: now - MIN}, // too young to tell
  ];
  const past = pastVerdicts(remarks, 'failed_command', now);
  assert.deepEqual(past.this_kind, {useful: 1, dismissed: 0, ignored: 1});
  assert.deepEqual(past.examples.map(example => example.verdict), ['useful', 'ignored', 'dismissed']);
  const json = momentState({trigger: failure, state, now, level: 'normal', bar: 6, score: 7, lastRemarkAt: now - 10 * MIN, past});
  assert.deepEqual(json.moment, {kind: 'failed_command', what_happened: 'npm test failed', watcher_score: 7, watcher_bar: 6});
  assert.deepEqual(json.user, {goal: 'fix reconnect', file: 'src/ws.js', seconds_since_last_keystroke: 3, seconds_typed_in_last_minute: 1.5, seconds_since_last_unasked_remark: 600, talk_level: 'normal'});
  assert.deepEqual(json.recent.commands, [{cmd: 'npm test', exit: 1, seconds_ago: 5}]);
  assert.deepEqual(json.recent.tests, {passed: 10, failed: 2, by: 'you', seconds_ago: 5});
  assert.equal(json.past_verdicts, past);
  const first = momentState({trigger: failure, state: initialState(), now, level: 'quiet', bar: 8, past});
  assert.equal(first.moment.watcher_score, undefined, 'no score before the Watcher is asked');
  assert.equal(first.user.seconds_since_last_unasked_remark, null);
});

test('each decision is logged with its probabilities, and linked to the remark it led to', () => {
  const store = openStore(join(scratch('pair-store-'), 'sessions.sqlite'));
  const session = store.createSession({root: '/p', conversationId: 'c', goal: null, level: 'normal', at: 0});
  const told = {moment: {kind: 'failed_command', what_happened: 'npm test failed'}, past_verdicts: {this_kind: {useful: 1, dismissed: 0, ignored: 0}, examples: []}};
  const id = store.addDecision({sessionId: session.id, at: 1000, trigger: 'failed_command', sort: 'worth', sortP: 0.9, speakP: 0.8, bar: 6, verdict: 'speak', state: told});
  const remark = store.addRemark({sessionId: session.id, trigger: 'failed_command', score: null, at: 1000});
  store.linkDecision(id, remark);
  store.rateRemark(remark, 'useful');
  store.addDecision({sessionId: session.id, at: 2000, trigger: 'drift', fallback: 'down', score: 3, rule: 'drop', verdict: 'drop'});
  const [down, spoke] = store.decisions(0);
  assert.deepEqual({...spoke}, {
    id, trigger: 'failed_command', at: 1000, sort: 'worth', sortP: 0.9, speakP: 0.8, score: null, bar: 6, rule: null, decided: 'speak', fallback: null,
    remarkId: remark, state: told, root: '/p', remarkAt: 1000, verdict: 'useful', shown: 0,
  });
  assert.deepEqual([down.fallback, down.rule, down.remarkAt, down.state], ['down', 'drop', null, null]);
  store.close();
});

test('a moment the decision model let pass is booked as such in the ledger', () => {
  const store = openStore(join(scratch('pair-store-'), 'sessions.sqlite'));
  const session = store.createSession({root: '/p', conversationId: 'c', goal: null, level: 'normal', at: 0});
  const ledger = new Ledger({store, sessionId: session.id, now: () => 5000});
  ledger.quiet('drift', 'the decision model: noise (90%)', {model: true});
  ledger.quiet('failed_command', 'score 3 < 6');
  const entries = today(store, '/p', 5000);
  assert.ok(JSON.stringify(entries.rows).includes('2 moments: 1 under the bar, 1 not worth it, said the decision model'), JSON.stringify(entries));
  store.close();
});

test('pair stats: what the model sorted, the calls it saved, and its remarks next to the rules\'', () => {
  const now = 10 * 24 * 60 * MIN;
  const row = fields => ({fallback: null, sort: null, sortP: null, speakP: null, score: null, rule: null, remarkId: null, remarkAt: null, verdict: null, root: '/p', at: now - MIN, ...fields});
  const decisions = [
    row({sort: 'noise', sortP: 0.9, decided: 'drop'}),
    row({sort: 'worth', sortP: 0.9, speakP: 0.8, decided: 'speak', remarkId: 1, remarkAt: now - 20 * MIN, verdict: 'useful'}),
    row({sort: 'ask', sortP: 0.6, speakP: 0.7, score: 5, rule: 'drop', decided: 'speak', remarkId: 2, remarkAt: now - 20 * MIN, verdict: 'useful'}),
    row({sort: 'ask', sortP: 0.6, speakP: 0.2, score: 8, rule: 'speak', decided: 'drop'}),
    row({sort: 'ask', sortP: 0.5, speakP: 0.9, score: 9, rule: 'speak', decided: 'speak', remarkId: 3, remarkAt: now - 20 * MIN, verdict: 'dismissed'}),
    row({sort: 'ask', sortP: 0.7, decided: 'drop'}), // the pace held it back: no call, but not the model's saving
    row({sort: 'noise', sortP: 0.6, decided: 'drop'}), // unsure noise, held back by the pace too
    row({fallback: 'timeout', score: 7, rule: 'speak', decided: 'speak', remarkId: 4, remarkAt: now - 20 * MIN, verdict: 'dismissed'}),
  ];
  const remarks = [1, 2, 3, 4, 5].map(id => ({id, trigger: 'failed_command', at: now - 20 * MIN, verdict: id === 5 ? 'useful' : id < 3 ? 'useful' : 'dismissed', root: '/p'}));
  const lines = decisionLines(decisions, remarks, now);
  assert.deepEqual(lines, [
    '',
    'Decision model: 8 moments judged; it answered 7, the rules decided the rest (timeout 1)',
    '  sorted as noise 2 · worth it 1 · for the Watcher 4; 2 Watcher calls saved',
    '  its remarks: 3: useful 2 · dismissed 1 · ignored 0 · kept 67%',
    '  the rules\' remarks (the Watcher\'s score against the bar): 2: useful 1 · dismissed 1 · ignored 0 · kept 50%',
    '  where the Watcher scored too, the model and the bar agreed on 1 of 3: it spoke 1 time the bar would not, and stayed quiet 1 time the bar would have spoken',
  ]);
  assert.deepEqual(decisionLines([], remarks, now), [], 'no decision model: nothing more');
  const report = statsReport({remarks, activeMs: 3_600_000, now, days: 7, level: 'normal', autoTune: false, decisions});
  assert.ok(report.includes('Decision model: 8 moments judged; it answered 7, the rules decided the rest (timeout 1)'));
  assert.ok(!statsReport({remarks, activeMs: 0, now, days: 7, level: 'normal', autoTune: false}).some(line => line.startsWith('Decision model')));
});

/** A fake System One server (the API TypeSafe and OpenRouter serve): `respond(body)` is its answer, after `ms`. */
async function systemOneServer(respond, {ms = 0} = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', chunk => { text += chunk; }).on('end', () => {
      const body = JSON.parse(text);
      requests.push({url: request.url, auth: request.headers.authorization, body});
      setTimeout(() => {
        if (response.destroyed) return;
        response.writeHead(200, {'content-type': 'application/json'});
        response.end(JSON.stringify(respond(body)));
      }, ms);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {url: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => { server.closeAllConnections(); server.close(); }};
}

test('through pi-ai to a gateway at a baseUrl: the System One request, its key, and the answers back', async () => {
  const server = await systemOneServer(() => ({answers: {moment: {type: 'choice', choice: 'noise', probabilities: {noise: 0.91, worth: 0.04, ask: 0.05}, confidence: 0.91}, speak: {type: 'noul', noul: 0.12}}}));
  try {
    process.env.PAIR_TEST_DECISION_KEY = 'test-key';
    const entry = decisionConfig({api: 'system-one', baseUrl: server.url, model: 'jev', apiKeyEnv: 'PAIR_TEST_DECISION_KEY', timeoutMs: 2000});
    const built = createDecisionModel({decision: entry}, {credentials});
    const result = await createDecider({models: built.models, model: built.model, timeoutMs: entry.timeoutMs})(['moment', 'speak'], {moment: {kind: 'stall'}});
    assert.equal(result.ok, true, result.error);
    assert.deepEqual([result.answers.moment.choice, result.answers.moment.probabilities.noise, result.answers.speak.probability], ['noise', 0.91, 0.12]);
    const [request] = server.requests;
    assert.equal(request.url, '/v1/systemone');
    assert.equal(request.auth, 'Bearer test-key');
    assert.deepEqual([request.body.model, request.body.state, request.body.questions.speak.type], ['jev', {moment: {kind: 'stall'}}, 'noul']);
  } finally {
    delete process.env.PAIR_TEST_DECISION_KEY;
    server.close();
  }
});

test('pair doctor: no decision model, one that answers, one that is too slow, one that fails', async () => {
  const base = parseConfig({model: {api: 'openai', baseUrl: 'http://x/v1', model: 'm'}});
  assert.match((await decisionCheck(base, null, credentials)).text, /^none: the speak gate goes by the Watcher's score/);
  const fast = await systemOneServer(() => ({answers: {speak: {type: 'noul', noul: 0.5}}}));
  const slow = await systemOneServer(() => ({answers: {speak: {type: 'noul', noul: 0.5}}}), {ms: 500});
  try {
    const at = (url, timeoutMs = 1500) => ({...base, decision: decisionConfig({api: 'system-one', baseUrl: url, model: 'jev', apiKey: 'k', timeoutMs})});
    const ok = await decisionCheck(at(fast.url), {decision: {down: null, calls: 12, fallbacks: 1}}, credentials);
    assert.equal(ok.level, 'ok');
    assert.match(ok.text, /^jev at http:\/\/127\.0\.0\.1:\d+\/v1 answers in \d\.\d s \(it may take 1\.5 s\); since the daemon started it was asked 12 times and the gate fell back 1 time$/);
    const late = await decisionCheck(at(slow.url, 100), null, credentials);
    assert.equal(late.level, 'fail');
    assert.match(late.text, /fails: no answer within 100 ms\. Until it answers, the gate goes by its own rules; a faster model, or a higher "timeoutMs", lets it decide/);
    const stillDown = await decisionCheck(at(fast.url), {decision: {down: 'too slow', calls: 1, fallbacks: 1}}, credentials);
    assert.equal(stillDown.level, 'warn');
    const nobody = await decisionCheck(at('http://127.0.0.1:9/v1'), null, credentials);
    assert.equal(nobody.level, 'fail');
    const unknown = await decisionCheck({...base, decision: decisionConfig({provider: 'typesafe', model: 'jev-0'})}, null, credentials);
    assert.match(unknown.text, /not a typesafe decision model/);
  } finally {
    fast.close();
    slow.close();
  }
});

test('the probe asks one small question', async () => {
  const models = fakeModels(() => ({stopReason: 'stop', answers: {speak: {type: 'bool', probability: 0.3}}}));
  const probe = await probeDecision(createDecider({models, model, timeoutMs: 500}));
  assert.equal(probe.ok, true);
  assert.deepEqual(Object.keys(models.asked[0].questions), ['speak']);
});
