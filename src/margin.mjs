// Notes in the margin: while you write a Markdown note, Pair puts at most five marks in its margin. Rules mark a
// paragraph that repeats an earlier one and a decision not logged yet, at each pause in your typing. When you stop
// for longer, the model reads the note and the code it names: a question the note leaves open, two lines that
// cannot both hold, what the code really does, a decision worth logging. A mark goes when you change its line.
// The decide key logs a decision in decisions.md next to the note, and :Pair tasks lists the note's work as tasks,
// which go anywhere only after your yes. Pair writes no file: the editor puts the log in a buffer you save.
import {execFile} from 'node:child_process';
import {dirname, join, relative} from 'node:path';
import {promisify} from 'node:util';
import {LOG_NAME, logDecision, logged} from './decision-log.mjs';
import {projectFile} from './files.mjs';
import {codeFor, MARKS_PROMPT, MAX_MARKS, noteInput, parseMarks, parseTasks, TASKS_PROMPT} from './note-reading.mjs';
import {decisionOf, decisions, ideaWords, isNote, noteLines, noteTitle, overlap, repeats} from './note-rules.mjs';

const run = promisify(execFile);

export const READ_PAUSE_MS = 10_000; // you stopped writing: the model reads the note
const NEAR = 20; // a mark whose line moved this far or less still finds it
const TASK_TIMEOUT_MS = 30_000;

/** The 1-based line of `text` that is `wanted`, nearest to `line`; null when it is gone. */
function find(lines, wanted, line) {
  for (let d = 0; d <= NEAR; d++) {
    for (const at of [line - d, line + d]) if (lines[at - 1] === wanted) return at;
  }
  return null;
}

