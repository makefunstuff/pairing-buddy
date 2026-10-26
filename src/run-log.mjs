// The run log: every build and run of the session, numbered, each with the change before it and the numbers it
// printed, and what it says next to the run before: the same numbers again after a change of the code, a number
// that moved, a crash, a build that broke. It is the lab notebook of exploratory coding (`:Pair runs`), and what
// the models read of the loop. Pure: no files, no clock.
import {numbersOf} from './delight.mjs';
import {isDebugLine} from './debug-lines.mjs';
import {crashText} from './run-output.mjs';
import {isSourceFile} from './test-output.mjs';

export const KEEP_RUNS = 30;
const OUTPUT_CHARS = 4000; // of each run's output, kept for `:Pair runs`
const NUMBERS = 12; // numbers of a run kept
const TIME_FACTOR = 2; // a time moves when it halves or doubles: one run of a small program is noisy
const SAME = 1e-9;

// The first word of a build or a run: a compiler, a build tool, an interpreter, a program by its path.
const BUILDERS = /^(?:make|gmake|cmake|ninja|meson|just|nob|cc|gcc|g\+\+|clang|clang\+\+|tcc|zig|odin|c3c|jai|rustc|cargo|go|dotnet|python3?|node|bun|deno|lua|luajit|ruby|perl|hyperfine|valgrind|perf|gdb|lldb|npm|pnpm|yarn|pytest)$/;
const SCRIPTS = /^(?:bash|sh|zsh)$/;

/** Whether the shell command `cmd` builds or runs a program, unlike `git status` or `ls`. */
export function isRun(cmd = '') {
  const words = cmd.trim().replace(/^(?:\w+=\S*\s+)+/, '').replace(/^(?:time|nice|env|command)\s+/, '').split(/\s+/);
  const [first, second] = words;
  if (!first) return false;
  if (first.includes('/')) return true; // ./probe, build/probe, ./build.sh
  if (SCRIPTS.test(first)) return /\.sh$/.test(second ?? '');
  return BUILDERS.test(first);
}

