// Delight, sized to the event: when the tests turn green after a red, the editor lights up once; when the red
// lasted (LONG_RED_MS) or began with a regression, or a number in a command's output finally moved the right way,
// one line in Pair's voice says what is now true. Never praise: the line names the fact. Pure, the clock is passed in.

export const LONG_RED_MS = 10 * 60_000;
const NAMES = 2; // failing tests the green line names
const HISTORY = 4; // runs of a command whose numbers are kept
const STEADY = 0.05; // a number that moves less than this between runs holds still
const MOVED = 0.25; // and one that moves at least this much, the right way, moved
const MAX_LINES = 400; // of a command's output, read for numbers
const MAX_LINE_CHARS = 160;

const minutes = ms => `${Math.round(ms / 60_000)} min`;
const code = text => `\`${text}\``;

/** "`TestA` passes", "`TestA` and `TestB` pass", "`TestA`, `TestB` and 3 more pass". */
function passing(names) {
  if (names.length === 1) return `${code(names[0])} passes`;
  const shown = names.slice(0, NAMES).map(code);
  const more = names.length - shown.length;
  return `${more ? `${shown.join(', ')} and ${more} more` : shown.join(' and ')} pass`;
}

// Which way is better, from the number's unit or the words before it. Lower first: "miss rate" is lower-better.
const LOWER_UNITS = /\/op$|^(ns|µs|us|ms|s|sec|secs|seconds?|min|cycles?|b|kb|kib|mb|mib|gb|gib|bytes?)$/i;
const LOWER_WORDS = /\b(time|latency|elapsed|took|duration|wait|miss(es)?|errors?|warnings?|fail(s|ures?)?|leaks?|allocs?|allocations?|collisions?|probes?|size|bytes|cycles|stalls?|retries)\b/i;
const HIGHER_UNITS = /\/s$|^(ops|fps|hz|x)$/i; // per second, or a speedup
const HIGHER_WORDS = /\b(throughput|ops|fps|hits?|score|speedup|passed|per sec(ond)?)\b/i;

/** -1 when lower is better, 1 when higher is, 0 when the number says nothing about it. */
export function betterWay(label, unit) {
  const words = `${label} ${unit}`;
  if (HIGHER_UNITS.test(unit)) return 1;
  if (LOWER_UNITS.test(unit) || LOWER_WORDS.test(words)) return -1;
  if (HIGHER_WORDS.test(words)) return 1;
  return 0;
}

// A number, and its unit: letters right after it ("12ms", "4.2x", "80%"), or a known one after a space ("12 ms").
const NUMBER = /(?<![\w.])(-?\d+(?:\.\d+)?)(?:([a-zµ%]+(?:\/(?:s|op))?)|[ \t]([a-zµ]+\/(?:s|op)|ns|µs|us|ms|s|sec|secs|seconds?|min|cycles|bytes|[kmg]i?b|ops|fps|misses|hits|errors|warnings|allocs|collisions|probes|x|%)(?![\w/]))?/gi;
const wordsOf = text => text.replace(/[^\p{L}\p{N}/ _.-]+/gu, ' ').split(/\s+/).filter(word => /\p{L}/u.test(word));
const LABEL_END = /[(),;|[\]{}]/; // what starts a new label on a line: "avg 23.7 (max 40)" labels 40 "max"

/**
 * The labelled numbers of a command's output, by where they stand: the line with its numbers blanked out, and
 * which number of the line. A number with no words before it, or none that tell which way is better, is left out.
 */
export function numbersOf(output = '') {
  const found = new Map();
  for (const line of output.split('\n').slice(-MAX_LINES)) {
    if (line.length > MAX_LINE_CHARS || /\d:\d\d/.test(line)) continue; // times of day and timestamps move anyway
    const shape = line.replace(NUMBER, '#').trim();
    let from = 0;
    [...line.matchAll(NUMBER)].forEach((match, index) => {
      const before = line.slice(from, match.index).split(LABEL_END).at(-1);
      from = match.index + match[0].length;
      // Else the line's first word: "BenchmarkLookup-8   1000000   1043 ns/op".
      const label = wordsOf(before).slice(-3).join(' ') || (wordsOf(line)[0] ?? '');
      const unit = match[2] ?? match[3] ?? '';
      const way = label ? betterWay(label, unit) : 0;
      if (way) found.set(`${shape}#${index}`, {label, value: Number(match[1]), text: match[1], unit, way});
    });
  }
  return found;
}

