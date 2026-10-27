// The Watcher's pace: while the server answers slowly, fewer kinds of moment get asked about at all.
//
// Every candidate remark waits for one Watcher call, and Pair cannot make a call faster: on a slow server, or one
// that keeps one model loaded, that call is the floor under each new moment. The cheap rules drop what they are sure
// of, and a moment seen before is answered from memory (see prefilter.mjs and score-memory.mjs), so what is left is a
// *new* moment: the only room left is to ask about fewer of them. That is what this decides, from how long the
// Watcher's own calls take.
//
// Which kinds to give up is not a guess. A moment is worth a call when the user cannot see it for themselves; the
// kinds first off the list are all on the screen already (the note you are writing, the file you chose to open, the
// numbers in the terminal, the warning the build printed). The ones kept to the end are news you cannot see: why a
// run crashed, an error in code you moved on from, a test you have not run, a failure you did not look at. Where the
// user's own verdicts on a kind add up (as many as tuning.mjs needs: five judged remarks), their kept share decides
// the order instead, so a kind Pair gets dismissed stops costing a call.
import {TRIGGER_KINDS} from './triggers.mjs';

// About a second is the aim. A cloud API tested for this (docs/watcher.md, "When the server is slow") scored in
// 0.5 to 1.4 s, its median under a second, and gives nothing up. Giving kinds up starts where `pair doctor` warns
// that the Watcher is slow; coming back needs the median at FAST_MS or under, so a server between the two keeps the
// pace it has and does not change its mind on every call.
export const SLOW_MS = 1500; // the median call at or over which Pair starts giving kinds up
export const VERY_SLOW_MS = 3000; // at or over this, only the moments you cannot see are asked about
export const FAST_MS = 1000; // at or under this, every kind is asked about again
export const MIN_CALLS = 5; // calls before the median says anything: two reload-long ones among them are not the norm
const SAMPLES = 12; // the latest this many calls count, and
const MIN_VERDICTS = 5; // judged remarks a kind needs before its kept share ranks it (as in tuning.mjs)

/** The kinds Pair gives up first, the least worth a call first; the rest it keeps to the end. */
export const GIVE_UP = ['note_drift', 'note_stall', 'drift', 'search_trail', 'number_moved', 'same_result', 'new_warning', 'stall'];

/** The kinds never given up: news the user cannot see for themselves. */
export const KEPT = TRIGGER_KINDS.filter(kind => !GIVE_UP.includes(kind));

const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]; // the lower middle: a slow half does not make a slow server
};

const seconds = ms => `${(ms / 1000).toFixed(1)} s`;

/**
 * The kinds given up at `level`, `GIVE_UP.length / 2` of them at `slow` and all of them at `very-slow`, the lowest
 * yielding first: `keptOf` (`{kind: {share, judged}}`, from tuning.mjs's keptShares) ranks a kind the user has
 * judged at least MIN_VERDICTS times by how many of those remarks they kept, and every other kind by the order
 * above. A kind is never given up for having no verdicts.
 */
export function giveUp(level, keptOf = {}) {
  if (level === 'fast' || level === 'off') return [];
  const rank = (kind, i) => (keptOf[kind]?.judged >= MIN_VERDICTS ? keptOf[kind].share : i / GIVE_UP.length);
  const judged = GIVE_UP.map((kind, i) => ({kind, rank: rank(kind, i), order: i}));
  judged.sort((a, b) => a.rank - b.rank || a.order - b.order);
  const count = level === 'very-slow' ? judged.length : Math.ceil(judged.length / 2);
  return judged.slice(0, count).map(row => row.kind);
}

/**
 * How much the Watcher's calls say Pair can ask about, from `hear(ms)` for each call it made (a score, a keep-warm
 * ping: everything the server answers). `level` is `fast` (ask about everything), `slow` (give the least yielding
 * kinds up), `very-slow` (ask only about the moments you cannot see) or `off` (`on: false`: ask about everything,
 * whatever the server costs). `rank(keptOf)` takes the user's verdicts on each kind (see giveUp), which order what is
 * given up for the sessions, the log and `pair doctor` alike. `skips(kind)` says whether a kind costs no call now,
 * with the reason for the ledger; a kind of KEPT is never skipped. `snapshot()` is what `pair doctor` shows.
 *
 * A slow server that stops being asked stops answering: the calls of the kinds kept, and the keep-warm pings, keep
 * measuring, so the pace finds its way back to `fast` on its own.
 */
export class Pace {
  constructor({on = true, log = () => {}} = {}) {
    this.log = log;
    this.samples = [];
    this.keptOf = {}; // the user's verdicts on each kind, which rank what is given up
    this.changes = 0; // level changes, for `pair doctor`
    this.#on = on;
  }

  #level = 'fast';
  #on = true;

  get level() {
    return this.#on ? this.#level : 'off';
  }

  get on() {
    return this.#on;
  }

  /** Turned on again, the pace goes by the calls measured while it was off, not the level it had before. */
  set on(on) {
    if (on === this.#on) return;
    this.#on = on;
    if (!on) return;
    this.#level = 'fast';
    this.#judge();
  }

  get medianMs() {
    return median(this.samples);
  }

  /** One Watcher call answered in `ms`: a score, or a keep-warm ping. */
  hear(ms) {
    this.samples = [...this.samples.slice(1 - SAMPLES), ms];
    if (this.#on) this.#judge();
  }

  /** The verdicts that rank the kinds given up, `{kind: {share, judged}}` from tuning.mjs's keptShares. */
  rank(keptOf) {
    const before = [...this.given()].sort().join();
    this.keptOf = keptOf;
    if ([...this.given()].sort().join() === before) return;
    this.log(`the user's verdicts change what Pair gives up: it is not asking about ${this.given().join(', ')} while the server is this slow`);
  }

  #judge() {
    if (this.samples.length < MIN_CALLS) {
      this.#level = 'fast';
      return;
    }
    const middle = median(this.samples);
    // Going down needs SLOW_MS; coming back needs FAST_MS. Between the two the pace keeps what it is.
    const next = middle >= VERY_SLOW_MS ? 'very-slow' : middle >= SLOW_MS ? 'slow' : middle <= FAST_MS ? 'fast' : this.#level;
    if (next === this.#level) return;
    this.changes += 1;
    this.#level = next;
    const given = this.given();
    if (given.length) {
      this.log(`the Watcher takes ${seconds(middle)} a call: Pair is not asking about ${given.join(', ')} while the server is this slow`);
    } else {
      this.log(`the Watcher answers in ${seconds(middle)} again: Pair asks about every kind of moment`);
    }
  }

  /** The kinds given up now, ranked by the user's verdicts (see giveUp). */
  given() {
    return giveUp(this.level, this.keptOf);
  }

  /**
   * `{reason}` when `kind` costs no Watcher call at this pace, and Pair stays quiet about it; null when it is asked
   * about as usual.
   */
  skips(kind) {
    if (!this.given().includes(kind)) return null;
    return {reason: `the Watcher takes ${seconds(this.medianMs)} a call: Pair is not asking about ${kind} while the server is this slow`};
  }

  /** What `pair doctor` shows: the pace, the Watcher's median call, and what it is not asking about. */
  snapshot() {
    return {level: this.level, medianMs: this.medianMs, calls: this.samples.length, changes: this.changes, givenUp: this.given()};
  }
}
