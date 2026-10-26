// What an OpenAI-compatible server lists and has loaded. A server that keeps one model in memory reloads on
// every switch between two models (seconds to minutes each), so when the Watcher and the Partner are two
// models on such a server, the Watcher scores with the Partner's model while only that one is loaded.
import {apiKeyOf} from './config.mjs';

const LIST_TIMEOUT_MS = 2000;

/** The `data` a server's /models lists, or null when it lists nothing; throws when it does not answer. */
export async function listModels(entry, {timeoutMs = LIST_TIMEOUT_MS} = {}) {
  const key = apiKeyOf(entry);
  const response = await fetch(`${entry.baseUrl.replace(/\/$/, '')}/models`, {
    headers: key ? {authorization: `Bearer ${key}`} : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return null;
  return (await response.json()).data ?? null;
}

/** The ids of `listed` that the server says are loaded; null when it does not say (most servers). */
export function loadedIds(listed) {
  const told = (listed ?? []).filter(model => typeof model.loaded === 'boolean' || typeof model.status?.value === 'string');
  if (!told.length) return null;
  return new Set(told.filter(model => model.loaded === true || model.status?.value === 'loaded').map(model => model.id));
}

/** Whether two model entries are different models on one OpenAI-compatible server. */
export function shareServer(a, b) {
  return a.api === 'openai' && b.api === 'openai' && a.baseUrl === b.baseUrl && a.model !== b.model;
}

/**
 * A `chooseModel()` for the Watcher (see watcher.mjs): the Partner's model while the server has it loaded and not
 * the Watcher's, else the Watcher's own. When the server says nothing, or both are loaded, nothing changes.
 * `log` hears each switch.
 */
export function followLoaded({entries, watcher, partner, list = listModels, log = () => {}}) {
  let using = watcher;
  return async () => {
    const loaded = loadedIds(await list(entries.watcher).catch(() => null));
    const next = loaded && !loaded.has(entries.watcher.model) && loaded.has(entries.partner.model) ? partner : watcher;
    if (next !== using) {
      log(next === partner
        ? `the server has only the Partner's model loaded: the Watcher uses it, so the server need not reload`
        : 'the Watcher uses its own model again');
      using = next;
    }
    return using;
  };
}
