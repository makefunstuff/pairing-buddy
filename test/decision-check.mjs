// The live check of the decision model: recorded moments (test/fixtures/decision-moments.json, each with the Watcher's
// score it got and whether a remark was wanted) through the real speak gate, with the decision model of the config's
// `decision` entry, or of `--entry`. It reports how often the gate was right with the model and with the rules alone
// (the recorded score against the bar), how often the prefilter's sort was right, the Watcher calls it saved, and the
// latency and cost of each call. Not a test, and not part of `npm test`: it asks a real model with your login or key,
// so run it by hand. `--fake` runs it against a fake model, to check the script itself.
//   node test/decision-check.mjs [--entry '{"provider": "openrouter", "model": "typesafe/jev-1.14"}'] [--level normal] [--fake]
import {readFileSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {Budget} from '../src/budget.mjs';
import {decisionConfig, loadConfig} from '../src/config.mjs';
import {createDecider, DecisionModel, momentState, pastVerdicts} from '../src/decision.mjs';
import {initialState} from '../src/fold.mjs';
import {decide} from '../src/gate.mjs';
import {createDecisionModel} from '../src/models.mjs';

const {values} = parseArgs({options: {entry: {type: 'string'}, level: {type: 'string', default: 'normal'}, fake: {type: 'boolean'}}});
const recorded = JSON.parse(readFileSync(new URL('./fixtures/decision-moments.json', import.meta.url), 'utf8'));
const NOW = 10 * 60 * 60_000;
const ago = seconds => NOW - seconds * 1000;

/** The session state of a recorded moment: its goal, edits, commands, typing and tests, at NOW. */
function stateOf(moment) {
  return {
    ...initialState({root: '/project', goal: recorded.goal}),
    file: moment.edits.at(-1)?.[0] ?? null,
    lastKeyAt: moment.typed.length ? ago(Math.min(...moment.typed)) : ago(600),
    typed: moment.typed.map(ago),
    edits: moment.edits.map(([file, seconds]) => ({file, from: 1, to: 1, at: ago(seconds)})),
    commands: moment.commands.map(([cmd, exit, seconds]) => ({cmd, exit, endedAt: ago(seconds)})),
    tests: moment.tests ? {passed: moment.tests.passed, failedCount: moment.tests.failedCount, by: 'you', at: ago(moment.tests.ago)} : null,
  };
}

/** A fake decision model: noise for a low recorded score, worth it for a high one, unsure between. */
function fakeModels() {
  return {
    classify: async (_model, context) => {
      await new Promise(resolve => setTimeout(resolve, 20));
      const score = context.state.moment.watcher_score ?? (/twice|crash|SIGSEGV|regression|uninitialized/.test(context.state.moment.what_happened) ? 8 : 3);
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
const calls = []; // {ms, cost, input, ok}
const timed = {
  classify: async (model, context, options) => {
    const started = performance.now();
    const result = await built.models.classify(model, context, options);
    calls.push({ms: performance.now() - started, cost: result.usage?.cost?.total ?? null, input: result.usage?.input ?? null, ok: result.stopReason === 'stop', error: result.errorMessage});
    return result;
  },
};
const timeoutMs = entry?.timeoutMs ?? 1500;
const decision = new DecisionModel({ask: createDecider({models: timed, model: built.model, timeoutMs}), log: line => console.log(`  log: ${line}`), onChange: reason => console.log(`  ${reason ? `down: ${reason}` : 'answers again'}`)});

const rows = [];
for (const moment of recorded.moments) {
  const trigger = {key: moment.name, ...moment.trigger};
  const state = stateOf(moment);
  const budget = new Budget(values.level);
  let watcherAsked = false;
  const decider = {
    sort: async (judged, at, {bar}) => {
      const result = await decision.decide(['moment', 'speak'], momentState({trigger: judged, state: at, now: NOW, level: values.level, bar, past: pastVerdicts([], judged.kind, NOW)}));
      if (!result.ok) return {fallback: result.why};
      const {moment: sorted, speak} = result.answers;
      return {choice: sorted.choice, p: sorted.probabilities?.[sorted.choice] ?? sorted.confidence, speak: speak.probability};
    },
    speak: async (judged, at, {score, bar}) => {
      const result = await decision.decide(['speak'], momentState({trigger: judged, state: at, now: NOW, level: values.level, bar, score, past: pastVerdicts([], judged.kind, NOW)}));
      return result.ok ? {p: result.answers.speak.probability} : {fallback: result.why};
    },
  };
  const watcher = async () => { watcherAsked = true; return {value: moment.score, reason: ''}; };
  const gate = await decide({trigger, state, now: NOW, budget, score: watcher, typingPauseMs: 2000, decider});
  const rule = moment.score >= budget.barFor(trigger.kind) ? 'speak' : 'quiet';
  rows.push({moment, gate: gate.verdict === 'speak' ? 'speak' : 'quiet', rule, watcherAsked, decided: gate.decided ?? {}});
}

const pct = (n, of) => (of ? `${Math.round((100 * n) / of)}%` : '-');
const ms = list => [...list].sort((a, b) => a - b);
const at = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
console.log(`Decision model ${values.fake ? 'fake' : `${entry.model}${entry.provider ? ` on ${entry.provider}` : ` at ${entry.baseUrl}`}`}, level ${values.level}, ${rows.length} recorded moments\n`);
for (const row of rows) {
  const {sort, sortP, speakP} = row.decided;
  const mark = row.gate === row.moment.expect ? 'ok ' : 'NO ';
  console.log(`${mark} want ${row.moment.expect.padEnd(5)} gate ${row.gate.padEnd(5)} rules ${row.rule.padEnd(5)} sort ${(sort ?? '-').padEnd(5)} ${sortP === null || sortP === undefined ? '    ' : pct(sortP * 100, 100).padStart(4)}`
    + ` speak ${speakP === null || speakP === undefined ? '   -' : pct(speakP * 100, 100).padStart(4)}${row.watcherAsked ? '  (Watcher asked)' : ''}  ${row.moment.name}`);
}
const right = rows.filter(row => row.gate === row.moment.expect).length;
const ruleRight = rows.filter(row => row.rule === row.moment.expect).length;
const sorted = rows.filter(row => row.decided.sort === 'noise' || row.decided.sort === 'worth');
const sortRight = sorted.filter(row => (row.decided.sort === 'worth') === (row.moment.expect === 'speak')).length;
const saved = rows.filter(row => !row.watcherAsked && row.decided.sort).length;
const answered = calls.filter(call => call.ok);
const latency = ms(answered.map(call => call.ms));
const costs = answered.map(call => call.cost).filter(cost => cost !== null);
const inputs = answered.map(call => call.input).filter(Boolean);
console.log(`
Gate with the model: ${right} of ${rows.length} right (${pct(right, rows.length)}); the rules alone: ${ruleRight} of ${rows.length} (${pct(ruleRight, rows.length)})
Prefilter sort: ${sorted.length} moments sorted as noise or worth it, ${sortRight} of them right (${pct(sortRight, sorted.length)}); the rest went to the Watcher
Watcher calls saved: ${saved} of ${rows.length}
Calls: ${calls.length}, ${answered.length} answered${calls.length > answered.length ? ` (failed: ${[...new Set(calls.filter(call => !call.ok).map(call => call.error))].join('; ')})` : ''}
Latency per call: median ${Math.round(at(latency, 0.5) ?? 0)} ms, p90 ${Math.round(at(latency, 0.9) ?? 0)} ms, slowest ${Math.round(latency.at(-1) ?? 0)} ms (timeout ${timeoutMs} ms)
Cost per call: ${costs.length ? `$${(costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(6)} on average, ${Math.round(inputs.reduce((a, b) => a + b, 0) / (inputs.length || 1))} input tokens` : 'not reported by the provider'}`);
