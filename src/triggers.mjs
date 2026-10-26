// Finds the moments where a remark might help. Pure: the caller passes the clock and the keys already fired.
import {errorSignature, failed, failureLine} from './fold.mjs';

export const TRIGGER_KINDS = ['failed_command', 'repeated_error', 'new_code_diagnostic', 'stall', 'drift'];

export const TIMING = {
  lookGraceMs: 4_000, // a failure gets this long to be noticed before Pair counts it as missed
  recentMs: 120_000, // older failures are history, not news
  stallMs: 90_000,
  newCodeMs: 60_000, // an edit this close before a diagnostic counts as the code that caused it
  driftWindowMs: 10 * 60_000, // drift is looked at only while the last edit is this recent
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
  } else if (now - command.endedAt >= TIMING.lookGraceMs && missed(state, command)) {
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

/** The candidate remarks for this moment whose keys have not fired yet. */
export function detectTriggers(state, now, fired = new Set()) {
  return [...commandTriggers(state, now), ...diagnosticTriggers(state), ...driftTriggers(state, now)]
    .filter(trigger => !fired.has(trigger.key));
}
