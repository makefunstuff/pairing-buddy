// Memory beyond the last note: the earlier sessions of a project, their goals, notes and chat lines, searched by
// words. The Partner searches them with its recall tool, and a question about the past ("what did we try last week?")
// comes with what they say already, for the small models that would not think to look.

const MAX_WORDS = 8;
const NOTES = 3; // of the best-matching notes, the Partner gets this many
const LINES = 6; // and of the chat lines
const CANDIDATES = 50; // rows the store returns of each, newest first, to rank
const LINE_CHARS = 300;

// Words that say nothing about what to look for.
const STOP = new Set(`the and for with that this what when where which who why how did does was were are has have had
not but you your our we us they them its it's from into about again there then than last time week month session sessions
yesterday earlier before previously remember tried try said say decided talk talked discussed any some just also can could
would should will all one way pair`.split(/\s+/));

/** The words of `text` worth searching for: lower case, three letters or more, at most MAX_WORDS. */
export function searchWords(text) {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(word => word.length >= 3 && !STOP.has(word));
  return [...new Set(words)].slice(0, MAX_WORDS);
}

// A question about earlier sessions, not about the code as it is now.
const ABOUT_BEFORE = /\b(last (time|week|month|session|friday|monday|tuesday|wednesday|thursday)|yesterday|the other day|previous(ly| session)|earlier session|(did|have|had) we|we (tried|did|decided|discussed|talked|said|agreed)|do you remember)\b/i;

/** Whether the user asks about what happened in earlier sessions. */
export const asksAboutBefore = text => ABOUT_BEFORE.test(text);

const pad = n => String(n).padStart(2, '0');
const day = at => {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const clock = at => `${pad(new Date(at).getHours())}:${pad(new Date(at).getMinutes())}`;
const SENDERS = {user: 'the user', pair: 'you', system: 'the chat'};
const cut = text => (text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS - 1)}…` : text);
const oneLine = text => text.replace(/\s*\n\s*/g, ' ');

/** How many of `words` `text` has. */
const hits = (text, words) => {
  const lower = (text ?? '').toLowerCase();
  return words.filter(word => lower.includes(word)).length;
};

/** The `count` best of `rows` (newest first): the most words found, the newest among equals. */
const best = (rows, score, count) => rows.map((row, i) => ({row, i, score: score(row)}))
  .sort((a, b) => b.score - a.score || a.i - b.i)
  .slice(0, count)
  .map(({row}) => row);

/**
 * What the earlier sessions of project `root` (all but session `id`) kept about `query`, as text for the Partner:
 * the best-matching notes, then chat lines, each with its day; null when the query has no words to look for.
 */
export function recall(store, root, id, query) {
  const words = searchWords(query);
  if (!words.length) return null;
  const {notes, lines} = store.history(root, id, words, CANDIDATES);
  if (!notes.length && !lines.length) return `Nothing in the earlier sessions of this project mentions ${words.join(', ')}.`;
  const goal = row => (row.goal ? ` (goal: ${row.goal})` : '');
  return [
    'From the earlier sessions of this project, best matches first:',
    ...best(notes, row => hits(row.note, words) + hits(row.goal, words), NOTES)
      .map(row => `- Session of ${day(row.at)}${goal(row)}${row.note ? `, its note:\n${row.note}` : ', no note'}`),
    ...best(lines, row => hits(row.text, words), LINES)
      .map(row => `- ${day(row.at)} ${clock(row.at)}${goal(row)}, ${SENDERS[row.sender] ?? row.sender}: ${cut(oneLine(row.text))}`),
  ].join('\n');
}
