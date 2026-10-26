// What the model is asked about a note, and how its answers are read: the marks in the margin, and the tasks
// you ask for with :Pair tasks. The note goes with the code it names, found by git grep, so a mark can say what the
// code does. The model only asks and points: it never writes the note.
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {noteLines, noteTitle} from './note-rules.mjs';

const run = promisify(execFile);

export const MAX_MARKS = 5;
export const MARK_KINDS = ['question', 'contradiction', 'code', 'decision'];
const MAX_NAMES = 10;
const MAX_TASKS = 8;
const TITLE_CHARS = 60;
const EXCERPT = {before: 2, after: 8};

// `Deliver`, `ErrBudget`, `dead_letters`, `cfg.Budget`: a name in backticks. Outside them, a word with a hump or an
// underscore inside (MaxAttempts, max_attempts) is a name too; plain words are prose.
const NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:(?:\.|::)[A-Za-z_][A-Za-z0-9_]*)*$/;
const BARE_NAME = /\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[a-z0-9]+_[a-z0-9_]+)\b/g;

/** The names of code a note mentions, most likely first: those in backticks, then the camel and snake words. */
export function codeNames(text) {
  const prose = noteLines(text).filter(line => !line.code).map(line => line.text).join('\n');
  const quoted = [...prose.matchAll(/`([^`\n]+)`/g)].map(match => match[1].trim()).filter(name => NAME.test(name));
  const bare = [...prose.replace(/`[^`\n]*`/g, '').matchAll(BARE_NAME)].map(match => match[0]);
  // cfg.Budget is found as Budget: the part after the last dot or :: is the one the code defines.
  return [...new Set([...quoted, ...bare].map(name => name.split(/\.|::/).at(-1)))].slice(0, MAX_NAMES);
}

// A line that defines `name` rather than uses it: after a keyword that introduces a definition (Go, Zig, Rust,
// Python, JS, C3 and the like), with Odin's `::`, as a top-level C function or #define, or assigned at a line's start.
const DEFINING = '(?:func|fn|proc|def|class|struct|enum|union|type|typedef|const|var|let|macro|interface|trait|impl)';
const NOT_A_TYPE = '(?:return|if|while|for|switch|else|case|do|sizeof)\\b';
function defines(line, name) {
  return new RegExp(`\\b${DEFINING}\\b.*\\b${name}\\b|\\b${name}\\s*::|^#\\s*define\\s+${name}\\b|^\\s*${name}\\s*=[^=]`).test(line)
    || new RegExp(`^(?!${NOT_A_TYPE})[A-Za-z_][\\w\\s*]*[\\s*]${name}\\s*\\(`).test(line);
}

/**
 * Where the project's code has `name`: `{name, file, line}` of its definition if one is found, else of its first
 * use. Read-only `git grep`, in tracked files that are not notes; null outside git or when nothing has it.
 */
async function findName(root, name) {
  const hits = await run('git', ['-C', root, 'grep', '-n', '-I', '-w', '-F', '-e', name, '--', '.', ':(exclude)*.md', ':(exclude)*.markdown'], {timeout: 3000, maxBuffer: 1 << 20})
    .then(({stdout}) => stdout.split('\n').filter(Boolean).slice(0, 200), () => []);
  const parsed = hits.map(hit => /^(.+?):(\d+):(.*)$/.exec(hit)).filter(Boolean).map(([, file, line, text]) => ({file, line: Number(line), text}));
  const hit = parsed.find(found => defines(found.text, name)) ?? parsed[0];
  return hit ? {name, file: hit.file, line: hit.line} : null;
}

/** The code the note names, as numbered excerpts `{name, file, line, text}` around where each name is defined. */
export async function codeFor(root, text) {
  const found = (await Promise.all(codeNames(text).map(name => findName(root, name)))).filter(Boolean);
  return Promise.all(found.map(async place => {
    const lines = (await readFile(join(root, place.file), 'utf8').catch(() => '')).split('\n');
    const first = Math.max(1, place.line - EXCERPT.before);
    const shown = lines.slice(first - 1, place.line + EXCERPT.after).map((line, i) => `${place.file}:${first + i}: ${line}`);
    return {...place, text: shown.join('\n')};
  }));
}

const numbered = text => text.split('\n').map((line, i) => `${i + 1}: ${line}`).join('\n');

