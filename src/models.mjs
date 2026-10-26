// Turns the two configured models into pi-ai providers: "pair-watcher" and "pair-partner".
import {createModels, createProvider} from '@earendil-works/pi-ai';
import {anthropicMessagesApi} from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import {openAICompletionsApi} from '@earendil-works/pi-ai/api/openai-completions.lazy';
import {apiKeyOf} from './config.mjs';

// Most local servers (llama.cpp, Ollama, vLLM) know only the plain `system` role and `max_tokens`.
const LOCAL_COMPAT = {supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens'};

function modelOf(providerId, entry) {
  const anthropic = entry.api === 'anthropic';
  return {
    id: entry.model,
    name: entry.model,
    api: anthropic ? 'anthropic-messages' : 'openai-completions',
    provider: providerId,
    baseUrl: entry.baseUrl,
    // A model that thinks by default must be marked `reasoning`, or pi-ai cannot switch its thinking off.
    reasoning: entry.reasoning,
    input: ['text'],
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    ...(anthropic ? {} : {compat: {...LOCAL_COMPAT, ...entry.compat}, samplingParams: entry.samplingParams}),
  };
}

function providerOf(providerId, entry) {
  const model = modelOf(providerId, entry);
  return createProvider({
    id: providerId,
    name: providerId,
    baseUrl: entry.baseUrl,
    // A local server without a key gets none; one that needs a key fails with the server's own message.
    auth: {apiKey: {name: providerId, resolve: async () => ({auth: {apiKey: apiKeyOf(entry) ?? 'none'}})}},
    models: [model],
    api: entry.api === 'anthropic' ? anthropicMessagesApi() : openAICompletionsApi(),
  });
}

/** `{models, watcher, partner}`: the pi-ai collection and the model of each role. */
export function createPairModels(config) {
  const models = createModels();
  const roles = {};
  for (const role of ['watcher', 'partner']) {
    const provider = providerOf(`pair-${role}`, config.models[role]);
    models.setProvider(provider);
    roles[role] = models.getModel(`pair-${role}`, config.models[role].model);
  }
  return {models, ...roles};
}
