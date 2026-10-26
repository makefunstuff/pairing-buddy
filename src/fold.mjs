// Folds raw editor, terminal and chat events into one small session state.
// Pure: `fold(state, event)` returns a new state and never looks at the clock.
import {namedFiles, parseTestOutput, testSummary} from './test-output.mjs';

const KEEP = {edits: 20, commands: 10, outputChars: 2000, diagnostics: 30};

export function initialState({root = null, goal = null} = {}) {
  return {
    root,
    goal,
    branch: null,
    file: null,
    cursor: null,
    selection: null,
    lastKeyAt: 0,
    lastEditAt: 0,
    edits: [],
    diagnostics: {},
    commands: [],
    errors: {},
    focus: {target: 'unknown', pane: null, scrolled: false, at: 0},
    terminalPane: null, // the user's terminal pane they used last: where the Driver's type goes
    tests: null, // the last test run, the user's or Pair's: parsed by test-output.mjs, plus cmd, by, at and the files it names
    savedRunFailed: null, // the tests that failed in the last run on save; null before the session's first
  };
}

const keepLast = (list, item, max) => [...list, item].slice(-max);

/**
 * Whether a finished command failed. Without an exit code (herdr alone gives none), its parsed test results
 * decide, else its output.
 */
export function failed(command) {
  if (command.exit !== null && command.exit !== undefined) return command.exit !== 0;
  if (command.tests) return command.tests.failedCount > 0;
  return /(error|exception)\b|\bfail(ed|ure)?\b|\bpanic|\btraceback/i.test(command.output ?? '');
}

/** The line that best names a failure: the first one that says error or fail, else the last one. */
export function errorLine(output = '') {
  const lines = output.split('\n').map(line => line.trim()).filter(Boolean);
  return lines.find(line => /error|fail|exception|panic|traceback|assert/i.test(line)) ?? lines.at(-1) ?? '';
}

/** What a failed command says went wrong: its failed tests and first error when it ran tests, else its error line. */
export function failureLine(command) {
  return command.tests?.failedCount ? testSummary(command.tests) : errorLine(command.output);
}

/** Two failures with the same failure line share a signature, whatever numbers, times or ids they print. */
export function errorSignature(command) {
  const line = failureLine(command).toLowerCase().replace(/0x[0-9a-f]+|\d+/g, '#').replace(/\s+/g, ' ').slice(0, 120);
  return line || `exit ${command.exit} ${command.cmd}`;
}

/** Whether the user's eyes are on the pane of `command`, at its bottom. */
export function lookingAt(focus, command) {
  return focus.target === 'terminal' && focus.pane === command.pane && !focus.scrolled;
}

/** The state's `tests` after a run of `cmd` by `by` ("you" or "pair"), if its output was a test run. */
function testsAfter(state, tests, event, by) {
  return tests ? {...tests, cmd: event.cmd ?? '', by, at: event.at, files: namedFiles(event.output)} : state.tests;
}

function foldCommandEnd(state, event) {
  // Parsed from the whole output: the failed tests' names are often far above the kept tail.
  const tests = parseTestOutput(event.output);
  const command = {
    pane: event.pane ?? null,
    cmd: event.cmd ?? '',
    exit: event.exit ?? null,
    output: (event.output ?? '').slice(-KEEP.outputChars),
    tests,
    endedAt: event.at,
  };
  command.seen = lookingAt(state.focus, command);
  const next = {
    ...state,
    commands: keepLast(state.commands, command, KEEP.commands),
    tests: testsAfter(state, tests, event, 'you'),
    terminalPane: command.pane ?? state.terminalPane,
  };
  if (!failed(command)) return next;
  const signature = errorSignature(command);
  const known = state.errors[signature];
  return {...next, errors: {...state.errors, [signature]: {count: (known?.count ?? 0) + 1, text: failureLine(command), lastAt: event.at}}};
}

const handlers = {
  typing: (state, event) => ({...state, lastKeyAt: event.at}),

  edit: (state, event) => ({
    ...state,
    file: event.file,
    lastKeyAt: Math.max(state.lastKeyAt, event.at),
    lastEditAt: event.at,
    edits: keepLast(state.edits, {file: event.file, from: event.from, to: event.to, text: event.text ?? '', at: event.at}, KEEP.edits),
  }),

  enter: (state, event) => ({...state, file: event.file}),

  cursor: (state, event) => ({
    ...state,
    file: event.file,
    cursor: {line: event.line, col: event.col ?? 0},
    selection: event.selection ?? null,
  }),

  diagnostics: (state, event) => {
    // A diagnostic keeps the time it first appeared, so "just appeared in new code" survives later refreshes.
    const before = state.diagnostics[event.file] ?? [];
    const firstSeen = item => before.find(old => old.line === item.line && old.message === item.message)?.at ?? event.at;
    const items = (event.items ?? []).slice(0, KEEP.diagnostics).map(item => ({...item, at: firstSeen(item)}));
    return {...state, diagnostics: {...state.diagnostics, [event.file]: items}};
  },

  command_end: foldCommandEnd,

  // A command Scout ran in its own pane: Pair already has its result, so only its test results count.
  scout_run: (state, event) => ({...state, tests: testsAfter(state, parseTestOutput(event.output), event, 'pair')}),

  // The tests Pair ran when the user saved `saved` (see test-runs.mjs), already parsed, with the files of the
  // failed tests. `newly` names the tests that fail now and did not in the last run on save. Only that run, of the
  // same command, says what passed before: the session's first run (also after a daemon restart) is the baseline,
  // and nothing in it is new.
  test_run: (state, event) => {
    if (!event.tests) return state;
    const {tests: _list, ...tests} = event.tests;
    const before = state.savedRunFailed && new Set(state.savedRunFailed);
    const newly = before ? tests.failed.filter(name => !before.has(name)) : [];
    return {
      ...state,
      tests: {...tests, cmd: event.cmd, by: 'pair', at: event.at, files: event.files ?? [], saved: event.saved, newly},
      savedRunFailed: tests.failed,
    };
  },

  focus: (state, event) => {
    const focus = {target: event.target, pane: event.pane ?? null, scrolled: !!event.scrolled, at: event.at};
    // A failure the user looked at once stays seen when they look away again.
    const last = state.commands.at(-1);
    const commands = last && !last.seen && lookingAt(focus, last) ? [...state.commands.slice(0, -1), {...last, seen: true}] : state.commands;
    return {...state, focus, commands, terminalPane: focus.target === 'terminal' ? focus.pane : state.terminalPane};
  },

  goal: (state, event) => ({...state, goal: event.text}),

  branch: (state, event) => ({...state, branch: event.name}),
};

export function fold(state, event) {
  const handler = handlers[event.kind];
  return handler ? handler(state, event) : state;
}
