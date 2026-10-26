// The speak gate: whether an unasked remark goes to the Partner now, later, or not at all.
import {prefilter} from './prefilter.mjs';

/**
 * `wait` while the user types, or while the Watcher has to wait for the model (the trigger is looked at again on
 * the next tick); `drop` when the budget is spent,
 * the prefilter knows it for noise, or the Watcher scores it below the trigger's bar at this level; otherwise
 * `speak`. A lasting trigger the budget holds back is `later`: looked at again until the budget allows.
 * `score(trigger, state)` is the Watcher, `{deferred, reason}` when it has to wait for the model: the decision is
 * then `held`. The Watcher is only asked once typing, budget and prefilter allow.
 */
export async function decide({trigger, state, now, budget, score, typingPauseMs}) {
  if (now - state.lastKeyAt < typingPauseMs) return {verdict: 'wait', reason: 'typing'};
  const room = budget.allows(now);
  // A lasting trigger (drift: the user is still in that file) is still true once the budget allows again.
  if (!room.ok) return {verdict: trigger.lasting ? 'later' : 'drop', reason: room.reason};
  const noise = prefilter(trigger, state);
  if (noise) return {verdict: 'drop', reason: noise.reason, score: noise.value};
  const scored = await score(trigger, state);
  if (scored.deferred) return {verdict: 'wait', reason: scored.reason, held: true};
  const {value, reason} = scored;
  const bar = budget.barFor(trigger.kind);
  if (value < bar) return {verdict: 'drop', reason: `score ${value} < ${bar}${reason ? `: ${reason}` : ''}`, score: value};
  return {verdict: 'speak', reason: reason || `score ${value}`, score: value};
}
