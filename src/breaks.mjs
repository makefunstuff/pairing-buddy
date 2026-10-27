// Break hints: after a long stretch of focus, Pair suggests a break, but only at a natural end (the tests turn
// green, a command passes again, a number finally moves, a commit), never in the middle of a red and never on a
// timer. At most one per FOCUS_MS of focus; five minutes away is a break, and the count starts again. The quiet
// level turns them off. Pure: the clock is passed in.
import {duration} from './debrief.mjs';

export const FOCUS_MS = 50 * 60_000; // focus before the first hint, and between two hints
const LONG_MS = 90 * 60_000; // focus that deserves a longer break
const REST_MS = 5 * 60_000; // this long away is a break, as it stops the active time (session.mjs)


export class Breaks {
  constructor() {
    this.since = null; // when this stretch of focus began
    this.hinted = null; // when the last hint was given in it
    this.last = null; // the user's last key, edit or command
  }

  /** The user's last key, edit or command, at each tick: a gap of REST_MS before it ends the stretch. */
  saw(at) {
    if (!at || at === this.last) return;
    if (this.last === null || at - this.last >= REST_MS) {
      this.since = at;
      this.hinted = null;
    }
    this.last = at;
  }

  /** A natural end: `what` is how it reads ("green", "committed"). The hint, or null when it is not time. */
  natural(what, now, {level = 'normal', red = false} = {}) {
    if (level === 'quiet' || red || this.since === null) return null;
    const focus = now - this.since;
    if (focus < FOCUS_MS || (this.hinted !== null && now - this.hinted < FOCUS_MS)) return null;
    this.hinted = now;
    const kind = focus >= LONG_MS ? 'a longer break' : 'a short break';
    return `${duration(focus)} of focus, and ${what}: a good moment for ${kind}.`;
  }
}
