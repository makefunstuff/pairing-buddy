// `pair stats`: how often Pair spoke unasked and what the user made of it, per trigger, and the tuning that follows,
// for all projects or, with --project, for one.
import {basename} from 'node:path';
import {Budget, BUDGETS} from './budget.mjs';
import {TRIGGER_KINDS} from './triggers.mjs';
import {keptShare, NO_TUNING, tally, tuning} from './tuning.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const percent = share => (share === null ? '-' : `${Math.round(share * 100)}%`);
const MIN_RATE_HOURS = 0.1; // a rate over a few minutes of pairing says nothing
const rate = (count, hours) => (hours >= MIN_RATE_HOURS ? (count / hours).toFixed(1) : '-');
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const signed = offset => (offset > 0 ? `+${offset}` : `${offset}`);
function gap(ms) {
  const seconds = Math.round(ms / 1000);
  const [minutes, rest] = [Math.floor(seconds / 60), seconds % 60];
  return [minutes && `${minutes} min`, (rest || !minutes) && `${rest} s`].filter(Boolean).join(' ');
}

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/**
 * How long remarks waited for the model while the Partner was at work (with one model, or one server, for both
 * roles); null when none did.
 */
function waitLine(remarks) {
  const waits = remarks.map(remark => remark.waitedMs).filter(ms => ms > 0);
  if (!waits.length) return null;
  return `${waits.length} of ${plural(remarks.length, 'remark')} waited for the model while the Partner was at work: `
    + `${gap(median(waits))} (median), at most ${gap(Math.max(...waits))}`;
}

function table(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => String(row[column]).length)));
  return rows.map(row => row.map((cell, column) => (column ? String(cell).padStart(widths[column]) : String(cell).padEnd(widths[column]))).join('  ').trimEnd());
}

const list = words => (words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0]);

/** What the tuning of project `root` follows: its own verdicts, those of all projects, or some of each. */
function tuningLine({triggers, budget}, root) {
  const own = [...triggers, ...(budget ? ['the budget'] : [])];
  const rule = 'a project needs 5 verdicts on a trigger to tune its bar, 10 in all for its budget';
  if (!own.length) return `Tuning follows the verdicts of all projects of the last 30 days until ${basename(root)} has enough of its own: ${rule}.`;
  return `Tuning follows ${basename(root)}'s own verdicts for ${list(own)}, those of all projects for the rest (${rule}).`;
}

/**
 * The stats view as lines of text. `remarks` are the stored remarks (newest first) of at least the tuning
 * window, `activeMs` the active time in the last `days`, `level` and `autoTune` the config's. With `root`, the
 * remarks and the tuning are that project's, and `activeMs` should be too.
 */
export function statsReport({remarks, activeMs, now, days, level, autoTune, root = null}) {
  const recent = remarks.filter(remark => now - remark.at <= days * DAY && (!root || remark.root === root));
  const hours = activeMs / HOUR;
  const total = tally(recent, now);
  const lines = [
    `Last ${plural(days, 'day')}, ${root ? `project ${basename(root)}` : 'all projects'}: ${hours.toFixed(1)} h of active pairing, ${plural(total.remarks, 'unasked remark')} (${rate(total.remarks, hours)} per hour)`,
    `useful ${total.useful} · dismissed ${total.dismissed} · ignored ${total.ignored}${total.seen ? ` · seen ${total.seen}` : ''}${total.waiting ? ` · waiting ${total.waiting}` : ''} · kept ${percent(keptShare(total))}`,
    ...[waitLine(recent)].filter(Boolean),
    '',
  ];
  const tuned = autoTune ? tuning(remarks, now, root) : NO_TUNING;
  const budget = new Budget(level, tuned);
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
  if (!autoTune) lines.push('Tuning is off ("autoTune": false in the config): bars and budget are the level\'s defaults.');
  else if (root) lines.push(tuningLine(tuned.project, root));
  else lines.push('Tuning follows your verdicts of the last 30 days: a trigger needs 5 of them to move its bar, the budget 10. Each project tunes on its own verdicts once it has as many (pair stats --project).');
  return lines;
}