const day = at => {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

/** The task command's words with a task's title and description in place of {title} and {description}. */
export const taskArgs = (command, task, description) => command.map(word => word.replaceAll('{title}', task.title).replaceAll('{description}', description));

export class NoteMargin {
  /**
   * `state()` is the session's state, and `receive(event)` folds an event into it. `read(path)` is a file's text
   * as the editor has it ('' when there is none), `ask(system, input, {asked})` the model's answer (`asked`: the
   * user asked for it), `notify` and `message` as for a PairSession. `ready()` says whether the model may read a
   * note now. `taskCommand` is the command line, as words, that :Pair tasks runs for each task the user says yes
   * to; without it, the editor copies them.
   */
  constructor({root, state, receive, read, ask, notify, message, typingPauseMs, ready = () => true, taskCommand = null, log = () => {}, now = Date.now}) {
    Object.assign(this, {root, state, receive, read, ask, notify, message, typingPauseMs, ready, taskCommand, log, now});
    this.notes = new Map(); // note (relative path) -> {ruledAt, text, readText, model}: model marks with the line texts they sit on
    this.working = false;
  }

  note(file) {
    if (!this.notes.has(file)) this.notes.set(file, {ruledAt: 0, text: null, readText: null, model: []});
    return this.notes.get(file);
  }

  /** At each pause after an edit in a note, its rule marks; after a longer one, the model's. Ticks never overlap. */
  async tick() {
    const state = this.state();
    const edit = state.edits.at(-1);
    if (this.working || !edit || !isNote(edit.file) || edit.file.split('/').at(-1) === LOG_NAME) return;
    const idle = this.now() - state.lastKeyAt;
    if (idle < this.typingPauseMs) return;
    const note = this.note(edit.file);
    this.working = true;
    try {
      if (edit.at > note.ruledAt) {
        note.ruledAt = edit.at;
        await this.refresh(edit.file);
      }
      if (idle >= READ_PAUSE_MS && note.text !== note.readText && this.ready()) await this.readNote(edit.file);
    } finally {
      this.working = false;
    }
  }

  /** The model reads the note and the code it names; its marks join the rules'. */
  async readNote(file) {
    const note = this.note(file);
    const text = note.readText = note.text;
    try {
      const code = await codeFor(this.root, text);
      const answer = await this.ask(MARKS_PROMPT, noteInput(file, text, code, this.state().goal), {asked: false});
      const lines = text.split('\n');
      const marks = await parseMarks(answer, text, async path => Boolean(await projectFile(this.root, path)));
      note.model = marks.map(mark => ({...mark, lineText: lines[mark.line - 1], otherText: mark.other && lines[mark.other - 1]}));
      this.log(`margin: the model marked ${marks.length} lines of ${file}`);
    } catch (error) {
      // Cancelled for the user's question, or the model is down (then the health check holds the next reading back
      // until it answers): read it again later.
      note.readText = null;
      this.log(`margin: reading ${file} failed: ${error.message}`);
      return;
    }
    await this.refresh(file);
  }

  /**
   * Sends the note's marks to the editors: the rules', and the model's that still sit on the lines they were made
   * for. A model mark whose line, or other line, the user changed is gone.
   */
  async refresh(file) {
    const note = this.note(file);
    const path = join(this.root, file);
    const text = note.text = await this.read(path);
    this.receive({kind: 'note', file, title: noteTitle(text, file)});
    const lines = text.split('\n');
    note.model = note.model.flatMap(mark => {
      const line = find(lines, mark.lineText, mark.line);
      const other = mark.other && find(lines, mark.otherText, mark.other);
      if (!line || (mark.other && !other)) return [];
      return [{...mark, line, ...(mark.other ? {other} : {})}];
    });
    const log = await this.read(join(dirname(path), LOG_NAME));
    const decided = decisions(text)
      .filter(decision => !logged(log, file, decision.text))
      .map(decision => ({kind: 'decision', line: decision.line, text: 'A decision for the log.', rule: true}));
    const repeated = repeats(text).map(repeat => ({kind: 'repeat', ...repeat}));
    const marks = [];
    for (const mark of [...repeated, ...decided, ...note.model]) {
      if (marks.length < MAX_MARKS && !marks.some(old => old.line === mark.line)) marks.push(mark);
    }
    marks.sort((a, b) => a.line - b.line);
    this.notify('editors', {
      type: 'margin',
      file: path,
      marks: marks.map(mark => ({
        kind: mark.kind, line: mark.line, text: mark.text, lineText: lines[mark.line - 1],
        ...(mark.other ? {other: mark.other, otherText: lines[mark.other - 1]} : {}),
        ...(mark.file ? {link: {file: join(this.root, mark.file), line: mark.fileLine, name: mark.file}} : {}),
      })),
    });
  }

  /**
   * Logs the decision on `line` of the note at `path` (the editor's decide key): a line that starts with
   * "Decision:", or one the model marked as a decision. The entry quotes the question in its section it answers
   * best, and that question's mark goes. The editor gets the log's next text.
   */
  async decide(path, line) {
    const file = relative(this.root, path);
    const text = await this.read(path);
    const at = noteLines(text)[line - 1];
    const note = this.note(file);
    const marked = note.model.find(mark => mark.kind === 'decision' && mark.line === line);
    const decision = at && (decisionOf(at.text) ?? (marked ? at.text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim() : null));
    if (!decision) return this.message('system', `${file}:${line} is no decision: start the line with "Decision:".`);
    const asked = this.question(note, text, line, decision);
    const logPath = join(dirname(path), LOG_NAME);
    const result = logDecision(await this.read(logPath), {date: day(this.now()), text: decision, file, line, section: at.section, asked: asked?.text});
    const name = relative(this.root, logPath);
    if (!result) return this.message('system', `That decision is in ${name} already.`);
    note.model = note.model.filter(mark => mark !== asked && mark !== marked);
    this.notify('editor', {type: 'decision_log', file: logPath, text: result.text, line: result.line, name});
    const superseded = result.superseded.length ? ` It supersedes: ${result.superseded.join('; ')}.` : '';
    this.message('system', `Logged in ${name}: ${decision.replace(/\.$/, '')}.${superseded} Save it to keep it.`);
    await this.refresh(file);
  }

  /**
   * The model's question or contradiction in the section of `line` that `decision` answers: the one that shares
   * most words with it, else the nearest above it. Null when its section has none.
   */
  question(note, text, line, decision) {
    const lines = noteLines(text);
    const section = lines[line - 1].section;
    const open = note.model.filter(mark => ['question', 'contradiction'].includes(mark.kind) && lines[mark.line - 1]?.section === section);
    const words = ideaWords(decision);
    const closest = [...open].sort((a, b) => overlap(ideaWords(b.text), words) - overlap(ideaWords(a.text), words))[0];
    if (closest && overlap(ideaWords(closest.text), words) > 0) return closest;
    return open.filter(mark => mark.line < line).at(-1) ?? null;
  }

  /** :Pair tasks: the model lists the note's work as tasks; the editor shows them, and nothing is added yet. */
  async tasks(path) {
    const file = relative(this.root, path);
    const text = await this.read(path);
    if (!text.trim()) return this.message('system', `${file} is empty: there is nothing to make tasks of.`);
    const tasks = parseTasks(await this.ask(TASKS_PROMPT, noteInput(file, text, [], this.state().goal), {asked: true}));
    if (!tasks.length) return this.message('system', `No tasks in ${file}.`);
    const adds = this.taskCommand ? this.taskCommand.slice(0, 2).join(' ') : null;
    this.notify('editor', {type: 'tasks', file: path, name: file, tasks, adds});
  }

  /** The user's yes: runs the task command once for each task, in the project. */
  async addTasks(path, tasks) {
    if (!this.taskCommand) return;
    const file = relative(this.root, path);
    const added = [];
    for (const task of tasks) {
      const [command, ...args] = taskArgs(this.taskCommand, task, `From ${file}${task.lines ? `, ${task.lines}` : ''}.`);
      try {
        await run(command, args, {cwd: this.root, timeout: TASK_TIMEOUT_MS});
        added.push(task.title);
      } catch (error) {
        const why = (error.stderr || error.message).trim().split('\n')[0];
        this.message('system', `\`${command}\` could not add "${task.title}": ${why}`);
        break;
      }
    }
    if (added.length) this.message('system', `Added ${added.length} task${added.length === 1 ? '' : 's'} from ${file}:\n${added.map(title => `- ${title}`).join('\n')}`);
  }
}
