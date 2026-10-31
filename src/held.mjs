// The held thought: an unasked remark that is not urgent waits for a natural breakpoint (a save, a run that
// ended, a stop to look), so Pair never breaks a train of thought for news that keeps. Meanwhile the editor shows a
// dot in the margin, and the jump key reads it early. A held thought that is no longer true by then is dropped.
import {join} from 'node:path';
import {userEdits} from './fold.mjs';

// About what you are doing right now: these speak at the next pause in your typing, as every remark did before.
const URGENT = new Set(['edit_while_red', 'regression', 'repeated_error', 'failed_command']);

export const BREAK = {
  normalMs: 3000, // out of Insert mode this long, with no edit: you stopped to look
  quietMs: 15_000, // no key or edit this long, in any mode or editor
};

// Events that end a stretch of work. A commit is a command that ended.
const ENDS = new Set(['save', 'command_end', 'test_run']);

/** Whether a remark on `kind` speaks at the next pause instead of the next breakpoint. */
export const urgent = kind => URGENT.has(kind);

/** Where the user's natural breakpoints fall, from the events the session receives. */
export class Breakpoints {
  endedAt = 0; // the last save, or command or test run that ended
  insert = false; // in Insert mode, as the editor last said
  modeAt = 0;

  see(event) {
    if (ENDS.has(event.kind)) this.endedAt = event.at;
    if (event.kind === 'mode') Object.assign(this, {insert: event.insert === true, modeAt: event.at});
  }

  /** When the user last came to a natural end: a work-ending event, or now, while they rest. */
  last(state, now) {
    const busyAt = Math.max(state.lastKeyAt, state.lastEditAt);
    const looking = !this.insert && now - Math.max(this.modeAt, busyAt) >= BREAK.normalMs;
    return looking || now - busyAt >= BREAK.quietMs ? now : this.endedAt;
  }
}

/**
 * Whether what `trigger` saw still holds in `state`: the error is still in the code, the user is still in the
 * file that drifted, no edit since the searches of a trail, the board task still changes the file. A held thought about what is gone is dropped.
 */
export function stillTrue(trigger, state) {
  if (trigger.kind === 'new_code_diagnostic') {
    // By its message: lines added or removed above it move the error, and it is still the same error.
    return (state.diagnostics[trigger.file] ?? []).some(item => item.message === trigger.message);
  }
  if (trigger.kind === 'drift') return userEdits(state).at(-1)?.file === trigger.file;
  // Fresh code: the user has not edited (or deleted: from > to) those lines since, nor written on right below them: a
  // thought about code they went back to finish is stale.
  if (trigger.kind === 'fresh_code') return !userEdits(state).some(edit => edit.file === trigger.file && edit.at > trigger.at && edit.from <= trigger.to + 2 && Math.max(edit.from, edit.to) >= trigger.from);
  if (trigger.kind === 'search_trail') return state.lastEditAt < trigger.searches[0].at; // an edit since: you found it
  // The task still changes that file: one that was merged, stopped or archived meanwhile is no news.
  if (trigger.kind === 'overlap') return (state.tasks ?? []).some(task => task.id === trigger.task.id && task.files.some(each => each.file === trigger.file));
  return true;
}

/**
 * Where the margin dot of a held thought goes: the place the remark points at, else the place its trigger
 * names (relative to `root`); the editor puts it on the user's line when neither has a line.
 */
export function placeOf(target, trigger, root) {
  if (target) return {file: target.file, line: target.line};
  return trigger.file ? {file: join(root, trigger.file), line: trigger.line ?? null} : {file: null, line: null};
}
