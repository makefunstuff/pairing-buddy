// One tiny request to a model: does it answer, and how fast. `pair doctor` reports it; the daemon uses it
// to notice that a model that was down answers again.

/** `{ok, ms, error}` for one short completion of `model`. */
export async function probeModel(models, model, {timeoutMs = 15_000} = {}) {
  const started = Date.now();
  const message = await models.completeSimple(
    model,
    {systemPrompt: 'Answer with one word.', messages: [{role: 'user', content: 'Say OK.', timestamp: started}]},
    {temperature: 0, maxTokens: 16, signal: AbortSignal.timeout(timeoutMs)},
  ).catch(error => ({errorMessage: String(error?.message ?? error)}));
  const ms = Date.now() - started;
  return message.errorMessage ? {ok: false, ms, error: message.errorMessage} : {ok: true, ms};
}
