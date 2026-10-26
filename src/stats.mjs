// `pair stats`: how often Pair spoke unasked and what the user made of it, per trigger, and the tuning that follows.
import {Budget, BUDGETS} from './budget.mjs';
import {TRIGGER_KINDS} from './triggers.mjs';
import {keptShare, NO_TUNING, tally, tuning} from './tuning.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const percent = share => (share === null ? '-' : `${Math.round(share * 100)}%`);
const rate = (count, hours) => (hours > 0 ? (count / hours).toFixed(1) : '-');
const signed = offset => (offset > 0 ? `+${offset}` : `${offset}`);
const gap = ms => (ms >= MINUTE ? `${Math.round(ms / MINUTE)} min` : `${Math.round(ms / 1000)} s`);

function table(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => String(row[column]).length)));
  return rows.map(row => row.map((cell, column) => (column ? String(cell).padStart(widths[column]) : String(cell).padEnd(widths[column]))).join('  ').trimEnd());
}

/**
 * The stats view as lines of text. `remarks` are the stored remarks (newest first) of at least the tuning
 * window, `activeMs` the active time in the last `days`, `level` and `autoTune` the config's.
 */
export function statsReport({remarks, activeMs, now, days, level, autoTune}) {
  const recent = remarks.filter(remark => now - remark.at <= days * DAY);
  const hours = activeMs / HOUR;
  const total = tally(recent, now);
  const lines = [
    `Last ${days} days, all projects: ${hours.toFixed(1)} h of active pairing, ${total.remarks} unasked remarks (${rate(total.remarks, hours)} per hour)`,
    `useful ${total.useful} · dismissed ${total.dismissed} · ignored ${total.ignored}${total.waiting ? ` · waiting ${total.waiting}` : ''} · kept ${percent(keptShare(total))}`,
    '',
  ];
  const budget = new Budget(level, autoTune ? tuning(remarks, now) : NO_TUNING);
  const base = BUDGETS[level];
  const kinds = [...new Set([...TRIGGER_KINDS, ...recent.map(remark => remark.trigger)])];
  const rows = kinds.map(kind => {
    const counts = tally(recent.filter(remark => remark.trigger === kind), now);
    const bar = budget.barFor(kind);
    return [kind, counts.remarks, rate(counts.remarks, hours), counts.useful, counts.dismissed, counts.ignored, percent(keptShare(counts)),
      bar === base.bar ? bar : `${bar} (${signed(bar - base.bar)})`];
  });
  lines.push(...table([['trigger', 'remarks', 'per hour', 'useful', 'dismissed', 'ignored', 'kept', 'bar'], ...rows]));
  const {perHour, minGapMs} = budget.limits();
  lines.push('', `Budget at level ${level}: at most ${perHour} remarks per hour, ${gap(minGapMs)} apart (the level's default: ${base.perHour}, ${gap(base.minGapMs)})`);
  lines.push(autoTune
    ? 'Tuning follows your verdicts of the last 30 days: a trigger needs 5 of them to move its bar, the budget 10.'
    : 'Tuning is off ("autoTune": false in the config): bars and budget are the level\'s defaults.');
  return lines;
}
