// Folds raw editor, terminal and chat events into one small session state.
// Pure: `fold(state, event)` returns a new state and never looks at the clock.
import {boardLaunch} from './board.mjs';
import {isRun, logRun} from './run-log.mjs';
import {hasNews, readingSummary, readRun, warningKey} from './run-output.mjs';
import {namedFiles, parseTestOutput, testSummary} from './test-output.mjs';

const KEEP = {typed: 120, edits: 20, commands: 10, outputChars: 2000, diagnostics: 30, searches: 12, places: 20, buildCommands: 20, warnings: 200, edited: 200};

export function initialState({root = null, goal = null} = {}) {
  return {
    root,
    goal,
    branch: null,
    file: null,
    cursor: null,
    selection: null,
    lastKeyAt: 0,
    typed: [], // when the user typed lately (Neovim says so at most every half second): how fast they type
    lastEditAt: 0,
    lastLookAt: 0, // when the user last moved the cursor or scrolled: reading counts as active time too
    edits: [],
    diagnostics: {},
    commands: [],
    errors: {},
    focus: {target: 'unknown', pane: null, scrolled: false, at: 0},
    terminalPane: null, // the user's terminal pane they used last: where the Driver's type goes
    tests: null, // the last test run, the user's or Pair's: parsed by test-output.mjs, plus cmd, by, at and the files it names
    savedRunFailed: null, // the tests that failed in the last run on save; null before the session's first
    searches: [], // what the user searched for in Neovim's pickers: picker, query, results, the file they opened (see trail.mjs)
    run: null, // the last build or run that crashed or printed compiler errors or warnings, or ran clean after one: see afterRun
    runs: [], // every build and run of the session that is no test run, numbered, with the change before it and its numbers (see run-log.mjs)
    builds: {cmds: [], warnings: []}, // the commands run so far, and the warnings their output printed (warningKey)
    edited: [], // the files the user edited in this session
    // The context card's sources (see context-card.mjs): git and the board as last read, where the user has been in the
    // editor (with the searches above), the sources they hid, and how many of the board's agent launches were left out of the commands.
    git: null,
    board: null,
    buffers: [],
    jumps: [],
    hidden: [],
    launches: 0,
    notes: {}, // the Markdown notes Pair has read, by file: {title}
  };
}

const keepLast = (list, item, max) => [...list, item].slice(-max);

/**
 * Whether a finished command failed. Without an exit code (herdr alone gives none), its parsed test results
 * decide, else a crash or a compiler error in its output, else the words in it.
 */
export function failed(command) {
  if (command.exit !== null && command.exit !== undefined) return command.exit !== 0;
  if (command.tests) return command.tests.failedCount > 0;
  if (command.reading?.crash || command.reading?.errors.length) return true;
  return /(error|exception)\b|\bfail(ed|ure)?\b|\bpanic|\btraceback/i.test(command.output ?? '');
}

/** The line that best names a failure: the first one that says error or fail, else the last one. */
export function errorLine(output = '') {
  const lines = output.split('\n').map(line => line.trim()).filter(Boolean);
  return lines.find(line => /error|fail|exception|panic|traceback|assert/i.test(line)) ?? lines.at(-1) ?? '';
}

/**
 * What a failed command says went wrong: its failed tests and first error when it ran tests, its crash or
 * compiler errors when it had any, else its error line.
 */
