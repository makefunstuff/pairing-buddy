// /gen: the user asks Pair for code. Each request has a number (gen #3), a shape, a conversation of its own on the
// Partner's model with the gen tool set (see tools.mjs), its pieces and its limits. A request never edits the user's
// text: it proposes, and the user takes a proposal into their buffer, unsaved, with one key. Code taken from a request
// is Pair's (origin gen:#n, see fold.mjs) until the user edits it, and marked ┊ in Neovim, part by part, until they
// edit a part or own it (see owning.mjs). The ledger books a request as one line with its
// pieces, and /undo takes back all of it: what was taken goes, what was not is dropped.
//
// Every request runs against the brief (see brief.mjs): the goal, the board task and a note, NOTES.md by default.
// When the request contradicts it, Pair asks one question before generating; after, the debrief says where the code
// goes against the brief (≠ brief) and what it decided that nobody said (? guessed).
//
// One request runs at a time; others wait their turn. While one runs, Pair makes no remark nobody asked for, and the
// user's questions in the chat still get answers, in the session's own conversation. There are four shapes: here
// (code at the cursor, or over the selection), file (new files, as pair://gen/<n>/<path> buffers in Neovim that :w in
// one writes to its real path), try (a sample in a folder of its own outside the project, which the model writes and
// runs there in the sandbox, and which opens in a split; /keep moves a file of it into the project as a buffer to
// review, as a file request's) and scaffold (many files and their wiring, built and run in a copy of the project in
// Pair's data folder, or with --branch in a git worktree; the user keeps a file at a time: a new file as a buffer to
// review, a change to a file of theirs as suggestions in it, and deletes the copy with one key). Scaffold is never
// guessed silently: a guess is always confirmed. The ledger keeps each proposed file's text, so Neovim gets its
// buffers again after a restart of either.
import {realpathSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {mkdir, readdir, readFile, realpath, stat, utimes, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, normalize, relative, sep} from 'node:path';
import {promisify} from 'node:util';
import {
  briefEmpty, briefLine, briefText, CHECK_PROMPT, checkInput, CONFLICT_PROMPT, conflictInput, exceptionKey, parseCheck,
  handoffBrief, parseConflict, quotePlace, readBrief,
} from './brief.mjs';
import {Board, boardTitle, commandLine} from './board.mjs';
import {checkCommand} from './check.mjs';
import {commandPolicy} from './command-policy.mjs';
import {GEN_BRIEF, GEN_KEEP_TRIES, GEN_LIMITS, GEN_SCAFFOLD} from './config.mjs';
import {logDecision, LOG_NAME} from './decision-log.mjs';
import {draftPath, numberedLines, projectFile} from './files.mjs';
import {
  changedIn, daysLeft, expireTries, filesIn, freshFolder, linesOf, makeCopy, makeWorktree, noLinks, pathIn, placeHunks, projectFolder,
  removeCopy, removeWorktree, scaffoldFolder, sizeOf, textOf, tryFolder, tryLine, triesIn, trySandboxed,
} from './gen-tree.mjs';
import {gitFiles} from './git.mjs';
import {DETAIL_KEPT_MS, keptOutput, notYoursLine, startOfDay} from './ledger.mjs';
import {markId, parseMarkId, takenMarks, tally, writtenMarks} from './owning.mjs';
import {runText} from './session.mjs';
import {parseTestOutput} from './test-output.mjs';
import {runLabel} from './test-runs.mjs';

export const SHAPES = ['here', 'file', 'scaffold', 'try', 'board'];
const BUILT = new Set(SHAPES);
/** What each shape makes, as the shape question lists it. */
export const SHAPE_WHAT = {
  here: 'at the cursor, over a selection',
  file: 'new files to review',
  scaffold: 'many files, in Pair\'s copy',
  try: 'a sample outside the project',
  board: 'a task for the board, for later',
};

// The keys of a hand-off's picks (see board.mjs PICKS); c copies the command and adds nothing.
const PICK_KEYS = {y: 'add', d: 'delegate', p: 'plan', r: 'research'};
/** What each answer to a hand-off does, as Neovim's dialog lists them. */
const PICK_WHAT = {
  y: 'add only: its agent reads the brief and waits for your go',
  d: 'add and delegate: its agent starts now',
  p: 'add, delegate, plan first: its agent writes a plan and waits',
  r: 'add, delegate, research only: a report, no code',
  c: 'copy the command, add nothing',
};
const NAMED_FILES = 20; // a board task's brief names at most this many files
const QUESTIONS = 2; // the model may ask the user this many questions per request
const AROUND = 30; // the request's input shows this many lines above and below the cursor
const SELECTED = 80; // and of a selection, at most this many
const NOTE = /\.(md|markdown|txt)$/i;
const SILENT = /^\W*silent\W*$/i;
const REVIEW_DAYS = 7; // a file proposed and neither taken nor dropped is offered again for this long
const DAY = 24 * 60 * 60 * 1000;
const LISTED = 200; // a file request is told the names of this many of the project's files
const TRY_LISTED = 60; // and a try request, of this many
const RUN_CHARS = 3000; // of a try's run, the model is told the last this many characters of its output
const RAN_LINES = 3; // and the chat shows its last this many lines, when the user runs it again
const SCAFFOLD_LISTED = 300; // a scaffold request is told the names of this many of the project's files
const CARD_FILES = 8; // the chat's line about a scaffold names this many of its files
const KEEP_LISTED = 200; // and its card, for /keep's menu, this many of those still to keep
const CHECKED_LINES = 300; // the brief's check after a scaffold reads this many lines of each file
const FLAG = /^--(branch|copy)(?=\s|$)\s*/; // /gen scaffold --branch: in a git worktree; --copy: in Pair's copy
// What installs a package: in a copy without the network it is listed for the user, not run.
const INSTALL = /(^|[\s;&|(])(npm (i|install|add|ci)|pnpm (i|install|add)|yarn( add| install|\s*$)|bun (i|install|add)|pip3? install|uv (add|pip install|sync)|poetry (add|install)|go (get|mod download)|cargo (add|install|fetch)|gem install|bundle( install)?\s*$|composer (require|install))\b/;

/** Of a try's files, the one that opens: the longest, the sample itself rather than its go.mod or package.json. */
const mainFile = files => files.reduce((best, piece) => (!best || lineCount(piece.text) > lineCount(best.text) ? piece : best), null);

/** `/gen [shape] words`: the shape when its first word names one, and the words. */
export function parseGen(text) {
  const [first, ...rest] = text.trim().split(/\s+/);
  if (SHAPES.includes(first?.toLowerCase())) return {shape: first.toLowerCase(), words: rest.join(' ')};
  return {shape: null, words: text.trim()};
}

// The cheap rule that guesses a shape from the request's words; the model never picks it. Scaffold, the costly
// shape, is only ever a guess the user confirms.
const RULES = [
  ['here', /\b(here|at the cursor|below this|above this|this (function|method|block|line|class))\b/i, 'at the cursor'],
  ['scaffold', /\b(scaffold|wired? (it )?(up|in|into)|end to end|the whole|several files|an? (new )?(app|service|project|admin page))\b/i, 'many files and wiring'],
  ['try', /\b(sample|example|demo|playground|show me how|to try|try out)\b/i, 'a sample to run'],
  ['file', /\b[\w./-]+\.(js|mjs|cjs|ts|tsx|jsx|go|py|rs|sql|json|ya?ml|toml|lua|sh|c|h|cc|cpp|rb|java|kt|swift|css|html)\b/i, 'a new file'],
  ['file', /\b(migrations?|test files?|config files?|new files?|a module)\b/i, 'new files'],
];

/**
 * The shape of a request the user did not name one for, with why, by rule: a selection in code means here; then the
 * words. A request with no clue is here, at the cursor. `note`: the request comes from a note, whose selection is the
 * request itself, not a place.
 */
export function guessShape(words, {selection = false, note = false} = {}) {
  if (selection && !note) return {shape: 'here', why: 'over the selection'};
  for (const [shape, pattern, why] of RULES) {
    const found = pattern.exec(words);
    if (found) return {shape, why: shape === 'here' ? why : `${why}: "${found[0]}"`};
  }
  return {shape: 'here', why: 'at the cursor'};
}

const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const day = at => {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const lineCount = text => (text === '' ? 0 : text.replace(/\n$/, '').split('\n').length);

/** The text of a finished turn's answer without SILENT, or ''. */
const answerOf = text => (text && !SILENT.test(text) ? text.trim() : '');
const ranMark = ran => (ran.exit === 0 && !ran.timedOut ? '✓' : '✗');
const ranText = ran => `${ranMark(ran)} \`${ran.command}\`${ran.timedOut ? ' (stopped: it ran too long)' : ran.exit ? ` exit ${ran.exit}` : ''}`;
const tail = (text, chars) => (text.length > chars ? `…${text.slice(-chars)}` : text);

export class Gen {
  /**
   * The requests of `session` (a PairSession); `limits` are the config's gen.limits, read when a request starts, and
   * `brief` its gen.brief, the note a brief has when the user pinned none. `ask(systemPrompt, content)` is one answer
   * of the Partner's model outside any conversation, for the brief's checks; without it, they are not made. `dir` is
   * /gen's folder in Pair's data folder (gen-tree.mjs), where the tries and the scaffold copies go: `keepTries` days,
   * run in the sandbox as `sandbox` (scoutPane.sandbox) says, with the network only when `network`. `scaffold` is
   * where a scaffold goes without --branch or --copy: 'tree' (Pair's copy) or 'worktree'. `board` is the board's
   * command (the config's board), which /gen board composes a task for; null for none.
   */
  constructor({session, limits = GEN_LIMITS, brief = GEN_BRIEF, ask = null, dir, keepTries = GEN_KEEP_TRIES, network = false, sandbox = 'auto', scaffold = GEN_SCAFFOLD, board = null}) {
    this.session = session;
    this.limits = limits;
    this.briefName = brief;
    this.askModel = ask;
    // Its real path, so the names of a try's files, which pathIn gives as real paths, are relative to their folder.
    this.dir = (() => { try { return realpathSync(dir); } catch { return dir; } })();
    this.folder = projectFolder(this.dir, session.root); // this project's
    Object.assign(this, {keepTries, network, sandbox, scaffold, board});
    const pinned = session.record.brief ?? session.store.lastBrief?.(session.root) ?? null;
    this.pin = pinned === '' ? false : pinned; // the note the user pinned, false for none, null for gen.brief's
    this.toldBrief = false; // the chat said once that a request runs against gen.brief's note
    this.exceptions = new Set(); // the brief's lines the user chose a request over (y): not asked about again
    this.stale();
    this.requests = new Map(); // n -> request, since the daemon loaded the session
    this.conversations = new Map(); // conversation id -> its request
    this.running = null; // the request whose model is at work
    this.queue = []; // requests waiting for it
    this.due = []; // pieces ready, waiting for the user's next pause in typing
    this.asked = 0; // questions asked, for their ids
    this.last = null; // the highest request number so far, read from the ledger once
  }

  get root() { return this.session.root; }

  /** Today's requests a daemon restart stopped mid-way say so in the ledger, not that they still generate. */
  stale() {
    const {store} = this.session;
    for (const action of store.actions?.(this.root, startOfDay(this.session.now())) ?? []) {
      if (action.kind === 'generated' && action.data?.asAsked?.key && action.at >= (this.session.record.started_at ?? 0)) this.exceptions.add(action.data.asAsked.key);
      if (action.kind !== 'generated' || !/generating$/.test(action.data?.note ?? '')) continue;
      store.updateAction(action.id, {data: {...action.data, note: 'stopped: the daemon restarted'}});
    }
  }

  /** Whether `conversationId` is a request's. */
  owns(conversationId) {
    return this.conversations.has(conversationId);
  }

  /** The next number: one past the highest this project's ledger or this daemon has given. */
  next() {
    this.last ??= Math.max(0, ...this.session.store.actions(this.root, 0).filter(action => action.kind === 'generated').map(action => action.data?.gen ?? 0));
    return ++this.last;
  }

  /** What the editors show of `request` in the statusline: its number, state and when that started. */
  status(request) {
    this.session.notify('editors', {type: 'gen', gen: request.n, state: request.state, since: request.since ?? this.session.now(), token: request.token ?? null, shape: request.shape});
    this.sendCard(request.action, request);
  }

  setState(request, state) {
    request.state = state;
    request.since = this.session.now();
    this.status(request);
  }

  /**
   * A new request: `text` is `[shape] words`, or the words with `shape` apart (Neovim's dialog). From Neovim it
   * comes with the `place` of the cursor ({file, line}) or the `selection` ({file, from, to}) and the `token` of the mark
   * there; from the chat, with `here` when it should take the selection. `from` is where it was asked ('editor' or
   * 'chat'): its questions go there. Resolves once it is done, cancelled or waiting.
   */
  async request({text = '', shape = null, here = false, selection = null, place = null, token = null, from = 'chat'} = {}) {
    const session = this.session;
    const parsed = parseGen(text);
    let named = SHAPES.includes(shape) ? shape : parsed.shape;
    // --branch and --copy say where a scaffold goes, so they make one.
    const flag = !named || named === 'scaffold' ? FLAG.exec(parsed.words)?.[1] ?? null : null;
    const words = flag ? parsed.words.replace(FLAG, '') : parsed.words;
    if (flag) named = 'scaffold';
    session.message('user', `/gen ${[named, flag && `--${flag}`, words].filter(Boolean).join(' ')}`);
    session.usedAt = session.now();
    session.worked = true;
    if (!words) return session.message('system', 'Say what Pair should write: /gen here a function that …');
    const request = {
      n: this.next(), words, shape: named, given: Boolean(named), flag, here, selection, place, token, from,
      state: 'asking', since: session.now(), pieces: [], said: [], questions: 0, commands: 0, lines: 0, files: new Set(),
      limits: {...this.limits}, action: null, conversation: null, question: null,
    };
    this.requests.set(request.n, request);
    this.status(request);
    if (!request.shape) {
      const guess = guessShape(words, {selection: Boolean(selection) || here, note: NOTE.test(place?.file ?? '')});
      const shape = await this.question(request, {kind: 'shape', title: `gen #${request.n} · ${guess.why}. Shape?`, guess: guess.shape});
      if (request.state === 'cancelled') return;
      if (!shape) return this.end(request, 'cancelled', `gen #${request.n} cancelled.`);
      request.shape = shape;
    }
    if (request.shape === 'board') return this.toBoard(request);
    if (request.shape === 'here' && !(await this.placeOf(request))) return;
    if (!(await this.against(request))) return;
    if (this.running) {
      this.queue.push(request);
      this.setState(request, 'queued');
      return session.message('system', `gen #${request.n} waits for gen #${this.running.n}.`);
    }
    return this.run(request);
  }

  /**
   * /gen board: the request as a task for the board (Shepherdr), its brief built from the brief it runs against (see
   * handoffBrief), for you to read and edit (in Neovim, the pair://board/new buffer) before anything is added. `/gen
   * board #9` hands on request #9, too big for gen's limits, with what its check found. Then one pick: y adds it for
   * later (add only: its agent reads the brief and waits for your go), d adds and delegates (its agent starts now),
   * p delegates with a plan first, r delegates for research only, c copies the command, n or Esc adds nothing.
   * Nothing is added without a pick, and nothing is ever merged, stopped or set from here.
   */
  async toBoard(request) {
    const session = this.session;
    const n = `gen #${request.n}`;
    if (!this.board) return this.end(request, 'cancelled', `${n}: there is no board to add it to ("board": null in the config).`);
    const handed = /^#?(\d+)$/.exec(request.words)?.[1];
    const source = handed ? this.requests.get(Number(handed)) : null;
    if (handed && !source) return this.end(request, 'cancelled', `${n}: there is no gen #${handed} since the daemon started, to hand to the board.`);
    const words = source?.words ?? request.words;
    const brief = await this.brief();
    request.brief = brief;
    const uncommitted = brief.note ? await this.uncommitted(brief.note) : false;
    const task = {
      title: boardTitle(words),
      brief: handoffBrief({
        words, brief, uncommitted, files: await this.namedFiles(words, source), test: session.testRuns?.command ?? null,
        found: source?.debrief?.filter(line => line.startsWith('≠')) ?? [], guessed: source?.check?.guessed ?? [], from: source ? `gen #${source.n}` : null,
      }),
    };
    const board = new Board(this.board);
    const space = session.state.board?.space ?? null;
    const line = edit => commandLine(board.handoffWords({...edit, space, pick: 'add'}));
    const warning = uncommitted ? `${brief.note.file} has changes that are not committed: the task's agent works in a git worktree and would not see them, so they are copied into its brief.` : null;
    if (warning) session.message('system', `${n}: ${warning}`);
    const choice = await this.question(request, {kind: 'board', title: `${n} · a task for the board: "${task.title}"`, command: line(task), task, warning});
    if (request.state === 'cancelled') return;
    const edit = request.edited;
    if (edit && (!boardTitle(edit.title) || !edit.brief.trim())) return this.end(request, 'cancelled', `${n} cancelled: the task you wrote has no ${boardTitle(edit.title) ? 'brief' : 'title'}, so nothing was added.`);
    const final = edit ? {title: boardTitle(edit.title), brief: edit.brief.trim()} : task;
    if (choice === 'c') {
      const text = line(final);
      if (request.from === 'editor') session.notify('editor', {type: 'gen_copy', gen: request.n, text});
      return this.end(request, 'done', `${n}: nothing added. The command, to run yourself: ${text}`);
    }
    const pick = PICK_KEYS[choice];
    if (!pick) return this.end(request, 'cancelled', `${n} cancelled: nothing added to the board.`);
    try {
      const {id, said} = await board.add(board.handoffWords({...final, space, pick}), {cwd: this.root});
      if (!id) return this.end(request, 'done', `${n}: the board answered: ${said}`); // added, as far as it says
      session.ledger.add('board', `${n} → board ${id}: ${final.title}`, {data: {gen: request.n, task: id, pick, later: pick === 'add', ...(source ? {from: source.n} : {})}});
      const how = pick === 'add' ? `added, for later: its agent reads the brief and waits for your go (${commandLine(board.tellWords(id, 'go'))})`
        : pick === 'delegate' ? 'added and delegated: its agent starts on the brief now'
          : pick === 'plan' ? 'added and delegated, plan first: its agent writes its plan and waits for your go'
            : 'added and delegated, research only: a report, no code';
      return this.end(request, 'done', `${n}${source ? ` (gen #${source.n})` : ''} → board ${id} · ${how}.`);
    } catch (error) {
      return this.end(request, 'failed', `${n}: the board did not add it: ${error.message.split('\n')[0]}`);
    }
  }

  /**
   * Whether the brief's `note` has changes that are not committed (in the editor, on disk or not in git at all): a
   * board task's agent works in a git worktree, which has only the committed note.
   */
  async uncommitted(note) {
    const rel = relative(this.root, note.path).split(sep).join('/');
    const committed = await promisify(execFile)('git', ['show', `HEAD:./${rel}`], {cwd: this.root, maxBuffer: 64 << 20}).then(result => result.stdout, () => null);
    return committed === null || committed.replace(/\n$/, '') !== note.lines.join('\n');
  }

  /** The project's files a request names in its `words`, and those that `source` (the request it hands on) proposed. */
  async namedFiles(words, source) {
    const named = [];
    for (const word of words.match(/[\w.-]*[\w-]\/[\w./-]*\w|[\w-]+\.[a-z]\w*/gi) ?? []) {
      const path = await projectFile(this.root, word).catch(() => null);
      if (path) named.push(relative(this.root, path));
    }
    for (const piece of source?.pieces ?? []) {
      if (piece.kind !== 'try' && piece.file) named.push(relative(this.root, piece.file));
    }
    return [...new Set(named)].slice(0, NAMED_FILES);
  }

  /**
   * A request that ran into gen.limits (its files, lines or minutes) is bigger than /gen takes: the chat, and Neovim
   * when it was asked there, offer it to the board. Only offered: nothing is added until the user asks.
   */
  offerBoard(request) {
    if (!this.board || !(request.pastLimit || request.over) || ['cancelled', 'undone'].includes(request.state)) return;
    const why = request.over ?? `it went past ${request.pastLimit}`;
    this.session.message('system', `gen #${request.n} is bigger than gen's limits (${why}). /gen board #${request.n} hands it to the board, with its brief and what it found.`);
    if (request.from === 'editor') this.session.notify('editor', {type: 'gen_debrief', gen: request.n, lines: [`bigger than gen's limits (${why}): :Pair gen board #${request.n} hands it to the board`]});
  }

  /** A tool's refusal at gen.limits.`limit`: the request is bigger than /gen takes, and is offered to the board when it ends. */
  past(request, limit, text) {
    request.pastLimit ??= `gen.limits.${limit}`;
    return text;
  }

  /**
   * Where a here request's code goes: the place it came with, else the Neovim's cursor or (`here`) selection, which
   * marks it. False, with why in the chat, when there is no place in the project.
   */
  async placeOf(request) {
    const session = this.session;
    if (!request.place && !request.selection) {
      const reply = await session.requestEditor({type: 'gen_place', gen: request.n, selection: request.here}).catch(() => null);
      if (reply?.from && reply.to && request.here) request.selection = {file: reply.file, from: reply.from, to: reply.to};
      else if (reply?.line) request.place = {file: reply.file, line: reply.line};
    }
    const where = request.selection ?? request.place;
    const path = where?.file && (await projectFile(this.root, where.file));
    if (!path) {
      const why = where?.file ? `${where.file} is not a file of the project` : 'it needs a Neovim with a file of the project open (:Pair start there)';
      this.end(request, 'cancelled', `gen #${request.n}: /gen here puts code at your cursor, and ${why}.`);
      return false;
    }
    request.file = path;
    return true;
  }

  /** The brief as it is now: the pinned note or gen.brief's, the goal and the board task. */
  brief() {
    const {session} = this;
    return readBrief({root: this.root, pin: this.pin, fallback: this.briefName, goal: session.state.goal, task: session.state.board?.task, read: path => session.bufferText(path)});
  }

  /**
   * /brief and :Pair brief: pins the note `file`, leaves the note out (`off`), or with neither shows what the brief is.
   * The pin lasts into the next sessions of the project, until the user changes it.
   */
  async pinBrief({file = null, off = false} = {}) {
    const text = await this.briefSaid({file, off});
    this.session.message('system', text);
    return text;
  }

  /** What /brief says: what it pinned, or what the brief is. */
  async briefSaid({file, off}) {
    if (off || file) {
      const path = off ? null : await projectFile(this.root, file).catch(() => null);
      if (!off && !path) return `No file ${file} in the project to pin as the brief.`;
      this.pin = off ? false : relative(this.root, path);
      this.session.store.setBrief?.(this.session.id, off ? '' : this.pin);
    }
    const brief = await this.brief();
    const line = briefLine(brief);
    if (off) return `The brief leaves the note out now: ${line}. /brief <note> pins one.`;
    if (file) return `The brief: ${line}. Every /gen runs against it; Pair never edits it.`;
    if (briefEmpty(brief)) return 'The brief is empty: no goal, no board task, no note. /goal sets the goal; /brief <note> pins a note.';
    const how = brief.note && !brief.note.pinned ? ` (${brief.note.file} by default, gen.brief)` : '';
    return `The brief: ${line}${how}. /brief <note> pins another note; /brief off leaves the note out.`;
  }

  /**
   * Compares `request` with the brief before it generates. A clear contradiction is one question: y goes as asked (and
   * that line is not asked about again this session), n follows the brief, e opens the brief there and ends the request.
   * False when the request ends.
   */
  async against(request) {
    const session = this.session;
    const brief = await this.brief();
    request.brief = brief;
    if (brief.note && !brief.note.pinned && !this.toldBrief) {
      this.toldBrief = true;
      session.message('system', `gen #${request.n} runs against the brief: ${briefLine(brief)}. /brief <note> pins another note; /brief off leaves it out.`);
    }
    if (briefEmpty(brief) || !this.askModel) return true;
    let conflict = null;
    try {
      conflict = parseConflict(await this.askModel(CONFLICT_PROMPT, conflictInput(brief, request.words)), brief, this.exceptions);
    } catch (error) {
      session.log(`gen #${request.n}: comparing with the brief failed: ${error.message}`);
    }
    if (request.state === 'cancelled') return false;
    if (!conflict) return true;
    const place = quotePlace(brief, conflict);
    const choice = await this.question(request, {kind: 'brief', title: `gen #${request.n} · the brief says ${conflict.says}`, conflict, place});
    if (request.state === 'cancelled' || !choice) return false;
    if (choice === 'e') {
      if (request.from !== 'editor' && conflict.source === 'note') session.notify('editor', {type: 'open', file: brief.note.path, line: conflict.line, ask: false});
      this.end(request, 'cancelled', `gen #${request.n} cancelled: ${place} is ${conflict.source === 'note' ? 'open in Neovim' : 'where the brief says it'}. Change the brief or the request, then /gen again.`);
      return false;
    }
    if (choice === 'y') {
      request.asAsked = conflict;
      this.exceptions.add(exceptionKey(conflict));
      session.message('system', `gen #${request.n}: as asked, ${conflict.asked}, against ${place}. Pair does not ask about that line again this session.`);
    } else {
      request.followBrief = conflict;
      session.message('system', `gen #${request.n} follows the brief: ${conflict.says} (${place}).`);
    }
    return true;
  }

  /** Runs `request` in a conversation of its own, then the next one waiting. */
  async run(request) {
    const session = this.session;
    this.running = request;
    const here = request.shape === 'here';
    const where = !here ? null : request.selection ? `${relative(this.root, request.file)}:${request.selection.from}-${request.selection.to}` : `${relative(this.root, request.file)}:${request.place.line}`;
    const asAsked = request.asAsked && {key: exceptionKey(request.asAsked), source: request.asAsked.source, line: request.asAsked.line, text: request.asAsked.text};
    if (request.shape === 'try' || request.shape === 'scaffold') {
      const made = await this.folderFor(request).then(() => null, error => error.message);
      if (made) {
        this.end(request, 'failed', `gen #${request.n}: no ${request.shape === 'try' ? 'folder for the try' : request.mode === 'worktree' ? 'worktree for the scaffold' : 'copy for the scaffold'}: ${made}.`);
        return this.release();
      }
      if (request.state === 'cancelled') {
        if (request.shape === 'scaffold') await this.removeTree(request);
        return this.release();
      }
    }
    request.action = session.ledger.add('generated', `gen #${request.n} · ${request.shape} · ${request.words}`, {
      data: {
        gen: request.n, shape: request.shape, ...(here ? {place: {file: request.file, line: request.selection?.from ?? request.place.line}} : {}),
        ...(request.dir ? {dir: request.dir} : {}), ...(request.mode ? {mode: request.mode} : {}),
        ...(request.branch ? {branch: request.branch, base: request.base} : {}),
        note: here ? `at ${where} · generating` : 'generating', undo: true,
        ...(request.brief ? {brief: briefLine(request.brief)} : {}), ...(asAsked ? {asAsked} : {}),
      },
      detail: {words: request.words, pieces: []},
    });
    this.setState(request, 'generating');
    request.started = session.now();
    let failure = null;
    try {
      request.conversation = await session.partner.createConversation();
      this.conversations.set(request.conversation, request);
      await session.partner.setRole(request.conversation, 'gen');
      if (request.state === 'generating') this.clock(request);
      const answer = request.state === 'generating' ? await session.partner.ask(request.conversation, await this.input(request), {kind: 'gen'}) : null;
      const words = answerOf(answer);
      if (words && !request.said.length) request.said.push(words);
    } catch (error) {
      failure = error.message;
    } finally {
      clearTimeout(request.timer);
      this.conversations.delete(request.conversation);
    }
    // Still the running request while it finishes: a scaffold's check runs in Pair's pane, and in its copy.
    await this.finish(request, failure);
    this.offerBoard(request);
    await this.release();
  }

  /** The request that ran is done: the next one waiting runs. */
  async release() {
    this.running = null;
    const next = this.queue.shift();
    if (next) await this.run(next);
  }

  /**
   * Makes the folder `request` (a try or a scaffold) works in: a try's, empty; a scaffold's copy of the project as the
   * user sees it (unsaved buffers included), or with --branch (or gen.scaffold "worktree") a git worktree on branch
   * gen/<n>. Throws with why when it cannot.
   */
  async folderFor(request) {
    await this.expire();
    if (request.shape === 'try') {
      request.dir = tryFolder(this.folder, request.n);
      return freshFolder(this.dir, request.dir);
    }
    request.dir = scaffoldFolder(this.folder, request.n);
    request.mode = request.flag === 'branch' ? 'worktree' : request.flag === 'copy' ? 'copy' : this.scaffold === 'worktree' ? 'worktree' : 'copy';
    if (request.mode === 'worktree') {
      request.branch = `gen/${request.n}`;
      request.base = (await makeWorktree(this.dir, request.dir, this.root, request.branch)).base;
      request.dir = await realpath(request.dir);
      return;
    }
    request.texts = await this.session.unsavedBuffers().catch(() => new Map());
    await makeCopy(this.dir, request.dir, this.root, request.texts);
    request.dir = await realpath(request.dir); // as pathIn names its files
  }

  /** Stops the request's model once it has worked its minutes, not counting the time a question waits for the user. */
  clock(request) {
    const left = request.limits.minutes * 60_000 - (request.worked ?? 0);
    request.resumed = this.session.now();
    request.timer = setTimeout(() => {
      request.over = `it worked ${plural(request.limits.minutes, 'minute')}, gen.limits.minutes`;
      this.stopModel(request);
    }, Math.max(0, left));
    request.timer.unref?.();
  }

  pause(request) {
    clearTimeout(request.timer);
    request.worked = (request.worked ?? 0) + this.session.now() - (request.resumed ?? this.session.now());
  }

  stopModel(request) {
    if (!request.conversation) return;
    const {partner} = this.session;
    (partner.stop ?? partner.cancel)?.call(partner, request.conversation)?.catch?.(error => this.session.log(`gen #${request.n}: stopping failed: ${error.message}`));
  }

  /** What the request's conversation is told: the request, where its code goes, the lines there and the goal. */
  async input(request) {
    if (request.shape === 'file') return this.fileInput(request);
    if (request.shape === 'try') return this.tryInput(request);
    if (request.shape === 'scaffold') return this.scaffoldInput(request);
    const session = this.session;
    // Where the mark is now: the user may have typed above it since they asked, or while the request waited its turn.
    // Neovim counts how the code it proposes moves from here on.
    const now = await session.requestEditor({type: 'gen_where', gen: request.n}).catch(() => null);
    if (Number.isInteger(now?.line) && request.selection) {
      const moved = now.line - request.selection.from;
      request.selection = {...request.selection, from: now.line, to: request.selection.to + moved};
    } else if (Number.isInteger(now?.line)) {
      request.place = {...request.place, line: now.line};
    }
    const name = relative(this.root, request.file);
    const text = await session.bufferText(request.file).catch(() => '');
    const count = text.split('\n').length;
    let where;
    let shown;
    if (request.selection) {
      const {from, to} = request.selection;
      where = `It replaces lines ${from}-${to} of ${name}, which the user selected: propose with insert false, line ${from}, end_line ${to}.`;
      shown = numberedLines(text, Math.max(1, from - 10), Math.min(count, to + 10, from + SELECTED));
    } else {
      const {line} = request.place;
      where = `The user's cursor is on line ${line} of ${name}: propose with insert true and line ${line}, unless the request names another place in this file.`;
      shown = numberedLines(text, Math.max(1, line - AROUND), Math.min(count, line + AROUND));
    }
    // The brief as it is when the request starts: the user may have changed it while the request waited its turn.
    request.brief = await this.brief();
    const brief = briefEmpty(request.brief) ? '' : `\n\n${briefText(request.brief)}`;
    const chose = request.asAsked ? `\nThe user chose the request over the brief's "${request.asAsked.text}": do as asked there.`
      : request.followBrief ? `\nWhere the request says ${request.followBrief.asked}, the user chose the brief: ${request.followBrief.says} ("${request.followBrief.text}").` : '';
    return `[gen] gen #${request.n}, here. The user asked: "${request.words}"\n${where}\n\n${name} as the editor has it:\n${shown}${brief}${chose}\n\n`
      + 'Read more of the project only if you need it. Then propose the code, and say in one or two sentences what you wrote and what you decided that the user did not say.';
  }

  /** What a file request's conversation is told: the request, the project's files, and the brief. */
  async fileInput(request) {
    const files = (await gitFiles(this.root)) ?? [];
    const listed = files.length ? `The project's files${files.length > LISTED ? ` (the first ${LISTED} of ${files.length})` : ''}:\n${files.slice(0, LISTED).join('\n')}`
      : 'read(".") lists the project.';
    request.brief = await this.brief();
    const brief = briefEmpty(request.brief) ? '' : `\n\n${briefText(request.brief)}`;
    const chose = request.asAsked ? `\nThe user chose the request over the brief's "${request.asAsked.text}": do as asked there.`
      : request.followBrief ? `\nWhere the request says ${request.followBrief.asked}, the user chose the brief: ${request.followBrief.says} ("${request.followBrief.text}").` : '';
    return `[gen] gen #${request.n}, file. The user asked: "${request.words}"\n`
      + 'Write each new file with draft(path, text): the user reviews it as an unsaved buffer and writes it, or not. Only new files: '
      + 'for a change to a file that exists, read it and call propose there, which the user gets as a suggestion.\n\n'
      + `${listed}${brief}${chose}\n\n`
      + 'Read the files the new ones follow, so names, imports and style match. Then draft the files, and say in one or two sentences what you wrote and what you decided that the user did not say.';
  }

  /** What a try request's conversation is told: the request, its folder, how it writes and runs there, and the brief. */
  async tryInput(request) {
    const files = (await gitFiles(this.root)) ?? [];
    const listed = files.length ? `The project's files${files.length > TRY_LISTED ? ` (the first ${TRY_LISTED} of ${files.length})` : ''}, for what the sample may follow:\n${files.slice(0, TRY_LISTED).join('\n')}`
      : 'read(".") lists the project.';
    request.brief = await this.brief();
    const brief = briefEmpty(request.brief) ? '' : `\n\n${briefText(request.brief)}`;
    const chose = request.asAsked ? `\nThe user chose the request over the brief's "${request.asAsked.text}": do as asked there.`
      : request.followBrief ? `\nWhere the request says ${request.followBrief.asked}, the user chose the brief: ${request.followBrief.says} ("${request.followBrief.text}").` : '';
    const network = this.network ? 'it may reach the network' : 'it has no network, so nothing can be installed';
    return `[gen] gen #${request.n}, try. The user asked: "${request.words}"\n`
      + `A sample to read and run, in a folder of its own outside the project: ${request.dir}\n`
      + 'Write its files with write(path, text), each path relative to that folder; read takes them by their full path, '
      + `such as ${join(request.dir, 'main.go')}, and the project's files by their path in the project. `
      + `Then run it with run(command), which runs in that folder in a sandbox where only the folder is writable and ${network}; `
      + 'fix what the run shows. Your last command is how the user runs it again, with one key.\n\n'
      + `${listed}${brief}${chose}\n\n`
      + 'Keep it small: one file if one does, and what it needs to run. Then say in one or two sentences what it shows, and what you decided that the user did not say.';
  }

  /** What a scaffold request's conversation is told: the request, where it builds, its tools there, and the brief. */
  async scaffoldInput(request) {
    const files = (await gitFiles(this.root)) ?? [];
    const listed = files.length ? `The project's files${files.length > SCAFFOLD_LISTED ? ` (the first ${SCAFFOLD_LISTED} of ${files.length})` : ''}:\n${files.slice(0, SCAFFOLD_LISTED).join('\n')}`
      : 'read(".") lists the project.';
    request.brief = await this.brief();
    const brief = briefEmpty(request.brief) ? '' : `\n\n${briefText(request.brief)}`;
    const chose = request.asAsked ? `\nThe user chose the request over the brief's "${request.asAsked.text}": do as asked there.`
      : request.followBrief ? `\nWhere the request says ${request.followBrief.asked}, the user chose the brief: ${request.followBrief.says} ("${request.followBrief.text}").` : '';
    const where = request.mode === 'worktree' ? `a git worktree of the project on a new branch ${request.branch}, at ${request.dir}`
      : `a copy of the project in Pair's data folder, at ${request.dir}`;
    const network = this.network ? 'it may reach the network' : 'it has no network: install nothing, and say which packages it needs, for the user to install';
    const {files: most, lines} = request.limits;
    return `[gen] gen #${request.n}, scaffold. The user asked: "${request.words}"\n`
      + `You build it in ${where}, not in the project: the user keeps what they want of it, a file at a time.\n`
      + 'Paths are as in the project, and read reads the copy, with your changes in it. write(path, text) writes a whole file there, new or not. '
      + 'propose(file, line, end_line, insert, text) changes lines of a file there: use it for small changes to files the project has (a route, an import). '
      + `run(command) runs a command there, in a sandbox where only the copy is writable and ${network}. Build and test what you made, and fix what fails. `
      + `At most ${plural(most, 'file')} and ${plural(lines, 'line')} written (gen.limits).\n\n`
      + `${listed}${brief}${chose}\n\n`
      + 'Read the files yours follow, so names, imports and style match, and change files the project has only where the wiring needs it. '
      + 'Then say in two or three sentences what you made, how to run it, and what you decided that the user did not say.';
  }

  /** A request ends: `state`, and the line the chat gets. */
  end(request, state, text) {
    this.setState(request, state);
    if (text) this.session.message('system', text);
  }

  /**
   * What the code proposed does against the brief and what it guessed, as lines of the debrief: at most three
   * `≠ brief` and three `? guessed`, only what holds up (see brief.mjs). None without pieces, a brief, or the model.
   */
  async checkBrief(request) {
    const {brief} = request;
    // A scaffold's files as the copy has them, each at most CHECKED_LINES lines.
    const pieces = request.shape !== 'scaffold' ? request.pieces : request.pieces.filter(piece => piece.kind === 'tree')
      .map(piece => ({file: piece.file, line: 1, insert: false, text: linesOf(`${piece.text}\n`).slice(0, CHECKED_LINES).join('\n')}));
    if (!this.askModel || !brief || briefEmpty(brief) || !pieces.length) return {contradicts: [], guessed: []};
    try {
      const answer = await this.askModel(CHECK_PROMPT, checkInput({...brief, asAsked: request.asAsked}, request.words, pieces, this.root));
      return parseCheck(answer, brief, pieces, this.exceptions);
    } catch (error) {
      this.session.log(`gen #${request.n}: checking against the brief failed: ${error.message}`);
      return {contradicts: [], guessed: []};
    }
  }

  /** The debrief's lines of `check`: `≠ brief "…" NOTES.md:4 · math.js:7 why` and `? guessed …`. */
  checkLines(request, check) {
    return [
      ...check.contradicts.map(item => `≠ brief "${item.text}" ${quotePlace(request.brief, item)} · ${this.nameOf(item.file)}:${item.fileLine} ${item.why}`),
      ...check.guessed.map(text => `? guessed ${text}`),
    ];
  }

  /** The request's model is done: what it proposed shows at the user's next pause, and the chat says what it made. */
  async finish(request, failure) {
    const session = this.session;
    if (['cancelled', 'undone'].includes(request.state)) return;
    const n = `gen #${request.n}`;
    const said = request.said.join(' ');
    if (request.shape === 'try') await this.scanTry(request);
    if (request.shape === 'scaffold') await this.scanTree(request);
    if (failure || request.over) {
      const why = failure ? `Pair could not finish it: ${failure}` : `stopped: ${request.over}`;
      this.book(request, {note: request.pieces.length ? `${plural(request.pieces.length, 'piece')} · ${why}` : why});
      if (!request.pieces.length) {
        if (request.shape === 'scaffold') await this.removeTree(request);
        this.book(request, {undo: false});
        return this.end(request, 'failed', `${n} · ${why}.`);
      }
      session.message('system', `${n} · ${why}; what it proposed so far shows.`);
    }
    if (!request.pieces.length) {
      if (request.shape === 'scaffold') await this.removeTree(request);
      this.book(request, {note: 'nothing proposed', undo: false});
      session.message('pair', `${n} · ${request.shape} · nothing proposed${said ? `: ${said}` : '.'}`, {gen: request.n});
      return this.setState(request, 'done');
    }
    const lines = request.pieces.reduce((sum, piece) => sum + lineCount(piece.text), 0);
    const check = await this.checkBrief(request);
    if (['cancelled', 'undone'].includes(request.state)) return;
    for (const item of check.contradicts) item.place = quotePlace(request.brief, item);
    request.check = check;
    const debrief = this.checkLines(request, check);
    request.debrief = debrief;
    if (debrief.length && request.from === 'editor') this.session.notify('editor', {type: 'gen_debrief', gen: request.n, lines: debrief});
    if (request.shape === 'file') return this.finishFiles(request, {said, debrief});
    if (request.shape === 'try') return this.finishTry(request, {said, debrief, cut: failure || request.over});
    if (request.shape === 'scaffold') return this.finishScaffold(request, {said, debrief});
    const against = check.contradicts.length ? ` · ≠${check.contradicts.length}` : '';
    this.book(request, {note: `${plural(lines, 'line')} proposed${against}`});
    // The chat shows the first piece as a diff, which `a` there takes in Neovim as Alt-y does.
    const [first] = request.pieces;
    const meta = {gen: request.n, place: {file: relative(this.root, first.file), line: first.line}, suggestion: {action: request.action, old: first.old, new: first.text.split('\n')}};
    const more = debrief.length ? `\n${debrief.join('\n')}` : '';
    if (!failure && !request.over) session.message('pair', `${n} · here · ${plural(lines, 'line')} at ${this.placeText(first)}${said ? `: ${said}` : ''}${more}`, meta);
    else if (more) session.message('pair', `${n} · against the brief:${more}`, {gen: request.n});
    if (request.pieces.some(piece => piece.state === 'proposed')) this.setState(request, 'ready');
  }

  /**
   * A file request's model is done: its new files go to Neovim as buffers to review, loaded but not opened, and are
   * checked there as unsaved buffers at their real paths. Changes it proposed to files that exist show as suggestions,
   * as for here.
   */
  async finishFiles(request, {said, debrief}) {
    const session = this.session;
    const files = request.pieces.filter(piece => piece.kind === 'file');
    const changes = request.pieces.filter(piece => piece.kind !== 'file');
    const shown = files.length ? await this.showFiles(request.action, request.n, files) : false;
    const check = files.length ? await session.checkGenerated(files.map(piece => piece.file), new Map(files.map(piece => [piece.file, `${piece.text}\n`]))) : null;
    if (['cancelled', 'undone'].includes(request.state)) return;
    const against = request.check.contradicts.length ? ` · ≠${request.check.contradicts.length}` : '';
    const what = [files.length ? `${plural(files.length, 'file')} to review` : '', changes.length ? plural(changes.length, 'change') : ''].filter(Boolean).join(' · ');
    this.book(request, {note: `${what}${against}`, ...(check ? {check: {label: check.label, mark: check.mark, text: check.text}} : {})});
    const names = files.map(piece => `${relative(this.root, piece.file)} +${lineCount(piece.text)}`);
    const lines = [
      `gen #${request.n} · file · ${files.length ? `${plural(files.length, 'new file')} to review: ${names.join(', ')}` : 'no new file'}${said ? `: ${said}` : ''}`,
      ...(changes.length ? [`${plural(changes.length, 'change')} to files you have, as suggestions there: ${changes.map(piece => this.placeText(piece)).join(', ')}`] : []),
      ...(check ? [`${check.mark === 'pass' ? '✓' : '✗'} \`${check.label}\` on the unsaved buffers: ${check.text}`] : []),
      ...debrief,
    ];
    // How to take them: the plain pane says it under the card, the full pane's card has keys for it.
    const hint = !files.length ? null : shown ? 'In Neovim, :w in one writes it to its path; :Pair gen list lists them.' : 'No Neovim shows them now: they open there as buffers once one connects.';
    session.message('pair', lines.join('\n'), {gen: request.n, ...(hint ? {hint} : {})});
    if (request.pieces.some(piece => piece.state === 'proposed')) this.setState(request, 'ready');
  }

  /** The files a try's runs made in its folder (`go mod init`, a heredoc) are pieces of it too, as written there. */
  async scanTry(request) {
    for (const name of await filesIn(request.dir)) {
      const at = await pathIn(request.dir, name);
      if (!at || request.pieces.some(piece => piece.kind === 'try' && piece.file === at)) continue;
      const text = await readFile(at, 'utf8').catch(() => null);
      if (text === null || text.includes('\0')) continue;
      const body = text.replace(/\n$/, '');
      request.pieces.push({i: request.pieces.length, n: request.n, kind: 'try', file: at, line: 1, endLine: lineCount(body), insert: false, text: body, state: 'scratch'});
    }
  }

  /**
   * A try request's model is done: its sample opens in Neovim in a split, a real file outside the project, and the
   * chat says what it made and how its last run went. `cut`: the model was stopped before it was done.
   */
  async finishTry(request, {said, debrief, cut}) {
    const session = this.session;
    const files = request.pieces.filter(piece => piece.kind === 'try');
    const main = mainFile(files);
    const ran = request.ran ?? null;
    if (!main) {
      this.book(request, {note: 'nothing in its folder', undo: false});
      session.message('pair', `gen #${request.n} · try · nothing in its folder${said ? `: ${said}` : '.'}`, {gen: request.n});
      return this.setState(request, 'done');
    }
    // Nothing to undo until a file of it is kept: /undo takes back what came before.
    const kept = request.pieces.some(piece => piece.kind === 'file');
    this.book(request, {note: `${plural(files.length, 'file')} in its folder · ${ran ? ranText(ran) : 'not run'}`, undo: kept, ...(ran ? {command: ran.command} : {})});
    const opened = session.notify('editor', {
      type: 'gen_try', gen: request.n, dir: request.dir, words: request.words, command: ran?.command ?? null, keep: this.keepTries,
      open: main.file, files: files.map(piece => ({file: piece.file, name: relative(request.dir, piece.file)})),
    });
    const names = files.map(piece => `${relative(request.dir, piece.file)} +${lineCount(piece.text)}`);
    const lines = [
      `gen #${request.n} · try · ${names.join(', ')} · ${ran ? ranText(ran) : 'not run'}${said ? `: ${said}` : ''}`,
      ...debrief,
    ];
    const hint = opened ? `In Neovim: ${relative(request.dir, main.file)} in a split, outside the project. ${ran ? 'Your run key runs it again; ' : ''}/keep <path> moves it into the project, as a buffer to review. The folder stays ${plural(this.keepTries, 'day')} after it last changed or ran (/gen tries).`
      : `No Neovim to open it in: it is in ${request.dir}. /keep <path> moves it into the project once one connects.`;
    if (!cut || files.length) session.message('pair', lines.join('\n'), {gen: request.n, hint});
    this.setState(request, 'done');
  }

  // Scaffolds: a copy of the project (or a worktree) the model builds in; the user keeps a file of it at a time.

  /** Where the scaffold `request` is, as the chat says it: `Pair's copy <dir>`, or `the worktree <dir>, branch gen/7`. */
  whereText(request) {
    return request.mode === 'worktree' ? `the worktree ${request.dir}, branch ${request.branch}` : `Pair's copy ${request.dir}`;
  }

  /** The text of the project's file `file` the scaffold `request` started from: the buffer then, else the disk, else HEAD. */
  async baseOf(request, file) {
    if (request.texts?.has(file)) return request.texts.get(file);
    if (request.mode === 'worktree') {
      const rel = relative(this.root, file).split(sep).join('/');
      return promisify(execFile)('git', ['show', `${request.base}:${rel}`], {cwd: this.root, maxBuffer: 64 << 20}).then(result => result.stdout, () => null);
    }
    return readFile(file, 'utf8').catch(() => null);
  }

  /**
   * The files a scaffold's runs made or changed in its copy (a lock file, `go.sum`, generated code) are pieces of it
   * too, as long as git would not ignore them; past gen.limits.files they are counted, not listed.
   */
  async scanTree(request) {
    const known = new Set(request.pieces.filter(piece => piece.kind === 'tree').map(piece => relative(request.dir, piece.tree)));
    for (const {rel, isNew} of await changedIn(request.dir, this.root, {worktree: request.mode === 'worktree', known})) {
      const at = await pathIn(request.dir, rel);
      const text = at && (await textOf(at));
      if (text === null || !at) continue;
      const file = join(this.root, rel);
      const base = isNew ? null : await this.baseOf(request, file);
      if (base === text) continue; // touched, not changed
      if (request.pieces.filter(piece => piece.kind === 'tree').length >= request.limits.files) {
        request.unlisted = (request.unlisted ?? 0) + 1;
        continue;
      }
      const body = text.replace(/\n$/, '');
      const {added, removed} = sizeOf(base, text);
      request.pieces.push({i: request.pieces.length, n: request.n, kind: 'tree', file, tree: at, line: 1, endLine: lineCount(body), insert: false, text: body, base, added, removed, state: 'proposed', note: 'by a run'});
    }
  }

  /**
   * The check of the scaffold `request` (`{n, dir}` will do) in its folder: the command a hand-over's check would use
   * (the project's command on save, else the user's last build and run), in Pair's pane, in the sandbox where only
   * the folder is writable. `{label, mark, text}`, or `{none}` with why nothing ran.
   */
  async checkTree(request) {
    const session = this.session;
    const check = checkCommand({testCommand: session.testRuns?.command, runs: session.state.runs, root: this.root});
    if (!check.command) return {none: check.none};
    if (!(await session.checkAllowed(check))) return {none: `the user did not allow \`${check.command}\``};
    const result = await this.runIn(request, request.dir, check.command, {byUser: true});
    if (typeof result === 'string') return {none: result};
    const tests = parseTestOutput(result.output);
    return {label: runLabel(check.command), mark: result.exit === 0 && !result.timedOut ? 'pass' : 'fail', text: runText({...result, tests})};
  }

  /**
   * A scaffold request's model is done: its copy is checked, the chat gets the debrief (what it made, where, how its
   * runs and the check went, the brief, what it could not install), and Neovim's review list keeps it a file at a time.
   */
  async finishScaffold(request, {said, debrief}) {
    const session = this.session;
    const files = request.pieces.filter(piece => piece.kind === 'tree');
    const changed = files.filter(piece => piece.base !== null);
    const check = await this.checkTree(request);
    if (['cancelled', 'undone'].includes(request.state)) return;
    request.checked = check;
    const against = request.check.contradicts.length ? ` · ≠${request.check.contradicts.length}` : '';
    const mark = check.label ? ` · ${check.mark === 'pass' ? '✓' : '✗'} ${check.label}` : '';
    this.book(request, {
      note: `${plural(files.length, 'file')}${changed.length ? ` · ${changed.length} of yours changed` : ''}${against}${mark}`,
      ...(check.label ? {check: {label: check.label, mark: check.mark, text: check.text}} : {}),
    });
    const seconds = Math.round((session.now() - request.started) / 1000);
    const took = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
    const ran = [...(request.runs ?? new Map()).values()].slice(-3).map(ranText);
    const checked = check.label ? `check ${check.mark === 'pass' ? '✓' : '✗'} \`${check.label}\`: ${check.text}` : `no check: ${check.none}`;
    const width = Math.max(...files.slice(0, CARD_FILES).map(piece => relative(this.root, piece.file).length));
    const listed = files.slice(0, CARD_FILES).map(piece => {
      const name = relative(this.root, piece.file).padEnd(width);
      return piece.base === null ? `│ + ${name}  +${piece.added}` : `│ ~ ${name}  +${piece.added} -${piece.removed}`;
    });
    const more = files.length - CARD_FILES + (request.unlisted ?? 0);
    const installs = [...(request.installs ?? [])];
    const opened = session.notify('editor', {type: 'gen_scaffold', gen: request.n, action: request.action, dir: request.dir, files: files.length});
    const lines = [
      `gen #${request.n} · scaffold · ${plural(files.length, 'file')}${changed.length ? `, ${changed.length} of yours changed` : ''} · ${took}${said ? `: ${said}` : ''}`,
      `in ${this.whereText(request)}${ran.length ? ` · ran ${ran.join(' · ')}` : ''}`,
      checked,
      ...listed,
      ...(more > 0 ? [`│ … ${more} more`] : []),
      ...debrief,
      ...(installs.length ? [`not run: ${installs.map(command => `\`${command}\``).join(', ')}: the copy has no network (gen.network), so install it yourself once you keep the files`] : []),
    ];
    const hint = opened ? 'In Neovim, :Pair gen list keeps them one at a time (k), shows each (Enter) and deletes the copy (x). Here, /keep <path> keeps one; /gen drop deletes the copy.'
      : 'No Neovim now: /keep <path> keeps a file; :Pair gen list lists them once one connects. /gen drop deletes the copy.';
    session.message('pair', lines.join('\n'), {gen: request.n, hint});
    this.setState(request, 'ready');
  }

  /** Deletes the folder of scaffold `request` (`{dir, mode, branch, base}`): a copy, or a worktree and its unused branch. */
  async removeTree(request) {
    if (!request.dir || !(await noLinks(this.dir, request.dir))) return {removed: false};
    if (request.mode === 'worktree') return removeWorktree(this.root, request.dir, request.branch, request.base);
    return {removed: await removeCopy(request.dir)};
  }

  /** A write, a run or a keep in `dir` keeps it from expiring for gen.keepTries days. */
  async touch(dir) {
    const now = new Date();
    await utimes(dir, now, now).catch(() => {});
  }

  /** What Neovim gets to make buffers of the proposed `files` of request `n` (ledger entry `action`); `open` opens them. */
  filesMessage(action, n, files, contradicts = [], open = false) {
    return {
      type: 'gen_files', gen: n, action, ...(open ? {open: true} : {}),
      files: files.map(piece => ({
        piece: piece.i, file: piece.file, name: relative(this.root, piece.file), text: piece.text, note: piece.note ?? '',
        marks: contradicts.filter(item => item.file === piece.file).map(item => ({line: item.fileLine, text: [`≠ brief "${item.text}"`, item.place, `· ${item.why}`].filter(Boolean).join(' ')})),
      })),
    };
  }

  /**
   * Sends the proposed `files` of request `n` (ledger entry `action`) to the Neovim the user works in, as buffers,
   * with what the debrief found against the brief in them; false without a Neovim.
   */
  async showFiles(action, n, files, {open = false} = {}) {
    const contradicts = this.requests.get(n)?.check?.contradicts ?? this.session.store.action(action)?.detail?.contradicts ?? [];
    const reply = await this.session.requestEditor(this.filesMessage(action, n, files, contradicts, open)).catch(() => null);
    return reply?.ok === true;
  }

  placeText(piece) {
    return `${this.nameOf(piece.file)}:${piece.line}`;
  }

  /** How the chat names `file`: by its path in the project, or in its try folder. */
  nameOf(file) {
    const tried = this.tryOfPath(file) ?? this.scaffoldOfPath(file);
    return tried ? relative(tried.dir, file) : relative(this.root, file);
  }

  /** Writes the request's ledger entry anew: `data` merged, and its pieces as they are now. */
  book(request, data = {}) {
    if (!request.action) return;
    // A scaffold's file keeps its text in its copy, not in the ledger; a change keeps what it was changed from.
    const pieces = request.pieces.map(({i, kind, file, line, endLine, insert, text, note, state, patch, from, to, written, source, tree, base, added, removed, old, marks}) => (kind === 'tree'
      ? {i, kind, file, tree, line, endLine, base, added, removed, note, state}
      : {i, kind, file, line, endLine, insert, text, note, state, patch, from, to, written, source, ...(kind === 'hunk' ? {old} : {}), ...(marks ? {marks} : {})}));
    const check = request.check ? {contradicts: request.check.contradicts, guessed: request.check.guessed, debrief: request.debrief ?? []} : {};
    this.session.ledger.update(request.action, {data: {...data, ...tally(pieces)}, detail: {words: request.words, pieces, ...check}});
    this.sendCard(request.action);
  }

  /**
   * The request booked as ledger entry `action`: `{entry, request, pieces}`, `request` while this daemon runs it, and
   * its pieces as it has them, else as the ledger does (a request of a daemon before a restart).
   */
  piecesOf(action) {
    const entry = this.session.store.action(action);
    const live = entry?.kind === 'generated' ? this.requests.get(entry.data?.gen) : null;
    const request = live?.action === action ? live : null;
    return {entry, request, pieces: request?.pieces ?? entry?.detail?.pieces ?? []};
  }

  /** Books `data` on ledger entry `action` with its pieces as they are now. */
  rebook(action, {entry, request, pieces}, data) {
    if (request) return this.book(request, data);
    this.session.ledger.update(action, {data: {...data, ...tally(pieces)}, detail: {...(entry.detail ?? {}), pieces}});
    this.sendCard(action);
  }

  /**
   * Asks the user about `request` where they asked for it: in Neovim as a dialog, else in the chat. `kind` 'shape'
   * resolves with a shape (the `guess` first) or null; 'question' with the answer, `answer` when they keep the one
   * given, or null when they leave it to Pair; 'brief', about a `conflict` with the brief at `place`, with y (as
   * asked), n (follow the brief) or e (open the brief there); 'board', about `task` ({title, brief}) and its `command`,
   * with a pick of PICK_KEYS or c, and the task as the user edited it in `request.edited`.
   */
  async question(request, {kind, title, guess = null, answer = '', conflict = null, place = null, command = null, task = null, warning = null}) {
    const session = this.session;
    const id = ++this.asked;
    const choices = kind === 'shape' ? [guess, ...SHAPES.filter(shape => shape !== guess)]
      : kind === 'brief' ? ['n', 'y', ...(conflict.source === 'note' ? ['e'] : [])] : kind === 'board' ? [...Object.keys(PICK_KEYS), 'c'] : null;
    const waiting = new Promise(resolve => { request.question = {id, kind, title, choices, answer, conflict, place, command, warning, resolve}; });
    const options = kind === 'shape' ? choices.map(shape => ({shape, what: SHAPE_WHAT[shape], built: BUILT.has(shape), guessed: shape === guess}))
      : kind === 'brief' ? choices.map(key => ({
        key,
        what: {n: `follow the brief: ${conflict.says}`, y: `as asked: ${conflict.asked}`, e: `open ${place}`}[key],
        ...(key === 'e' ? {file: request.brief.note.path, line: conflict.line} : {}),
      }))
      : kind === 'board' ? choices.map(key => ({key, what: PICK_WHAT[key]})) : undefined;
    const asked = request.from === 'editor' && session.notify('editor', {
      type: 'gen_ask', gen: request.n, id, kind, title, answer, choices: options,
      ...(conflict ? {quote: conflict.text, place} : {}), ...(command ? {command} : {}), ...(task ? {task} : {}), ...(warning ? {warning} : {}),
    });
    request.question.where = asked ? 'editor' : 'chat'; // the chat's status says where it waits
    if (request.state === 'generating') this.pause(request);
    this.setState(request, request.state === 'generating' ? 'asks' : 'asking');
    if (asked) {
      if (kind === 'question') session.message('system', `${title} (default: ${answer || 'none'}; answer in Neovim)`);
      if (kind === 'board') session.message('system', `${title}: edit its brief in Neovim (pair://board/new), then pick how to add it.`);
      if (kind === 'brief') session.message('system', `${title}: "${conflict.text}" ${place}. ${conflict.asked} anyway? (answer in Neovim)`);
    } else {
      this.inChat(request, request.question);
    }
    const result = await waiting;
    request.question = null;
    if (request.state === 'asks') {
      this.setState(request, 'generating');
      this.clock(request);
    } else this.sendCard(request.action, request); // it asks no more
    return result;
  }

  /**
   * The question as the chat asks it: y keeps the guess or the answer given, n leaves it, other words answer. About
   * the brief: y as asked, n (or Esc) follows the brief, e opens it.
   */
  inChat(request, question) {
    const session = this.session;
    const {kind, title, choices, answer} = question;
    if (kind === 'board') {
      const asking = session.confirm(`${title}. How should Pair add it?`, choices.filter(key => key !== 'y'), {
        command: question.command, copy: true, keys: choices.filter(key => key !== 'y'), timeoutMs: null, gen: request.n, said: () => null,
        hint: 'y add only (its agent waits for your go) · d add and delegate · p delegate, plan first · r delegate, research only · c copy the command · n nothing',
      });
      question.confirm = session.lastConfirmation;
      asking.then(result => this.answered(request, question.id, result === true ? 'y' : typeof result === 'string' ? result : 'n'));
      return;
    }
    if (kind === 'brief') {
      const {conflict, place} = question;
      const open = choices.includes('e') ? ` · e open ${place}` : '';
      const asking = session.confirm(`${title}:\n│ "${conflict.text}" ${place}\n${conflict.asked} anyway?`, choices.includes('e') ? ['e'] : [], {
        timeoutMs: null, hint: `y as asked · n follow the brief (${conflict.says})${open}`, said: () => null, gen: request.n,
      });
      question.confirm = session.lastConfirmation;
      asking.then(result => this.answered(request, question.id, result === true ? 'y' : result === 'e' ? 'e' : 'n'));
      return;
    }
    const others = choices?.slice(1).join(', ');
    const text = kind === 'shape' ? `${title} y: ${choices[0]}, or type ${others}; n cancels.` : `${title} y keeps \`${answer}\`, n leaves it to Pair, or type your answer.`;
    const asking = session.confirm(text, choices ?? [], {
      free: kind === 'question', timeoutMs: null, gen: request.n,
      hint: kind === 'shape' ? `y: ${choices[0]} · ${others} · n cancels` : `y keeps ${answer} · n leaves it to Pair · or your answer`,
      said: result => (result === false && kind === 'question' ? `gen #${request.n}: left to Pair.` : null), // a cancel says so itself
    });
    question.confirm = session.lastConfirmation;
    asking.then(result => this.answered(request, question.id, result === true ? (choices?.[0] ?? answer) : result || null));
  }

  /**
   * The user's answer to question `id` of request `n` (Neovim's gen_answer): the first answer counts. A board task's
   * comes with `edit`, the task as they edited it ({title, brief}).
   */
  answer(n, id, text, edit = null) {
    const request = this.requests.get(n);
    if (!request?.question || request.question.id !== id) return;
    if (request.question.kind === 'board' && typeof edit?.title === 'string' && typeof edit.brief === 'string') request.edited = {title: edit.title, brief: edit.brief};
    this.answered(request, id, typeof text === 'string' ? text : null);
  }

  answered(request, id, text) {
    const question = request.question;
    if (!question || question.id !== id) return;
    if (question.kind === 'shape') return question.resolve(SHAPES.includes(text) ? text : null);
    if (question.kind === 'brief' || question.kind === 'board') return question.resolve(question.choices.includes(text) ? text : null);
    question.resolve(text === null ? null : text.trim() || question.answer || null);
  }

  /** Stops the newest request not yet done (/gen cancel): its model, its question, or its place in the queue. */
  cancel(n = null) {
    const request = n ? this.requests.get(n) : [...this.requests.values()].reverse().find(one => ['asking', 'asks', 'queued', 'generating'].includes(one.state));
    if (!request || !['asking', 'asks', 'queued', 'generating'].includes(request.state)) {
      return this.session.message('system', 'No gen request is running or waiting.');
    }
    this.stop(request, 'cancelled');
    this.book(request, {note: 'cancelled', undo: request.pieces.some(piece => piece.state === 'taken')});
    this.session.message('system', `gen #${request.n} cancelled.`);
    // Not taken is not kept: a scaffold's copy goes with it, once its model has stopped writing there.
    if (request.shape === 'scaffold' && request.dir && request.action) {
      this.book(request, {deleted: true});
      (this.running === request ? this.whenDone(request) : Promise.resolve()).then(() => this.removeTree(request));
    }
  }

  /** Resolves once `request`'s model has stopped. */
  whenDone(request) {
    return new Promise(resolve => {
      const wait = () => (this.running === request ? setTimeout(wait, 50).unref?.() : resolve());
      wait();
    });
  }

  /** Ends `request` now as `state`: its question, its place in the queue, its model, its proposals still showing. */
  stop(request, state) {
    this.queue = this.queue.filter(one => one !== request);
    const question = request.question;
    this.setState(request, state);
    if (question?.confirm) this.session.withdraw(question.confirm);
    question?.resolve(null);
    this.stopModel(request);
    this.due = this.due.filter(piece => piece.n !== request.n);
    for (const piece of request.pieces) if (piece.state === 'proposed') piece.state = 'dropped';
    this.session.notify('editors', {type: 'gen_drop', gen: request.n});
  }

  // The gen tool set: the tools of a request's conversation (see tools.mjs).

  /** Carries out tool `name` for the request of `conversationId`. */
  async tool(conversationId, name, args) {
    const request = this.conversations.get(conversationId);
    if (!request || request.state === 'cancelled' || request.state === 'undone') return 'The user stopped this request: end now, without more tool calls.';
    const session = this.session;
    if (name === 'say') {
      const words = answerOf(args.text);
      if (words) request.said.push(words);
      return 'noted: the user reads it with your code';
    }
    if (name === 'read') return request.shape === 'scaffold' ? this.readTree(request, args) : session.read(args);
    if (name === 'recall') return session.recall(args);
    if (name === 'search') {
      if (++request.commands > request.limits.commands) return `That is ${request.limits.commands} searches for this request (gen.limits.commands): propose with what you found.`;
      // A scaffold searches its copy, with what it wrote there.
      return session.search(args, {gen: true, ...(request.shape === 'scaffold' ? {cwd: request.dir} : {})}).catch(error => `Not searched: ${error.message}`);
    }
    if (name === 'propose') return this.propose(request, args);
    if (name === 'draft') return this.draft(request, args);
    if (name === 'write') return this.write(request, args);
    if (name === 'run') return this.runTry(request, args);
    if (name === 'ask') return this.ask(request, args);
    return `Pair has no tool "${name}" in a /gen request.`;
  }

  async ask(request, {question, answer}) {
    if (request.questions >= QUESTIONS) return `You asked ${QUESTIONS} questions already: decide with what you know, and say what you decided.`;
    request.questions++;
    const said = await this.question(request, {kind: 'question', title: `gen #${request.n} asks: ${question}`, answer});
    if (['cancelled', 'undone'].includes(request.state)) return 'The user stopped this request: end now, without more tool calls.';
    return said === null ? 'The user left it to you: decide, and say what you decided.' : `The user answered: "${said}"`;
  }

  async propose(request, {file, line, endLine, insert, text, note}) {
    const session = this.session;
    if (request.shape === 'scaffold') return this.proposeTree(request, {file, line, endLine, insert, text});
    const path = await projectFile(this.root, file);
    if (!path) return `No file ${file} in the project`;
    if (request.shape === 'here' && path !== request.file) return `This request is /gen here in ${relative(this.root, request.file)}: propose there.`;
    if (request.shape === 'try') return 'This request is /gen try: it never changes the project. Write the sample in your folder with write.';
    if (endLine < line) return `end_line ${endLine} is before line ${line}`;
    const buffer = (await session.bufferText(path)).split('\n');
    const count = buffer.length;
    if (line > count) return `Line ${line} is past the end of ${file}, which has ${count} lines. Read it first.`;
    const lines = lineCount(text);
    if (!lines) return 'propose needs the code: text has no lines.';
    if (request.lines + lines > request.limits.lines) return this.past(request, 'lines', `That is more than ${request.limits.lines} lines for this request (gen.limits.lines): propose less, or say what is left.`);
    if (!request.files.has(path) && request.files.size >= request.limits.files) return this.past(request, 'files', `That is ${request.limits.files} files for this request (gen.limits.files).`);
    request.lines += lines;
    request.files.add(path);
    const old = insert ? [] : buffer.slice(line - 1, endLine); // what the chat shows it replace
    const piece = {i: request.pieces.length, n: request.n, file: path, line, endLine, insert, text: text.replace(/\n$/, ''), note, state: 'proposed', old};
    request.pieces.push(piece);
    this.book(request);
    this.due.push(piece);
    this.showDue();
    return `Shown at ${file}:${line} as ghost lines, at the user's next pause in typing. They take it with one key, or not; nothing changes until then.`;
  }

  /** A new file for a file request: it goes to Neovim as a buffer to review once the model is done. */
  async draft(request, {path, text, note}) {
    if (request.shape === 'try') return 'This request is /gen try: write its files in your folder with write.';
    if (request.shape === 'scaffold') return 'This request is /gen scaffold: write its files in the copy with write, new or not.';
    if (request.shape !== 'file') return `This request is /gen ${request.shape}: draft makes new files only in a /gen file request. Call propose.`;
    const at = await draftPath(this.root, path);
    if (!at) return `Cannot draft ${path}: not a path inside the project.`;
    const name = relative(this.root, at.path);
    if (at.exists) return `${name} exists already, and draft makes new files only. To change it, read it and call propose there: the user gets that as a suggestion.`;
    const body = text.replace(/\n$/, '');
    const lines = lineCount(body);
    if (!lines) return 'draft needs the file: text has no lines.';
    const old = request.pieces.find(piece => piece.kind === 'file' && piece.file === at.path);
    if (request.lines - (old ? lineCount(old.text) : 0) + lines > request.limits.lines) return this.past(request, 'lines', `That is more than ${request.limits.lines} lines for this request (gen.limits.lines): draft less, or say what is left.`);
    if (!request.files.has(at.path) && request.files.size >= request.limits.files) return this.past(request, 'files', `That is ${request.limits.files} files for this request (gen.limits.files).`);
    request.lines += lines - (old ? lineCount(old.text) : 0);
    request.files.add(at.path);
    if (old) Object.assign(old, {text: body, note, endLine: lines});
    else request.pieces.push({i: request.pieces.length, n: request.n, kind: 'file', file: at.path, line: 1, endLine: lines, insert: false, text: body, note, state: 'proposed'});
    this.book(request);
    return `Drafted ${name}${old ? ' anew' : ''}, ${plural(lines, 'line')}. Once you are done, the user reviews it as an unsaved buffer and writes it to ${name}, or not.`;
  }

  /** A file of a try request's sample, written in its folder at once: the folder is Pair's, not the project. */
  async write(request, {path, text}) {
    if (request.shape === 'scaffold') {
      const written = await this.writeTree(request, path, text);
      if (typeof written === 'string') return written;
      const name = relative(this.root, written.file);
      const what = written.base === null ? `a new file, ${plural(lineCount(written.text), 'line')}` : `+${written.added} -${written.removed} against the project`;
      return `Wrote ${name} in the copy: ${what}. run runs commands there.`;
    }
    if (request.shape !== 'try') return `This request is /gen ${request.shape}: write works only in a /gen try or scaffold request. ${request.shape === 'file' ? 'Call draft.' : 'Call propose.'}`;
    const at = await pathIn(request.dir, path);
    if (!at) return `Cannot write ${path}: not a path inside your folder ${request.dir}.`;
    const name = relative(request.dir, at);
    const body = text.replace(/\n$/, '');
    const lines = lineCount(body);
    if (!lines) return 'write needs the file: text has no lines.';
    const old = request.pieces.find(piece => piece.kind === 'try' && piece.file === at);
    if (request.lines - (old ? lineCount(old.text) : 0) + lines > request.limits.lines) return this.past(request, 'lines', `That is more than ${request.limits.lines} lines for this request (gen.limits.lines): write less, or say what is left.`);
    if (!request.files.has(at) && request.files.size >= request.limits.files) return this.past(request, 'files', `That is ${request.limits.files} files for this request (gen.limits.files).`);
    try {
      await mkdir(dirname(at), {recursive: true});
      await writeFile(at, `${body}\n`);
    } catch (error) {
      return `Not written: ${error.message}.`;
    }
    request.lines += lines - (old ? lineCount(old.text) : 0);
    request.files.add(at);
    if (old) Object.assign(old, {text: body, endLine: lines});
    else request.pieces.push({i: request.pieces.length, n: request.n, kind: 'try', file: at, line: 1, endLine: lines, insert: false, text: body, state: 'scratch'});
    this.book(request);
    return `Wrote ${name} in your folder, ${plural(lines, 'line')}${old ? ', anew' : ''}. run runs it there.`;
  }

  /** run in a try request: `command` in its folder, in the sandbox; the last one is how the user runs it again. */
  async runTry(request, {command}) {
    if (!['try', 'scaffold'].includes(request.shape)) return 'run works only in a /gen try or scaffold request, in its own folder. Here Pair checks your code once the user takes it: do not run anything.';
    if (request.shape === 'scaffold' && !this.network && INSTALL.test(command)) {
      (request.installs ??= new Set()).add(command);
      return 'Not run: the copy has no network (gen.network), so nothing can be installed. The user is told to install it; go on without it, and say what needs it.';
    }
    if (++request.commands > request.limits.commands) return `That is ${request.limits.commands} commands for this request (gen.limits.commands): say what you have.`;
    const result = await this.runIn(request, request.dir, command);
    if (typeof result === 'string') return result;
    request.ran = {command, exit: result.exit, timedOut: result.timedOut};
    if (request.shape === 'scaffold') {
      (request.runs ??= new Map()).delete(command); // the last run of each command, in the order they last ran
      request.runs.set(command, request.ran);
    }
    this.book(request, {command});
    const said = result.timedOut ? 'It ran too long, so it was stopped with Ctrl-C.' : `exit ${result.exit}`;
    return `${said}\n${tail(result.output, RUN_CHARS) || '(no output)'}`;
  }

  /**
   * Runs `command` of try request `request` (`{n}` will do) in its folder `dir`, in Pair's pane: `{exit, output,
   * timedOut}`, or why not as text. In the sandbox (only that folder writable) it runs at once unless the command
   * policy refuses it; without one, a command Scout would ask about asks first, unless the user ran it (`byUser`).
   */
  async runIn(request, dir, command, {byUser = false} = {}) {
    const session = this.session;
    const policy = commandPolicy(command);
    if (policy.verdict === 'refuse') {
      session.ledger.add('refused', command, {data: {note: policy.reason}});
      session.message('system', `Pair may not run \`${command}\`: ${policy.reason}.`);
      return `Refused: ${policy.reason}. Do not try another way; tell the user.`;
    }
    let sandboxed;
    try {
      sandboxed = trySandboxed(this.sandbox);
    } catch (error) {
      return `Not run: ${error.message}.`;
    }
    const folder = request.shape === 'scaffold' ? 'copy' : 'folder';
    if (policy.verdict === 'ask' && !sandboxed && !byUser
      && !(await session.allowed(command, `May I run \`${command}\` in gen #${request.n}'s ${folder}, outside the project (${policy.reason})? There is no sandbox here.`))) {
      return 'The user did not allow it. Do not run it another way.';
    }
    let result;
    try {
      result = await session.inPane(tryLine(dir, command, {sandboxed, network: this.network}), {gen: true});
    } catch (error) {
      return `Not run: ${error.message}.`;
    }
    // A run keeps the try or the copy: its folder counts as changed now, for gen.keepTries.
    await this.touch(dir);
    session.ledger.add('ran', `${command} (gen #${request.n}'s ${request.shape === 'scaffold' ? 'copy' : 'try'})`, {
      data: {note: result.timedOut ? 'stopped' : result.exit ? `exit ${result.exit}` : undefined, result: result.exit === 0 && !result.timedOut ? 'pass' : 'fail'},
      detail: {output: keptOutput(result.output)},
    });
    return result;
  }

  /**
   * `path` as a path in scaffold `request`'s copy, relative to it: a path of the project (relative, or absolute in the
   * project or in the copy), never in .git; null for one outside.
   */
  relInTree(request, path) {
    if (typeof path !== 'string' || !path.trim()) return null;
    const wanted = path.trim();
    const rel = !isAbsolute(wanted) ? normalize(wanted)
      : !relative(request.dir, wanted).startsWith('..') ? relative(request.dir, wanted) : relative(this.root, wanted);
    if (rel === '.' || rel === '') return '';
    if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('.git')) return null;
    return rel;
  }

  /**
   * Writes `text` as the file at `path` in scaffold `request`'s copy, within its limits: the piece it is now, or why
   * not. The file's text before the first write is the project's, which a change of it is kept against.
   */
  async writeTree(request, path, text) {
    const rel = this.relInTree(request, path);
    const at = rel && (await pathIn(request.dir, rel));
    if (!at) return `Cannot write ${path}: not a file's path in the project.`;
    const body = text.replace(/\n$/, '');
    if (!lineCount(body)) return 'write needs the file: text has no lines.';
    const old = request.pieces.find(piece => piece.kind === 'tree' && piece.tree === at);
    // The project's text when the copy was made, not the copy's now: a run may have changed it since.
    const base = old ? old.base : (await stat(join(this.root, rel)).catch(() => null))?.isFile() ? await this.baseOf(request, join(this.root, rel)) : null;
    const size = sizeOf(base, `${body}\n`);
    const others = request.pieces.filter(piece => piece.kind === 'tree' && piece !== old);
    const written = others.reduce((sum, piece) => sum + piece.added, 0);
    if (written + size.added > request.limits.lines) return this.past(request, 'lines', `That is more than ${request.limits.lines} lines for this request (gen.limits.lines): write less, or say what is left.`);
    if (!old && others.length >= request.limits.files) return this.past(request, 'files', `That is ${request.limits.files} files for this request (gen.limits.files).`);
    try {
      await mkdir(dirname(at), {recursive: true});
      await writeFile(at, `${body}\n`);
    } catch (error) {
      return `Not written: ${error.message}.`;
    }
    await this.touch(request.dir);
    const piece = old ?? {i: request.pieces.length, n: request.n, kind: 'tree', file: join(this.root, rel), tree: at, line: 1, insert: false, base, state: 'proposed'};
    Object.assign(piece, {text: body, endLine: lineCount(body), added: size.added, removed: size.removed});
    if (!old) request.pieces.push(piece);
    request.lines = written + size.added;
    this.book(request);
    return piece;
  }

  /** propose in a scaffold: lines of a file of the copy change at once, as they would in the user's buffer. */
  async proposeTree(request, {file, line, endLine, insert, text}) {
    const rel = this.relInTree(request, file);
    const at = rel && (await pathIn(request.dir, rel));
    const current = at && (await textOf(at));
    if (current === null || !at) return `No file ${file} in the copy: write makes a new file.`;
    const lines = linesOf(current);
    const last = insert ? line : endLine ?? line;
    if (!Number.isInteger(line) || line < (insert ? 0 : 1) || last < line) return `Lines ${line}-${last} are no lines to change. Read the file first.`;
    if (last > lines.length) return `Line ${last} is past the end of ${rel}, which has ${lines.length} lines. Read it first.`;
    const added = linesOf(`${text.replace(/\n$/, '')}\n`);
    const changed = insert ? [...lines.slice(0, line), ...added, ...lines.slice(line)] : [...lines.slice(0, line - 1), ...added, ...lines.slice(last)];
    const written = await this.writeTree(request, rel, changed.join('\n'));
    if (typeof written === 'string') return written;
    const where = insert ? `below line ${line}` : `lines ${line}-${last}`;
    return `Changed ${rel} in the copy, ${where}: now +${written.added} -${written.removed} against the project. read shows it as it is now.`;
  }

  /** read in a scaffold: a file or folder of its copy, by its path in the project. */
  async readTree(request, {file, from, to}) {
    const rel = this.relInTree(request, file ?? '.');
    if (rel === null) return `Cannot read ${file}: not a path in the project.`;
    const at = join(request.dir, rel);
    const realDir = await realpath(request.dir).catch(() => request.dir);
    const real = await realpath(at).catch(() => null);
    if (!real) return `${file} does not exist in the copy.`;
    if ((await stat(real)).isDirectory()) {
      if (real !== realDir && relative(realDir, real).startsWith('..')) return `Cannot read ${file}: it leads out of the copy.`;
      const entries = (await readdir(real, {withFileTypes: true})).filter(entry => entry.name !== '.git').sort((a, b) => a.name.localeCompare(b.name));
      return entries.slice(0, 200).map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name)).join('\n') || `${file} is empty.`;
    }
    const path = await pathIn(request.dir, rel);
    const text = path && (await textOf(path));
    if (!path || text === null) return `Cannot read ${file}: not a text file of the copy.`;
    return numberedLines(text, from ?? 1, to);
  }

  // Tries after the model is done: the user runs one again, keeps a file of it, lists them; they expire.

  /** Deletes the try folders, of every project, that have not changed for gen.keepTries days. */
  async expire() {
    // By the clock, not the session's: the folders' times are the disk's.
    const gone = await expireTries(this.dir, this.keepTries, Date.now()).catch(() => []);
    if (gone.length) this.session.log(`gen: ${plural(gone.length, 'try folder')} older than ${plural(this.keepTries, 'day')} deleted`);
  }

  /** The try request whose folder holds `file`, as `{n, dir}`, or null. */
  tryOfPath(file) {
    if (typeof file !== 'string' || !isAbsolute(file)) return null;
    const rel = relative(join(this.folder, 'try'), file);
    const [n, ...rest] = rel.split(sep);
    if (!/^[1-9]\d*$/.test(n) || rel.startsWith('..')) return null;
    return {n: Number(n), dir: tryFolder(this.folder, Number(n)), inside: rest.length > 0};
  }

  /** The scaffold request whose copy (or worktree) holds `file`, as `{n, dir, inside}`, or null. */
  scaffoldOfPath(file) {
    if (typeof file !== 'string' || !isAbsolute(file)) return null;
    const rel = relative(this.folder, file);
    const [n, ...rest] = rel.split(sep);
    if (!/^[1-9]\d*$/.test(n) || rel.startsWith('..')) return null;
    return {n: Number(n), dir: scaffoldFolder(this.folder, Number(n)), inside: rest.length > 0};
  }

  /**
   * A scaffold request to keep from or act on: the one booked as `action`, number `n`, the one whose copy holds
   * `file`, else (`newest`) the newest try or scaffold, when that is a scaffold whose copy is still there. As `{n, dir,
   * data, action, entry, request, pieces}`, or null.
   */
  async scaffoldOf({action = null, n = null, file = null, newest = true} = {}) {
    const rows = this.session.store.actions(this.root, 0).filter(row => row.kind === 'generated' && ['try', 'scaffold'].includes(row.data?.shape) && row.data?.dir);
    const found = row => (row?.data.shape === 'scaffold' ? {n: row.data.gen, dir: row.data.dir, data: row.data, action: row.id, ...this.piecesOf(row.id)} : null);
    if (action !== null) return found(rows.find(row => row.id === action));
    const number = n ?? this.scaffoldOfPath(file)?.n ?? null;
    if (number !== null) return found(rows.findLast(row => row.data.gen === number && row.data.shape === 'scaffold'));
    if (!newest || this.tryOfPath(file)) return null;
    for (const row of rows.reverse()) {
      // The newest is a try still in its folder: /keep is for it.
      if (row.data.shape === 'try' && (await filesIn(row.data.dir)).length) return null;
      if (row.data.shape === 'scaffold' && !row.data.deleted && (await stat(row.data.dir).catch(() => null))) return found(row);
    }
    return null;
  }

  /**
   * A try request: number `n`, or the one whose folder holds `file`, else the newest whose folder is still there. As
   * `{n, dir, action, entry, request, pieces}`, or null.
   */
  async tryOf({n = null, file = null} = {}) {
    const wanted = n ?? this.tryOfPath(file)?.n ?? null;
    const rows = this.session.store.actions(this.root, 0).filter(row => row.kind === 'generated' && row.data?.shape === 'try' && row.data?.dir);
    for (const row of rows.reverse()) {
      if (wanted !== null && row.data.gen !== wanted) continue;
      if (!(await filesIn(row.data.dir)).length) {
        if (wanted !== null) return null;
        continue;
      }
      return {n: row.data.gen, dir: row.data.dir, action: row.id, ...this.piecesOf(row.id)};
    }
    return null;
  }

  /**
   * /keep [path] and :Pair keep: a file of a try (`file`, else the try's main file) goes into the project at `path`
   * (else its path in the folder), as a buffer to review that :w takes, like a file request's. Only a new file. When
   * the newest of them is a scaffold (or `file`, `n` or `action` names one), a file of its copy is kept instead (see
   * keepTree): `piece`, `file`, or the one at `path`.
   */
  async keep({path = '', file = null, n = null, action = null, piece: index = null} = {}) {
    const session = this.session;
    const scaffold = await this.scaffoldOf({action, n, file});
    if (scaffold) return this.keepTree(scaffold, {path, file, piece: index});
    if (action !== null) return this.said('No /gen scaffold to keep from there.');
    const found = await this.tryOf({n, file});
    if (!found) return this.said('No /gen try to keep from: /gen try <what> makes one.');
    const name = `gen #${found.n}`;
    const scratch = found.pieces.filter(piece => piece.kind === 'try');
    const wanted = file && this.tryOfPath(file)?.n === found.n && this.tryOfPath(file).inside ? file : mainFile(scratch)?.file ?? join(found.dir, (await filesIn(found.dir))[0]);
    // Not through a link: a sample's run may have made its file one, to anything you can read.
    const source = await pathIn(found.dir, wanted);
    if (!source || !(await noLinks(this.dir, found.dir))) return this.said(`${name}: cannot keep ${relative(found.dir, wanted)}, not a file of its folder.`);
    const sourceName = relative(found.dir, source);
    const target = path.trim() || sourceName;
    const at = await draftPath(this.root, target);
    if (!at) return this.said(`${name}: cannot keep ${sourceName} as ${target}, not a path inside the project.`);
    const keptName = relative(this.root, at.path);
    if (at.exists) return this.said(`${name}: ${keptName} exists already, and /keep makes a new file. /keep <another path>; or copy what you need from ${sourceName}.`);
    const text = await session.bufferText(source).catch(() => readFile(source, 'utf8').catch(() => null));
    if (text === null) return this.said(`${name}: ${sourceName} is gone from its folder.`);
    const body = text.replace(/\n$/, '');
    const old = found.pieces.find(piece => piece.kind === 'file' && piece.file === at.path && piece.state === 'proposed');
    const piece = old ?? {i: found.pieces.length, n: found.n, kind: 'file', file: at.path, line: 1, insert: false, state: 'proposed'};
    Object.assign(piece, {text: body, endLine: lineCount(body), note: `kept from ${sourceName}`, source});
    if (!old) found.pieces.push(piece);
    const kept = found.pieces.filter(one => one.kind === 'file').map(one => relative(this.root, one.file));
    this.rebook(found.action, found, {note: `kept as ${kept.join(', ')}`, undo: true});
    if (found.entry?.state === 'undone') {
      this.session.ledger.update(found.action, {state: null}); // kept again after an undo
      this.sendCard(found.action);
    }
    const shown = await this.showFiles(found.action, found.n, [piece], {open: true});
    // The try's ledger line is the one to undo, which may not be the newest: /undo takes back the newest.
    return this.said(shown ? `${name}: ${keptName} opened, unsaved, generated. :w takes it; u on ${name} in :Pair today takes it back.`
      : `${name}: ${keptName} kept as a buffer to review; it opens in Neovim once one connects.`);
  }

  /**
   * Keeps one file of the scaffold `found` (see scaffoldOf): piece `piece`, the copy's `file`, or the one at `path`
   * in the project, else the only one left. A new file opens as a buffer to review that :w takes, as a file request's;
   * a change to a file of the user's shows in it as suggestions, a hunk each, on their buffer as it is now. A hunk on
   * lines they changed since the copy was made is not shown, and the chat says so.
   */
  async keepTree(found, {path = '', file = null, piece = null} = {}) {
    const name = `gen #${found.n}`;
    const files = found.pieces.filter(one => one.kind === 'tree');
    const wanted = path.trim() && normalize(path.trim());
    const target = Number.isInteger(piece) ? files.find(one => one.i === piece)
      : file && this.scaffoldOfPath(file)?.inside ? files.find(one => one.tree === file)
        : wanted ? files.find(one => relative(this.root, one.file) === wanted)
          : files.filter(one => one.state === 'proposed').length === 1 ? files.find(one => one.state === 'proposed') : null;
    if (found.request && ['asking', 'asks', 'queued', 'generating'].includes(found.request.state)) return this.said(`${name} is still at work: keep its files once it is done.`);
    if (found.data.deleted) return this.said(`${name}: its copy is deleted, so there is nothing left to keep.`);
    if (!target) {
      const left = files.filter(one => one.state === 'proposed').map(one => relative(this.root, one.file));
      if (!left.length) return this.said(`${name}: nothing left to keep. /gen drop deletes its copy.`);
      const which = wanted ? `no file ${wanted} in its copy` : `${plural(left.length, 'file')} to keep`;
      return this.said(`${name}: ${which}: ${left.slice(0, 10).join(', ')}${left.length > 10 ? ', …' : ''}. /keep <path> keeps one; :Pair gen list in Neovim lists them.`);
    }
    const rel = relative(this.root, target.file);
    // Kept, and still to take or taken: kept already. One whose suggestions or buffer went (undone, dismissed) keeps again.
    const live = found.pieces.some(one => one.source === target.tree && ['file', 'hunk'].includes(one.kind) && ['proposed', 'taken'].includes(one.state));
    if (target.keeping || (target.state === 'kept' && live)) return this.said(`${name}: ${rel} is kept already.`);
    target.keeping = true;
    try {
      return await this.keepOne(found, target, rel);
    } finally {
      delete target.keeping;
    }
  }

  /** keepTree for the file `target` (at `rel` in the project) of scaffold `found`. */
  async keepOne(found, target, rel) {
    const session = this.session;
    const name = `gen #${found.n}`;
    const text = await textOf(target.tree);
    if (text === null) return this.said(`${name}: ${rel} is gone from its copy.`);
    // As the user may have changed it in the copy, in Neovim.
    const now = await session.bufferText(target.tree, text).catch(() => text);
    const at = await draftPath(this.root, rel);
    if (!at) return this.said(`${name}: cannot keep ${rel}, not a path inside the project.`);
    await this.touch(found.dir);
    if (!at.exists) {
      const body = now.replace(/\n$/, '');
      const kept = {i: found.pieces.length, n: found.n, kind: 'file', file: at.path, line: 1, endLine: lineCount(body), insert: false, text: body, state: 'proposed', note: `from gen #${found.n}'s copy`, source: target.tree};
      found.pieces.push(kept);
      target.state = 'kept';
      this.keptNote(found);
      const shown = await this.showFiles(found.action, found.n, [kept], {open: true});
      return this.said(shown ? `${name}: ${rel} opened, unsaved, generated. :w takes it.` : `${name}: ${rel} kept as a buffer to review; it opens in Neovim once one connects.`);
    }
    // A file of the user's: the change since the copy was made, as hunks on their buffer now.
    const current = await session.bufferText(at.path).catch(() => null);
    if (current === null) return this.said(`${name}: cannot read ${rel} to show the change in it.`);
    const {hunks, conflicts} = placeHunks(target.base ?? current, now, current);
    const pieces = hunks.map((hunk, k) => ({
      i: found.pieces.length + k, n: found.n, kind: 'hunk', file: at.path, ...hunk, state: 'proposed', source: target.tree,
      note: hunks.length > 1 ? `${rel} · ${k + 1} of ${hunks.length}` : rel,
    }));
    found.pieces.push(...pieces);
    target.state = 'kept';
    this.keptNote(found);
    for (const one of pieces) this.show(one, found.action);
    const skipped = conflicts ? ` ${plural(conflicts, 'change')} not shown: you changed those lines since; copy it from ${target.tree}.` : '';
    if (!pieces.length) return this.said(`${name}: ${rel}: ${conflicts ? 'no change shown.' : 'nothing to change, it is as the copy has it.'}${skipped}`);
    return this.said(`${name}: ${rel}: ${plural(pieces.length, 'change')}, shown there as suggestions; Alt-y (:Pair accept) takes each.${skipped}`);
  }

  /** Books what is kept of scaffold `found` so far, which makes it undoable. */
  keptNote(found) {
    const files = found.pieces.filter(one => one.kind === 'tree');
    const kept = files.filter(one => one.state === 'kept').length;
    this.rebook(found.action, found, {note: `${kept} of ${plural(files.length, 'file')} kept`, undo: true});
    if (found.entry?.state === 'undone') {
      this.session.ledger.update(found.action, {state: null}); // kept again after an undo
      this.sendCard(found.action);
    }
    this.session.notify('editors', {type: 'gen_kept', gen: found.n});
  }

  /** d on a file of a scaffold in :Pair gen list: it is not kept. It stays in the copy, until the copy goes. */
  async dropTree(action, i) {
    const found = await this.scaffoldOf({action});
    const target = found?.pieces.find(one => one.i === i && one.kind === 'tree');
    if (!target || target.state !== 'proposed') return;
    target.state = 'dropped';
    const files = found.pieces.filter(one => one.kind === 'tree');
    this.rebook(action, found, {note: `${files.filter(one => one.state === 'kept').length} of ${plural(files.length, 'file')} kept · ${files.filter(one => one.state === 'dropped').length} dropped`});
    this.said(`gen #${found.n}: ${relative(this.root, target.file)} dropped.`);
  }

  /**
   * x in :Pair gen list, /gen drop, :Pair gen drop: the copy of scaffold `action` (else the newest) is deleted, and
   * what is not kept of it is dropped. A worktree goes with its branch, unless the user committed on it.
   */
  async deleteCopy({action = null} = {}) {
    const found = await this.scaffoldOf({action});
    if (!found) return this.said('No /gen scaffold with a copy to delete.');
    const name = `gen #${found.n}`;
    if (found.request && ['asking', 'asks', 'queued', 'generating'].includes(found.request.state)) return this.said(`${name} is still at work: /gen cancel stops it.`);
    if (found.data.deleted) return this.said(`${name}: its copy is deleted already.`);
    const {removed, branchKept} = await this.removeTree({dir: found.dir, mode: found.data.mode, branch: found.data.branch, base: found.data.base});
    if (!removed) return this.said(`${name}: could not delete ${found.dir}.`);
    const files = found.pieces.filter(one => one.kind === 'tree');
    for (const one of files) if (one.state === 'proposed') one.state = 'dropped';
    const kept = files.filter(one => one.state === 'kept').length;
    this.rebook(found.action, found, {note: `${kept} of ${plural(files.length, 'file')} kept · copy deleted`, deleted: true});
    if (found.request?.state === 'ready') this.setState(found.request, 'done');
    this.session.notify('editors', {type: 'gen_copy_gone', gen: found.n, dir: found.dir});
    const what = found.data.mode === 'worktree' ? `its worktree is deleted${branchKept ? `; the branch ${found.data.branch} has commits of yours, so it stays` : `, and its branch ${found.data.branch}`}` : 'its copy is deleted';
    return this.said(`${name}: ${what}. ${kept ? `${plural(kept, 'file')} kept from it stay` : 'Nothing of it was kept'}.`);
  }

  /** r in :Pair gen list, the run key in a file of a copy: the check runs again in the copy of scaffold `action`. */
  async checkAgain({action = null, n = null, file = null} = {}) {
    const found = await this.scaffoldOf({action, n, file});
    if (!found) return this.said('No /gen scaffold to check.');
    const name = `gen #${found.n}`;
    if (found.data.deleted) return this.said(`${name}: its copy is deleted.`);
    if (found.request && ['asking', 'asks', 'queued', 'generating'].includes(found.request.state)) return this.said(`${name} is still at work.`);
    const check = await this.checkTree({n: found.n, shape: 'scaffold', dir: found.dir});
    if (!check.label) return this.said(`${name} · no check: ${check.none}.`);
    this.rebook(found.action, found, {check: {label: check.label, mark: check.mark, text: check.text}});
    return this.said(`${name} · ${check.mark === 'pass' ? '✓' : '✗'} \`${check.label}\` in the copy: ${check.text}`);
  }

  /** The user runs try `n` (or the one of `file`, or the newest) again; what it showed, for the chat and Neovim. */
  async rerun({n = null, file = null} = {}) {
    const session = this.session;
    // The run key in a file of a scaffold's copy checks the copy again.
    if (this.scaffoldOfPath(file)) return this.checkAgain({file});
    const found = await this.tryOf({n, file});
    if (!found) return this.said('No /gen try to run: /gen try <what> makes one.');
    const command = found.request?.ran?.command ?? found.entry?.data?.command ?? null;
    if (!command) return this.said(`gen #${found.n} has no command to run it by: its model never ran it. Ask in the chat, or run it in a terminal of yours.`);
    const result = await this.runIn({n: found.n}, found.dir, command, {byUser: true});
    if (typeof result === 'string') return this.said(`gen #${found.n} · ${result}`);
    const ran = {command, exit: result.exit, timedOut: result.timedOut};
    const shown = result.output.trimEnd().split('\n').slice(-RAN_LINES).join('\n');
    return this.said(`gen #${found.n} · ${ranText(ran)}${shown ? `\n${shown}` : ''}`);
  }

  said(text) {
    this.session.message('system', text);
    return text;
  }

  /** /gen tries: the tries of the project still in their folders, newest first, with the days they have left. */
  async tries() {
    const rows = this.session.store.actions(this.root, 0).filter(row => row.kind === 'generated' && row.data?.shape === 'try');
    const tries = [];
    for (const one of await triesIn(this.folder)) {
      const row = rows.findLast(each => each.data.gen === one.n);
      const files = await filesIn(one.dir);
      if (!files.length) continue;
      const pieces = row ? this.piecesOf(row.id).pieces : [];
      const main = mainFile(pieces.filter(piece => piece.kind === 'try'))?.file ?? join(one.dir, files[0]);
      tries.push({
        gen: one.n, dir: one.dir, words: row ? (this.session.store.action(row.id)?.detail?.words ?? row.text) : '', files, main,
        left: daysLeft(one.changed, this.keepTries, Date.now()), command: row?.data?.command ?? null,
        kept: pieces.filter(piece => piece.kind === 'file').map(piece => relative(this.root, piece.file)),
      });
    }
    return tries;
  }

  /** What /gen tries says in the chat. */
  async triesText() {
    const tries = await this.tries();
    if (!tries.length) return this.said('No /gen try folders for this project. /gen try <what> makes one.');
    const lines = tries.map(one => `gen #${one.gen} · ${one.words || '(not in the ledger)'} · ${one.files.join(', ')}${one.kept.length ? ` · kept as ${one.kept.join(', ')}` : ''} · ${one.left ? `goes in ${plural(one.left, 'day')}` : 'goes today'}\n  ${one.dir}`);
    return this.said(`${lines.join('\n')}\n:Pair gen tries in Neovim opens one; /keep <path> keeps a file of the newest.`);
  }

  /**
   * read of a file in one of the project's try folders (the gen request's, or the user's question about a try): the
   * file as the editor has it, or the folder's files. Null for any other path.
   */
  async readTry(file, from, to) {
    const tried = this.tryOfPath(file) ?? this.scaffoldOfPath(file);
    if (!tried) return null;
    if (!tried.inside) {
      const files = await filesIn(tried.dir);
      return files.length ? files.join('\n') : `${file} is empty, or gone.`;
    }
    const at = await pathIn(tried.dir, file);
    if (!at) return `Cannot read ${file}: not a file of gen #${tried.n}'s folder.`;
    if (at && !this.tryOfPath(file)) {
      const text = await textOf(at);
      return text === null ? `Cannot read ${file}: not a text file.` : numberedLines(text, from ?? 1, to);
    }
    const text = await this.session.bufferText(at).catch(() => null) ?? (await readFile(at, 'utf8').catch(() => null));
    if (text === null) return `${file} does not exist.`;
    return numberedLines(text, from ?? 1, to);
  }

  /** What the user's questions in the chat are told of the newest try this daemon made, while its folder is there. */
  async tryContext() {
    const request = [...this.requests.values()].reverse().find(one => one.shape === 'try' && one.dir && one.pieces.some(piece => piece.kind === 'try'));
    const files = request ? await filesIn(request.dir) : [];
    const tried = files.length ? `\n\nThe last /gen try, gen #${request.n} ("${request.words}"), is a sample outside the project, in ${request.dir}: ${files.join(', ')}. read takes its files by their full path, such as ${join(request.dir, files[0])}.` : '';
    return tried + (await this.scaffoldContext());
  }

  /** What the user's questions in the chat are told of the newest scaffold this daemon made, while its copy is there. */
  async scaffoldContext() {
    const request = [...this.requests.values()].reverse().find(one => one.shape === 'scaffold' && one.dir && one.pieces.some(piece => piece.kind === 'tree'));
    if (!request || !(await stat(request.dir).catch(() => null))) return '';
    const files = request.pieces.filter(piece => piece.kind === 'tree').map(piece => relative(this.root, piece.file));
    return `\n\nThe last /gen scaffold, gen #${request.n} ("${request.words}"), is in ${this.whereText(request)}: ${files.slice(0, 20).join(', ')}${files.length > 20 ? ', …' : ''}. read takes its files by their full path there, such as ${join(request.dir, files[0])}.`;
  }

  /** Shows the pieces that wait, once the user pauses typing: like an unasked remark, they never land mid-thought. */
  showDue() {
    if (!this.due.length || this.session.typing()) return;
    for (const piece of this.due.splice(0)) this.show(piece);
  }

  /** Shows `piece` in Neovim as a suggestion of ledger entry `action` (the live request's, by default). */
  show(piece, action = this.requests.get(piece.n)?.action) {
    const session = this.session;
    if (!action || piece.state !== 'proposed') return;
    const origin = `gen:#${piece.n}`;
    const shown = session.notify('editor', {
      type: 'suggest', file: piece.file, line: piece.line, endLine: piece.endLine, insert: piece.insert, text: piece.text,
      note: `gen #${piece.n} · ${piece.note}`, action, piece: piece.i, gen: piece.n, origin, aim: true,
    });
    if (!shown) session.message('system', `gen #${piece.n}: no Neovim to show its code in; :Pair start in Neovim, then /gen again.`);
  }

  /** The user took piece `i` of the request booked as ledger entry `action` (Alt-y): from then on /undo can take it back. */
  async taken(action, i, {before, after, from, to}) {
    const session = this.session;
    const entry = session.store.action(action);
    const n = entry?.data?.gen;
    const request = this.requests.get(n);
    const piece = request?.pieces[i] ?? entry?.detail?.pieces?.[i];
    if (!piece || piece.state === 'taken') return;
    // Its lines are marked as generated, part by part, until the user makes them theirs (see owning.mjs).
    Object.assign(piece, {state: 'taken', patch: {file: piece.file, before, after}, from, to, marks: takenMarks(piece.text, from ?? piece.line)});
    const pieces = request?.pieces ?? entry.detail.pieces;
    const taken = pieces.filter(one => one.state === 'taken').length;
    this.rebook(action, {entry, request, pieces}, {note: `${taken} of ${plural(pieces.length, 'piece')} taken`, undo: true});
    session.ledger.update(action, {state: 'applied'});
    session.notify('chat', {type: 'applied', action});
    this.sendMarks(action, n, [piece]);
    if (request && !pieces.some(one => one.state === 'proposed') && ['ready', 'done'].includes(request.state)) this.setState(request, 'done');
    // Checked on the unsaved buffer as after a hand-over; the result shows once, under the lines taken.
    const check = await session.checkGenerated([piece.file]);
    const lines = (to ?? piece.line) - (from ?? piece.line) + 1;
    session.notify('editor', {
      type: 'handback', file: piece.file, line: from ?? piece.line, endLine: to ?? piece.line, changes: [{file: piece.file, line: from ?? piece.line, endLine: to ?? piece.line}],
      text: `gen #${n}: ${plural(lines, 'line')} taken, unsaved`, tests: check?.mark ?? null, check: check ? `${check.label} (unsaved) · ${check.text}` : null,
    });
    session.message('system', `gen #${n}: ${plural(lines, 'line')} taken into ${relative(this.root, piece.file)}, unsaved${check ? `; \`${check.label}\` on the unsaved buffer: ${check.text}` : ''}. /undo takes back the request.`);
  }

  /**
   * The user wrote piece `i`, a proposed file, to its path (:w in its buffer, w in :Pair gen list), as `text`: it is
   * taken. It is an ordinary file of theirs from then on; /undo of the request deletes it while it is as written.
   */
  fileTaken(action, i, text) {
    const found = this.piecesOf(action);
    const piece = found.pieces[i];
    if (!piece || piece.kind !== 'file' || piece.state !== 'proposed') return;
    piece.state = 'taken';
    piece.written = typeof text === 'string' ? text : `${piece.text}\n`;
    piece.marks = writtenMarks(piece.text, piece.written, this.session.now());
    const files = found.pieces.filter(one => one.kind === 'file');
    const taken = files.filter(one => one.state === 'taken').length;
    this.rebook(action, found, {note: `${taken} of ${plural(files.length, 'file')} taken`, undo: true});
    this.session.ledger.update(action, {state: 'applied'});
    this.session.notify('chat', {type: 'applied', action});
    this.sendMarks(action, found.entry.data.gen, [piece]);
    const left = files.filter(one => one.state === 'proposed').length;
    this.session.message('system', `gen #${found.entry.data.gen}: ${relative(this.root, piece.file)} written, taken${left ? `; ${left} more to review` : ''}. /undo takes back the request.`);
    this.settle(found);
  }

  /** A live request with nothing left to take is done. */
  settle({request, pieces}) {
    if (request && !pieces.some(one => one.state === 'proposed') && ['ready', 'done'].includes(request.state)) this.setState(request, 'done');
  }

  /** The user dismissed piece `i` (or edited its lines), or dropped a proposed file: it is dropped, not taken. */
  dropped(action, i) {
    const found = this.piecesOf(action);
    const piece = found.pieces[i];
    if (!piece || piece.state !== 'proposed') return;
    piece.state = 'dropped';
    const taken = found.pieces.some(one => one.state === 'taken');
    const showing = found.pieces.some(one => one.state === 'proposed');
    this.rebook(action, found, {note: `${found.pieces.filter(one => one.state === 'dropped').length} dropped`, undo: taken || showing});
    if (piece.kind === 'file') this.session.message('system', `gen #${found.entry.data.gen}: ${relative(this.root, piece.file)} dropped.`);
    this.settle(found);
  }

  /**
   * /undo of the request booked as ledger entry `action`: it stops if it still runs, what it proposed and was not taken
   * goes, and what was taken is undone, newest first: code merged out of the buffers as they are now, a file written
   * from it deleted while it is as written. Once undone, again makes the code taken again, and the files proposals to
   * review again.
   */
  async undo(action) {
    const session = this.session;
    const n = action.data.gen;
    const request = this.requests.get(n)?.action === action.id ? this.requests.get(n) : null;
    const pieces = request?.pieces ?? action.detail?.pieces ?? [];
    const undone = action.state === 'undone';
    if (!undone && request) this.stop(request, 'undone');
    else if (!undone) session.notify('editors', {type: 'gen_drop', gen: n});
    const taken = pieces.filter(piece => piece.patch && (undone ? piece.state === 'undone' : piece.state === 'taken'));
    const failed = [];
    const unmarked = []; // the marks of what was taken back: no code of Pair's to own any more
    for (const piece of undone ? taken : [...taken].reverse()) {
      const [base, other] = undone ? [piece.patch.before, piece.patch.after] : [piece.patch.after, piece.patch.before];
      const reply = await session.requestEditor({type: 'revert', file: piece.file, base, other, origin: `gen:#${n}`}).catch(error => ({error: error.message}));
      if (reply?.error) failed.push(`${relative(this.root, piece.file)}: ${reply.error}`);
      else {
        if (!undone) unmarked.push(...this.unmark(action.id, piece));
        else piece.marks ??= takenMarks(piece.text, piece.from ?? piece.line);
        piece.state = undone ? 'taken' : 'undone';
      }
    }
    const files = pieces.filter(piece => piece.kind === 'file' && piece.state === (undone ? 'undone' : 'taken'));
    for (const piece of files) {
      if (undone) {
        piece.state = 'proposed';
        continue;
      }
      const reply = await session.requestEditor({type: 'gen_unwrite', file: piece.file, text: piece.written}).catch(error => ({error: error.message}));
      if (reply?.error) failed.push(`${relative(this.root, piece.file)}: ${reply.error}`);
      else {
        piece.state = 'undone';
        unmarked.push(...this.unmark(action.id, piece));
      }
    }
    for (const piece of pieces) if (!undone && piece.state === 'proposed') piece.state = 'dropped';
    const again = undone ? files : [];
    const back = taken.length + files.length - failed.length;
    const left = pieces.filter(piece => piece.state === (undone ? 'undone' : 'taken')).length;
    const state = undone ? (back ? 'applied' : 'undone') : left ? 'applied' : 'undone';
    const booked = pieces.map(({n: _n, ...piece}) => piece);
    session.ledger.update(action.id, {state, data: {undo: true, ...tally(booked)}, detail: {...(action.detail ?? {}), pieces: booked}});
    this.sendCard(action.id);
    if (unmarked.length) session.notify('editors', {type: 'gen_unmark', ids: unmarked});
    if (undone) this.sendMarks(action.id, n, taken.filter(piece => piece.state === 'taken'));
    if (again.length) {
      if (request) this.setState(request, 'ready');
      await this.showFiles(action.id, n, again);
    }
    const deleted = files.filter(piece => piece.state === 'undone').length;
    const what = undone ? `Made gen #${n} again: ${plural(back, 'piece')}`
      : back ? `Undid gen #${n}: took back ${plural(back, 'piece')}`
        : taken.length + files.length ? `Could not undo gen #${n}` : `Undid gen #${n}: nothing was taken`;
    const how = undone ? [taken.length ? 'unsaved' : '', again.length ? `${plural(again.length, 'file')} to review again` : ''].filter(Boolean).join('; ')
      : [back - deleted ? 'unsaved' : '', deleted ? `${plural(deleted, 'file')} you wrote from it deleted` : ''].filter(Boolean).join('; ');
    session.message('system', `${what}${how ? `, ${how}` : ''}.${failed.length ? ` Not changed: ${failed.join('; ')}.` : ''}`);
  }

  /** The marks of `pieces` of ledger entry `action` (request #n) that are still Pair's go to Neovim: ┊ on their lines. */
  sendMarks(action, n, pieces) {
    const marks = pieces.flatMap(piece => this.marksOf(action, n, piece));
    if (marks.length) this.session.notify('editors', {type: 'gen_marks', marks});
  }

  /** The marks of `piece` still Pair's, as Neovim gets them: {id, gen, file, line, text}. */
  marksOf(action, n, piece) {
    return (piece.marks ?? []).filter(mark => mark.state === 'generated')
      .map(mark => ({id: markId(action, piece.i, mark.k), gen: n, file: piece.file, line: mark.line, text: mark.text}));
  }

  /**
   * `piece` was taken back: its marks go from Neovim, and stay in the ledger as they were, so taking it again marks
   * what was Pair's again, and what was the user's stays theirs. Returns the ids of those that were still Pair's.
   */
  unmark(action, piece) {
    return this.marksOf(action, 0, piece).map(mark => mark.id);
  }

  /** The requests of the last DETAIL_KEPT_MS with code taken that is not the user's yet: {action, n, entry, request, pieces}. */
  marked() {
    return this.session.store.actions(this.root, this.session.now() - DETAIL_KEPT_MS)
      .filter(row => row.kind === 'generated' && row.data?.counts?.lines.generated > 0)
      .map(row => ({...this.piecesOf(row.id), action: row.id, n: row.data.gen}));
  }

  /** Every mark still Pair's in the project (in `file`, with one): what a Neovim that connects marks. */
  allMarks(file = null) {
    return this.marked().flatMap(({action, n, pieces}) => pieces
      .filter(piece => piece.state === 'taken' && (!file || piece.file === file))
      .flatMap(piece => this.marksOf(action, n, piece)));
  }

  /**
   * Changes the marks `ids` with `change(mark, id)`, which returns false when it changed nothing; each request's are
   * booked once. Returns the ids of those it changed.
   */
  changeMarks(ids, change) {
    const changed = [];
    const byAction = Map.groupBy(ids.map(id => ({id, ...parseMarkId(id)})).filter(one => one.action !== undefined), one => one.action);
    for (const [action, marks] of byAction) {
      const found = this.piecesOf(action);
      if (found.entry?.kind !== 'generated' || found.entry.root !== this.root) continue;
      for (const {id, piece, k} of marks) {
        const mark = found.pieces[piece]?.state === 'taken' && found.pieces[piece].marks?.find(one => one.k === k);
        if (mark && change(mark, id) !== false) changed.push(id);
      }
      if (marks.some(({id}) => changed.includes(id))) this.rebook(action, found, {});
    }
    return changed;
  }

  /**
   * The user made the marks `ids` theirs: by editing their lines (`how` 'edit', which goes unsaid), or with
   * :Pair own ('own'). Every Neovim takes their ┊ away. Returns how many lines are theirs now.
   */
  own(ids, how = 'own') {
    let lines = 0;
    const owned = this.changeMarks(ids, mark => {
      if (mark.state !== 'generated') return false;
      Object.assign(mark, {state: 'owned', how, at: this.session.now()});
      lines += mark.text.length;
    });
    if (owned.length) this.session.notify('editors', {type: 'gen_unmark', ids: owned});
    if (how === 'own') this.session.message('system', lines ? `${plural(lines, 'line')} of generated code ${lines === 1 ? 'is' : 'are'} yours now.` : 'No generated code there that is not yours already.');
    return lines;
  }

  /** :Pair own! (or O in :Pair today), and :Pair own in a file Neovim has no marks in: all of it (of `file`) is the user's. */
  ownAll(file = null) {
    return this.own(this.allMarks(file).map(mark => mark.id), 'own');
  }

  /** The lines of marks `ids` are gone: deleted, or no longer found by their text. Neither the user's nor Pair's. */
  gone(ids) {
    const gone = this.changeMarks(ids, mark => (mark.state === 'generated' ? void Object.assign(mark, {state: 'gone'}) : false));
    if (gone.length) this.session.notify('editors', {type: 'gen_unmark', ids: gone});
  }

  /**
   * Where Neovim sees marks now, as a buffer is saved or unloaded: {id, line, text}. The ledger keeps it, so a buffer
   * loaded again finds them there by their text.
   */
  moved(marks) {
    const at = new Map(marks.filter(mark => Number.isInteger(mark?.line)).map(mark => [mark.id, mark]));
    this.changeMarks([...at.keys()], (mark, id) => {
      const {line, text} = at.get(id);
      const lines = Array.isArray(text) && text.every(one => typeof one === 'string') ? text : mark.text;
      if (mark.state !== 'generated' || (line === mark.line && lines.join('\n') === mark.text.join('\n'))) return false;
      Object.assign(mark, {line, text: lines});
    });
  }

  /** What Pair's own marks list shows: taken code not the user's yet, per file, with where its first part starts. */
  notYours() {
    const files = new Map();
    for (const mark of this.allMarks()) {
      const file = files.get(mark.file) ?? {file: mark.file, name: relative(this.root, mark.file), lines: 0, line: mark.line, gens: []};
      file.lines += mark.text.length;
      file.line = Math.min(file.line, mark.line);
      if (!file.gens.includes(mark.gen)) file.gens.push(mark.gen);
      files.set(mark.file, file);
    }
    const list = [...files.values()].sort((a, b) => a.name.localeCompare(b.name));
    return {files: list, lines: list.reduce((sum, file) => sum + file.lines, 0)};
  }

  // The gen card: what the chat pane shows of a request under its message, and in the status rule (see chat.mjs).

  /**
   * The card of the request booked as ledger entry `action` (or of `live`, a request not booked yet): its state, how
   * much of it is taken, kept or left, and the keys that still do something on it, each with its words:
   * k keep, Enter open, d drop, u undo. Null for an entry that is no request.
   */
  card(action, live = null) {
    const found = action ? this.piecesOf(action) : null;
    const entry = found?.entry;
    if (action && entry?.kind !== 'generated') return null;
    const request = live ?? found?.request ?? null;
    const n = entry?.data?.gen ?? request.n;
    const shape = entry?.data?.shape ?? request?.shape ?? null;
    const pieces = found?.pieces ?? request?.pieces ?? [];
    const undone = entry?.state === 'undone';
    const running = ['asking', 'asks', 'queued', 'generating'].includes(request?.state);
    const kind = {here: piece => !piece.kind, file: piece => piece.kind === 'file', scaffold: piece => piece.kind === 'tree', try: piece => piece.kind === 'file'}[shape] ?? (() => true);
    const mine = pieces.filter(kind);
    const proposed = mine.filter(piece => piece.state === 'proposed');
    const taken = mine.filter(piece => ['taken', 'kept'].includes(piece.state)).length;
    // A file request's changes to files you have show as suggestions, as code at the cursor does.
    const changes = shape === 'file' && request ? pieces.filter(piece => !piece.kind && piece.state === 'proposed').length : 0;
    // A request of a daemon before a restart: its code at the cursor shows no more, its files to review still do.
    const showing = (shape === 'here' ? (request ? proposed.length : 0) : proposed.length) + changes;
    // The ledger has the last word on undone: a request made again after an undo is not undone any more. Ready
    // with nothing left to take (a scaffold whose files are all kept or dropped) is done.
    let state = undone ? 'undone' : request && request.state !== 'undone' ? request.state : showing ? 'ready' : 'done';
    if (state === 'ready' && !showing) state = 'done';
    const deleted = Boolean(entry?.data?.deleted);
    const keys = {};
    if (!running && !undone && !['cancelled', 'failed'].includes(state)) {
      if (shape === 'here' && showing) Object.assign(keys, {k: 'keep', d: 'drop'});
      if (shape === 'file' && proposed.length) keys.k = 'keep one';
      if (shape === 'file' && showing) keys.d = 'drop all';
      if (shape === 'try' && pieces.some(piece => piece.kind === 'try')) keys.k = 'keep';
      if (shape === 'scaffold' && !deleted && mine.length) Object.assign(keys, proposed.length ? {k: 'keep one'} : {}, {d: 'drop all'});
      if (shape === 'here' && pieces.length) keys.enter = 'open';
      if (shape === 'try' && pieces.some(piece => piece.kind === 'try')) keys.enter = 'open';
      if (shape === 'file' && mine.length) keys.enter = 'open the list';
      if (shape === 'scaffold' && !deleted && mine.length) keys.enter = 'open the list';
    }
    if (!running && entry?.data?.undo && !undone) keys.u = 'undo';
    if (undone && pieces.some(piece => piece.state === 'undone')) keys.u = 'again';
    return {
      type: 'gen_card', gen: n, action: action ?? null, shape, state, since: request?.since ?? entry?.at ?? null,
      of: mine.length, taken, left: proposed.length, keys, ...(changes ? {changes} : {}),
      // Where its question waits, when it asks one: 'editor' (a dialog in Neovim) or 'chat'.
      ...(request?.question ? {asks: request.question.where ?? 'chat'} : {}),
      // A scaffold's files still to keep, for /keep's menu in the chat.
      ...(shape === 'scaffold' && !deleted ? {files: proposed.slice(0, KEEP_LISTED).map(piece => relative(this.root, piece.file))} : {}),
    };
  }

  /** The chat gets the card of `action` (or of `live`, not booked yet) as it is now. */
  sendCard(action, live = null) {
    const card = this.card(action ?? null, action ? null : live);
    if (card) this.session.notify('chat', card);
  }

  /** The cards of today's requests here, for a chat pane that connects: its messages come back with their keys. */
  cards() {
    const booked = this.session.store.actions(this.root, startOfDay(this.session.now())).filter(row => row.kind === 'generated').map(row => this.card(row.id));
    // And those not booked yet: asking their shape or the brief, or waiting their turn.
    const waiting = [...this.requests.values()].filter(request => !request.action && ['asking', 'asks', 'queued'].includes(request.state)).map(request => this.card(null, request));
    return [...booked, ...waiting].filter(Boolean);
  }

  /**
   * d on a gen card in the chat: what request `action` proposed and the user did not take is dropped (its code at the
   * cursor, its files to review); a scaffold's copy is deleted, which drops what was not kept of it.
   */
  async dropAll(action) {
    const found = this.piecesOf(action);
    if (found.entry?.kind !== 'generated') return '';
    const {gen: n, shape} = found.entry.data;
    if (shape === 'scaffold') return this.deleteCopy({action});
    if (found.request && ['asking', 'asks', 'queued', 'generating'].includes(found.request.state)) return this.said(`gen #${n} is still at work: /gen cancel stops it.`);
    const proposed = found.pieces.filter(piece => piece.state === 'proposed');
    if (!proposed.length) return this.said(`gen #${n}: nothing left to drop.`);
    for (const piece of proposed) piece.state = 'dropped';
    this.due = this.due.filter(piece => !proposed.includes(piece));
    this.session.notify('editors', {type: 'gen_drop', gen: n});
    const files = proposed.filter(piece => piece.kind === 'file');
    this.rebook(action, found, {note: `${plural(proposed.length, 'piece')} dropped`, undo: found.pieces.some(piece => piece.state === 'taken')});
    this.settle(found);
    const what = files.length ? `${files.map(piece => relative(this.root, piece.file)).join(', ')} dropped` : 'its code dropped';
    return this.said(`gen #${n}: ${what}.`);
  }

  /**
   * Enter and k on a gen card in the chat: request `action` in Neovim. `what` 'open': the code at the cursor goes to
   * its place, a try to its file, file and scaffold requests to :Pair gen list; 'next': the next file to review opens.
   */
  async open(action, what = 'open') {
    const session = this.session;
    const found = this.piecesOf(action);
    if (found.entry?.kind !== 'generated') return '';
    const {gen: n, shape} = found.entry.data;
    const none = () => this.said('No Neovim is connected to this session: :Pair start in Neovim first.');
    if (what === 'next') {
      const piece = found.pieces.find(one => one.kind === 'file' && one.state === 'proposed');
      if (!piece) return this.said(`gen #${n}: no file left to review.`);
      const reply = await session.requestEditor({type: 'gen_open', action, piece: piece.i}).catch(() => null);
      // A Neovim that lost the buffer (it restarted) makes it again.
      if (!reply?.ok && !(await this.showFiles(action, n, [piece], {open: true}))) return none();
      return '';
    }
    if (shape === 'file' || shape === 'scaffold') return session.notify('editor', {type: 'gen_list_open'}) ? '' : none();
    const target = shape === 'try' ? mainFile(found.pieces.filter(one => one.kind === 'try')) : found.pieces.find(one => one.state === 'proposed') ?? found.pieces[0];
    if (!target) return this.said(`gen #${n}: nothing to open.`);
    return session.notify('editor', {type: 'go', file: target.file, line: target.from ?? target.line ?? 1}) ? '' : none();
  }

  /**
   * The file requests of the last REVIEW_DAYS days, newest first, as :Pair gen list shows them: each file, with its
   * text while it is still to review, so Neovim can open it again after either of them restarted.
   */
  review() {
    const {store} = this.session;
    const rows = store.actions(this.root, this.session.now() - REVIEW_DAYS * DAY).filter(row => row.kind === 'generated' && ['file', 'try', 'scaffold'].includes(row.data?.shape));
    const requests = rows.reverse().map(row => {
      const entry = store.action(row.id);
      const pieces = entry.detail?.pieces ?? [];
      if (row.data.shape === 'try' && !pieces.some(piece => piece.kind === 'file')) return null; // a try with nothing kept
      if (row.data.shape === 'scaffold' && !pieces.some(piece => piece.kind === 'tree')) return null; // nothing made
      const live = this.requests.get(row.data.gen);
      return {
        action: row.id, gen: row.data.gen, shape: row.data.shape, words: entry.detail?.words ?? row.text, at: row.at, state: row.state, note: row.data.note ?? '',
        running: Boolean(live?.action === row.id && ['asking', 'asks', 'queued', 'generating'].includes(live.state)),
        brief: row.data.brief ?? null, check: row.data.check ?? null,
        files: pieces.filter(piece => piece.kind === 'file').map(piece => ({
          piece: piece.i, file: piece.file, name: relative(this.root, piece.file), lines: lineCount(piece.text), state: piece.state, note: piece.note ?? '',
          ...(piece.state === 'proposed' ? {text: piece.text} : {}),
        })),
        changes: pieces.filter(piece => !['file', 'try', 'tree'].includes(piece.kind)).map(piece => ({name: relative(this.root, piece.file), line: piece.line, state: piece.state})),
        ...(row.data.shape === 'scaffold' ? {
          dir: row.data.dir, mode: row.data.mode ?? 'copy', branch: row.data.branch ?? null, deleted: Boolean(row.data.deleted),
          tree: pieces.filter(piece => piece.kind === 'tree').map(piece => {
            const kept = pieces.find(one => one.kind === 'file' && one.source === piece.tree);
            const hunks = pieces.filter(one => one.kind === 'hunk' && one.source === piece.tree);
            return {
              piece: piece.i, name: relative(this.root, piece.file), file: piece.file, tree: piece.tree, state: piece.state, isNew: piece.base === null,
              added: piece.added ?? 0, removed: piece.removed ?? 0, ...(kept ? {kept: kept.i} : {}),
              ...(hunks.length ? {hunks: hunks.length, taken: hunks.filter(one => one.state === 'taken').length} : {}),
            };
          }),
        } : {}),
        contradicts: (entry.detail?.debrief ?? []).filter(line => line.startsWith('≠')),
        guessed: entry.detail?.guessed ?? [],
      };
    }).filter(Boolean);
    return {type: 'gen_review', requests};
  }

  /**
   * What a Neovim that connects gets to make buffers of the files still to review: it may have restarted, or not
   * have them at all. One that has them keeps its own, with what the user changed in them.
   */
  reopen() {
    return this.review().requests.filter(request => !request.running && request.files.some(file => file.state === 'proposed')).map(request => {
      const {detail} = this.session.store.action(request.action);
      const proposed = detail.pieces.filter(piece => piece.kind === 'file' && piece.state === 'proposed');
      return {...this.filesMessage(request.action, request.gen, proposed, detail.contradicts ?? []), reopen: true};
    });
  }

  /**
   * Alt-d on `? guessed` line `i` of the request booked as `action`, in :Pair gen list: the guess is logged as a
   * decision in decisions.md next to the brief's note (else at the project root), in the buffer, which the user saves.
   */
  async decide(action, i) {
    const session = this.session;
    const entry = session.store.action(action);
    const guess = entry?.kind === 'generated' && entry.detail?.guessed?.[i];
    if (!guess) return;
    const brief = await this.brief();
    const logPath = join(brief.note?.path ? dirname(brief.note.path) : this.root, LOG_NAME);
    const [first] = entry.detail.pieces ?? [];
    const decision = guess.charAt(0).toUpperCase() + guess.slice(1);
    const result = logDecision(await session.bufferText(logPath).catch(() => ''), {
      date: day(session.now()), text: decision, file: first ? relative(this.root, first.file) : relative(this.root, logPath), line: first?.line ?? 1, section: null,
      asked: `gen #${entry.data.gen}: ${entry.detail.words ?? entry.text}`,
    });
    const name = relative(this.root, logPath);
    if (!result) return session.message('system', `That decision is in ${name} already.`);
    session.notify('editor', {type: 'decision_log', file: logPath, text: result.text, line: result.line, name});
    session.message('system', `Logged in ${name}: ${decision}. Save it to keep it.`);
  }

  /** What /gen alone shows: today's requests in this project, one line each, and what is not the user's yet. */
  list() {
    const rows = this.session.store.actions(this.root, startOfDay(this.session.now())).filter(action => action.kind === 'generated');
    const notYours = notYoursLine(this.notYours());
    const own = notYours ? `\n${notYours} · :Pair own in Neovim makes it yours, :Pair today lists it` : '';
    if (!rows.length && own) return this.session.message('system', `No /gen requests here today.${own}`);
    if (!rows.length) return this.session.message('system', 'No /gen requests here today. /gen here <what> asks for code at your cursor in Neovim; /gen file <what> for new files; /gen try <what> for a sample to run; /gen scaffold <what> for many files, built in a copy.');
    const lines = rows.map(row => `${new Date(row.at).toTimeString().slice(0, 5)}  ${row.text}${row.data?.note ? ` · ${row.data.note}` : ''}${row.state === 'undone' ? ' (undone)' : ''}`);
    this.session.message('system', `${lines.join('\n')}\n/undo takes back the last one; u in :Pair today any of them.${own}`);
  }

  /** The session ends: nothing runs or waits any more. */
  close() {
    for (const request of this.requests.values()) {
      if (['asking', 'asks', 'queued', 'generating'].includes(request.state)) this.stop(request, 'cancelled');
    }
  }
}
