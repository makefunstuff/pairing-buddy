// `pair auth`: log in to a model provider with its subscription (OAuth) or an API key, log out, and say what is set.
// pi-ai runs each provider's own login flow; the result goes to the credential store (see credentials.mjs).
import {createModels, getModelType} from '@earendil-works/pi-ai';
import {knownProviders} from './models.mjs';
import {subscriptionTerms} from './terms.mjs';

const NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** The ways to log in to `provider`: its subscription first, then an API key. */
export function loginMethods(provider) {
  return [
    ...(provider.auth.oauth ? [{type: 'oauth', label: provider.auth.oauth.loginLabel ?? `Sign in: ${provider.auth.oauth.name}`}] : []),
    ...(provider.auth.apiKey?.login ? [{type: 'api_key', label: `API key: ${provider.auth.apiKey.name}`}] : []),
  ];
}

/**
 * Logs in to the provider `id` and stores the credential; returns how (`oauth`, `api_key`, or `key` for a name pi-ai
 * does not know: an API key for an OpenAI- or Anthropic-compatible server of your own, used with `"auth": id`).
 */
export async function login({id, credentials, interaction, getDeviceId, providers = knownProviders()}) {
  if (!NAME.test(id) || id.startsWith('pair-')) throw new Error(`"${id}" is not a name to log in with: lower-case letters, digits, . _ -, not starting with pair-`);
  const provider = providers.get(id);
  if (!provider) {
    const key = await interaction.prompt({type: 'secret', message: `"${id}" is not a provider pi-ai knows. API key of your server, stored as "${id}":`});
    if (!key) throw new Error('no key given: nothing stored');
    await credentials.modify(id, async () => ({type: 'api_key', key}));
    return 'key';
  }
  const methods = loginMethods(provider);
  if (!methods.length) throw new Error(`${provider.name} takes no login here: it uses the credentials of its own tools`);
  const type = methods.length === 1 ? methods[0].type : await interaction.prompt({
    type: 'select', message: `Log in to ${provider.name} with:`, options: methods.map(method => ({id: method.type, label: method.label})),
  });
  if (type === 'oauth' && provider.auth.oauth.isSubscription) {
    const terms = subscriptionTerms(provider);
    interaction.notify({type: 'info', message: `Terms: ${terms.note}`, links: terms.url ? [{label: 'Read', url: terms.url}] : []});
  }
  const models = createModels({credentials});
  models.setProvider(provider);
  await models.login(id, type, interaction, {getDeviceId});
  return type;
}

/** Removes the stored login or key of `id`; false when there was none. */
export async function logout({id, credentials}) {
  if (!(await credentials.read(id))) return false;
  await credentials.delete(id);
  return true;
}

const clock = ms => new Date(ms).toTimeString().slice(0, 5);

/** What a stored credential is, in words, without any of its secret. */
export function credentialState(credential, now = Date.now()) {
  if (credential.type === 'api_key') return 'key stored';
  return credential.expires > now
    ? `logged in; the token renews itself (this one until ${clock(credential.expires)})`
    : `logged in; the token expired at ${clock(credential.expires)} and renews on the next request`;
}

/**
 * `[{id, name, set, state}]` for every provider, then every stored key of your own: whether a login or key is set
 * (stored, or from the provider's environment variable or files), and how it can be set when not.
 */
export async function authStates({credentials, providers = knownProviders(), now = Date.now()}) {
  const stored = Object.fromEntries(await Promise.all((await credentials.list()).map(async ({providerId}) => [providerId, await credentials.read(providerId)])));
  // Only what is not stored is looked for elsewhere, with nothing stored to look at.
  const ambient = createModels();
  for (const provider of providers.values()) ambient.setProvider(provider);
  const rows = [];
  for (const provider of providers.values()) {
    const row = {id: provider.id, name: provider.name};
    if (stored[provider.id]) {
      const kind = stored[provider.id].type === 'oauth' && provider.auth.oauth ? ` (${provider.auth.oauth.name})` : '';
      rows.push({...row, set: true, state: `${credentialState(stored[provider.id], now)}${kind}`});
      continue;
    }
    const found = await ambient.checkAuth(provider.id).catch(() => undefined);
    if (found) rows.push({...row, set: true, state: `key from ${found.source ?? 'its environment'}`});
    else rows.push({...row, set: false, state: `not set: ${loginMethods(provider).map(method => (method.type === 'api_key' ? 'API key' : provider.auth.oauth.isSubscription ? 'subscription' : 'sign-in')).join(' or ') || 'its own tools'}`});
  }
  for (const [id, credential] of Object.entries(stored)) {
    if (!providers.has(id)) rows.push({id, name: 'your server', set: true, state: `${credentialState(credential, now)}, for "auth": "${id}"`});
  }
  return rows;
}

/** The ids of the chat models `id` offers, for a model entry's `model`. */
export function providerModels(id, providers = knownProviders()) {
  const provider = providers.get(id);
  if (!provider) throw new Error(`"${id}" is not a provider pi-ai knows; \`pair auth list\` lists them`);
  return provider.getModels().map(model => model.id);
}

/** The ids of a provider's decision (classifier) models, for a `decision` entry (see decision.mjs). */
export function providerDecisionModels(id, providers = knownProviders()) {
  const provider = providers.get(id);
  if (!provider) throw new Error(`"${id}" is not a provider pi-ai knows; \`pair auth list\` lists them`);
  return (provider.getAllModels?.() ?? []).filter(model => getModelType(model) === 'classifier').map(model => model.id);
}
