// The session state as a few short lines of text: what both models see instead of raw events.
import {failed, failureLine} from './fold.mjs';
import {testSummary} from './test-output.mjs';

const ago = (now, at) => `${Math.max(0, Math.round((now - at) / 1000))} s ago`;

function commandLine(command, now) {
  const result = failed(command) ? `failed${command.exit ? ` (exit ${command.exit})` : ''}: ${failureLine(command)}` : 'ok';
  return `\`${command.cmd}\` ${result}, ${ago(now, command.endedAt)}`;
}

function currentFile(state) {
  const selection = state.selection ? `, selected lines ${state.selection.from}-${state.selection.to}` : '';
  return `Current file: ${state.file}${state.cursor ? `, cursor at line ${state.cursor.line}` : ''}${selection}`;
}

const testsLine = (tests, now) => `Last test run: \`${tests.cmd}\` by ${tests.by === 'pair' ? 'Pair' : 'the user'}, ${ago(now, tests.at)}: ${testSummary(tests)}`;

const looking = state => `The user is looking at: ${state.focus.target}${state.focus.scrolled ? ' (scrolled up)' : ''}`;
const lastKey = (state, now) => `Last keystroke: ${state.lastKeyAt ? ago(now, state.lastKeyAt) : 'none yet'}`;

/** What the Partner sees with every input. */
export function describeState(state, now) {
  const lines = [];
  lines.push(`Goal: ${state.goal ?? '(not set)'}`);
  if (state.branch) lines.push(`Branch: ${state.branch}`);
  if (state.file) lines.push(currentFile(state));
  const edits = state.edits.slice(-5).map(edit => `${edit.file}:${edit.from}-${edit.to} (${ago(now, edit.at)})`);
  if (edits.length) lines.push(`Recent edits: ${edits.join('; ')}`);
  const diagnostics = Object.entries(state.diagnostics)
    .flatMap(([file, items]) => items.map(item => `${file}:${item.line} ${item.severity}: ${item.message}`))
    .slice(0, 8);
  if (diagnostics.length) lines.push(`Diagnostics:\n${diagnostics.map(line => `- ${line}`).join('\n')}`);
  const commands = state.commands.slice(-3).map(command => `- ${commandLine(command, now)}`);
  if (commands.length) lines.push(`Recent commands:\n${commands.join('\n')}`);
  if (state.tests) lines.push(testsLine(state.tests, now));
  if (state.focus.target !== 'unknown') lines.push(looking(state));
  lines.push(lastKey(state, now));
  return lines.join('\n');
}

/** What the Watcher sees: just enough to judge a trigger, since every token here costs latency on each event. */
export function describeBriefly(state, now) {
  const lines = [`Goal: ${state.goal ?? '(not set)'}`];
  if (state.file) lines.push(currentFile(state));
  if (state.focus.target !== 'unknown') lines.push(looking(state));
  lines.push(lastKey(state, now));
  return lines.join('\n');
}
