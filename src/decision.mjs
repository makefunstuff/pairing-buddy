// The decision model: a classifier (TypeSafe's Jev, Cloudflare's Clef, OpenAI's Decisions API) that answers a typed
// question (one of N choices, yes or no, a score) with probabilities instead of words. pi-ai asks it (`classify`).
//
// The speak gate asks it two questions about each candidate moment (see gate.mjs): what kind of moment it is (noise,
// worth a remark, or one for the Watcher to score), and whether a remark is worth interrupting the user for right
// now. Both questions go in one request; the second is asked again, with the Watcher's score, when the moment was
// one for the Watcher. Every answer is optional: a model that is down, slow or answers nonsense gives no answer, and
// the gate goes by its own rules at once, as Pair does without a decision model.
//
// `ask(questions, state)` is the one way in, so later questions (when to interrupt, drift, whether the user is stuck
// on the search trail, routing) are a QUESTIONS entry and a state of their own; docs/decision.md lists them.
import {momentOf} from './watcher.mjs';

// A sort the gate acts on without the Watcher needs this much probability; below it the Watcher is asked.
export const SURE = 0.8;
const EXAMPLES = 6; // of the user's verdicts on earlier remarks, the latest this many go with every question
const MINUTE = 60_000;

/** The questions, by name. Each request asks some of them about one state. */
export const QUESTIONS = {
  moment: {
    type: 'choice',
    instructions: 'A pair programmer\'s assistant noticed this moment while the user works. Sort it: is a short unasked remark about it noise, '
      + 'plainly worth it, or does it take a closer look at what happened? Use the user\'s past verdicts on such remarks.',
    criteria: {
      noise: 'Noise: obvious from the screen, the user is already on it, or remarks like it were dismissed or ignored',
      worth: 'Plainly worth a remark: the user will lose time without it, and remarks like it were found useful',
      ask: 'Unsure: it depends on details of what happened that need a closer look',
    },
  },
  speak: {
    type: 'bool',
    instructions: 'Is a short remark about this moment worth interrupting the user for right now? Weigh how much time it saves '
      + 'against breaking their focus: how fast they type, how recently the assistant last spoke, the watcher\'s score if there is one, '
      + 'and the user\'s past verdicts.',
    criteria: {true: 'Worth interrupting for now', false: 'Not worth an interruption now'},
  },
};

const seconds = (now, at) => (at ? Math.max(0, Math.round((now - at) / 1000)) : null);

/** What became of a remark, as the user's verdict: useful, dismissed, ignored (no verdict in time) or seen. */
function verdictOf(remark, now, ignoredAfterMs) {
  if (remark.verdict) return remark.verdict;
  return now - remark.at >= ignoredAfterMs ? 'ignored' : null;
}

/**
 * The user's past verdicts as the decision model reads them: for the moment's kind, how many remarks were useful,
 * dismissed and ignored; and the latest judged remarks of any kind as examples. `remarks` are the store's, newest first.
 */
export function pastVerdicts(remarks, kind, now, {ignoredAfterMs = 10 * MINUTE} = {}) {
  const judged = remarks.map(remark => ({...remark, outcome: verdictOf(remark, now, ignoredAfterMs)}))
    .filter(remark => ['useful', 'dismissed', 'ignored'].includes(remark.outcome));
  const same = judged.filter(remark => remark.trigger === kind);
  const count = outcome => same.filter(remark => remark.outcome === outcome).length;
  return {
    this_kind: {useful: count('useful'), dismissed: count('dismissed'), ignored: count('ignored')},
    examples: judged.slice(0, EXAMPLES).map(remark => ({kind: remark.trigger, watcher_score: remark.score ?? null, verdict: remark.outcome})),
  };
}

/** How many seconds of the last minute the user typed: Neovim says it types at most every half second. */
function typingSeconds(state, now) {
  return Math.min(60, (state.typed ?? []).filter(at => now - at < MINUTE).length / 2);
}

function testsOf(tests, now) {
  if (!tests) return null;
  return {passed: tests.passed ?? null, failed: tests.failedCount ?? tests.failed?.length ?? null, by: tests.by ?? null, seconds_ago: seconds(now, tests.at)};
}

/**
 * The state the decision model judges `trigger` in: the moment (its kind, what happened, the Watcher's `score` and
 * the bar when there is one), the user (goal, typing, how long since Pair last spoke unasked), recent edits, runs
 * and tests, and `past`, their verdicts (see pastVerdicts).
 */
export function momentState({trigger, state, now, level, bar, score = null, lastRemarkAt = null, past}) {
  return {
    moment: {
      kind: trigger.kind,
      what_happened: momentOf(trigger, state).slice(0, 2000),
      ...(score === null ? {} : {watcher_score: score, watcher_bar: bar}),
    },
    user: {
      goal: state.goal ?? null,
      file: state.file ?? null,
      seconds_since_last_keystroke: seconds(now, state.lastKeyAt),
      seconds_typed_in_last_minute: typingSeconds(state, now),
      seconds_since_last_unasked_remark: seconds(now, lastRemarkAt),
      talk_level: level,
    },
    recent: {
      edits: state.edits.slice(-5).map(edit => ({file: edit.file, seconds_ago: seconds(now, edit.at)})),
      commands: state.commands.slice(-3).map(command => ({cmd: command.cmd, exit: command.exit ?? null, seconds_ago: seconds(now, command.endedAt ?? command.at)})),
      tests: testsOf(state.tests, now),
    },
    past_verdicts: past,
  };
}

