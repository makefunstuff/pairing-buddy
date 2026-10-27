// The live check of the decision model: moments through the real speak gate and prefilter, with the decision model of
// the config's `decision` entry, or of `--entry`. It reports how often the gate was right with the model and with the
// rules alone (the Watcher's score against the bar), how often the prefilter's sure sorts were right, the Watcher
// calls they saved, and the latency and cost of each call, for each of `--runs` runs.
//
// The moments are the hand-written samples in test/fixtures/decision-moments.json (with a sample history of verdicts,
// which the model is told as calibration), or, with `--store PATH`, moments the daemon recorded in a sessions.sqlite:
// each decision it logged with the state the model was told, whose remark you judged (useful: a remark was wanted;
// dismissed or ignored: it was not). Not a test, and not part of `npm test`: it asks a real model with your login or
// key, so run it by hand. `--fake` runs it against a fake model, to check the script itself.
//   node test/decision-check.mjs [--entry '{"provider": "openrouter", "model": "typesafe/jev-1.14"}'] [--store PATH]
//     [--level normal] [--runs 1] [--fake]
import {readFileSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {Budget} from '../src/budget.mjs';
import {decisionConfig, loadConfig} from '../src/config.mjs';
import {createDecider, DecisionModel, momentState, pastVerdicts, SURE} from '../src/decision.mjs';
import {initialState} from '../src/fold.mjs';
import {decide} from '../src/gate.mjs';
import {createDecisionModel} from '../src/models.mjs';
import {openStore} from '../src/store.mjs';
import {outcome} from '../src/tuning.mjs';

const {values} = parseArgs({options: {
  entry: {type: 'string'}, store: {type: 'string'}, level: {type: 'string', default: 'normal'}, runs: {type: 'string', default: '1'}, fake: {type: 'boolean'},
}});
const NOW = 10 * 60 * 60_000;
const ago = seconds => NOW - seconds * 1000;

/** The hand-written samples: each moment's trigger, the session state at NOW, and the model's state. */
function samples() {
  const sample = JSON.parse(readFileSync(new URL('./fixtures/decision-moments.json', import.meta.url), 'utf8'));
  const remarks = sample.past.map((remark, id) => ({id, trigger: remark.trigger, score: remark.score, verdict: remark.verdict, at: NOW - remark.minutes * 60_000}));
  return sample.moments.map(moment => {
    const state = {
      ...initialState({root: '/project', goal: sample.goal}),
      file: moment.edits.at(-1)?.[0] ?? null,
      lastKeyAt: moment.typed.length ? ago(Math.min(...moment.typed)) : ago(600),
      typed: moment.typed.map(ago),
      edits: moment.edits.map(([file, seconds]) => ({file, from: 1, to: 1, at: ago(seconds)})),
      commands: moment.commands.map(([cmd, exit, seconds]) => ({cmd, exit, endedAt: ago(seconds)})),
      tests: moment.tests ? {passed: moment.tests.passed, failedCount: moment.tests.failedCount, by: 'you', at: ago(moment.tests.ago)} : null,
    };
    const trigger = {key: moment.name, ...moment.trigger};
    const told = ({bar, score = null}) => momentState({trigger, state, now: NOW, level: values.level, bar, score, past: pastVerdicts(remarks, trigger.kind, NOW)});
    return {name: moment.name, expect: moment.expect, score: moment.score, trigger, state, told};
  });
}

/**
 * Moments the daemon recorded: logged decisions with the state the model was told and a judged remark. The Watcher's
 * score is the one recorded; a moment the Watcher was not asked about has none, so the rules cannot judge it.
 */
function recordedMoments(path) {
  const store = openStore(path);
  try {
    const now = Date.now();
    return store.decisions(0).filter(row => row.state && row.remarkAt !== null).flatMap(row => {
      const verdict = outcome({verdict: row.verdict, at: row.remarkAt}, now);
      if (!['useful', 'dismissed', 'ignored'].includes(verdict)) return [];
      const {watcher_score: _score, watcher_bar: _bar, ...moment} = row.state.moment;
      const told = ({bar, score = null}) => ({...row.state, moment: {...moment, ...(score === null ? {} : {watcher_score: score, watcher_bar: bar})}});
      return [{
        name: `${row.trigger} #${row.id}`, expect: verdict === 'useful' ? 'speak' : 'quiet', score: row.score,
        trigger: {kind: row.trigger, key: `d${row.id}`}, state: initialState(), told,
      }];
    });
  } finally {
    store.close();
  }
}

/** A fake decision model: noise for a low score, worth it for a high one, unsure between. */
function fakeModels() {
  return {
    classify: async (_model, context) => {
      await new Promise(resolve => setTimeout(resolve, 20));
      const score = context.state.moment.watcher_score ?? (/twice|SIGSEGV|uninitialized/.test(context.state.moment.what_happened) ? 8 : 3);
      const choice = score >= 7 ? 'worth' : score <= 2 ? 'noise' : 'ask';
      return {
        stopReason: 'stop',
        usage: {input: 400, output: 0, cost: {total: 0}},
        answers: {
          moment: {type: 'choice', choice, probabilities: {noise: 0.05, worth: 0.05, ask: 0.05, [choice]: 0.85}, confidence: 0.85},
          speak: {type: 'bool', probability: score / 10},
        },
      };
    },
  };
}

const entry = values.fake ? null : values.entry ? decisionConfig(JSON.parse(values.entry)) : loadConfig().decision;
if (!values.fake && !entry) throw new Error('no decision entry: set "decision" in the config, pass --entry, or --fake');
const built = values.fake ? {models: fakeModels(), model: {id: 'fake'}} : createDecisionModel({decision: entry});
const timeoutMs = entry?.timeoutMs ?? 1500;
const moments = values.store ? recordedMoments(values.store) : samples();
if (!moments.length) throw new Error(`${values.store}: no logged decision with its state and a judged remark yet`);

/** One run over every moment: a row per moment, and every call with its latency and cost. */
async function run() {
  const calls = [];
  const timed = {
    classify: async (model, context, options) => {
      const started = performance.now();
      const result = await built.models.classify(model, context, options);
      calls.push({ms: performance.now() - started, cost: result.usage?.cost?.total ?? null, input: result.usage?.input ?? null, ok: result.stopReason === 'stop', error: result.errorMessage});
      return result;
    },
  };
  const decision = new DecisionModel({
    ask: createDecider({models: timed, model: built.model, timeoutMs}),
    log: line => console.log(`  log: ${line}`),
    onChange: reason => console.log(`  ${reason ? `down: ${reason}` : 'answers again'}`),
  });
  const rows = [];
  for (const moment of moments) {
    const budget = new Budget(values.level);
    let watcherAsked = false;
    const decider = {
      sort: async (_trigger, _state, {bar}) => {
        const result = await decision.decide(['moment', 'speak'], moment.told({bar}));
        if (!result.ok) return {fallback: result.why};
        const {moment: sorted, speak} = result.answers;
        return {choice: sorted.choice, p: sorted.probabilities?.[sorted.choice] ?? sorted.confidence, speak: speak.probability};
      },
      speak: async (_trigger, _state, {score, bar}) => {
        const result = await decision.decide(['speak'], moment.told({bar, score}));
        return result.ok ? {p: result.answers.speak.probability} : {fallback: result.why};
      },
    };
    // A recorded moment the Watcher was not asked about has no score: it scores 0, and the rules cannot judge it.
    const watcher = async () => { watcherAsked = true; return {value: moment.score ?? 0, reason: ''}; };
    const gate = await decide({trigger: moment.trigger, state: moment.state, now: NOW, budget, score: watcher, typingPauseMs: 2000, decider});
    const rule = moment.score === null ? null : moment.score >= budget.barFor(moment.trigger.kind) ? 'speak' : 'quiet';
    rows.push({moment, gate: gate.verdict === 'speak' ? 'speak' : 'quiet', rule, watcherAsked, decided: gate.decided ?? {}});
  }
  return {rows, calls};
}

const pct = (n, of) => (of ? `${Math.round((100 * n) / of)}%` : '-');
const percent = p => (p === null || p === undefined ? '   -' : `${Math.round(p * 100)}%`.padStart(4));
const at = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const sure = row => ['noise', 'worth'].includes(row.decided.sort) && row.decided.sortP >= SURE;
const where = values.fake ? 'fake' : `${entry.model}${entry.provider ? ` on ${entry.provider}` : ` at ${entry.baseUrl}`}`;
console.log(`Decision model ${where}, level ${values.level}, ${moments.length} ${values.store ? 'recorded moments' : 'hand-written sample moments'}`);

const runs = Number(values.runs);
for (let n = 1; n <= runs; n++) {
  const {rows, calls} = await run();
  console.log(`\nRun ${n} of ${runs}\n`);
  for (const row of rows) {
    console.log(`${row.gate === row.moment.expect ? 'ok ' : 'NO '} want ${row.moment.expect.padEnd(5)} gate ${row.gate.padEnd(5)} rules ${(row.rule ?? '-').padEnd(5)}`
      + ` sort ${(row.decided.sort ?? '-').padEnd(5)} ${percent(row.decided.sortP)} speak ${percent(row.decided.speakP)}${row.watcherAsked ? '  (Watcher asked)' : ''}  ${row.moment.name}`);
  }
  const right = rows.filter(row => row.gate === row.moment.expect).length;
  const judged = rows.filter(row => row.rule !== null);
  const ruleRight = judged.filter(row => row.rule === row.moment.expect).length;
  const sorted = rows.filter(sure);
  const sortRight = sorted.filter(row => (row.decided.sort === 'worth') === (row.moment.expect === 'speak')).length;
  const answered = calls.filter(call => call.ok);
  const latency = answered.map(call => call.ms).sort((a, b) => a - b);
  const costs = answered.map(call => call.cost).filter(cost => cost !== null);
  const inputs = answered.map(call => call.input).filter(Boolean);
  console.log(`
Gate with the model: ${right} of ${rows.length} right (${pct(right, rows.length)}); the rules alone: ${ruleRight} of ${judged.length} (${pct(ruleRight, judged.length)})
Prefilter: ${sorted.length} moments sorted as noise or worth it at ${pct(SURE * 100, 100)} or more, ${sortRight} of them right (${pct(sortRight, sorted.length)}); the rest went to the Watcher
Watcher calls saved: ${rows.filter(row => !row.watcherAsked && sure(row)).length} of ${rows.length}
Calls: ${calls.length}, ${answered.length} answered${calls.length > answered.length ? ` (failed: ${[...new Set(calls.filter(call => !call.ok).map(call => call.error))].join('; ')})` : ''}
Latency per call: median ${Math.round(at(latency, 0.5) ?? 0)} ms, p90 ${Math.round(at(latency, 0.9) ?? 0)} ms, slowest ${Math.round(latency.at(-1) ?? 0)} ms (timeout ${timeoutMs} ms)
Cost per call: ${costs.length ? `$${(costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(6)} on average, ${Math.round(inputs.reduce((a, b) => a + b, 0) / (inputs.length || 1))} input tokens` : 'not reported by the provider'}`);
}
