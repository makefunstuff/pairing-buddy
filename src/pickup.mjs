// The morning pick-up: the first Neovim after a long gap lands where the last session stopped, its "Tomorrow, first"
// place (see debrief.mjs). Pair's gaze reads the code there again, so a debrief the code no longer bears out never
// sends you the wrong way, and one line says what is left. A test that was red when you stopped stays in the
// statusline, "since yesterday", until the next run. Pure but for `tests`' look at the files' times.
import {stat} from 'node:fs/promises';

export const PICKUP_AFTER_MS = 30 * 60_000; // a session that starts sooner after the last one carries on: no pick-up
const AROUND = 6; // lines on each side of the place that the gaze reads and the Partner gets
const LINE_CHARS = 240;
const SILENT = /^\W*silent\W*$/i;

/**
 * Where the place `{line, text}` is in `lines` now: the same line when its code is still there, else the nearest
 * line with that code (`moved`), else the same line number (`changed`: its code is gone).
 */
export function relocate(lines, {line, text}) {
  const at = Math.min(Math.max(1, line), lines.length);
  const want = text.trim();
  if (!want || lines[at - 1]?.trim() === want) return {line: at, moved: false, changed: false};
  let best = null;
  lines.forEach((code, index) => {
    if (code.trim() === want && (best === null || Math.abs(index + 1 - line) < Math.abs(best - line))) best = index + 1;
  });
  return best ? {line: best, moved: true, changed: false} : {line: at, moved: false, changed: true};
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const midnight = at => new Date(at).setHours(0, 0, 0, 0);

/** When the last session ended, as the statusline says it: "14:20" today, "yesterday", else "Friday" or "3 Oct". */
export function since(endedAt, now) {
  const days = Math.round((midnight(now) - midnight(endedAt)) / 86_400_000);
  const ended = new Date(endedAt);
  if (days <= 0) return ended.toTimeString().slice(0, 5);
  if (days === 1) return 'yesterday';
  if (days < 7) return DAYS[ended.getDay()];
  return ended.toLocaleDateString('en-GB', {day: 'numeric', month: 'short'});
}

/** The lines the gaze reads around `line`: {from, to}. */
export const around = (line, count) => ({from: Math.max(1, line - AROUND), to: Math.min(count, line + AROUND)});

/** What the Partner is asked: the last debrief, its first step and the code there now, numbered. */
export function pickupInput({note, place, code, moved, changed, failing = [], ended, now}) {
  const day = new Date(now);
  const where = `${place.file}:${place.line}`;
  const state = changed ? ', and this line changed since' : moved ? `, moved here from line ${moved}` : '';
  return `[pickup] The user is back: it is ${DAYS[day.getDay()]} ${day.toTimeString().slice(0, 5)}, and the last session ended ${since(ended, now)}. It ended with this debrief:
${note ?? '(none)'}

Its first step: ${place.step ?? 'carry on where the user stopped'}
The code there now (${where}${state}):
${code}
${failing.length ? `Still failing since then: ${failing.join(', ')}\n` : ''}
Check the debrief against the code as it is now. Then say in one line, at most 25 words, what is left here, starting with that step; if the code shows it is done, say what that leaves instead. Plain text, no tool calls.`;
}

/** The Partner's answer as one line; null for SILENT or nothing. */
export function pickupLine(text) {
  const line = text?.split('\n').map(part => part.trim()).find(Boolean);
  if (!line || SILENT.test(line)) return null;
  return line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS - 1)}…` : line;
}

/** The first `code` in the line that shows on `line` (the place's code), for the editor to underline; null when none does. */
export function codeOn(text, line = '') {
  return [...text.matchAll(/`([^`]+)`/g)].map(match => match[1]).find(code => line.includes(code)) ?? null;
}

/** The line without a model: the first step, as the debrief wrote it. */
export function fallbackLine(place, changed) {
  return `Where you stopped${place.step ? `: ${place.step}` : '.'}${changed ? ' (this line changed since)' : ''}`;
}

/**
 * The failing run the last session ended with, for the statusline: "1 failing since yesterday · TestX". A test
 * keeps its sign only while its file is unchanged since, so no sign lands on a line that moved. Null for a run that
 * was not failing.
 */
export async function restoredTests(tests, ended, now) {
  if (tests?.state !== 'fail') return null;
  const unchanged = async file => (await stat(file).catch(() => null))?.mtimeMs <= ended;
  const results = [];
  for (const test of tests.results ?? []) {
    if ((await unchanged(test.file)) && (!test.failure?.file || (await unchanged(test.failure.file)))) results.push(test);
  }
  const when = since(ended, now);
  return {type: 'tests', state: 'fail', label: tests.label, text: tests.text.replace(/^(.*?)( · |$)/, `$1 since ${when}$2`), results, since: when};
}
