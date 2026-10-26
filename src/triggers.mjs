// Finds the moments where a remark might help. Pure: the caller passes the clock and the keys already fired.
import {errorSignature, failed, failureLine} from './fold.mjs';
import {readingSummary} from './run-output.mjs';
import {isSourceFile, testSummary} from './test-output.mjs';
import {currentTrail, lost, TRAIL, trailLines} from './trail.mjs';

export const TRIGGER_KINDS = ['failed_command', 'repeated_error', 'new_code_diagnostic', 'stall', 'drift', 'edit_while_red', 'regression', 'search_trail', 'crash', 'new_warning'];

export const TIMING = {
  lookGraceMs: 4_000, // a failure gets this long to be noticed before Pair counts it as missed
  recentMs: 120_000, // older failures are history, not news
  stallMs: 90_000,
  newCodeMs: 60_000, // an edit this close before a diagnostic counts as the code that caused it
  driftWindowMs: 10 * 60_000, // drift is looked at only while the last edit is this recent
  redMs: 10 * 60_000, // a failed test run counts as still red for this long, unless a newer run passed
};

/** Not looked at: never seen at the bottom of its pane, or the user scrolled away from it since (scrolled past). */
function missed(state, command) {
  return !command.seen || (state.focus.pane === command.pane && state.focus.scrolled);
}

function lastFailure(state, now) {
  const command = state.commands.at(-1);
  if (!command || !failed(command) || now - command.endedAt > TIMING.recentMs) return null;
  return command;
}

function commandTriggers(state, now) {
  const command = lastFailure(state, now);
  if (!command) return [];
  const signature = errorSignature(command);
  const error = failureLine(command);
  const count = state.errors[signature]?.count ?? 1;
  const found = [];
  if (count >= 2) {
    found.push({kind: 'repeated_error', key: `repeat:${signature}:${count}`, command, detail: `\`${command.cmd}\` failed again (${count} times) with: ${error}`});
  } else if (!command.reading?.crash && now - command.endedAt >= TIMING.lookGraceMs && missed(state, command)) {
    // A crash has a trigger of its own, looked at or not: the terminal says that it crashed, not where or why.
    found.push({kind: 'failed_command', key: `failed:${command.endedAt}`, command, detail: `\`${command.cmd}\` failed${command.exit ? ` (exit ${command.exit})` : ''} and you are not looking at it: ${error}`});
  }
  const quietSince = Math.max(state.lastKeyAt, state.lastEditAt, command.endedAt);
  if (quietSince === command.endedAt && now - command.endedAt >= TIMING.stallMs) {
    found.push({kind: 'stall', key: `stall:${command.endedAt}`, command, detail: `No edits or commands for ${Math.round((now - command.endedAt) / 1000)} s since \`${command.cmd}\` failed with: ${error}`});
  }
  return found;
}

function causedByEdit(state, file, diagnostic) {
  return state.edits.some(edit => edit.file === file
    && diagnostic.line >= edit.from - 1 && diagnostic.line <= edit.to + 1
    && diagnostic.at >= edit.at && diagnostic.at - edit.at <= TIMING.newCodeMs);
}

function movedOn(state, file, diagnostic) {
  return state.file !== file || !state.cursor || Math.abs(state.cursor.line - diagnostic.line) > 2;
}

function diagnosticTriggers(state) {
  const found = [];
  for (const [file, items] of Object.entries(state.diagnostics)) {
    for (const diagnostic of items) {
      if (diagnostic.severity !== 'error' || !causedByEdit(state, file, diagnostic) || !movedOn(state, file, diagnostic)) continue;
      found.push({
        kind: 'new_code_diagnostic',
        key: `diag:${file}:${diagnostic.line}:${diagnostic.message}`,
        detail: `${file}:${diagnostic.line}: ${diagnostic.message} (in code you just wrote; you moved on)`,
        file,
        line: diagnostic.line,
        message: diagnostic.message,
      });
    }
  }
  return found;
}

function driftTriggers(state, now) {
  const latest = state.edits.at(-1);
  if (!state.goal || !latest || now - latest.at > TIMING.driftWindowMs) return [];
  const recent = state.edits.filter(edit => now - edit.at <= TIMING.driftWindowMs);
  const others = [...new Set(recent.map(edit => edit.file))].filter(file => file !== latest.file);
  const detail = `Possible drift from the goal "${state.goal}": the user now edits ${latest.file}`
    + `${others.length ? ` (recently also ${others.join(', ')})` : ''}${state.branch ? ` on branch ${state.branch}` : ''}.`;
  // Judged once per goal, branch and file: moving into a file is when work drifts, and staying in it is no news;
  // a new goal judges every file again. It lasts while the user stays in that file, so a budget that holds it
  // back does not lose it.
  return [{kind: 'drift', key: `drift:${state.goal}:${state.branch}:${latest.file}`, detail, file: latest.file, lasting: true}];
}

/** A file's name without its directory, extension and test marker: worker_test.go, worker.go and test_worker.py are all "worker". */
export function fileStem(file) {
  const name = file.split('/').at(-1).replace(/\.[^.]+$/, '');
  return (name.replace(/^test_|(_test|\.test|\.spec|_spec|Tests?)$/, '') || name).toLowerCase();
}

/**
 * The wrong turn: the user edits while a test run is red, in a file the failure does not name. Raised once per
 * run and file, after the first edit there; a failure that names no file says nothing about where the cause is.
 */
