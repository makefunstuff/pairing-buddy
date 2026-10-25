// The session state as a few short lines of text: what both models see instead of raw events.
import {errorLine, failed} from './fold.mjs';

const ago = (now, at) => `${Math.max(0, Math.round((now - at) / 1000))} s ago`;

function commandLine(command, now) {
  const result = failed(command) ? `failed${command.exit ? ` (exit ${command.exit})` : ''}: ${errorLine(command.output)}` : 'ok';
  return `\`${command.cmd}\` ${result}, ${ago(now, command.endedAt)}`;
}

export function describeState(state, now) {
  const lines = [];
  lines.push(`Goal: ${state.goal ?? '(not set)'}`);
  if (state.branch) lines.push(`Branch: ${state.branch}`);
  if (state.file) {
    const selection = state.selection ? `, selected lines ${state.selection.from}-${state.selection.to}` : '';
    lines.push(`Current file: ${state.file}${state.cursor ? `, cursor at line ${state.cursor.line}` : ''}${selection}`);
  }
  const edits = state.edits.slice(-5).map(edit => `${edit.file}:${edit.from}-${edit.to} (${ago(now, edit.at)})`);
  if (edits.length) lines.push(`Recent edits: ${edits.join('; ')}`);
  const diagnostics = Object.entries(state.diagnostics)
    .flatMap(([file, items]) => items.map(item => `${file}:${item.line} ${item.severity}: ${item.message}`))
    .slice(0, 8);
  if (diagnostics.length) lines.push(`Diagnostics:\n${diagnostics.map(line => `- ${line}`).join('\n')}`);
  const commands = state.commands.slice(-3).map(command => `- ${commandLine(command, now)}`);
  if (commands.length) lines.push(`Recent commands:\n${commands.join('\n')}`);
  if (state.focus.target !== 'unknown') lines.push(`The user is looking at: ${state.focus.target}${state.focus.scrolled ? ' (scrolled up)' : ''}`);
  lines.push(`Last keystroke: ${state.lastKeyAt ? ago(now, state.lastKeyAt) : 'none yet'}`);
  return lines.join('\n');
}
