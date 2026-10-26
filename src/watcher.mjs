// The Watcher: a small fast model that scores whether a remark is worth interrupting for.
// It answers with the score alone: every token it writes costs latency on each candidate remark.
import {describeBriefly} from './describe.mjs';

const SYSTEM = `You help a pair programmer decide when to speak up.
You get a short session state and one thing that just happened.
Score from 0 to 10 how much the programmer would want a short remark about it right now.
0-3: noise, obvious, or they are already on it. 4-6: maybe useful. 7-10: they will lose time without it.
Answer with the score alone: one number.`;

// What to score, for triggers where "would they want a remark" is the wrong question: models then score how
// important the work is, not whether it drifted.
const QUESTIONS = {
  drift: 'Score how clearly the file now edited is unrelated to the goal: 0 if it could be part of the goal, 10 if it is plainly something else.',
};

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
 * A `score(trigger, state)` for the speak gate. A Watcher that fails or answers nonsense scores 0,
 * so a broken small model keeps Pair quiet instead of noisy; a failure also carries its `error`.
 * `chooseModel()` resolves the model to ask each time (see loaded-model.mjs); by default it is `model`.
 * `score.warm()` sends the same instructions with nothing to judge, so the server keeps the model loaded
 * and its prompt cached; `score.lastCallAt` is when the model was last asked.
 */
export function createWatcher({models, model, chooseModel = async () => model, now = Date.now, timeoutMs = 10_000}) {
  const ask = async (content, maxTokens) => {
    score.lastCallAt = now();
    return models.completeSimple(
      await chooseModel(),
      {systemPrompt: SYSTEM, messages: [{role: 'user', content, timestamp: now()}]},
      {temperature: 0, maxTokens, signal: AbortSignal.timeout(timeoutMs)},
    ).catch(error => ({content: [], errorMessage: String(error?.message ?? error)}));
  };

  async function score(trigger, state) {
    const question = QUESTIONS[trigger.kind] ? `\n${QUESTIONS[trigger.kind]}` : '';
    const message = await ask(`${describeBriefly(state, now())}\n\nWhat just happened (${trigger.kind}): ${trigger.detail}${question}`, MAX_TOKENS);
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('');
    const parsed = parseScore(text);
    if (parsed) return parsed;
    if (message.errorMessage) return {value: 0, reason: `watcher failed: ${message.errorMessage}`, error: message.errorMessage};
    return {value: 0, reason: 'watcher gave no score'};
  }
  score.lastCallAt = now(); // the daemon probes every model as it starts
  score.warm = async () => {
    const message = await ask('Nothing happened yet.', 1);
    return message.errorMessage ? {ok: false, error: message.errorMessage} : {ok: true};
  };
  return score;
}
