// The decision log: decisions.md next to a note, one entry per decision you log with the decide key, in the
// spirit of Nygard's ADRs. An entry keeps your decision in your words, where it stands in the note, the question
// that led to it (its context), and an empty line for its consequences, which you write. A later decision about the same thing supersedes it: the entry stays, its status says so.
// Pure: it turns the log's text into its next text; the editor puts that in the buffer, which you save.
import {ideaWords, overlap} from './note-rules.mjs';

export const LOG_NAME = 'decisions.md';
const HEAD = '# Decisions\n';
const ENTRY = /^## (\S+) · (.+)$/;
const WHERE = /^- Where: (.+?):(\d+)(?: \((.*)\))?$/;
const DECIDED = '- Status: decided';
const SAME_THING = 0.5; // how much two decisions in one section must share to be about the same thing

/**
 * The log's entries: `{date, title, file, section, decided, status}`, `status` being the 0-based index of its status
 * line.
 */
export function entries(log) {
  const found = [];
  log.split('\n').forEach((text, index) => {
    const heading = ENTRY.exec(text);
    if (heading) return found.push({date: heading[1], title: heading[2], file: null, section: null, decided: false, status: null});
    const entry = found.at(-1);
    if (!entry) return;
    const where = WHERE.exec(text);
    if (where) Object.assign(entry, {file: where[1], section: where[3] ?? null});
    if (text.startsWith('- Status: ')) Object.assign(entry, {decided: text === DECIDED, status: index});
  });
  return found;
}

/**
 * Whether `decision`, from the note `file`, is the log's decision now. One that was superseded is not: going back
 * to it is a decision of its own.
 */
export const logged = (log, file, decision) => entries(log).some(entry => entry.decided && entry.file === file && entry.title === decision);

/**
 * The log after `decision` ({date, text, file, line, section, asked}) is logged: `{text, line, superseded}`, with
 * the 1-based line of the new entry and the titles of the entries it supersedes; null when it is logged already.
 */
export function logDecision(log, decision) {
  const before = log.trim() ? log : HEAD;
  if (logged(before, decision.file, decision.text)) return null;
  const words = ideaWords(decision.text);
  const lines = before.split('\n');
  const superseded = [];
  for (const entry of entries(before)) {
    const same = entry.decided && entry.file === decision.file && entry.section === decision.section
      && overlap(ideaWords(entry.title), words) >= SAME_THING;
    if (!same) continue;
    lines[entry.status] = `- Status: superseded by ${decision.date} · ${decision.text}`;
    superseded.push(entry.title);
  }
  const body = lines.join('\n').replace(/\n*$/, '');
  const entry = [
    `## ${decision.date} · ${decision.text}`,
    '',
    DECIDED,
    `- Where: ${decision.file}:${decision.line}${decision.section ? ` (${decision.section})` : ''}`,
    ...(decision.asked ? [`- Asked: "${decision.asked}"`] : []),
    '- Consequences:',
  ];
  return {text: `${body}\n\n${entry.join('\n')}\n`, line: body.split('\n').length + 2, superseded};
}