export function failureLine(command) {
  if (command.tests?.failedCount) return testSummary(command.tests);
  if (command.reading?.crash || command.reading?.errors.length) return readingSummary(command.reading);
  return errorLine(command.output);
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

/**
 * The state after a build or run of `cmd` that run-output.mjs read. It becomes the state's `run` when it found
 * something, or when it is the command of the last such run, which now ran clean. Its `newWarnings` are the
 * warnings in files the user edited in this session that no output since the session began printed. The first
 * run of each command is its baseline, so warnings already there when the session starts are never new; nor is
 * a warning in a file the user did not touch, which an incremental build prints only when it compiles that file
 * again (after a header changed, say).
 */
function afterRun(state, {cmd, by, at, reading}) {
  const {builds, edited} = state;
  const known = builds.cmds.includes(cmd);
  const fresh = warning => edited.includes(warning.file) && !builds.warnings.includes(warningKey(warning));
  const newWarnings = known ? reading.warnings.filter(fresh) : [];
  const next = {
    ...state,
    builds: {
      cmds: known ? builds.cmds : keepLast(builds.cmds, cmd, KEEP.buildCommands),
      warnings: [...new Set([...builds.warnings, ...reading.warnings.map(warningKey)])].slice(-KEEP.warnings),
    },
  };
  return hasNews(reading) || state.run?.cmd === cmd ? {...next, run: {cmd, by, at, ...reading, newWarnings}} : next;
}

/** The state after a build or run, `run` as afterRun takes it plus its `exit` and `output`: also in the run log. */
function afterLoggedRun(state, run) {
  const next = afterRun(state, run);
  const newWarnings = next.run !== state.run ? next.run.newWarnings : [];
  return {...next, runs: logRun(state.runs, {...run, newWarnings, edits: state.edits})};
}

function foldCommandEnd(state, event) {
  if (boardLaunch(event.cmd ?? '')) return {...state, launches: state.launches + 1};
  // Parsed from the whole output: the failed tests' names are often far above the kept tail.
  const tests = parseTestOutput(event.output);
  const command = {
    pane: event.pane ?? null,
    cmd: event.cmd ?? '',
    exit: event.exit ?? null,
    output: (event.output ?? '').slice(-KEEP.outputChars),
    tests,
    // The shell hook says where the command ran: compilers name files relative to that.
    reading: readRun(event.output, {exit: event.exit ?? null, root: state.root, cwd: event.cwd ?? state.root}),
    endedAt: event.at,
  };
  command.seen = lookingAt(state.focus, command);
  const ran = {cmd: command.cmd, by: 'you', at: event.at, reading: command.reading, exit: command.exit, output: event.output ?? '', cwd: event.cwd ?? null};
  const next = {
    ...(isRun(command.cmd) && !tests ? afterLoggedRun(state, ran) : afterRun(state, ran)),
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
  typing: (state, event) => ({...state, lastKeyAt: event.at, typed: keepLast(state.typed, event.at, KEEP.typed)}),

  edit: (state, event) => ({
    ...state,
    file: event.file,
    lastKeyAt: Math.max(state.lastKeyAt, event.at),
    lastEditAt: event.at,
    edits: keepLast(state.edits, {file: event.file, from: event.from, to: event.to, text: event.text ?? '', at: event.at}, KEEP.edits),
    edited: state.edited.includes(event.file) ? state.edited : keepLast(state.edited, event.file, KEEP.edited),
  }),

  enter: (state, event) => ({...state, file: event.file}),

  // A cursor that stays where it was (Neovim reports it again after any pause) is no sign of reading.
  cursor: (state, event) => ({
    ...state,
    file: event.file,
    cursor: {line: event.line, col: event.col ?? 0},
    selection: event.selection ?? null,
    lastLookAt: event.file !== state.file || event.line !== state.cursor?.line ? event.at : state.lastLookAt,
  }),

  scroll: (state, event) => ({...state, lastLookAt: event.at}),

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
  // and nothing in it is new. Its `reading` (run-output.mjs) is the crash or compiler output of a build on save;
  // with its `output`, a run that is no test run goes into the run log too.
  test_run: (previous, event) => {
    const ran = {cmd: event.cmd, by: 'pair', at: event.at, reading: event.reading, exit: event.exit ?? null, output: event.output};
    const logged = event.output !== undefined && !event.tests;
    const state = !event.reading ? previous : logged ? afterLoggedRun(previous, ran) : afterRun(previous, ran);
    if (!event.tests) return state;
    const {tests: list, ...tests} = event.tests;
    const before = state.savedRunFailed && new Set(state.savedRunFailed);
    const newly = before ? tests.failed.filter(name => !before.has(name)) : [];
    // A `narrowed` run ran only the tests a save affects: the others that failed before, and did not run now, still fail.
    // A Go subtest ran with its test.
    const listed = (list ?? []).map(test => test.name);
    const didRun = name => listed.some(test => name === test || name.startsWith(`${test}/`));
    const still = event.narrowed && before ? [...before].filter(name => !didRun(name) && !tests.failed.includes(name)) : [];
    return {
      ...state,
      tests: {...tests, cmd: event.cmd, by: 'pair', at: event.at, files: event.files ?? [], saved: event.saved, newly},
      savedRunFailed: [...tests.failed, ...still],
    };
  },

  focus: (state, event) => {
    const focus = {target: event.target, pane: event.pane ?? null, scrolled: !!event.scrolled, at: event.at};
    // A failure the user looked at once stays seen when they look away again.
    const last = state.commands.at(-1);
    const commands = last && !last.seen && lookingAt(focus, last) ? [...state.commands.slice(0, -1), {...last, seen: true}] : state.commands;
    return {...state, focus, commands, terminalPane: focus.target === 'terminal' ? focus.pane : state.terminalPane};
  },

  // The user went to one of their :terminal buffers in Neovim (without herdr's focus to say so): where type goes.
  terminal: (state, event) => ({...state, terminalPane: event.pane ?? state.terminalPane}),

  goal: (state, event) => ({...state, goal: event.text}),

  // A search in one of Neovim's pickers, as it closed: `file` is what the user opened from it, if anything.
  search: (state, event) => ({
    ...state,
    searches: keepLast(state.searches, {
      picker: event.picker ?? 'search', query: event.query ?? '', results: event.results ?? null, file: event.file ?? null, line: event.line ?? null, at: event.at,
    }, KEEP.searches),
  }),

  forget_searches: state => ({...state, searches: []}),

  branch: (state, event) => ({...state, branch: event.name}),

  context: (state, event) => ({...state, branch: event.branch ?? state.branch, git: event.git, board: event.board}),

  // The editor's listed buffers, most recent first, and its jumplist, newest first: absolute paths.
  places: (state, event) => ({...state, buffers: (event.buffers ?? []).slice(0, KEEP.places), jumps: (event.jumps ?? []).slice(0, KEEP.places)}),

  hide: (state, event) => ({...state, hidden: event.hidden ? [...new Set([...state.hidden, event.source])] : state.hidden.filter(source => source !== event.source)}),

  // A note Pair read for its margin (see margin.mjs).
  note: (state, event) => ({...state, notes: {...state.notes, [event.file]: {title: event.title}}}),
};

export function fold(state, event) {
  const handler = handlers[event.kind];
  return handler ? handler(state, event) : state;
}