function redTriggers(state, now) {
  const {tests} = state;
  const edit = state.edits.at(-1);
  if (!tests?.failedCount || !tests.files?.length || !edit || edit.at <= tests.at || now - tests.at > TIMING.redMs) return [];
  const named = new Set(tests.files.map(fileStem));
  if (!isSourceFile(edit.file) || named.has(fileStem(edit.file))) return []; // notes and docs are no attempt at a fix
  return [{
    kind: 'edit_while_red',
    key: `red:${tests.at}:${edit.file}`,
    detail: `The user edits ${edit.file}:${edit.from}-${edit.to} while \`${tests.cmd}\` is red: ${testSummary(tests)}. `
      + `The failure names ${tests.files.slice(0, 4).join(', ')}, not ${edit.file}.`,
    file: edit.file,
    named: tests.files,
    line: edit.to,
  }];
}

/**
 * A regression: the tests Pair ran when the user saved fail where its run before did not. Raised once per run;
 * a run that is still red with the same failures is no news (the statusline says it), and the session's first run
 * has nothing to compare with.
 */
function regressionTriggers(state, now) {
  const {tests} = state;
  if (!tests?.saved || !tests.newly?.length || now - tests.at > TIMING.recentMs) return [];
  const newly = tests.newly.slice(0, 4).join(', ');
  return [{
    kind: 'regression',
    key: `regression:${tests.at}`,
    detail: `Pair ran \`${tests.cmd}\` when the user saved ${tests.saved}. Now failing, and not in Pair's run before: ${newly}. ${testSummary(tests)}`
      + `${tests.files.length ? ` The failure names ${tests.files.slice(0, 4).join(', ')}.` : ''}`,
    file: tests.saved,
    newly: tests.newly,
  }];
}

const runBy = run => (run.by === 'pair' ? 'Pair ran it when the user saved' : 'the user ran it');
const place = item => `${item.file}:${item.line}${item.function ? ` (${item.function})` : ''}`;

/**
 * A crash: the last build or run (the user's, or Pair's on save) died of a signal or reported a fault: a
 * sanitizer, a failed assert, a panic. Raised once per crash and place: the same crash again is a repeated error.
 */
function crashTriggers(state, now) {
  const {run} = state;
  if (!run?.crash || now - run.at > TIMING.recentMs) return [];
  const {crash} = run;
  const stack = crash.frames.slice(0, 6).map(place).join(', ');
  return [{
    kind: 'crash',
    key: `crash:${run.cmd}:${crash.text}:${crash.at ? place(crash.at) : ''}`,
    detail: `\`${run.cmd}\` crashed (${runBy(run)}): ${readingSummary(run)}. `
      + (stack ? `Its stack, innermost first: ${stack}.` : 'It printed no stack, so where it crashed is not known.'),
    file: crash.at?.file ?? null,
    line: crash.at?.line ?? null,
  }];
}

/** A build printed a warning that no build before it in this session printed. Raised once per build. */
function warningTriggers(state, now) {
  const {run} = state;
  if (!run?.newWarnings?.length || now - run.at > TIMING.recentMs) return [];
  const shown = run.newWarnings.slice(0, 3).map(warning => `${warning.file}:${warning.line}: ${warning.message}`).join('; ');
  return [{
    kind: 'new_warning',
    key: `warning:${run.at}`,
    detail: `\`${run.cmd}\` (${runBy(run)}) printed ${run.newWarnings.length === 1 ? 'a new warning' : `${run.newWarnings.length} new warnings`}, not in the builds before: ${shown}`,
    file: run.newWarnings[0].file,
    line: run.newWarnings[0].line,
    warnings: run.newWarnings,
  }];
}

/** What fails now, in one line: a red test run, else a failed command, both while recent; null when nothing does. */
export function failingNow(state, now) {
  const {tests} = state;
  if (tests?.failedCount && now - tests.at <= TIMING.redMs) return `\`${tests.cmd}\`: ${testSummary(tests)}`;
  const command = state.commands.at(-1);
  if (command && failed(command) && now - command.endedAt <= TIMING.redMs) return `\`${command.cmd}\` failed: ${failureLine(command)}`;
  return null;
}

/**
 * The search trail: three or more searches since the last edit, one of them closed with nothing opened or the same
 * words again landing elsewhere (see trail.mjs). Looked at once the user pauses after the last one; each new search is a new look.
 * What fails now goes with it: without it, a cue from the trail alone guesses what the user is after.
 */
function trailTriggers(state, now) {
  const trail = currentTrail(state, now);
  const last = trail.at(-1);
  if (!last || now - last.at < TRAIL.settleMs || !lost(trail)) return [];
  const seconds = Math.round((last.at - trail[0].at) / 1000);
  const failing = failingNow(state, now);
  return [{
    kind: 'search_trail',
    key: `trail:${trail[0].at}:${trail.length}`,
    detail: `The user searched ${trail.length} times in ${seconds} s for what looks like one thing, and has not edited since:\n`
      + `${trailLines(trail)}\n${failing ? `Failing now: ${failing}` : 'Nothing is failing now.'}`,
    searches: trail,
    failing,
    file: last.file ?? state.file,
  }];
}

/** The candidate remarks for this moment whose keys have not fired yet. */
export function detectTriggers(state, now, fired = new Set()) {
  return [...crashTriggers(state, now), ...commandTriggers(state, now), ...diagnosticTriggers(state), ...regressionTriggers(state, now), ...redTriggers(state, now), ...warningTriggers(state, now), ...driftTriggers(state, now), ...trailTriggers(state, now)]
    .filter(trigger => !fired.has(trigger.key));
}