/** How many of the last runs (`runs`, oldest first) had `key` near the last one's value: at least 2 is holding still. */
function held(key, runs) {
  const last = runs.at(-1)?.get(key);
  if (!last?.value) return 0;
  let count = 0;
  for (const run of runs.toReversed()) {
    const old = run.get(key);
    if (!old || Math.abs(old.value - last.value) > STEADY * Math.abs(last.value)) break;
    count++;
  }
  return count;
}

/** The line about the number that moved most the right way after holding still for two runs or more, or null. */
function moved(now, runs) {
  let best = null;
  for (const [key, number] of now) {
    const count = held(key, runs);
    if (count < 2) continue;
    const last = runs.at(-1).get(key);
    const change = (number.value - last.value) / Math.abs(last.value);
    if (change * number.way < MOVED || (best && Math.abs(change) <= Math.abs(best.change))) continue;
    best = {change, number, last, count};
  }
  if (!best) return null;
  const {number, last, count} = best;
  return `${number.label} ${last.text} → ${number.text}${number.unit ? ` ${number.unit}` : ''}, after ${count} runs at ${last.text}.`;
}

/**
 * The moments of one session. Each method returns a moment, or null when nothing changed: `sound` is 'green' when
 * something turned good (the editor glows) or 'red' when a test that passed before fails, and `text` is the one line
 * for a green that is worth words.
 */
export class Delight {
  constructor() {
    this.ran = false; // the tests on save ran in this session: the first run is the baseline
    this.red = null; // the tests on save while red: {since, failed: the names that failed meanwhile, regression}
    this.commands = new Map(); // a command line -> {redSince, runs: its numbers, oldest first}
  }

  /**
   * A finished run of the tests on save, `newly` the tests that fail now and passed in the run before. A green
   * after a red has words when the red lasted, or began with a regression; `lasted` says how long it was red.
   */
  testRun({red, failed = [], newly = []}, at) {
    const baseline = !this.ran;
    this.ran = true;
    if (red) {
      const regression = newly.length > 0 || (!this.red && !baseline);
      this.red ??= {since: at, failed: [], regression};
      this.red.failed = [...new Set([...this.red.failed, ...failed])];
      this.red.regression ||= regression;
      return regression ? {sound: 'red'} : null;
    }
    if (!this.red) return null;
    const {since, failed: names, regression} = this.red;
    this.red = null;
    const lasted = at - since;
    const what = names.length ? passing(names) : 'The tests pass';
    let text = null;
    if (lasted >= LONG_RED_MS) text = `${what} again, after ${minutes(lasted)} of red.`;
    else if (regression && names.length) text = `${what} again: the regression is fixed.`;
    return {sound: 'green', text, lasted};
  }

  /** Since when the tests on save are red, or null. */
  get redSince() {
    return this.red?.since ?? null;
  }

  /** A command the user ran, `failed` as fold.mjs judges it: green again after a long red, or a number that moved. */
  command({cmd, failed, output}, at) {
    const known = this.known(cmd);
    if (!known) return null;
    if (failed) {
      known.redSince ??= at;
      return null;
    }
    const lasted = known.redSince === null ? 0 : at - known.redSince;
    known.redSince = null;
    if (lasted >= LONG_RED_MS) return {sound: 'green', text: `${code(cmd.trim())} passes again, after ${minutes(lasted)} of red.`};
    return this.numbers(cmd, output);
  }

  /** A run of `cmd` that passed, `output` what it printed: a number in it that finally moved the right way. */
  numbers(cmd, output) {
    const known = this.known(cmd);
    if (!known) return null;
    const now = numbersOf(output);
    const text = moved(now, known.runs);
    known.runs = text ? [now] : [...known.runs.slice(1 - HISTORY), now]; // a number that moved holds from its new value
    return text ? {sound: 'green', text} : null;
  }

  known(cmd) {
    const key = cmd.trim();
    if (!key) return null;
    if (!this.commands.has(key)) this.commands.set(key, {redSince: null, runs: []});
    return this.commands.get(key);
  }
}
