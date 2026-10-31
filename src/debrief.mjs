// The day's end debrief, which the session note grew into: when a session ends, Pair says in a few lines what is now
// true, what is left, and the one step to start with next time, which it keeps as a place (file:line) for the
// morning pick-up (see pickup.mjs). The wins come from what happened, not from the model's memory: tests and commands
// that went green, numbers that moved, Pair's changes you kept, commits. The last line is a rule, not a model: what
// your verdicts on Pair's remarks say it should do differently.
import {isAbsolute, join, relative} from 'node:path';
import {projectFile} from './files.mjs';
import {gitFilesNamed} from './git.mjs';
import {outcome} from './tuning.mjs';

const NOTE_CHANGES = 20; // lines of git status the debrief request shows
const MOVED_KEPT = 3; // numbers that moved, the latest
const STEP_CHARS = 200;

/** What went right in one session, as it happens. */
export class Wins {
  constructor() {
    this.failed = new Set(); // every test that failed in a run during the session
    this.failing = new Set(); // those that failed in the last run
    this.commands = new Map(); // a command line -> 'red' while it fails, 'green' once it passes after that
    this.moved = []; // delight's lines about numbers that moved the right way
  }

  /** A run with test results: `failed` names the tests that failed in it. */
  tests(failed) {
    for (const name of failed) this.failed.add(name);
    this.failing = new Set(failed);
  }

  /** A command the user ran, and whether it failed. */
  command(cmd, failed) {
    const key = cmd.trim();
    if (!key) return;
    if (failed) this.commands.set(key, 'red');
    else if (this.commands.has(key)) this.commands.set(key, 'green');
  }

  moment(text) {
    this.moved = [...this.moved, text].slice(-MOVED_KEPT);
  }

  /** The tests that failed during the session and pass now, and the commands that pass again. */
  get green() {
    return {
      tests: [...this.failed].filter(name => !this.failing.has(name)),
      commands: [...this.commands].filter(([, state]) => state === 'green').map(([cmd]) => cmd),
    };
  }
}

/** Pair's changes the user kept, from the session's ledger entries: suggestions accepted, edits not undone. */
export function keptChanges(actions) {
  return actions
    .filter(action => (action.kind === 'suggested' && action.state === 'applied') || (action.kind === 'typed' && action.data.undo && action.state !== 'undone'))
    .map(action => action.text);
}

const list = items => items.map(item => `\n- ${item}`).join('');

/**
 * What the Partner is asked at the end. `stopped` is where the user was, {file, line, text}, or null; `failing`
 * the tests failing now; `changes` git status --short.
 */
export function debriefInput({goal, wins, kept = [], commits = [], changes = null, stopped = null, failing = []}) {
  const lines = changes ? changes.split('\n') : [];
  const shown = lines.length > NOTE_CHANGES ? [...lines.slice(0, NOTE_CHANGES), `(${lines.length - NOTE_CHANGES} more)`] : lines;
  const {tests, commands} = wins.green;
  const facts = [
    `Goal: ${goal ?? '(not set)'}`,
    tests.length && `Tests that failed during the session and pass now: ${tests.join(', ')}`,
    commands.length && `Commands that pass again after failing: ${commands.map(cmd => `\`${cmd}\``).join(', ')}`,
    wins.moved.length && `Numbers that moved the right way:${list(wins.moved)}`,
    kept.length && `Pair's changes the user kept:${list(kept)}`,
    commits.length && `Commits made in the session:${list(commits)}`,
    failing.length && `Still failing: ${failing.join(', ')}`,
    `Uncommitted changes (git status): ${shown.length ? `\n${shown.join('\n')}` : 'none'}`,
    stopped && `Where the user stopped: ${stopped.file}:${stopped.line}: ${stopped.text.trim()}`,
  ];
  return `[end] The session is over. Write its debrief for the next session in this project, in plain text, in exactly this form:
✓ <something that is now true> (one to three of these lines, from the facts below)
○ open: <something left open> (none to two of these lines)
Tomorrow, first: <the one concrete step to start with>, in <file>:<line>.
Say what the code does now, not how it was found. No heading, no other lines and no tool calls.

${facts.filter(Boolean).join('\n')}`;
}

