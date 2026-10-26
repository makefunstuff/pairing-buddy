// The speak gate: whether an unasked remark goes to the Partner now, later, or not at all.
import {prefilter} from './prefilter.mjs';

/**
 * `wait` while the user types (the trigger is looked at again on the next tick), `drop` when the budget is
 * spent, the prefilter knows it for noise, or the Watcher scores it below the trigger's bar at this level,
 * otherwise `speak`. `score(trigger, state)` is the Watcher; it is only asked once typing, budget and
 * prefilter allow.
 */
export async function decide({trigger, state, now, budget, score, typingPauseMs}) {
  if (now - state.lastKeyAt < typingPauseMs) return {verdict: 'wait', reason: 'typing'};
  const room = budget.allows(now);
  if (!room.ok) return {verdict: 'drop', reason: room.reason};
  const noise = prefilter(trigger, state);
  if (noise) return {verdict: 'drop', reason: noise.reason, score: noise.value};
  const {value, reason} = await score(trigger, state);
  const bar = budget.barFor(trigger.kind);
  if (value < bar) return {verdict: 'drop', reason: `score ${value} < ${bar}${reason ? `: ${reason}` : ''}`, score: value};
  return {verdict: 'speak', reason: reason || `score ${value}`, score: value};
}
