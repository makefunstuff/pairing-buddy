// The context window of a model whose entry does not set `contextWindow`: a provider's from pi-ai's catalog, an
// OpenAI-compatible server's from what the server says it serves. Read as the daemon starts and by `pair doctor`;
// the config's own `contextWindow` always wins, and without either the window is DEFAULT_CONTEXT.
import {apiKeyOf, configPath, parseConfig, readConfig, sameModel} from './config.mjs';
import {listModels, loadedIds} from './loaded-model.mjs';
import {knownProviders} from './models.mjs';

// A larger window is not used in full: every turn sends the whole conversation, which costs time and, on a paid
// API, money; compaction keeps it to this.
export const MAX_FOUND_CONTEXT = 131072;
const ASK_TIMEOUT_MS = 2000;

const positive = value => (Number.isInteger(value) && value > 0 ? value : null);

/** The window pi-ai's catalog gives a provider's model; null when it does not know the model. */
export function catalogWindow(entry, providers = knownProviders()) {
  const model = providers.get(entry.provider)?.getModels().find(known => known.id === entry.model);
  return positive(model?.contextWindow);
}

async function getJson(url, entry) {
  const key = apiKeyOf(entry);
  const response = await fetch(url, {headers: key ? {authorization: `Bearer ${key}`} : {}, signal: AbortSignal.timeout(ASK_TIMEOUT_MS)});
  return response.ok ? response.json() : null;
}

/**
 * The window an OpenAI-compatible server serves `entry.model` with, or null when it does not say: vLLM and SGLang
 * list `max_model_len` in /models, OpenRouter-style proxies `context_length`; llama.cpp's /props has the `n_ctx`
 * of each slot, LM Studio's model info its `loaded_context_length`. A router that lists the model as not loaded
 * is not asked for its props, which would load it.
 */
export async function servedWindow(entry) {
  const listed = (await listModels(entry).catch(() => null))?.find(known => known.id === entry.model);
  const fromList = positive(listed?.max_model_len) ?? positive(listed?.context_length);
  if (fromList) return fromList;
  const root = entry.baseUrl.replace(/\/$/, '').replace(/\/v1$/, '');
  const unloaded = loadedIds(listed ? [listed] : null)?.has(entry.model) === false;
  const [props, info] = await Promise.all([
    unloaded ? null : getJson(`${root}/props?model=${encodeURIComponent(entry.model)}`, entry).catch(() => null),
    getJson(`${root}/api/v0/models/${encodeURIComponent(entry.model)}`, entry).catch(() => null),
  ]);
  return positive(props?.default_generation_settings?.n_ctx) ?? positive(info?.loaded_context_length);
}

/** `{tokens, from, served}` for one model entry, or null when nothing says. */
async function windowOf(entry, providers) {
  if (entry.provider) {
    const tokens = catalogWindow(entry, providers);
    return tokens && {tokens: Math.min(tokens, MAX_FOUND_CONTEXT), from: tokens > MAX_FOUND_CONTEXT ? `pi-ai's catalog, which says ${tokens}` : "pi-ai's catalog"};
  }
  if (entry.api !== 'openai') return null;
  const tokens = await servedWindow(entry);
  return tokens && {tokens: Math.min(tokens, MAX_FOUND_CONTEXT), from: tokens > MAX_FOUND_CONTEXT ? `the server, which serves ${tokens}` : 'the server', served: true};
}

/** The `windows` parseConfig takes, for both roles of `config` (one ask when one model serves both). */
export async function foundWindows(config, providers = knownProviders()) {
  const {watcher, partner} = config.models;
  const forPartner = windowOf(partner, providers);
  const forWatcher = sameModel(watcher, partner) ? forPartner : windowOf(watcher, providers);
  const [w, p] = await Promise.all([forWatcher, forPartner]);
  return {...(w ? {watcher: w} : {}), ...(p ? {partner: p} : {})};
}

/** The config at `path`, with each model's window from its catalog or server where the config does not set one. */
export async function loadSizedConfig(path = configPath()) {
  const raw = readConfig(path);
  return parseConfig(raw, {windows: await foundWindows(parseConfig(raw))});
}
