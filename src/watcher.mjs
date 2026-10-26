// The Watcher: a small fast model that scores whether a remark is worth interrupting for.
// It answers with the score alone: every token it writes costs latency on each candidate remark.
import {describeBriefly} from './describe.mjs';
import {trailLines} from './trail.mjs';

// Every token here is read again on each candidate remark, so the instructions are as short as they can be.
const SYSTEM = `Score 0-10 how much a pair programmer would want a short remark about what just happened.
0-3: noise, obvious, or they are already on it. 7-10: they will lose time without it.
Answer with one number.`;

// What happened, for triggers whose detail is written for the Partner. Drift: the file and what it is about (its
// gist: words of a path say little, `billing/ranking.ts` is no search ranking), and a question with the goal right
// next to it. Asked whether you would want a remark, models score how important the work
// is, not whether it drifted; and the Partner's longer detail costs tokens without helping the score.
// The wrong turn: the Watcher cannot see the code, so it is asked whether a check of the file would save time.
// A regression: whether hearing of it now saves time, since the user has not run the tests that found it.
// The search trail: whether the user is going in circles, with what fails now, which says what they are after.
// A crash: whether hearing where and why saves a hunt. A new warning: whether it is a bug, not just untidy.
const WHAT_HAPPENED = {
  drift: (trigger, state) => `The user now edits ${trigger.file}.${trigger.gist ? ` What the file is about: ${trigger.gist}` : ''}\n`
    + `Score how clearly this file is unrelated to the goal "${state.goal}", by what it does: 0 if it could be part of it, 10 if it is plainly other work.`,
  edit_while_red: trigger => `The tests are red. The failure points at ${trigger.named.slice(0, 4).join(', ')}, but the user is changing ${trigger.file}, a file it does not name.\n`
    + `Score how much a quick check of whether ${trigger.file} can cause this failure would save them: 0 if ${trigger.file} is plainly the code that fails, 10 if they may be fixing the wrong file.`,
  regression: trigger => `The user saved ${trigger.file}. The tests Pair ran right after show ${trigger.newly.slice(0, 4).join(', ')} failing, which did not fail before. The user has not run them.\n`
    + 'Score how much hearing now what broke would save them: 0 if it is plainly the test they are working on, 10 if their change broke something elsewhere.',
  search_trail: trigger => `The user searched ${trigger.searches.length} times for one thing and has not edited since:\n${trailLines(trigger.searches)}\n`
    + `${trigger.failing ? `Failing now: ${trigger.failing}` : 'Nothing is failing.'}\n`
    + 'Score how much being told where it is in the code would save them: 0 if the last search plainly found it, 10 if their words are not the code\'s and they go in circles.',
  crash: trigger => `${trigger.detail}\n`
    + 'Score how much hearing where and why it crashed would save them: 0 if the output already names the line and the cause plainly, 10 if they would have to hunt for it.',
  new_warning: trigger => `A build printed a warning that was not there before: ${trigger.warnings.slice(0, 3).map(warning => warning.message).join('; ')}\n`
    + 'Score how likely this is a real bug worth a word now: 0 for something untidy while exploring (an unused variable or parameter), 10 for a likely bug (an uninitialised value, a wrong format, an overflow, a missing return).',
};

/** What the Watcher is asked about `trigger`: the same text is the same moment (see score-memory.mjs). */
export const momentOf = (trigger, state) => WHAT_HAPPENED[trigger.kind]?.(trigger, state) ?? trigger.detail;

const MAX_TOKENS = 8; // a number, with room for a model that wraps it in a word or two

/** `{value, reason}` from the model's answer: a bare number, "score: N" or JSON; null when it holds no score. */
export function parseScore(text) {
  const json = /\{[^{}]*\}/.exec(text)?.[0];
  if (json) {
    try {
      const {score, reason} = JSON.parse(json);
      const value = Number(score);
      if (Number.isFinite(value)) return {value: Math.max(0, Math.min(10, value)), reason: String(reason ?? '')};
    } catch {}
  }
  const number = /^\D{0,12}?(\d+(?:\.\d+)?)/.exec(text.trim()) ?? /\bscore\D{0,4}(\d+(?:\.\d+)?)/i.exec(text);
  return number ? {value: Math.min(10, Number(number[1])), reason: ''} : null;
}

/**
 * A `score(trigger, state, {signal})` for the speak gate; `signal` cancels the call (see slot.mjs). A Watcher that
 * fails or answers nonsense scores 0, so a broken small model keeps Pair quiet instead of noisy; a failure also
 * carries its `error`.
 * `chooseModel()` resolves the model to ask each time (see loaded-model.mjs); by default it is `model`.
 * `score.warm()` sends the same instructions with nothing to judge, so the server keeps the model loaded
 * and its prompt cached; `score.lastCallAt` is when the model was last asked.
 */
export function createWatcher({models, model, chooseModel = async () => model, now = Date.now, timeoutMs = 10_000}) {
  const ask = async (content, maxTokens, signal) => {
    score.lastCallAt = now();
    const timeout = AbortSignal.timeout(timeoutMs);
    return models.completeSimple(
      await chooseModel(),
      {systemPrompt: SYSTEM, messages: [{role: 'user', content, timestamp: now()}]},
      {temperature: 0, maxTokens, signal: signal ? AbortSignal.any([signal, timeout]) : timeout},
    ).catch(error => ({content: [], errorMessage: String(error?.message ?? error)}));
  };

  async function score(trigger, state, {signal} = {}) {
    const happened = momentOf(trigger, state);
    const message = await ask(`${describeBriefly(state, now())}\n\nWhat just happened (${trigger.kind}): ${happened}`, MAX_TOKENS, signal);
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('');
    const parsed = parseScore(text);
    if (parsed) return parsed;
    if (message.errorMessage) return {value: 0, reason: `watcher failed: ${message.errorMessage}`, error: message.errorMessage};
    return {value: 0, reason: 'watcher gave no score', unscored: true};
  }
  score.lastCallAt = now(); // the daemon probes every model as it starts
  score.warm = async () => {
    const message = await ask('Nothing happened yet.', 1);
    return message.errorMessage ? {ok: false, error: message.errorMessage} : {ok: true};
  };
  return score;
}