// A place in a file (a compiler's "probe.c:21:7:", odin's "main.odin(7:5)", a stack frame): no measurement.
const PLACE = /\w\.\w+(?::\d+|\(\d+)/;
const TIME_UNIT = /^(?:ns|µs|us|ms|s|sec|secs|seconds?|min)$|\/op$/i;

/**
 * The numbers of a run's output, each `{label, text, value, unit, way, time}` by where it stands. Only lines whose
 * shape the output prints once count: a listing (one line per bucket, per item) is what a debug print shows, not
 * a measurement. Addresses, and lines that name a place in a file, are no numbers.
 */
export function measure(output = '') {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').replace(/0x[0-9a-f]+/gi, 'ADDR').split('\n');
  const shapes = new Map();
  for (const line of lines) {
    const shape = line.replace(/\d+(?:\.\d+)?/g, '#').trim();
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
  }
  const once = lines.filter(line => /\d/.test(line) && !PLACE.test(line) && shapes.get(line.replace(/\d+(?:\.\d+)?/g, '#').trim()) === 1);
  const found = {};
  for (const [key, number] of [...numbersOf(once.join('\n'), {all: true})].slice(-NUMBERS)) {
    found[key] = {...number, time: TIME_UNIT.test(number.unit)};
  }
  return found;
}

/** The number a run is known by: the first that says which way is better and is no time, else the first no time. */
export function headline(numbers) {
  const all = Object.values(numbers).filter(number => !number.time);
  return all.find(number => number.way) ?? all[0] ?? null;
}

/** How long the run says it took: the first time it printed. */
const timeOf = numbers => Object.values(numbers).find(number => number.time) ?? null;

/**
 * The numbers that moved between `before` and `now` (both of measure()), the most first: every number that is not
 * a time and changed, and a time that halved or doubled. Each `{label, from, to, unit, way, better}`.
 */
export function moves(before, now) {
  const found = [];
  for (const [key, number] of Object.entries(now)) {
    const old = before[key];
    if (!old || old.value === number.value) continue;
    const ratio = Math.max(Math.abs(number.value), Math.abs(old.value)) / Math.max(Math.min(Math.abs(number.value), Math.abs(old.value)), SAME);
    if (number.time && ratio < TIME_FACTOR) continue;
    const change = (number.value - old.value) / Math.max(Math.abs(old.value), SAME);
    found.push({label: number.label, from: old.text, to: number.text, unit: number.unit, way: number.way, time: number.time, better: number.way ? change * number.way > 0 : null, change});
  }
  // Numbers that say which way is better first, then by how much they moved; times last.
  return found.sort((a, b) => (a.time - b.time) || (!!b.way - !!a.way) || Math.abs(b.change) - Math.abs(a.change));
}

/** Whether `before` and `now` print the same numbers, times aside; false when they print none. */
function sameNumbers(before, now) {
  const keys = Object.keys(now).filter(key => !now[key].time);
  return keys.length > 0 && keys.length === Object.keys(before).filter(key => !before[key].time).length
    && keys.every(key => before[key]?.value === now[key].value);
}

/** The output as text to compare: times and addresses blanked, so a rerun that prints the same reads the same. */
const plain = output => output.replace(/\x1b\[[0-9;]*m/g, '').replace(/0x[0-9a-f]+/gi, '').replace(/\d+(?:\.\d+)?\s*(?:ns|µs|us|ms|s)\b/g, '#').trim();

/** Whether an edit changed code: not a note, and more than debug prints, blank lines and comments. */
export function changesCode(edit) {
  if (!isSourceFile(edit.file)) return false;
  return edit.text.split('\n').some(line => line.trim() && !/^\s*(\/\/|#|--|\/?\*)/.test(line) && !isDebugLine(edit.file, line));
}

/**
 * What run `run` says next to `earlier` (oldest first): `{kind, ...}`. 'crash' and 'error' (it did not build) come
 * first. Else, next to the last run of the same command that got that far: 'same' (`as`, its number) when the code
 * changed since and the numbers (or, with none, the output) did not; 'moved' with its `moves`, and `held`, how many
 * runs before it printed the numbers it moved from; 'again' for a rerun that printed the same (a time is noise
 * there); 'first' for the first run of its command.
 */
export function verdict(run, earlier) {
  if (run.crash) return {kind: 'crash', text: run.crash};
  if (run.errors) return {kind: 'error'};
  const before = earlier.findLast(other => other.cmd === run.cmd && !other.crash && !other.errors);
  if (!before) return {kind: 'first'};
  const changed = earlier.filter(other => other.n > before.n).concat(run).some(other => other.changes.some(changesCode));
  const moved = moves(before.numbers, run.numbers).filter(move => changed || !move.time);
  const same = Object.keys(run.numbers).length ? sameNumbers(before.numbers, run.numbers) && !moved.length : plain(before.output) === plain(run.output) && !!plain(run.output);
  if (same) return changed ? {kind: 'same', as: before.n, numbers: Object.keys(run.numbers).length > 0} : {kind: 'again', as: before.n};
  if (moved.length) {
    const streak = earlier.filter(other => other.cmd === run.cmd && !other.crash && !other.errors).reverse();
    const held = streak.findIndex(other => !sameNumbers(other.numbers, before.numbers));
    return {kind: 'moved', as: before.n, moves: moved, changed, held: held < 0 ? streak.length : held};
  }
  return {kind: 'changed', as: before.n};
}

/**
 * The run log with one more run: `cmd` by `by` ("you" or "pair") ended at `at` with `exit` (null when unknown),
 * having printed `output`, which run-output.mjs read as `reading`, with `newWarnings` among its warnings.
 * `edits` are the session's edits: those since the run before are this run's change.
 */
export function logRun(runs, {cmd, by, at, exit = null, output = '', reading, newWarnings = [], edits = []}) {
  const last = runs.at(-1);
  const run = {
    n: (last?.n ?? 0) + 1,
    cmd,
    by,
    at,
    exit,
    output: output.length > OUTPUT_CHARS ? output.slice(-OUTPUT_CHARS) : output,
    numbers: measure(output),
    changes: edits.filter(edit => edit.at > (last?.at ?? 0)).map(({file, from, to, text}) => ({file, from, to, text})),
    crash: reading?.crash ? crashText(reading.crash) : null,
    errors: reading?.errors.length ?? 0,
    warnings: newWarnings.length,
  };
  return [...runs, {...run, verdict: verdict(run, runs)}].slice(-KEEP_RUNS);
}

const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** A move as it reads: "avg probe 23.7 → 1.1", "55 → 5 ms", "hits 12 → 9 (worse)". */
export function moveText(move) {
  const unit = move.unit ? `${/^[a-zµ]/i.test(move.unit) ? ' ' : ''}${move.unit}` : '';
  return `${move.time ? '' : `${move.label} `}${move.from} → ${move.to}${unit}${move.better === false ? ' (worse)' : ''}`;
}

// A time's label is often only the line's first word ("190000 keys ... 35 ms"): a time reads well without one.
const numberText = number => `${number.time ? '' : `${number.label} `}${number.text}${number.unit ? `${/^[a-zµ]/i.test(number.unit) ? ' ' : ''}${number.unit}` : ''}`;

/** What the verdict says in a few words, '' when it says nothing worth a word. */
export function verdictText({verdict: v, warnings}) {
  const said = {
    crash: () => v.text,
    error: () => 'does not build',
    same: () => `same ${v.numbers ? 'numbers' : 'output'} as run ${v.as}`,
    moved: () => moveText(v.moves[0]),
  }[v.kind]?.() ?? '';
  return [said, warnings ? `${plural(warnings, 'new warning')}` : ''].filter(Boolean).join(' · ');
}

/** The statusline's line for a run: "run 3 · exit 0 · 55 ms · avg probe 23.7 · same numbers as run 2". */
export function runLine(run) {
  const time = timeOf(run.numbers);
  const top = headline(run.numbers);
  const parts = [`run ${run.n}`];
  if (run.exit !== null) parts.push(`exit ${run.exit}`);
  if (time && !(run.verdict.kind === 'moved' && run.verdict.moves[0].time)) parts.push(`${time.text} ${time.unit}`);
  if (top && run.verdict.kind !== 'moved') parts.push(numberText(top));
  const said = verdictText(run);
  if (said) parts.push(said);
  return parts.join(' · ');
}

/** The change before a run, in one line: the first line of code the user typed, else "no change". */
export function changeLine(run) {
  const typed = run.changes.flatMap(edit => edit.text.split('\n')).map(line => line.trim()).filter(Boolean);
  if (run.n === 1 || !typed.length) return run.n === 1 && !typed.length ? 'first run' : 'no change';
  return typed.find(line => !/^(\/\/|#|--)/.test(line)) ?? typed[0];
}

/**
 * The last runs of `cmd` as the models read them, oldest first: the change before each, its numbers and what it
 * says. "run 3 after probe.c:13 `return (key * 31) & (CAP - 1);`: avg probe 23.7, worst 47, 55 ms; same numbers as run 2".
 */
export function runLines(runs, cmd, max = 5) {
  return runs.filter(run => run.cmd === cmd).slice(-max).map(run => {
    const change = run.changes.filter(changesCode).at(-1) ?? run.changes.at(-1);
    const print = change && !changesCode(change) ? ', a debug print' : '';
    const after = change ? ` after ${change.file}:${change.from} \`${changeLine({...run, changes: [change]})}\`${print}` : run.n === 1 ? ' (first run)' : ' (no change)';
    const numbers = Object.values(run.numbers).map(numberText).join(', ');
    const said = verdictText(run);
    return `run ${run.n}${after}: ${run.crash ?? (run.errors ? 'did not build' : numbers || 'no numbers')}${said && !run.crash ? `; ${said}` : ''}`;
  });
}

const OUTPUT_LINES = 14; // of each run's output, in what the models read

/**
 * The runs of `cmd` for a remark about the last one: runLines(), then what the last `outputs` runs printed (their
 * last lines), so the model can see what changed in the output, not only in the numbers.
 */
export function runsDetail(runs, cmd, outputs = 3) {
  const mine = runs.filter(run => run.cmd === cmd);
  const printed = mine.slice(-outputs).map(run => {
    const lines = run.output.trimEnd().split('\n');
    const shown = lines.length > OUTPUT_LINES ? ['(earlier lines cut)', ...lines.slice(-OUTPUT_LINES)] : lines;
    return `Run ${run.n} printed:\n${shown.join('\n')}`;
  });
  return `Runs of \`${cmd}\`, oldest first:\n${runLines(runs, cmd).join('\n')}\n\n${printed.join('\n\n')}`;
}
