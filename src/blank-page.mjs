// The blank page (:Pair new): in a folder with nothing to run yet, Pair asks one question at a time, then
// proposes the first slice that runs, as a suggestion in the user's NOTES.md. The questions and the slice are
// the Partner's; how many there are, how short, and what a first slice may hold (two files, no library the user
// did not name, no README) is decided here. Nothing is written to disk: the note changes when the user takes the
// suggestion, and the files come when they write them or hand Pair the wheel for one.
import {readProjectPath} from './files.mjs';

export const QUESTIONS = 3;
const QUESTION_WORDS = 18;
const MAX_FILES = 3; // the rule; the stacks below say two
const ITEM_CHARS = 90; // of one line of the slice
const LINE_CHARS = 80; // of the line that lists what to leave out

// The first slice for the stacks the idea names: a build file with a run target, and one source file.
const STACKS = [
  {name: 'C', test: /(?<![\w#+])C(?![\w#+])|\bc99\b|\bc11\b|\bgcc\b|\bclang\b|\braylib\b/, files: 'Makefile (`make run` builds and runs it) and main.c'},
  {name: 'C3', test: /\bC3\b/i, files: 'Makefile (`make run` calls c3c) and main.c3'},
  {name: 'Odin', test: /\bodin\b/i, files: 'Makefile (`make run` calls odin) and main.odin'},
  {name: 'Zig', test: /\bzig\b/i, files: 'Makefile (`make run` calls zig) and main.zig'},
  {name: 'Go', test: /\bgo(lang)?\b/i, files: 'go.mod and main.go (`go run .`)'},
  {name: 'JavaScript', test: /\b(js|javascript|node(\.js)?|typescript|ts)\b/i, files: 'package.json (a "start" script, no dependencies) and main.js'},
];

/** The stack the user's words name, or null: C3 before C, since "C3" also reads as C. */
export function stackOf(words) {
  const named = STACKS.filter(stack => stack.test.test(words));
  return named.find(stack => stack.name === 'C3') ?? named[0] ?? null;
}

const asked = qa => qa.map(({question, answer}, i) => `Q${i + 1}: ${question}\nA${i + 1}: ${answer}`).join('\n');

/** What the Partner is asked for question `n`: the idea, the answers so far, and the rules for a question. */
export function questionInput({idea, qa, listing}) {
  const n = qa.length + 1;
  return `[new] The user starts something new with :Pair new, in a folder that has: ${listing || 'nothing yet'}.
Their idea: "${idea}"
${qa.length ? `${asked(qa)}\n` : ''}
Ask question ${n} of ${QUESTIONS}: the one question whose answer changes the first runnable version most, and that
the answers so far leave open. Ask about what it should do or show, not about tools or style they already named.
At most ${QUESTION_WORDS} words, one question, no code, no list of options, no tool calls. Answer with the question only.`;
}

/** The Partner's question as one line: without a "Q2:" or quotes of its own; null when it asked none. */
export function cleanQuestion(text) {
  const line = (text ?? '').split('\n').map(part => part.trim()).find(part => part.includes('?'));
  if (!line) return null;
  return line.replace(/^[\s*]*(Q(uestion)?\s*\d+\s*[:.)-])?[\s*]*/i, '').replace(/^["“]|["”]$/g, '').trim();
}

const words = text => text.split(/\s+/).filter(Boolean).length;

/** What is wrong with a question, for the Partner's second try; null when nothing is. */
export function questionProblem(question) {
  if (!question) return 'That was not a question. Ask exactly one question.';
  if (words(question) > QUESTION_WORDS) return `That question has ${words(question)} words; ask it in at most ${QUESTION_WORDS}.`;
  return null;
}

const SHAPE = `{"files": [{"path": "Makefile", "does": "a few words"}], "run": "make run", "shows": "what the user sees when it runs",
 "needs": ["each library or tool beyond the language and its build tool"], "probes": ["a change to try and what to watch"],
 "test": "the first test worth writing, once it runs", "later": ["what to leave out of this slice"]}`;

/** What the Partner is asked once the questions are answered: the first slice, as JSON in the shape above. */
export function sliceInput({idea, qa, listing}) {
  const stack = stackOf([idea, ...qa.map(item => item.answer)].join(' '));
  return `[new] The user's answers are in. Propose the first slice: the thinnest version that runs end to end and shows the
part they want to learn or see, not a skeleton of the whole idea.
Their idea: "${idea}"
${asked(qa)}
The folder has: ${listing || 'nothing yet'}.

Rules:
- Two files: the build or run file, and one source file${stack ? ` (for ${stack.name}: ${stack.files})` : ''}. Never more than ${MAX_FILES}.
- No README, licence, .gitignore, test folder or config files: there is nothing to describe until it runs.
- No library or tool the user did not name; "needs" lists only the ones they named.
- probes: 2 to 4 small changes to make once it runs, each with what to watch.
- test: the first piece with an answer you can write down without running the program, and what to assert.
- later: 2 to 4 things to leave out of this slice, a few words each.
- Every string at most ${ITEM_CHARS} characters, plain words, no code beyond file names and commands.
Answer with the JSON only, no tool calls, in this shape:
${SHAPE}`;
}

/** The slice in the Partner's answer, or null when there is no JSON object in it. */
export function parseSlice(text) {
  const start = text?.indexOf('{') ?? -1;
  const end = text?.lastIndexOf('}') ?? -1;
  if (start < 0 || end < start) return null;
  let raw;
  try { raw = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  const list = value => (Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()) : []);
  const string = value => (typeof value === 'string' ? value.trim() : '');
  return {
    files: (Array.isArray(raw.files) ? raw.files : []).filter(file => typeof file?.path === 'string' && file.path.trim())
      .map(file => ({path: file.path.trim(), does: string(file.does)})),
    run: string(raw.run),
    shows: string(raw.shows),
    needs: list(raw.needs),
    probes: list(raw.probes),
    test: string(raw.test),
    later: list(raw.later),
  };
}

// Files a first slice has no use for: there is nothing to describe, license or ignore until it runs.
const SLOP = /(^|\/)(readme|licen[cs]e|changelog|contributing|\.gitignore|\.editorconfig|dockerfile|\.github|tests?\/|docs?\/)/i;

/** What breaks the rules of a first slice, as sentences for the Partner's second try; [] when nothing does. */
export function sliceProblems(slice, userWords) {
  if (!slice) return ['That was not the JSON asked for.'];
  const problems = [];
  if (!slice.files.length) problems.push('It names no files.');
  if (slice.files.length > MAX_FILES) problems.push(`It has ${slice.files.length} files; a first slice has two, at most ${MAX_FILES}.`);
  for (const file of slice.files.filter(file => SLOP.test(file.path))) problems.push(`${file.path} has no place in a first slice.`);
  const said = userWords.toLowerCase();
  for (const need of slice.needs.filter(need => !said.includes(need.toLowerCase().replace(/\s*\(.*\)$/, '')))) {
    problems.push(`The user did not name ${need}: leave it out.`);
  }
  if (!slice.run) problems.push('It does not say how to run it.');
  if (slice.probes.length < 2) problems.push('It needs 2 to 4 probes.');
  const long = [slice.run, slice.shows, slice.test, ...slice.probes, ...slice.later, ...slice.files.map(file => file.does)].filter(item => item.length > ITEM_CHARS);
  if (long.length) problems.push(`Some lines are longer than ${ITEM_CHARS} characters: ${long.map(item => `"${item.slice(0, 30)}…"`).join(', ')}.`);
  return problems;
}

const NUMBERS = ['No', 'One', 'Two', 'Three', 'Four', 'Five'];
const number = n => NUMBERS[n] ?? String(n);
const plural = (n, noun) => `${noun}${n === 1 ? '' : 's'}`;

/** The slice as the Markdown it adds to the note. */
export function sliceText(slice) {
  const lines = ['## First run'];
  for (const file of slice.files) lines.push(`- \`${file.path}\`${file.does ? `: ${file.does}` : ''}`);
  lines.push(`- run: \`${slice.run}\``);
  if (slice.shows) lines.push(`- shows: ${slice.shows}`);
  lines.push('', '## Then poke at it', ...slice.probes.map(probe => `- ${probe}`));
  if (slice.test) lines.push('', '## A test, once it exists', `- ${slice.test}`);
  // What to leave out reads as one line while it fits a window; the suggestion's lines do not wrap.
  const later = slice.later.join(' · ');
  if (slice.later.length) lines.push('', '## Not yet', ...(later.length <= LINE_CHARS ? [`- ${later}`] : slice.later.map(item => `- ${item}`)));
  return lines.join('\n');
}

/** The words under the slice: how many answers it comes from and how many files it has. */
export function sliceNote(answers, files) {
  const from = answers ? `Your ${number(answers).toLowerCase()} ${plural(answers, 'answer')} as a first slice.` : 'A first slice.';
  return `${from} ${number(files)} ${plural(files, 'file')}, nothing written yet.`;
}

/** The text of a buffer up to its last line with text: where the slice goes, after one blank line. */
const lastTextLine = text => text.replace(/\s+$/, '').split('\n').length;

/**
 * One :Pair new in `session` (a PairSession): its questions, the user's answers and the slice. The questions show
 * under the last line of `file`, the note (an absolute path inside the project); each answer is what the user
 * typed under the question.
 */
export class BlankPage {
  constructor({session, file}) {
    Object.assign(this, {session, file});
    this.idea = '';
    this.qa = []; // {question, answer}
    this.question = null; // the question waiting for its answer
    this.open = true; // until the slice is shown: no remarks nobody asked for meanwhile
    this.consulting = false; // a turn of the Partner for a question or the slice is running
  }

  async start(idea) {
    this.idea = idea.trim();
    if (!this.idea) return this.ask('What are we making?', 0); // the idea itself, from the user, before any model
    this.session.setGoal(this.idea);
    await this.next();
  }

  /** The user's answer to the waiting question. */
  async answer(text) {
    const answer = text.replace(/^\s*[-*]\s+/gm, '').replace(/\s+/g, ' ').trim();
    if (!answer || !this.question || !this.open) return;
    this.session.message('user', answer);
    if (!this.idea) {
      this.idea = answer;
      this.session.setGoal(answer);
    } else {
      this.qa.push({question: this.question, answer});
    }
    this.question = null;
    await this.next();
  }

  async next() {
    const listing = await this.listing();
    if (this.qa.length >= QUESTIONS) return this.slice(listing);
    const question = await this.consult(questionInput({idea: this.idea, qa: this.qa, listing}), cleanQuestion, questionProblem);
    if (question) return this.ask(question, this.qa.length + 1);
    this.close();
    this.session.message('system', 'Pair asked no question it could use, so the questions stop here. :Pair new starts again.');
  }

  ask(question, n) {
    this.question = question;
    this.session.message('pair', question);
    this.session.notify('editor', {type: 'interview', file: this.file, n, text: question});
  }

  async slice(listing) {
    const said = [this.idea, ...this.qa.map(item => item.answer)].join(' ');
    const slice = await this.consult(sliceInput({idea: this.idea, qa: this.qa, listing}), parseSlice, found => sliceProblems(found, said).join(' ') || null);
    this.close();
    if (!slice) return this.session.message('system', 'Pair could not put a first slice together. :Pair new starts again.');
    const problems = sliceProblems(slice, said);
    if (problems.length) return this.session.message('system', `Pair's first slice broke its own rules, so it is not shown: ${problems.join(' ')}`);
    const text = sliceText(slice);
    const line = lastTextLine(await this.session.bufferText(this.file, ''));
    this.session.message('pair', text);
    this.session.notify('editor', {
      type: 'suggest', file: this.file, line, endLine: line, insert: true, text: `\n${text}`,
      note: sliceNote(this.qa.length, slice.files.length), keyNote: 'takes it into the note', remark: null,
    });
  }

  close() {
    this.open = false;
    this.question = null;
    this.session.notify('editor', {type: 'interview', file: this.file, done: true});
  }

  /**
   * One Partner turn in the session's conversation: `parse` takes what it wants from the answer, and when `problem`
   * finds one the Partner gets one more try with it. Null when the Partner could not answer.
   */
  async consult(input, parse, problem) {
    const first = await this.turn(input);
    if (first === null) return null;
    const wrong = problem(parse(first));
    if (!wrong) return parse(first);
    const second = await this.turn(`${wrong} Answer again, as asked.`);
    return second === null ? null : parse(second);
  }

  /**
   * Asks the Partner and resolves with its answer, null when it failed. Not shown by itself; the statusline says
   * that it thinks meanwhile, as for any turn.
   */
  async turn(input) {
    const {session} = this;
    session.busy = true;
    this.consulting = true;
    session.words = [];
    session.thinks = session.partner.thinkingOf(session.conversationId) !== 'off';
    session.showThinking(true);
    try {
      // A model that said its answer with the say tool has it in the session's words, not in the chat yet.
      return (await session.partner.ask(session.conversationId, input)) || session.words.join('\n');
    } catch (error) {
      session.message('system', `Pair could not answer: ${error.message}`);
      return null;
    } finally {
      session.busy = false;
      this.consulting = false;
      session.showThinking(false);
      session.thinks = false;
    }
  }

  /** The folder's entries, for the Partner: so it does not propose a file that is already there. */
  async listing() {
    const {listing} = await readProjectPath(this.session.root, '.');
    return (listing ?? '').split('\n').filter(Boolean).join(', ');
  }
}
