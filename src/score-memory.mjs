// Scores already given: the same moment again (the same failure, the same file under the same goal) gets the score
// the Watcher gave it last time, without asking. The Watcher answers at temperature 0, so asking again would cost a
// request, and on a slow server a second, for the same number.

const KEPT_MS = 30 * 60_000; // a score this old is asked again: the work around it has moved on
const MAX_KEPT = 200;

/**
 * `score(trigger, state)` with a memory: `momentOf(trigger, state)` says what the Watcher is asked about, and a moment
 * scored in the last half hour gets that score again, `remembered`. A call that failed, or had to wait, is not kept.
 */
export function rememberScores(score, {momentOf, now = Date.now}) {
  const kept = new Map(); // moment -> {value, reason, at}
  return async (trigger, state) => {
    const moment = `${trigger.kind}\n${state.goal ?? ''}\n${momentOf(trigger, state)}`;
    const known = kept.get(moment);
    if (known && now() - known.at < KEPT_MS) return {value: known.value, reason: known.reason, remembered: true};
    const result = await score(trigger, state);
    if (result.deferred || result.error || result.unscored) return result;
    kept.delete(moment);
    kept.set(moment, {value: result.value, reason: result.reason, at: now()});
    if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value);
    return result;
  };
}