/** Whether `answer` answers `question`: the right type, probabilities in 0..1, a choice among the criteria. */
function wellFormed(question, answer) {
  const probability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
  if (!answer || answer.type !== question.type) return false;
  if (question.type === 'bool') return probability(answer.probability);
  if (question.type === 'score') return Number.isFinite(answer.score);
  return answer.choice in question.criteria && Object.values(answer.probabilities ?? {}).every(probability);
}

/**
 * `ask(names, state, {signal})` for the gate: the questions `names` of QUESTIONS about `state`, from `model` through pi-ai's
 * `models`. It resolves `{ok: true, answers, ms}`, or `{ok: false, why, error, ms}` when there is no answer to go by:
 * `why` is "timeout" (none within `timeoutMs`), "error" (the model failed) or "malformed" (an answer of the wrong
 * shape). It never rejects, and never waits past `timeoutMs`, whatever the provider does with the signal.
 */
export function createDecider({models, model, timeoutMs, now = Date.now}) {
  return async function ask(names, state, {signal} = {}) {
    const questions = Object.fromEntries(names.map(name => [name, QUESTIONS[name]]));
    const started = now();
    const controller = new AbortController();
    let timer;
    const late = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs); });
    const options = {signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, maxRetries: 0, timeoutMs};
    const result = await Promise.race([
      models.classify(model, {state, questions}, options).catch(error => ({stopReason: 'error', errorMessage: String(error?.message ?? error)})),
      late,
    ]);
    clearTimeout(timer);
    const ms = now() - started;
    if (!result) return {ok: false, why: 'timeout', error: `no answer within ${timeoutMs} ms`, ms};
    if (result.stopReason !== 'stop') {
      const timedOut = /timed out/i.test(result.errorMessage ?? '');
      return {ok: false, why: timedOut ? 'timeout' : 'error', error: timedOut ? `no answer within ${timeoutMs} ms` : result.errorMessage ?? 'the model failed', ms};
    }
    const bad = names.find(name => !wellFormed(QUESTIONS[name], result.answers?.[name]));
    if (bad) return {ok: false, why: 'malformed', error: `the answer to "${bad}" is not a ${QUESTIONS[bad].type} answer`, ms};
    return {ok: true, answers: result.answers, ms};
  };
}

/** One tiny question, for `pair doctor` and the health probe: `{ok, ms, error}`. */
export async function probeDecision(ask) {
  const result = await ask(['speak'], {moment: {kind: 'probe', what_happened: 'Nothing happened yet.'}});
  return result.ok ? {ok: true, ms: result.ms} : {ok: false, ms: result.ms, error: result.error};
}

/**
 * The daemon's decision model: `ask` with its health. A model that fails or is too slow is down at once: one log
 * line and one notice (`onChange(reason)`, null when it answers again), and while it is down the gate is not kept
 * waiting for it at all; a probe every `intervalMs` notices when it answers again. An answer of the wrong shape only
 * costs that one decision, and is logged once.
 */
export class DecisionModel {
  constructor({ask, onChange = () => {}, log = () => {}, intervalMs = 30_000}) {
    Object.assign(this, {ask, onChange, log, intervalMs});
    this.down = null; // why it is down
    this.malformed = false; // a malformed answer was logged
    this.probing = false;
    this.calls = 0;
    this.fallbacks = 0;
  }

  /** `{ok, answers}` for the questions `names` about `state`, or `{ok: false, why, error}` to go by Pair's own rules. */
  async decide(names, state) {
    if (this.down) {
      this.fallbacks += 1;
      return {ok: false, why: 'down', error: this.down, ms: 0};
    }
    this.calls += 1;
    const result = await this.ask(names, state);
    if (result.ok) return result;
    this.fallbacks += 1;
    if (result.why === 'malformed') {
      if (!this.malformed) this.log(`decision model: ${result.error}; Pair goes by its own rules for that moment`);
      this.malformed = true;
    } else {
      this.report(result.why === 'timeout' ? `too slow: ${result.error}` : result.error);
    }
    return result;
  }

  report(reason) {
    const why = reason ? String(reason).split('\n')[0].slice(0, 160) : null;
    if (Boolean(this.down) === Boolean(why)) return;
    this.down = why;
    this.onChange(why);
  }

  /** Probes the model now, then while it is down every interval. */
  start() {
    this.check();
    this.timer = setInterval(() => { if (this.down) this.check(); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  async check() {
    if (this.probing) return;
    this.probing = true;
    try {
      const probe = await probeDecision(this.ask);
      this.report(probe.ok ? null : probe.error);
    } finally {
      this.probing = false;
    }
  }

  snapshot() {
    return {down: this.down, calls: this.calls, fallbacks: this.fallbacks};
  }
}
