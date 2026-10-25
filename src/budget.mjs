// How often Pair may speak unasked, per talk level. Answers to the user's own questions never count.

const HOUR = 60 * 60_000;

export const BUDGETS = {
  quiet: {minGapMs: 15 * 60_000, perHour: 2, bar: 8},
  normal: {minGapMs: 4 * 60_000, perHour: 6, bar: 6},
  chatty: {minGapMs: 90_000, perHour: 15, bar: 4},
};

export class Budget {
  constructor(level = 'normal') {
    this.setLevel(level);
    this.spent = [];
  }

  setLevel(level) {
    if (!BUDGETS[level]) throw new Error(`Unknown level ${level}`);
    this.level = level;
  }

  /** The Watcher score a remark needs at this level, 0 to 10. */
  get bar() {
    return BUDGETS[this.level].bar;
  }

  allows(now) {
    const {minGapMs, perHour} = BUDGETS[this.level];
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
