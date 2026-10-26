// One tiny request to a model: does it answer, how fast, and does it think. `pair doctor` reports it; the daemon
// uses it to notice that a model that was down answers again.

const thought = message => (message.content ?? []).some(block => block.type === 'thinking' && block.thinking?.trim());

async function probe(models, model, prompt, options) {
  const started = Date.now();
  const message = await models.completeSimple(model, prompt, options)
    .catch(error => ({errorMessage: String(error?.message ?? error)}));
  const ms = Date.now() - started;
  return message.errorMessage ? {ok: false, ms, error: message.errorMessage} : {ok: true, ms, thought: thought(message)};
}

/** `{ok, ms, error, thought}` for one short completion of `model`, with its thinking switched off where it can be. */
export function probeModel(models, model, {timeoutMs = 15_000} = {}) {
  return probe(
    models, model,
    {systemPrompt: 'Answer with one word.', messages: [{role: 'user', content: 'Say OK.', timestamp: Date.now()}]},
    {temperature: 0, maxTokens: 16, signal: AbortSignal.timeout(timeoutMs)},
  );
}

/** The same with thinking at `level`, on a question worth a thought: whether the model thinks when asked to. */
export function probeThinking(models, model, level, {timeoutMs = 60_000} = {}) {
  return probe(
    models, model,
    {systemPrompt: 'Answer with the number alone.', messages: [{role: 'user', content: 'What is 17 * 23 - 19?', timestamp: Date.now()}]},
    {reasoning: level, maxTokens: 4096, signal: AbortSignal.timeout(timeoutMs)},
  );
}

/** The request body pi-ai builds for `model` with thinking at `level`, caught before it is sent. */
async function requestAt(models, model, level) {
  let body = null;
  const fetch = async (_url, init) => { body = init.body; throw new Error('not sent'); };
  await models.completeSimple(model, {messages: [{role: 'user', content: 'x', timestamp: 0}]}, {reasoning: level, fetch, maxRetries: 0})
    .catch(() => {});
  return body;
}

/**
 * Which of `levels` reach the model as a level of their own: the levels in groups that send the same request, one
 * group per request. A server whose thinking switch is only on or off puts every level in one group.
 */
export async function levelGroups(models, model, levels) {
  const groups = new Map(); // request body -> its levels
  for (const level of levels) {
    const body = await requestAt(models, model, level);
    groups.set(body, [...(groups.get(body) ?? []), level]);
  }
  return [...groups.values()];
}
