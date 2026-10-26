// What the pair knows besides what you do right now: the board task, git, the terminal and where you have been in
// the editor. Each source is a few labelled rows, from the session state. The same rows go to the Partner (as one
// line per source) and to the context card in Neovim, so the card shows exactly what is sent; a source the user
// hides goes nowhere. Each source keeps to a budget of rows, and the card says what was cut.
import {isAbsolute, relative} from 'node:path';
import {failed, failureLine} from './fold.mjs';

export const SOURCES = ['board', 'git', 'terminal', 'editor'];
export const RECENT_COMMANDS = 3;
const BUDGET = {buffers: 6, jumps: 4, searches: 3};

export const ago = (now, at) => `${Math.max(0, Math.round((now - at) / 1000))} s ago`;

/** One finished command as the Partner reads it: `npm test` failed (exit 1): FAIL x, 12 s ago. */
export function commandLine(command, now) {
  const result = failed(command) ? `failed${command.exit ? ` (exit ${command.exit})` : ''}: ${failureLine(command)}` : 'ok';
  return `\`${command.cmd}\` ${result}, ${ago(now, command.endedAt)}`;
}

const plural = (n, noun, nouns = `${noun}s`) => `${n} ${n === 1 ? noun : nouns}`;

function boardRows({board}) {
  if (!board) return [];
  if (!board.task) return [{label: 'task', text: 'none for this branch'}];
  const {task, working, waiting} = board;
  const others = `${plural(working, 'other task')} working; ${waiting.length ? `${waiting.length} need${waiting.length === 1 ? 's' : ''} you: ${waiting.map(each => each.id).join(', ')}` : 'none needs you'}`;
  return [
    {label: 'task', text: `${task.id} · ${task.title}`},
    {label: 'state', text: task.msg ? `${task.state} · ${task.msg}` : task.state},
    {label: 'others', text: others},
  ];
}

function gitRows(state) {
  const git = state.git ?? {};
  const rows = [];
  if (state.branch) rows.push({label: 'branch', text: state.branch});
  if (git.last) rows.push({label: 'last', text: git.last});
  if (git.changed !== undefined && git.changed !== null) rows.push({label: 'tree', text: git.changed ? `${git.changed} changed` : 'clean'});
  if (git.pr !== undefined && git.pr !== null) rows.push({label: 'PR', text: git.pr || 'none yet'});
  return rows;
}

function terminalRows(state, now) {
  // describeState sends these as its "Recent commands", oldest first
  return state.commands.slice(-RECENT_COMMANDS).reverse().map(command => ({label: 'ran', text: commandLine(command, now)}));
}

/** `items` as one row, as many as the budget allows, with the number cut. */
function listRow(label, items, budget, separator) {
  if (!items.length) return [];
  return [{label, text: items.slice(0, budget).join(separator), cut: Math.max(0, items.length - budget)}];
}

function editorRows(state) {
  const name = file => (isAbsolute(file) && state.root ? relative(state.root, file) : file);
  const inProject = file => !name(file).startsWith('..');
  const buffers = state.buffers.filter(inProject).map(name);
  const jumps = state.jumps.filter(jump => inProject(jump.file)).map(jump => `${name(jump.file)}:${jump.line}`);
  const searches = state.searches.slice().reverse().map(search => {
    const results = search.results === null || search.results === undefined ? '' : ` · ${plural(search.results, 'result')}`;
    const opened = search.file ? ` · opened ${name(search.file)}${search.line ? `:${search.line}` : ''}` : '';
    return `${search.tool} "${search.query}"${results}${opened}`;
  });
  return [
    ...listRow('buffers', buffers, BUDGET.buffers, '  '),
    ...listRow('jumps', jumps, BUDGET.jumps, '  ←  '),
    ...searches.slice(0, BUDGET.searches).map(text => ({label: 'searched', text})),
    ...(searches.length > BUDGET.searches ? [{label: 'searched', text: '', cut: searches.length - BUDGET.searches}] : []),
  ];
}

/** Rows that are about the source but never sent: they say what was left out. */
function notSent(source, state) {
  if (source === 'terminal' && state.launches) return [{label: 'not sent', text: `${plural(state.launches, 'agent launch', 'agent launches')} from the board, not yours`}];
  return [];
}

const ROWS = {board: boardRows, git: gitRows, terminal: terminalRows, editor: editorRows};

/** The card: every source with its rows, whether the user hid it, and the rows that say what is not sent. */
export function contextCard(state, now) {
  return SOURCES
    .filter(source => source !== 'board' || state.board) // without a board, there is no such source
    .map(source => ({source, hidden: state.hidden.includes(source), rows: ROWS[source](state, now), notSent: notSent(source, state)}));
}

const LINES = {board: 'Board', git: 'Git', editor: 'Editor'};

/** What the Partner gets of the board, git and the editor: one line per source the user did not hide. */
export function contextLines(state) {
  return Object.entries(LINES)
    .filter(([source]) => !state.hidden.includes(source))
    .map(([source, title]) => [title, ROWS[source](state).filter(row => row.text)])
    .filter(([, rows]) => rows.length)
    .map(([title, rows]) => `${title}: ${rows.map(row => `${row.label} ${row.text}`).join('; ')}`);
}

export const DEFAULT_BRANCHES = new Set(['main', 'master', 'trunk', 'HEAD']);

/**
 * The goal a session can start with instead of asking: the title of its board task, else the words of its branch
 * name (`work/25-context-card` is "context card"). Null on a default branch without a board task.
 */
export function goalFromContext(state) {
  const task = state.board?.task;
  if (task) return {text: task.title, from: `the board task ${task.id}`};
  if (!state.branch || DEFAULT_BRANCHES.has(state.branch)) return null;
  const words = state.branch.split('/').pop().replace(/^\d+[-_.]*/, '').replace(/[-_.]+/g, ' ').trim();
  return words ? {text: words, from: `the branch ${state.branch}`} : null;
}
