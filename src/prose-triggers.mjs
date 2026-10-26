// The triggers of a Markdown note, where you think in prose: you wrote a question and stopped (the stall), or a new
// section has left the note's title and the goal (the drift). Either way Pair asks, once, and never writes for you.
// Pure, like triggers.mjs: the caller passes the clock and the keys already fired.
import {ideaWords, isNote} from './note-rules.mjs';

export const PROSE_KINDS = ['note_stall', 'note_drift'];

export const PROSE_TIMING = {
  stallMs: 90_000, // no new words for this long after a question you wrote
  awayMs: 5 * 60_000, // longer, and you are away rather than stuck
  sectionMs: 60_000, // a new section is judged once you have written under it this long
};

const HEADING = /^#{2,6}\s+(.+?)\s*#*\s*$/;

// What the Partner is asked for each of them (see CHECKS in session.mjs).
export const PROSE_CHECKS = {
  note_stall: 'The user is thinking in their note and stopped after writing a question. Read the note around that line. '
    + 'Do not answer the question, do not write their text and do not suggest a change: here a question back is the remark. '
    + 'Ask one short question (at most 18 words) that helps them answer it themselves, about the note or the code it names. '
    + 'If they plainly do not need one, answer exactly SILENT.',
  note_drift: 'Do not help with the section itself. Read the note: its title and the new section. If the section serves '
    + 'the title or the goal, answer exactly SILENT. If it has left them, ask once, as one short question that names the note, '
    + 'for example "is this still the <title> note?".',
};

// What the Watcher is asked to score for each of them (see WHAT_HAPPENED in watcher.mjs). Asked whether a remark
// would save time, a tested model scored a stalled question 3 and an off-topic section 2, under the normal bar:
// nothing failed. Asked about the question and the section themselves, 7 and 8, and 2 for a section on topic.
export const PROSE_WATCH = {
  note_stall: trigger => `The user writes a design note. They wrote the question "${trigger.question}" and have written nothing since, for ${trigger.quietS} s.\n`
    + 'Score how much one question back, that helps them answer it themselves, would help now: 0 if their question is rhetorical or trivial, 10 if they seem stuck on a real design question.',
  note_drift: trigger => `The user writes a design note titled "${trigger.title}". They began the section "${trigger.heading}" in it and write under it.\n`
    + `Score how clearly that section is about something other than "${trigger.title}": 0 if it could belong in that note, 10 if it is plainly another subject.`,
};

/** The last line of `text` that asks a question, as {index, text}; null when none does. */
function lastQuestion(text) {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    if (/\?\s*$/.test(lines[index]) && !HEADING.test(lines[index])) return {index, text: lines[index].trim()};
  }
  return null;
}

function stallTriggers(state, now) {
  const edit = state.edits.at(-1);
  if (!edit || !isNote(edit.file)) return [];
  const quiet = now - Math.max(state.lastKeyAt, state.lastEditAt);
  const question = lastQuestion(edit.text);
  if (!question || quiet < PROSE_TIMING.stallMs || quiet > PROSE_TIMING.awayMs) return [];
  const line = edit.from + question.index;
  return [{
    kind: 'note_stall',
    key: `note_stall:${edit.file}:${edit.at}`,
    detail: `In the note ${edit.file}, the user wrote the question "${question.text}" (line ${line}) and has written nothing for ${Math.round(quiet / 1000)} s.`,
    file: edit.file,
    line,
    question: question.text,
    quietS: Math.round(quiet / 1000),
  }];
}

/**
 * A section the user began in a note in this session, whose heading and first words share no word with the note's
 * title or the goal; judged once per note and heading, a minute after it was begun, while the user is still in it.
 */
function driftTriggers(state, now) {
  const latest = state.edits.at(-1);
  if (!latest || !isNote(latest.file)) return [];
  const edits = state.edits.filter(edit => edit.file === latest.file);
  const begun = edits.findLastIndex(edit => edit.text.split('\n').some(line => HEADING.test(line)));
  if (begun < 0 || now - edits[begun].at < PROSE_TIMING.sectionMs) return [];
  const heading = edits[begun].text.split('\n').findLast(line => HEADING.test(line)).trim();
  const title = state.notes?.[latest.file]?.title;
  if (!title) return [];
  const written = ideaWords([heading, ...edits.slice(begun).map(edit => edit.text)].join('\n'));
  const theme = ideaWords(`${title} ${state.goal ?? ''}`);
  if ([...written].some(word => theme.has(word))) return [];
  return [{
    kind: 'note_drift',
    key: `note_drift:${latest.file}:${heading}`,
    detail: `In the note "${title}" (${latest.file}), the user began the section "${heading}" and writes under it; `
      + `it shares no word with the note's title${state.goal ? ` or the goal "${state.goal}"` : ''}.`,
    file: latest.file,
    title,
    heading,
    lasting: true,
  }];
}

/** The candidate remarks about the note the user writes now. */
export const proseTriggers = (state, now) => [...stallTriggers(state, now), ...driftTriggers(state, now)];
