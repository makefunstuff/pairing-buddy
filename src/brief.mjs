// The brief: the user's idea in their own words, which every /gen request runs against. It is the session goal, the
// board task of the branch with its brief on the board, and one note: the one the user pinned (/brief, :Pair brief), else the config's gen.brief
// (NOTES.md) when the project has it. Pair reads it and never writes it, as it never writes a note.
//
// Before a request generates, the model is asked whether the request contradicts the brief; after, whether the code
// does, and what it decided that the brief does not say. Each answer is JSON, and only what holds up in code is kept,
// as note-reading.mjs keeps marks: a contradiction quotes a real line of the brief, and the code's names a real line
// of what was proposed.
import {relative} from 'node:path';
import {entries} from './decision-log.mjs';
import {projectFile} from './files.mjs';
import {jsonList} from './note-reading.mjs';

export const BRIEF_LINES = 300; // a longer note goes to the model cut here
export const MAX_CONTRADICTIONS = 3;
export const MAX_GUESSED = 3;
const QUOTE_CHARS = 120;
const SIDE_CHARS = 60;
const TEXT_CHARS = 160;
const SOURCES = ['note', 'goal', 'task'];
const TASK_BRIEF_LINES = 80; // of the board task's brief, the model reads this many

const plain = text => text.toLowerCase().replace(/[`*_"“”'‘’]/g, '').replace(/\s+/g, ' ').trim();
const shorten = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…`);
const words = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/**
 * The brief of a session: `{goal, task, note}`, `task` being `{id, title, brief}` (`brief`, what the board keeps as
 * its brief, or null) and `note` `{file, path, lines, pinned}` or null. `pin` is the note the
 * user pinned (a path in the project), false when they left the note out (/brief off), null when they did neither:
 * then `fallback` (the config's gen.brief) is used when the project has it. `read(path)` gives a file's text as the
 * editor has it.
 */
export async function readBrief({root, pin = null, fallback = 'NOTES.md', goal = null, task = null, read}) {
  const name = pin === false ? null : pin ?? fallback;
  const path = name ? await projectFile(root, name) : null;
  let note = null;
  if (path) {
    const text = await read(path).catch(() => null);
    if (typeof text === 'string') note = {file: relative(root, path), path, lines: text.replace(/\n$/, '').split('\n'), pinned: Boolean(pin)};
  }
  const told = typeof task?.brief === 'string' && task.brief.trim() ? task.brief.trim() : null;
  return {goal: goal || null, task: task?.id ? {id: task.id, title: task.title ?? '', brief: told} : null, note};
}

/** Whether the brief says anything: a request runs against nothing without it. */
export const briefEmpty = brief => !brief.goal && !brief.task && !brief.note?.lines.some(line => line.trim());

/** What the brief is made of, in one line: `NOTES.md (pinned) + goal "…" + board task repo/12`. */
export function briefLine(brief) {
  const parts = [];
  if (brief.note) parts.push(`${brief.note.file}${brief.note.pinned ? ' (pinned)' : ''}`);
  if (brief.goal) parts.push(`goal "${shorten(brief.goal, SIDE_CHARS)}"`);
  if (brief.task) parts.push(`board task ${brief.task.id}${brief.task.brief ? ' with its brief' : ''}`);
  return parts.join(' + ') || 'nothing yet';
}

/** The lines of the board task's brief the model reads. */
const taskLines = task => task.brief.split('\n').slice(0, TASK_BRIEF_LINES);

/** The brief as the model reads it: the goal, the task with its brief on the board, and the note with its lines numbered. */
export function briefText(brief) {
  const parts = ['The brief: the user\'s own idea in their words. Follow it; never edit it.'];
  if (brief.goal) parts.push(`Goal: ${brief.goal}`);
  if (brief.task) parts.push(`Board task ${brief.task.id}: ${brief.task.title}${brief.task.brief ? `\nIts brief on the board:\n${taskLines(brief.task).join('\n')}` : ''}`);
  if (brief.note) {
    const shown = brief.note.lines.slice(0, BRIEF_LINES).map((line, i) => `${i + 1}: ${line}`);
    const cut = brief.note.lines.length > BRIEF_LINES ? `\n(${brief.note.lines.length - BRIEF_LINES} more lines not shown)` : '';
    parts.push(`Note ${brief.note.file}:\n${shown.join('\n')}${cut}`);
  }
  return parts.join('\n');
}

const QUOTED_LINES = 40; // a committed note: a board task's brief quotes this many of its lines; its agent reads the rest
const COPIED_LINES = BRIEF_LINES; // a note with changes not committed: copied whole, up to this many lines

/**
 * A board task's brief, from a request and the brief it runs against: the request in the user's words; the goal, the
 * branch's board task and the note's lines, quoted with file:line (a committed note in part, since the task's agent
 * reads it in its worktree; one with changes not committed (`uncommitted`) whole, since the agent would not see them);
 * the project's `files` the request names; `test`, the command Pair runs on save; and when Pair already tried it as
 * gen #n (`from`), what its check `found` against the brief and what it `guessed`, as open questions.
 */
export function handoffBrief({words, brief, files = [], test = null, found = [], guessed = [], uncommitted = false, from = null}) {
  const parts = [words.trim()];
  const quoted = [];
  if (brief.goal) quoted.push(`Goal: ${brief.goal}`);
  if (brief.task) quoted.push(`Board task ${brief.task.id}: ${brief.task.title}`);
  if (brief.note) {
    const {file} = brief.note;
    if (uncommitted) {
      // The agent's only copy: every line as it is, blank lines and indents too, in a fence longer than any in the note.
      const copied = brief.note.lines.slice(0, COPIED_LINES);
      const fence = '`'.repeat(Math.max(3, ...copied.map(line => (line.match(/`+/g) ?? []).reduce((most, run) => Math.max(most, run.length + 1), 0))));
      const cut = brief.note.lines.length > copied.length ? ` (lines 1-${copied.length} of ${brief.note.lines.length})` : '';
      quoted.push(`${file} has changes that are not committed, so your worktree does not have them. It is copied here as it is now${cut}:`, fence, ...copied, fence);
    } else {
      const lines = brief.note.lines.map((text, i) => ({text: text.trim(), line: i + 1})).filter(each => each.text);
      const shown = lines.slice(0, QUOTED_LINES);
      quoted.push(...shown.map(each => `> ${each.text} (${file}:${each.line})`));
      if (lines.length > shown.length) quoted.push(`(the rest is in ${file}, in your worktree)`);
    }
  }
  const what = [
    brief.note && `${brief.note.file}${brief.note.pinned ? ', pinned' : ''}, ${uncommitted ? 'not committed' : 'committed'}`,
    brief.goal && 'the goal', brief.task && `board task ${brief.task.id}`,
  ].filter(Boolean).join(' + ');
  if (quoted.length) parts.push(`From the brief (${what}):\n${quoted.join('\n')}`);
  if (files.length) parts.push(`Files it names: ${files.join(', ')}`);
  if (test) parts.push(`Tests: \`${test}\` (Pair runs it on save: testOnSave)`);
  if (found.length) parts.push(`What ${from}'s check found against the brief:\n${found.map(line => `- ${line}`).join('\n')}`);
  if (guessed.length) parts.push(`Open questions: ${from} guessed these, which neither the brief nor the request says. Settle them, or ask:\n${guessed.map(text => `- ${text}`).join('\n')}`);
  parts.push(from ? `Handed to the board from Pair (${from}).` : 'Asked from Pair with /gen board.');
  return parts.join('\n\n');
}

/**
 * Where `quote` is in the brief: `{source, line, text}` with the whole line it is on, or null when the brief has no
 * such words. `line` (of the note) is looked at first; a quote found on another line is moved there.
 */
export function findQuote(brief, source, line, quote) {
  const wanted = plain(words(quote));
  if (wanted.length < 3) return null;
  if (source === 'goal') return brief.goal && plain(brief.goal).includes(wanted) ? {source, line: null, text: brief.goal} : null;
  if (source === 'task') {
    if (!brief.task) return null;
    const text = [brief.task.title, ...(brief.task.brief ? taskLines(brief.task) : [])].find(each => plain(each).includes(wanted));
    return text ? {source, line: null, text: text.trim()} : null;
  }
  const lines = brief.note?.lines.slice(0, BRIEF_LINES) ?? [];
  const at = Number.isInteger(line) && plain(lines[line - 1] ?? '').includes(wanted) ? line - 1 : lines.findIndex(each => plain(each).includes(wanted));
  return at < 0 ? null : {source: 'note', line: at + 1, text: lines[at].trim()};
}

/** Where a quote is, as the user reads it: NOTES.md:4, the goal, board task repo/12. */
export function quotePlace(brief, found) {
  if (found.source === 'note') return `${brief.note.file}:${found.line}`;
  return found.source === 'goal' ? 'the goal' : `board task ${brief.task.id}`;
}

/** The key under which a quote the user chose to go against is kept, so the same conflict is not asked again. */
export const exceptionKey = found => `${found.source}:${plain(found.text)}`;

export const CONFLICT_PROMPT = `You compare a request for code with the brief it runs against: the user's own idea in their
words. Does the request clearly contradict the brief? A contradiction is a request for what the brief rules out: another
database, library, layout or behaviour than the one the brief names. A request for something the brief does not mention
is no contradiction, and neither is one that only adds detail.
Answer with a JSON array: [] when nothing clearly contradicts, else one item:
{"source": "note", "line": N, "quote": "the brief's exact words", "brief_says": "...", "asked": "..."}
- source: "note" (give the line number), "goal" or "task".
- quote: copied word for word from that line, at most 15 words.
- brief_says and asked: the two sides, at most 6 words each, for example "SQLite" and "Postgres".
Answer with the JSON alone.`;

/** What the model reads to compare a request with the brief. */
export function conflictInput(brief, request) {
  return `${briefText(brief)}\n\nThe request: "${request}"`;
}

/**
 * The conflict in the model's answer when it holds up: `{source, line, text, says, asked}`, the quote found in the
 * brief; null when there is none, the quote is not the brief's, or the user already chose to go against that line
 * (`exceptions`, a Set of exceptionKey).
 */
export function parseConflict(answer, brief, exceptions = new Set()) {
  for (const item of jsonList(answer)) {
    const source = SOURCES.includes(item.source) ? item.source : 'note';
    const found = findQuote(brief, source, Number(item.line), item.quote);
    const says = words(item.brief_says);
    const asked = words(item.asked);
    if (!found || !says || !asked || exceptions.has(exceptionKey(found))) continue;
    return {...found, says: shorten(says, SIDE_CHARS), asked: shorten(asked, SIDE_CHARS)};
  }
  return null;
}

export const CHECK_PROMPT = `You check code that was written for a user against their brief: their own idea in their
words. Answer with a JSON array of at most ${MAX_CONTRADICTIONS + MAX_GUESSED} items, of two kinds:
{"kind": "contradicts", "source": "note", "line": N, "quote": "the brief's exact words", "piece": P, "piece_line": L, "text": "..."}
  The code goes against the brief: quote the line it goes against word for word (at most 15 words; source "note"
  with its line number, or "goal" or "task"), give the piece and the line in that piece's code, and say in at most
  20 words what the code does against it. Only clear contradictions, not style.
{"kind": "guessed", "text": "..."}
  A decision the code makes that neither the brief nor the request settles: a library, a name, a layout, a default,
  an error behaviour. At most 15 words each, the decision itself ("the default status is new").
[] when the code follows the brief and decides nothing worth saying. Answer with the JSON alone.`;

/** What the model reads to check what a request proposed: the brief, the request, and each piece numbered. */
export function checkInput(brief, request, pieces, root) {
  const shown = pieces.map((piece, i) => {
    const lines = piece.text.split('\n').map((line, j) => `${j + 1}: ${line}`).join('\n');
    return `Piece ${i + 1}, for ${relative(root, piece.file)}:${piece.line}:\n${lines}`;
  });
  return `${briefText(brief)}\n\nThe request: "${request}"${brief.asAsked ? `\nThe user chose the request over the brief's "${brief.asAsked.text}".` : ''}\n\n${shown.join('\n\n')}`;
}

/**
 * The items of the check that hold up: `contradicts`, at most three `{source, line, text, piece, pieceLine, file,
 * fileLine, why}` whose quote is a real line of the brief and whose place is a real line of a piece, and `guessed`,
 * at most three short decisions. A contradiction of a line the user chose to go against (`exceptions`) is no news.
 */
export function parseCheck(answer, brief, pieces, exceptions = new Set()) {
  const contradicts = [];
  const guessed = [];
  for (const item of jsonList(answer)) {
    if (item.kind === 'guessed') {
      const text = words(item.text).replace(/\.$/, '');
      if (text && guessed.length < MAX_GUESSED && !guessed.some(each => plain(each) === plain(text))) guessed.push(shorten(text, TEXT_CHARS));
      continue;
    }
    if (item.kind !== 'contradicts' || contradicts.length >= MAX_CONTRADICTIONS) continue;
    const source = SOURCES.includes(item.source) ? item.source : 'note';
    const found = findQuote(brief, source, Number(item.line), item.quote);
    const piece = pieces[Number(item.piece) - 1];
    const at = Number(item.piece_line);
    const why = words(item.text);
    if (!found || !piece || !Number.isInteger(at) || at < 1 || at > piece.text.split('\n').length || !why) continue;
    if (exceptions.has(exceptionKey(found)) || contradicts.some(each => exceptionKey(each) === exceptionKey(found))) continue;
    // Inserted code starts under its line; code over a selection starts on it.
    const fileLine = piece.line + at - (piece.insert ? 0 : 1);
    contradicts.push({...found, piece: Number(item.piece) - 1, pieceLine: at, file: piece.file, fileLine, why: shorten(why, TEXT_CHARS)});
  }
  return {contradicts, guessed};
}

const SYNC_SHOWN = 12; // of each kind, /brief sync lists this many
// A line of the note worth comparing: words, not a heading's marks, a rule or a fence alone.
const bare = text => plain(text.replace(/^\s*(?:#+|[-*+>]|\d+[.)])\s+/, '').replace(/^\s*(?:#+|[-*_=`]{3,})\s*$/, ''));
// handoffBrief's quotes: `> words (NOTES.md:4)`.
const QUOTE = /^> (.+) \(([^()\s]+):(\d+)\)$/;

/**
 * How the brief differs from its board task's brief (`brief.task.brief`), for /brief sync: `added`, the note's lines
 * the task's brief does not have ({line, text}), its headings left out; `gone`, the lines it quotes from the note that the note no longer
 * has; `decided`, the decisions of the log `log` (decisions.md's text) it does not have ({date, title}). Null without
 * a board task.
 */
export function briefSync(brief, log = '') {
  if (!brief.task) return null;
  const told = plain(brief.task.brief ?? '');
  const has = text => text.length >= 3 && told.includes(text);
  const added = !brief.note ? [] : brief.note.lines.map((text, i) => ({line: i + 1, text: text.trim()}))
    .filter(each => !/^#/.test(each.text) && bare(each.text) && !has(bare(each.text))); // a heading is no instruction
  const kept = new Set((brief.note?.lines ?? []).map(bare));
  const gone = !brief.note ? [] : (brief.task.brief ?? '').split('\n').map(line => QUOTE.exec(line.trim()))
    .filter(quote => quote && quote[2] === brief.note.file && !kept.has(bare(quote[1]))).map(quote => quote[1]);
  const decided = entries(log).filter(entry => entry.decided && !has(plain(entry.title))).map(({date, title}) => ({date, title}));
  return {added: added.slice(0, SYNC_SHOWN), gone: gone.slice(0, SYNC_SHOWN), decided: decided.slice(0, SYNC_SHOWN),
    more: Math.max(0, added.length - SYNC_SHOWN) + Math.max(0, gone.length - SYNC_SHOWN) + Math.max(0, decided.length - SYNC_SHOWN)};
}

/** Whether /brief sync found nothing to say. */
export const inSync = sync => !sync.added.length && !sync.gone.length && !sync.decided.length;

/** What /brief sync found, as lines: + what the task's brief lacks, - what it has that the brief no longer says. */
export function syncLines(brief, sync) {
  const file = brief.note?.file;
  return [
    ...sync.added.map(each => `+ ${shorten(each.text, TEXT_CHARS)} (${file}:${each.line})`),
    ...sync.gone.map(text => `- ${shorten(text, TEXT_CHARS)} (no longer in ${file})`),
    ...sync.decided.map(each => `+ decided ${each.date}: ${shorten(each.title, TEXT_CHARS)}`),
    ...(sync.more ? [`(and ${sync.more} more)`] : []),
  ];
}

/**
 * What /brief sync tells task `brief.task.id`'s agent: what changed in the brief since its brief was written. `waiting`,
 * its agent waits for a go, and this is none.
 */
export function syncTell(brief, sync, {waiting = false} = {}) {
  const file = brief.note?.file;
  const parts = [`The brief in Pair${file ? ` (${file})` : ''} changed since your brief was written. Take this in:`];
  if (sync.added.length) parts.push(`It says now:\n${sync.added.map(each => `- ${each.text} (${file}:${each.line})`).join('\n')}`);
  if (sync.gone.length) parts.push(`It no longer says:\n${sync.gone.map(text => `- ${text}`).join('\n')}`);
  if (sync.decided.length) parts.push(`Decided since (decisions.md):\n${sync.decided.map(each => `- ${each.date}: ${each.title}`).join('\n')}`);
  if (waiting) parts.push('This is no go: keep waiting for mine.');
  return parts.join('\n\n');
}
