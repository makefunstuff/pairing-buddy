// What an OpenAI-compatible server lists and has loaded. A server that keeps one model in memory reloads on
// every switch between two models (seconds to minutes each), so when the Watcher and the Partner are two
// models on such a server, the Watcher scores with the Partner's model while only that one is loaded, or, on a
// server that does not say, once its calls show the reloads.
import {apiKeyOf, sameServer} from './config.mjs';

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
  return a.api === 'openai' && sameServer(a, b) && a.model !== b.model;
}

// A server that does not say what it has loaded may still swap: then the Watcher's first call after a Partner turn
// takes far longer than its calls in between, each time.
export const SWAP_MS = 2000; // a call after a Partner turn that takes longer than this, and
export const SWAP_FACTOR = 4; // this many times the Watcher's usual call, looks like a reload
const SWAPS_SEEN = 2; // in a row: then the server swaps
const BASELINE = 2; // Watcher calls not after a Partner turn, before a reload can be told from a slow server

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/**
 * A `chooseModel()` for the Watcher (see watcher.mjs): the Partner's model while the server has it loaded and not
 * the Watcher's, else the Watcher's own. When the server does not say, `timed(ms, afterPartner)` hears how long
 * each Watcher call took and whether a Partner turn came before it: once two calls in a row after a Partner turn
 * look like reloads, the Watcher uses the Partner's model for good. `log` hears each switch.
 */
export function followLoaded({entries, watcher, partner, list = listModels, log = () => {}}) {
  let using = watcher;
  let swaps = false; // learned from timing
  let seen = 0; // reload-like calls in a row
  let usual = []; // the latest Watcher calls not after a Partner turn, in ms
  const choose = async () => {
    const loaded = loadedIds(await list(entries.watcher).catch(() => null));
    const onlyPartner = loaded ? !loaded.has(entries.watcher.model) && loaded.has(entries.partner.model) : swaps;
    const next = onlyPartner ? partner : watcher;
    if (next !== using) {
      log(next === partner
        ? (loaded ? `the server has only the Partner's model loaded: the Watcher uses it, so the server need not reload`
          : 'the server seems to reload on each switch between the two models: the Watcher uses the Partner\'s model from now on')
        : 'the Watcher uses its own model again');
      using = next;
    }
    return using;
  };
  choose.timed = (ms, afterPartner) => {
    if (swaps || using !== watcher) return;
    if (!afterPartner) { usual = [...usual.slice(-19), ms]; return; }
    // Without the Watcher's usual time to compare with, a slow call says nothing: the server may be slow every time.
    const reload = usual.length >= BASELINE && ms > SWAP_MS && ms > SWAP_FACTOR * median(usual);
    seen = reload ? seen + 1 : 0;
    swaps = seen >= SWAPS_SEEN;
  };
  return choose;
}
