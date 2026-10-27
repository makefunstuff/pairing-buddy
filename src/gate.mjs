// The speak gate: whether an unasked remark goes to the Partner now, later, or not at all.
import {SURE} from './decision.mjs';
import {prefilter} from './prefilter.mjs';

const percent = p => `${Math.round(p * 100)}%`;

/**
 * `wait` while the user types, or while the Watcher has to wait for the model (the trigger is looked at again on
 * the next tick); `drop` when the budget is spent,
 * the prefilter knows it for noise, the Watcher's pace is not asking about that kind (see pace.mjs), or the Watcher
 * scores it below the trigger's bar at this level; otherwise
 * `speak`. A lasting trigger the budget holds back is `later`: looked at again until the budget allows.
 * `score(trigger, state)` is the Watcher, `{deferred, reason}` when it has to wait for the model: the decision is
 * then `held`. The Watcher is only asked once typing, budget and prefilter allow.
 * `pace` (a pace.mjs Pace) says what the server can afford.
 *
 * With a `decider` (the decision model, see decision.mjs), the moment is first sorted: noise is dropped and a moment
 * plainly worth a remark goes on without the Watcher, when the model is SURE; else the Watcher scores it. Whether to
 * speak is then the probability that the remark is worth interrupting for now, against the bar as a share (a bar of
 * 6 needs 60%). `decider.sort(trigger, state, {bar})` resolves `{choice, p, speak}` and `decider.speak(trigger, state,
 * {score, bar})` `{p}`; either is `{fallback}` when the model gave no answer, and the gate goes by the rules above at
 * once. The decision's `decided` says what the model answered and what the rules alone would have done, for the log.
 */
export async function decide({trigger, state, now, budget, score, typingPauseMs, pace = null, decider = null}) {
  if (now - state.lastKeyAt < typingPauseMs) return {verdict: 'wait', reason: 'typing'};
  const room = budget.allows(now);
  // A lasting trigger (drift: the user is still in that file) is still true once the budget allows again.
  if (!room.ok) return {verdict: trigger.lasting ? 'later' : 'drop', reason: room.reason};
  const noise = prefilter(trigger);
  if (noise) return {verdict: 'drop', reason: noise.reason, score: noise.value};
  const bar = budget.barFor(trigger.kind);
  const sorted = decider ? await decider.sort(trigger, state, {bar}) : null;
  const decided = sorted && {sort: sorted.choice ?? null, sortP: sorted.p ?? null, fallback: sorted.fallback ?? null};
  if (sorted?.choice === 'noise' && sorted.p >= SURE) {
    return {verdict: 'drop', reason: `the decision model: noise (${percent(sorted.p)})`, decided, byModel: true};
  }
  if (sorted?.choice === 'worth' && sorted.p >= SURE) return byProbability(sorted.speak, bar, {...decided, speakP: sorted.speak}, `worth a remark (${percent(sorted.p)})`);
  const slow = pace?.skips(trigger.kind);
  if (slow) return {verdict: 'drop', reason: slow.reason, skipped: true, ...(decided ? {decided} : {})};
  const scored = await score(trigger, state);
  if (scored.deferred) return {verdict: 'wait', reason: scored.reason, held: true};
  const {value, reason} = scored;
  const rule = value < bar ? 'drop' : 'speak';
  const judged = decider && !scored.error && !scored.unscored ? await decider.speak(trigger, state, {score: value, bar}) : null;
  if (judged && !judged.fallback) {
    const asked = byProbability(judged.p, bar, {...decided, speakP: judged.p, score: value, rule}, `score ${value}`);
    return {...asked, score: value};
  }
  const fellBack = decided || judged ? {decided: {...decided, speakP: null, score: value, rule, fallback: judged?.fallback ?? decided?.fallback ?? null}} : {};
  if (rule === 'drop') return {verdict: 'drop', reason: `score ${value} < ${bar}${reason ? `: ${reason}` : ''}`, score: value, ...fellBack};
  return {verdict: 'speak', reason: reason || `score ${value}`, score: value, ...fellBack};
}

/** Speak when the probability `p` that a remark is worth interrupting for reaches the bar as a share. */
function byProbability(p, bar, decided, why) {
  const need = bar / 10;
  if (p < need) return {verdict: 'drop', reason: `the decision model: ${why}, but worth interrupting for now ${percent(p)} < ${percent(need)}`, decided, byModel: true};
  return {verdict: 'speak', reason: `the decision model: ${why}, worth interrupting for now ${percent(p)}`, decided, byModel: true};
}
