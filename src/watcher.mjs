// The Watcher: a small fast model that scores whether a remark is worth interrupting for.
import {describeBriefly} from './describe.mjs';

const SYSTEM = `You help a pair programmer decide when to speak up.
You get a short session state and one thing that just happened.
Score from 0 to 10 how much the programmer would want a short remark about it right now.
0-3: noise, obvious, or they are already on it. 4-6: maybe useful. 7-10: they will lose time without it.
Answer with one line of JSON and nothing else: {"score": <0-10>, "reason": "<at most 8 words>"}`;

/** `{value, reason}` from the model's answer; null when it holds no score. */
export function parseScore(text) {
  const json = /\{[^{}]*\}/.exec(text)?.[0];
  if (json) {
    try {
      const {score, reason} = JSON.parse(json);
      const value = Number(score);
      if (Number.isFinite(value)) return {value: Math.max(0, Math.min(10, value)), reason: String(reason ?? '')};
    } catch {}
  }
  const bare = /\bscore\D{0,4}(\d+(?:\.\d+)?)/i.exec(text);
  return bare ? {value: Math.min(10, Number(bare[1])), reason: ''} : null;
}

/**
 * A `score(trigger, state)` for the speak gate. A Watcher that fails or answers nonsense scores 0,
 * so a broken small model keeps Pair quiet instead of noisy.
 */
export function createWatcher({models, model, now = Date.now, timeoutMs = 10_000}) {
  return async function score(trigger, state) {
    const prompt = `${describeBriefly(state, now())}\n\nWhat just happened (${trigger.kind}): ${trigger.detail}`;
    const message = await models.completeSimple(
      model,
      {systemPrompt: SYSTEM, messages: [{role: 'user', content: prompt, timestamp: now()}]},
      {temperature: 0, maxTokens: model.maxTokens, signal: AbortSignal.timeout(timeoutMs)},
    ).catch(error => ({content: [], errorMessage: String(error?.message ?? error)}));
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('');
    const parsed = parseScore(text);
    if (parsed) return parsed;
    return {value: 0, reason: message.errorMessage ? `watcher failed: ${message.errorMessage}` : 'watcher gave no score'};
  };
}
