// How often Pair may speak unasked, per talk level, as tuned by the user's feedback (see tuning.mjs).
// Answers to the user's own questions never count.
import {BOUNDS, NO_TUNING} from './tuning.mjs';

const HOUR = 60 * 60_000;

export const BUDGETS = {
  quiet: {minGapMs: 15 * 60_000, perHour: 2, bar: 8},
  normal: {minGapMs: 3 * 60_000, perHour: 6, bar: 6},
  chatty: {minGapMs: 90_000, perHour: 15, bar: 4},
};

const clamp = (value, {min, max}) => Math.min(max, Math.max(min, value));

export class Budget {
  constructor(level = 'normal', tuning = NO_TUNING) {
    this.setLevel(level);
    this.tune(tuning);
    this.spent = [];
  }

  setLevel(level) {
    if (!BUDGETS[level]) throw new Error(`Unknown level ${level}`);
    this.level = level;
  }

  /** Applies a tuning from tuning.mjs, held within BOUNDS whatever it says. */
  tune({offsets, factor}) {
    this.tuning = {
      offsets: Object.fromEntries(Object.entries(offsets).map(([kind, offset]) => [kind, clamp(offset, BOUNDS.barOffset)])),
      factor: clamp(factor, BOUNDS.factor),
    };
  }

  /** The Watcher score a remark of trigger `kind` needs at this level, 0 to 10. */
  barFor(kind) {
    return clamp(BUDGETS[this.level].bar + (this.tuning.offsets[kind] ?? 0), BOUNDS.bar);
  }

  /** How many remarks an hour, and how far apart, at this level and tuning. */
  limits() {
    const {minGapMs, perHour} = BUDGETS[this.level];
    const {factor} = this.tuning;
    return {perHour: Math.max(1, Math.round(perHour * factor)), minGapMs: Math.round(minGapMs / factor)};
  }

  allows(now) {
    const {minGapMs, perHour} = this.limits();
    const lastHour = this.spent.filter(at => now - at < HOUR);
    if (lastHour.length >= perHour) return {ok: false, reason: `${perHour} remarks in the last hour`};
    const last = lastHour.at(-1);
    if (last !== undefined && now - last < minGapMs) return {ok: false, reason: 'spoke too recently'};
    return {ok: true};
  }

  spend(now) {
    this.spent = [...this.spent.filter(at => now - at < HOUR), now];
  }
}
