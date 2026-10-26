// Model entries that name a pi-ai provider: its catalog model with the config's limits, its own provider id (its
// API depends on it), and the login or key from the credential store.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {InMemoryCredentialStore} from '@earendil-works/pi-ai';
import {providerModels} from '../src/auth.mjs';
import {parseConfig} from '../src/config.mjs';
import {createPairModels} from '../src/models.mjs';

const configOf = (watcher, partner) => parseConfig({models: {watcher, partner}});

test('a provider entry gets the catalog model with the config limits, and its key from the store', async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify('deepseek', async () => ({type: 'api_key', key: 'sk-stored'}));
  const config = configOf({provider: 'deepseek', model: providerModels('deepseek')[0]}, {api: 'openai', baseUrl: 'http://x/v1', model: 'p'});
  const pairModels = createPairModels(config, {credentials});
  assert.equal(pairModels.watcher.provider, 'deepseek', "pi-ai's own provider id: its API depends on it");
  assert.equal(pairModels.watcher.contextWindow, config.models.watcher.contextWindow);
  assert.equal(pairModels.watcher.maxTokens, config.models.watcher.maxTokens);
  assert.equal(pairModels.partner.provider, 'pair-partner');
  assert.equal((await pairModels.models.getAuth('deepseek')).auth.apiKey, 'sk-stored');
});

test("one provider for both roles: the Partner's limits win for a shared model", () => {
  const model = providerModels('anthropic')[0];
  const pairModels = createPairModels(configOf(
    {provider: 'anthropic', model, contextWindow: 1000},
    {provider: 'anthropic', model, contextWindow: 50_000},
  ), {credentials: new InMemoryCredentialStore()});
  assert.equal(pairModels.watcher, pairModels.partner);
  assert.equal(pairModels.partner.contextWindow, 50_000);
  assert.equal(pairModels.partner.api, 'anthropic-messages');
});

test('an unknown provider or model says where the right names are', () => {
  const credentials = new InMemoryCredentialStore();
  assert.throws(() => createPairModels(configOf({provider: 'nope', model: 'w'}, {api: 'anthropic', model: 'p'}), {credentials}),
    /"nope" is not a provider pi-ai knows; `pair auth list` lists them/);
  assert.throws(() => createPairModels(configOf({provider: 'anthropic', model: 'no-such-model'}, {api: 'anthropic', model: 'p'}), {credentials}),
    /"no-such-model" is not a anthropic model: `pair auth models anthropic` lists them/);
});