/** What the model reads: the note, numbered, and the code it names. */
export function noteInput(file, text, code, goal = null) {
  const parts = [`Note: ${file} ("${noteTitle(text, file)}")${goal ? `\nThe session's goal: ${goal}` : ''}`, numbered(text)];
  if (code.length) parts.push(`Code the note names:\n${code.map(place => place.text).join('\n\n')}`);
  return parts.join('\n\n');
}

export const MARKS_PROMPT = `You read a design note in its margin, like a colleague with a pencil. The writer thinks by writing:
you never write, rewrite or summarise the note. You only ask and point.

Answer with a JSON array of at most ${MAX_MARKS} marks, the most useful first, or [] when nothing deserves one:
[{"kind": "...", "line": N, "text": "...", "other_line": N, "file": "path", "file_line": N}]
Kinds:
- "question": something the note needs to answer and does not. Ask it in one sentence ending with "?".
- "contradiction": two lines that cannot both be true (give other_line), or a line the code contradicts (give file
  and file_line). Name both sides with their numbers.
- "code": a line whose claim depends on the code shown: say what the code really does there, with file and file_line.
- "decision": a line that settles a choice worth logging but does not start with "Decision:". Say what it settles.
Rules: "line" is the note's line number the mark sits on. Each text at most 25 words, specific: use the note's own
numbers and names. No praise, no style or wording advice, no marks on headings. Do not mark a paragraph for
repeating an earlier one: a rule does that. Answer with the JSON alone.`;

export const TASKS_PROMPT = `The writer of this design note asked for the work in it as tasks. List at most ${MAX_TASKS},
in the note's order, as a JSON array: [{"title": "...", "lines": "lines 3-4, line 8", "open": false}]
- title: imperative, at most 60 characters, in the note's own words. Invent nothing the note does not say.
- An open question in the note becomes a task to decide it, with "open": true.
- lines: the note lines the task comes from.
Answer with the JSON alone.`;

const ANSWER_TIMEOUT_MS = 120_000;

/**
 * One answer of `model` to `content`, outside any conversation: its text. Throws when the model fails or `signal`
 * aborts it. It does not think: reading a note this way took a thinking model 25 to 55 s and found no more than in
 * 2 s without.
 */
export async function oneAnswer({models, model, signal}, systemPrompt, content) {
  const timeout = AbortSignal.timeout(ANSWER_TIMEOUT_MS);
  const message = await models.completeSimple(
    model,
    {systemPrompt, messages: [{role: 'user', content, timestamp: Date.now()}]},
    {signal: signal ? AbortSignal.any([signal, timeout]) : timeout},
  );
  if (message.errorMessage) throw new Error(message.errorMessage);
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('');
}

/**
 * The JSON array in a model's answer, also inside a code fence, after words, before words that have brackets of
 * their own, or as the one list in an object ({"marks": [...]}); [] when there is none.
 */
export function jsonList(text) {
  const start = text.search(/[[{]/);
  if (start < 0) return [];
  for (let end = text.length; end > start; end = text.lastIndexOf(text[start] === '[' ? ']' : '}', end - 1)) {
    let value;
    try { value = JSON.parse(text.slice(start, end + 1)); } catch { continue; }
    const list = Array.isArray(value) ? value : Object.values(value ?? {}).find(Array.isArray);
    return (list ?? []).filter(item => item && typeof item === 'object');
  }
  return [];
}

const inNote = (count, line) => Number.isInteger(line) && line >= 1 && line <= count;

/**
 * The marks in the model's answer that hold up: a known kind, a line of the note that is not a heading, words, and
 * for a contradiction its other line or the code that contradicts it. `exists(file)` says whether a file it names is in the project; a code
 * place that is not loses its link, not its mark.
 */
export async function parseMarks(answer, text, exists) {
  const lines = noteLines(text);
  const marks = [];
  for (const item of jsonList(answer)) {
    const line = Number(item.line);
    const words = typeof item.text === 'string' ? item.text.trim() : '';
    if (!MARK_KINDS.includes(item.kind) || !inNote(lines.length, line) || !words || lines[line - 1].heading || !lines[line - 1].text.trim()) continue;
    const mark = {kind: item.kind, line, text: words};
    const other = Number(item.other_line);
    if (inNote(lines.length, other) && other !== line) mark.other = other;
    if (typeof item.file === 'string' && Number.isInteger(item.file_line) && (await exists(item.file))) Object.assign(mark, {file: item.file, fileLine: item.file_line});
    if (mark.kind === 'contradiction' && !mark.other && !mark.file) continue; // it names neither side it contradicts
    if (marks.some(old => old.line === line)) continue;
    marks.push(mark);
    if (marks.length === MAX_MARKS) break;
  }
  return marks;
}

/** `text` in at most `max` characters: cut at a word, with an ellipsis, when it is longer. */
const shorten = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…`);

/** The tasks in the model's answer: `{title, lines, open}` with a title of at most 60 characters. */
export function parseTasks(answer) {
  return jsonList(answer)
    .filter(item => typeof item.title === 'string' && item.title.trim())
    .slice(0, MAX_TASKS)
    .map(item => ({
      title: shorten(item.title.trim(), TITLE_CHARS),
      lines: typeof item.lines === 'string' ? item.lines.trim() : '',
      open: item.open === true,
    }));
}
