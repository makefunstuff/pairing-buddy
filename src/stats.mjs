// `pair stats`: how often Pair spoke unasked and what the user made of it, per trigger, and the tuning that follows,
// for all projects or, with --project, for one.
import {basename} from 'node:path';
import {Budget, BUDGETS} from './budget.mjs';
import {SURE} from './decision.mjs';
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

const counted = (parts, sep = ' · ') => parts.filter(([n]) => n).map(([n, what]) => `${what} ${n}`).join(sep);

/**
 * How the decision model did (see decision.mjs), from the logged `decisions` (newest first) of the shown days: what it
 * sorted the moments as, the Watcher calls that saved, and what became of the remarks it let through, next to the
 * remarks the rules alone let through (`remarks`: the same days' remarks). Where the Watcher scored a moment too, it
 * says how often the model and the bar agreed. Empty without any decision.
 */
export function decisionLines(decisions, remarks, now) {
  if (!decisions.length) return [];
  const answered = decisions.filter(decision => !decision.fallback);
  const sorts = sort => answered.filter(decision => decision.sort === sort).length;
  const fallbacks = Object.entries(Object.groupBy(decisions.filter(decision => decision.fallback), decision => decision.fallback))
    .map(([why, list]) => `${why} ${list.length}`);
  // Saved: the model was sure (noise, or worth it) and the Watcher was not asked. A moment the pace held back after an
  // unsure sort cost no call either, but that is the pace's saving, not the model's.
  const noWatcher = answered.filter(decision => decision.score === null && ['noise', 'worth'].includes(decision.sort) && decision.sortP >= SURE).length;
  const lines = [
    '',
    `Decision model: ${plural(decisions.length, 'moment')} judged; it answered ${answered.length}`
      + `${fallbacks.length ? `, the rules decided the rest (${fallbacks.join(', ')})` : ''}`,
    `  sorted as ${counted([[sorts('noise'), 'noise'], [sorts('worth'), 'worth it'], [sorts('ask'), 'for the Watcher']]) || 'nothing'}; `
      + `${plural(noWatcher, 'Watcher call')} saved`,
  ];
  // What the model let through, and the remarks of the same days the rules let through.
  const byModel = answered.filter(decision => decision.speakP !== null);
  const spoke = byModel.filter(decision => decision.decided === 'speak' && decision.remarkAt !== null);
  const mine = new Set(spoke.map(decision => decision.remarkId));
  const own = tally(spoke.map(decision => ({verdict: decision.verdict, at: decision.remarkAt})), now);
  const rules = tally(remarks.filter(remark => !mine.has(remark.id)), now);
  const verdicts = counts => `useful ${counts.useful} · dismissed ${counts.dismissed} · ignored ${counts.ignored}${counts.waiting ? ` · waiting ${counts.waiting}` : ''} · kept ${percent(keptShare(counts))}`;
  lines.push(`  its remarks: ${own.remarks}: ${verdicts(own)}`);
  lines.push(`  the rules' remarks (the Watcher's score against the bar): ${rules.remarks}: ${verdicts(rules)}`);
  const both = byModel.filter(decision => decision.rule !== null);
  if (both.length) {
    const agreed = both.filter(decision => decision.rule === decision.decided).length;
    const more = both.filter(decision => decision.decided === 'speak' && decision.rule === 'drop').length;
    const less = both.filter(decision => decision.decided === 'drop' && decision.rule === 'speak').length;
    lines.push(`  where the Watcher scored too, the model and the bar agreed on ${agreed} of ${both.length}: it spoke ${plural(more, 'time')} the bar would not, `
      + `and stayed quiet ${plural(less, 'time')} the bar would have spoken`);
  }
  return lines;
}

/**
 * The stats view as lines of text. `remarks` are the stored remarks (newest first) of at least the tuning
 * window, `activeMs` the active time in the last `days`, `level` and `autoTune` the config's. With `root`, the
 * remarks and the tuning are that project's, and `activeMs` should be too.
 */
export function statsReport({remarks, activeMs, now, days, level, autoTune, root = null, decisions = []}) {
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
  const judged = decisions.filter(decision => now - decision.at <= days * DAY && (!root || decision.root === root));
  lines.push(...decisionLines(judged, recent, now));
  return lines;
}
