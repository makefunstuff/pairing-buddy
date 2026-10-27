// Turns the configured models into pi-ai providers: "pair-watcher", "pair-partner" and "pair-decision" for an `api` at
// a `baseUrl`, and pi-ai's own provider (its API and catalog) for an entry that names a `provider`.
import {createModels, createProvider, getModelType} from '@earendil-works/pi-ai';
import {anthropicMessagesApi} from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import {llamaCppClassifyApi} from '@earendil-works/pi-ai/api/llama-cpp-classify.lazy';
import {openAICompletionsApi} from '@earendil-works/pi-ai/api/openai-completions.lazy';
import {openAIDecisionsApi} from '@earendil-works/pi-ai/api/openai-decisions.lazy';
import {typesafeSystemOneApi} from '@earendil-works/pi-ai/api/typesafe-system-one.lazy';
import {builtinProviders} from '@earendil-works/pi-ai/providers/all';
import {apiKeyOf, authPath, DECISION_APIS} from './config.mjs';
import {fileCredentialStore} from './credentials.mjs';

// Most local servers (llama.cpp, Ollama, vLLM) know only the plain `system` role and `max_tokens`.
const LOCAL_COMPAT = {supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens'};

/** pi-ai's providers by id: every one `pair auth` can log in to and a model entry can name. */
export function knownProviders() {
  return new Map(builtinProviders().map(provider => [provider.id, provider]));
}

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
    // A model at a baseUrl reads only text unless the config says it reads images too (a run's picture, see check.mjs).
    input: entry.images ? ['text', 'image'] : ['text'],
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    // `thinkingLevelMap` sends a level as the server's own name for it (see `pair doctor --thinking`).
    ...(anthropic ? {} : {compat: {...LOCAL_COMPAT, ...entry.compat}, samplingParams: entry.samplingParams, thinkingLevelMap: entry.thinkingLevelMap}),
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

const CLASSIFIER_APIS = {'openai-decisions': openAIDecisionsApi, 'typesafe-system-one': typesafeSystemOneApi, 'llama-cpp-classify': llamaCppClassifyApi};

/** The decision model at a baseUrl: a classifier of the API the entry names, its key resolved as a role's is. */
function decisionProviderOf(entry) {
  const api = DECISION_APIS[entry.api];
  const model = {
    type: 'classifier', id: entry.model, name: entry.model, api, provider: 'pair-decision', baseUrl: entry.baseUrl, input: ['text'],
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: entry.contextWindow,
  };
  return createProvider({
    id: 'pair-decision',
    name: 'pair-decision',
    baseUrl: entry.baseUrl,
    auth: {apiKey: {name: 'pair-decision', resolve: async () => ({auth: {apiKey: apiKeyOf(entry) ?? 'none'}})}},
    models: [model],
    classifiers: {[api]: CLASSIFIER_APIS[api]()},
  });
}

/** The classifier model `entry` names in `provider`'s catalog. */
function catalogClassifier(provider, entry) {
  const classifiers = (provider.getAllModels?.() ?? []).filter(model => getModelType(model) === 'classifier');
  const known = classifiers.find(model => model.id === entry.model);
  if (known) return known;
  const listed = classifiers.length ? `; it has ${classifiers.map(model => model.id).join(', ')}` : '; it has none';
  throw new Error(`config: decision.model: "${entry.model}" is not a ${provider.id} decision model${listed}`);
}

/**
 * The catalog model `entry` names, with the config's context window and longest answer. Whether it can think is
 * the catalog's to say: a model that thinks by default needs `reasoning` so its thinking can be switched off.
 */
function catalogModel(provider, entry) {
  const known = provider.getModels().find(model => model.id === entry.model);
  if (!known) throw new Error(`"${entry.model}" is not a ${provider.id} model: \`pair auth models ${provider.id}\` lists them`);
  return {...known, contextWindow: entry.contextWindow, maxTokens: entry.maxTokens};
}

/**
 * `{models, watcher, partner}`: the pi-ai collection and the model of each role. Logins and keys come from
 * `credentials` (the file `pair auth` writes), and pi-ai refreshes an expired token in it.
 */
export function createPairModels(config, {credentials = fileCredentialStore(authPath())} = {}) {
  const models = createModels({credentials});
  const providers = new Map(); // a named provider -> its models in use; the Partner's settings win for a shared one
  let known;
  for (const role of ['watcher', 'partner']) {
    const entry = config.models[role];
    if (!entry.provider) { models.setProvider(providerOf(`pair-${role}`, entry)); continue; }
    const provider = (known ??= knownProviders()).get(entry.provider);
    if (!provider) throw new Error(`config: models.${role}.provider: "${entry.provider}" is not a provider pi-ai knows; \`pair auth list\` lists them`);
    const used = providers.get(provider.id) ?? {provider, models: new Map()};
    used.models.set(entry.model, catalogModel(provider, entry));
    providers.set(provider.id, used);
  }
  for (const {provider, models: used} of providers.values()) {
    const listed = () => [...used.values()];
    models.setProvider({...provider, getModels: listed, getAllModels: listed});
  }
  const roles = Object.fromEntries(['watcher', 'partner'].map(role => {
    const entry = config.models[role];
    return [role, models.getModel(entry.provider ?? `pair-${role}`, entry.model)];
  }));
  return {models, ...roles};
}

/**
 * `{models, model}`: the decision model of the config's `decision` entry (see decision.mjs) in a pi-ai collection of
 * its own, so a change to it leaves the roles' models alone; null without one. Logins and keys as createPairModels.
 */
export function createDecisionModel(config, {credentials = fileCredentialStore(authPath())} = {}) {
  const entry = config.decision;
  if (!entry) return null;
  const models = createModels({credentials});
  if (!entry.provider) {
    models.setProvider(decisionProviderOf(entry));
    return {models, model: models.getModelOfType('classifier', 'pair-decision', entry.model)};
  }
  const provider = knownProviders().get(entry.provider);
  if (!provider) throw new Error(`config: decision.provider: "${entry.provider}" is not a provider pi-ai knows; \`pair auth list\` lists them`);
  const model = catalogClassifier(provider, entry);
  models.setProvider({...provider, getModels: () => [], getAllModels: () => [model]});
  return {models, model};
}
