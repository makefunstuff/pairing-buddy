// Folds raw editor, terminal and chat events into one small session state.
// Pure: `fold(state, event)` returns a new state and never looks at the clock.

const KEEP = {edits: 20, commands: 10, chat: 10, outputChars: 2000, diagnostics: 30};

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
    chat: [],
  };
}

const keepLast = (list, item, max) => [...list, item].slice(-max);

/** Whether a finished command failed. Without an exit code (herdr alone gives none), its output decides. */
export function failed(command) {
  if (command.exit !== null && command.exit !== undefined) return command.exit !== 0;
  return /\b(error|failed|failure|panic|traceback|exception)\b/i.test(command.output ?? '');
}

/** The line that best names a failure: the first one that says error or fail, else the last one. */
export function errorLine(output = '') {
  const lines = output.split('\n').map(line => line.trim()).filter(Boolean);
  return lines.find(line => /error|fail|exception|panic|traceback|assert/i.test(line)) ?? lines.at(-1) ?? '';
}

/** Two failures with the same error line share a signature, whatever numbers, times or ids they print. */
export function errorSignature(output) {
  return errorLine(output).toLowerCase().replace(/0x[0-9a-f]+|\d+/g, '#').replace(/\s+/g, ' ').slice(0, 120);
}

function foldCommandEnd(state, event) {
  const command = {
    pane: event.pane ?? null,
    cmd: event.cmd ?? '',
    exit: event.exit ?? null,
    output: (event.output ?? '').slice(-KEEP.outputChars),
    endedAt: event.at,
  };
  const next = {...state, commands: keepLast(state.commands, command, KEEP.commands)};
  if (!failed(command)) return next;
  const signature = errorSignature(command.output) || `exit ${command.exit} ${command.cmd}`;
  const seen = state.errors[signature];
  return {...next, errors: {...state.errors, [signature]: {count: (seen?.count ?? 0) + 1, text: errorLine(command.output), lastAt: event.at}}};
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

  focus: (state, event) => ({...state, focus: {target: event.target, pane: event.pane ?? null, scrolled: !!event.scrolled, at: event.at}}),

  chat: (state, event) => ({...state, chat: keepLast(state.chat, {from: event.from, text: event.text, at: event.at}, KEEP.chat)}),

  goal: (state, event) => ({...state, goal: event.text}),

  branch: (state, event) => ({...state, branch: event.name}),
};

export function fold(state, event) {
  const handler = handlers[event.kind];
  return handler ? handler(state, event) : state;
}
