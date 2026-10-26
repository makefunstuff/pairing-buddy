// Learning when to talk: the user's verdicts on Pair's unasked remarks raise or lower each trigger's bar and
// shrink or grow the speak budget, always within fixed bounds. Pure: the caller passes the remarks and the clock.

const DAY = 24 * 60 * 60_000;

export const IGNORED_AFTER_MS = 10 * 60_000; // a remark with no verdict by then, and never seen, was ignored: not useful
export const WINDOW_MS = 30 * DAY; // older verdicts no longer count
const PER_TRIGGER = 20; // the latest judged remarks of each trigger that count, so tuning follows recent habits
const MIN_PER_TRIGGER = 5; // fewer judged remarks of a trigger leave its bar alone
const MIN_OVERALL = 10; // fewer judged remarks in all leave the budget alone

/** The safe bounds: a bar moves at most this far from its level's, and the budget scales at most this much. */
export const BOUNDS = {barOffset: {min: -1, max: 2}, bar: {min: 3, max: 9}, factor: {min: 0.5, max: 1.5}};

/**
 * What became of a remark: "useful", "dismissed", "seen" (the user edited on after it, without a verdict: neither
 * useful nor noise), "ignored", or "waiting" while it is too young to tell.
 */
export function outcome(remark, now) {
  if (remark.verdict) return remark.verdict;
  return now - remark.at >= IGNORED_AFTER_MS ? 'ignored' : 'waiting';
}

/** How many of `remarks` ended each way. */
export function tally(remarks, now) {
  const counts = {remarks: remarks.length, useful: 0, dismissed: 0, seen: 0, ignored: 0, waiting: 0};
  for (const remark of remarks) counts[outcome(remark, now)] += 1;
  return counts;
}

/** The share of judged remarks that were useful; null when none were judged. Seen remarks are not judged. */
export function keptShare({useful, dismissed, ignored}) {
  const judged = useful + dismissed + ignored;
  return judged ? useful / judged : null;
}

// Mostly noise raises the bar, mostly useful lowers it; in between it stays.
function barOffset(kept) {
  if (kept < 0.25) return 2;
  if (kept < 0.4) return 1;
  if (kept > 0.75) return -1;
  return 0;
}

function budgetFactor(kept) {
  if (kept < 0.3) return 0.5;
  if (kept < 0.5) return 0.75;
  if (kept > 0.8) return 1.5;
  return 1;
}

/**
 * The tuning that `remarks` (newest first) call for: `offsets` to each trigger's bar, by trigger kind, and
 * `factor`, which scales how many remarks the budget allows per hour (and divides the gap between them).
 */
export function tuning(remarks, now) {
  const byTrigger = new Map();
  for (const remark of remarks) {
    if (now - remark.at > WINDOW_MS || ['waiting', 'seen'].includes(outcome(remark, now))) continue;
    const judged = byTrigger.get(remark.trigger) ?? [];
    if (judged.length < PER_TRIGGER) byTrigger.set(remark.trigger, [...judged, remark]);
  }
  const offsets = {};
  for (const [trigger, judged] of byTrigger) {
    if (judged.length >= MIN_PER_TRIGGER) offsets[trigger] = barOffset(keptShare(tally(judged, now)));
  }
  const counted = [...byTrigger.values()].flat();
  const factor = counted.length >= MIN_OVERALL ? budgetFactor(keptShare(tally(counted, now))) : 1;
  return {offsets, factor};
}

export const NO_TUNING = {offsets: {}, factor: 1};