const FIRST = /^\W*tomorrow,?\s*first\W*\s*(.+)$/i;
// A file:line: in backticks, as written (`src/ring buffer.c:9`); else a name with a letter in it, with or without an
// extension (worker.go:27, Makefile:14), and not a time of day (09:12).
const QUOTED = /`([^`]*[A-Za-z][^`]*):(\d+)`/g;
const PLACE = /([\w./-]*[A-Za-z][\w./-]*):(\d+)/g;
const WORDS_BEFORE = 3; // an unquoted name may be the end of a path with spaces: up to this many words before it

/**
 * The debrief's lines, and its first step: `{step, files, line}` with the file:line named last in it, or `{step}`
 * without one; null when there is no "Tomorrow, first" line. `files` are the names the file may have, longest first:
 * an unquoted `ring buffer.c:9` may be "ring buffer.c" or "buffer.c", and only the project can tell (see firstPlace).
 */
export function parseDebrief(text) {
  const lines = text.split('\n').map(line => line.trimEnd()).filter(line => line.trim());
  const found = lines.map(line => line.match(FIRST)).find(Boolean);
  if (!found) return {lines, first: null};
  const step = found[1].trim().slice(0, STEP_CHARS);
  const quoted = [...step.matchAll(QUOTED)].at(-1);
  if (quoted) return {lines, first: {step, files: [quoted[1]], line: Number(quoted[2])}};
  const place = [...step.matchAll(PLACE)].at(-1);
  if (!place) return {lines, first: {step}};
  const spaced = step[place.index - 1] === ' ';
  const before = spaced ? step.slice(0, place.index).split(' ').slice(-WORDS_BEFORE - 1, -1).filter(Boolean) : [];
  const files = before.map((_, i) => [...before.slice(i), place[1]].join(' ')).concat(place[1]);
  return {lines, first: {step, files, line: Number(place[2])}};
}

/**
 * The file the first step names, relative to `root`: as written, else the one file git tracks, or the user had
 * open (`known`, relative paths), whose path ends in it; null when none or several do.
 */
export async function resolveFile(root, name, known = []) {
  if (isAbsolute(name)) return (await projectFile(root, name)) ? relative(root, name) : null;
  if (await projectFile(root, name).catch(() => null)) return name;
  const ends = file => file === name || file.endsWith(`/${name}`);
  const open = [...new Set(known.filter(ends))];
  if (open.length === 1) return open[0];
  const tracked = await gitFilesNamed(root, name);
  return tracked.length === 1 ? tracked[0] : null;
}

/** The first of `names` that resolves to a file of the project (see resolveFile), or null. */
async function firstFile(root, names = [], known) {
  for (const name of names) {
    const file = await resolveFile(root, name, known);
    if (file) return file;
  }
  return null;
}

/**
 * Where the pick-up lands: the first step's place when it names a file in the project, else where the user stopped.
 * `{step, file, line, text}`, `text` the line's code as it was, so the pick-up can tell when it moved or changed.
 */
export async function firstPlace(root, first, stopped, known, readLines) {
  const file = await firstFile(root, first?.files, known);
  const lines = file ? await readLines(join(root, file)).catch(() => null) : null;
  if (lines) {
    const line = Math.min(Math.max(1, first.line), lines.length);
    return {step: first.step, file, line, text: lines[line - 1] ?? ''};
  }
  if (!stopped) return first?.step ? {step: first.step} : null;
  return {step: first?.step ?? null, ...stopped};
}

const ABOUT = {
  drift: 'drift', edit_while_red: 'edits while red', regression: 'regressions', repeated_error: 'repeated errors',
  failed_command: 'failed commands', stall: 'being stuck', new_code_diagnostic: 'diagnostics', search_trail: 'searches',
  crash: 'crashes', new_warning: 'warnings', overlap: 'overlaps with board tasks',
};

/**
 * What the user's verdicts on this session's remarks say Pair should do differently; null without noise. Noise is
 * what the user dismissed: a remark that got no answer (they may have read it in the chat, or acted on it elsewhere)
 * is only counted beside it. With `tuned` (autoTune) Pair says it acts on it.
 */
export function lessonLine(remarks, now, {tuned = false} = {}) {
  const noise = remarks.filter(remark => outcome(remark, now) === 'dismissed');
  if (!noise.length) return null;
  const unanswered = remarks.filter(remark => outcome(remark, now) === 'ignored').length;
  const counts = new Map();
  for (const remark of noise) counts.set(remark.trigger, (counts.get(remark.trigger) ?? 0) + 1);
  const [trigger, count] = [...counts].sort((a, b) => b[1] - a[1])[0];
  const about = ABOUT[trigger] ?? trigger.replaceAll('_', ' ');
  const share = `${noise.length} of my ${remarks.length} remark${remarks.length === 1 ? '' : 's'} ${noise.length === 1 ? 'was' : 'were'} noise`;
  const which = noise.length === 1 ? `about ${about}` : count === noise.length ? `${count === 2 ? 'both' : 'all'} about ${about}` : `${count} about ${about}`;
  const rest = unanswered ? `; ${unanswered} got no answer` : '';
  return `${share}, ${which}${tuned && count > 1 ? ': I\'ll keep quieter there' : ''}${rest}.`;
}

/** "3 h 05 min", "25 min", "under a minute". */
export function duration(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min` : `${minutes} min`;
}

const DAY_ENDS_AT = 15; // a session that ends after 15:00 ends the day

/** The debrief's first line: "Day's end: 3 h 05 min in hookd." */
export function heading(at, activeMs, project) {
  return `${new Date(at).getHours() >= DAY_ENDS_AT ? 'Day\'s end' : 'Session\'s end'}: ${duration(activeMs)} in ${project}.`;
}
