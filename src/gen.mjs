// /gen: the user asks Pair for code. Each request has a number (gen #3), a shape, a conversation of its own on the
// Partner's model with the gen tool set (see tools.mjs), its pieces and its limits. A request never edits the user's
// text: it proposes, and the user takes a proposal into their buffer, unsaved, with one key. Code taken from a request
// is Pair's (origin gen:#n, see fold.mjs) until the user edits it. The ledger books a request as one line with its
// pieces, and /undo takes back all of it: what was taken goes, what was not is dropped.
//
// Every request runs against the brief (see brief.mjs): the goal, the board task and a note, NOTES.md by default.
// When the request contradicts it, Pair asks one question before generating; after, the debrief says where the code
// goes against the brief (≠ brief) and what it decided that nobody said (? guessed).
//
// One request runs at a time; others wait their turn. While one runs, Pair makes no remark nobody asked for, and the
// user's questions in the chat still get answers, in the session's own conversation. This version builds three
// shapes: here (code at the cursor, or over the selection), file (new files, as pair://gen/<n>/<path> buffers in
// Neovim that :w in one writes to its real path) and try (a sample in a folder of its own outside the project, which
// the model writes and runs there in the sandbox, and which opens in a split; /keep moves a file of it into the project
// as a buffer to review, as a file request's). Scaffold is named, guessed and confirmed, but not built yet. The ledger
// keeps each proposed file's text, so Neovim gets its buffers again after a restart of either.
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, sep} from 'node:path';
import {
  briefEmpty, briefLine, briefText, CHECK_PROMPT, checkInput, CONFLICT_PROMPT, conflictInput, exceptionKey, parseCheck,
  parseConflict, quotePlace, readBrief,
} from './brief.mjs';
import {commandPolicy} from './command-policy.mjs';
import {GEN_BRIEF, GEN_KEEP_TRIES, GEN_LIMITS} from './config.mjs';
import {logDecision, LOG_NAME} from './decision-log.mjs';
import {draftPath, numberedLines, projectFile} from './files.mjs';
import {daysLeft, expireTries, filesIn, freshFolder, pathIn, projectFolder, tryFolder, tryLine, triesIn, trySandboxed} from './gen-tree.mjs';
import {gitFiles} from './git.mjs';
import {keptOutput, startOfDay} from './ledger.mjs';

export const SHAPES = ['here', 'file', 'scaffold', 'try'];
const BUILT = new Set(['here', 'file', 'try']);
/** What each shape makes, as the shape question lists it. */
export const SHAPE_WHAT = {
  here: 'at the cursor, over a selection',
  file: 'new files to review',
  scaffold: 'many files, in Pair\'s copy',
  try: 'a sample outside the project',
};

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
   * /gen's folder in Pair's data folder (gen-tree.mjs), where the tries go: `keepTries` days, run in the sandbox as
   * `sandbox` (scoutPane.sandbox) says, with the network only when `network`.
   */
  constructor({session, limits = GEN_LIMITS, brief = GEN_BRIEF, ask = null, dir, keepTries = GEN_KEEP_TRIES, network = false, sandbox = 'auto'}) {
    this.session = session;
    this.limits = limits;
    this.briefName = brief;
    this.askModel = ask;
    this.dir = dir;
    this.folder = projectFolder(dir, session.root); // this project's
    Object.assign(this, {keepTries, network, sandbox});
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
    const words = parsed.words;
    const named = SHAPES.includes(shape) ? shape : parsed.shape;
    session.message('user', `/gen ${[named, words].filter(Boolean).join(' ')}`);
    session.usedAt = session.now();
    session.worked = true;
    if (!words) return session.message('system', 'Say what Pair should write: /gen here a function that …');
    const request = {
      n: this.next(), words, shape: named, given: Boolean(named), here, selection, place, token, from,
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
    if (!BUILT.has(request.shape)) {
      return this.end(request, 'cancelled', `gen #${request.n}: /gen ${request.shape} (${SHAPE_WHAT[request.shape]}) is not built yet; this version has /gen here, /gen file and /gen try.`);
    }
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
    if (request.shape === 'try') {
      request.dir = tryFolder(this.folder, request.n);
      await this.expire();
      await freshFolder(request.dir).catch(error => session.log(`gen #${request.n}: its folder: ${error.message}`));
    }
    request.action = session.ledger.add('generated', `gen #${request.n} · ${request.shape} · ${request.words}`, {
      data: {
        gen: request.n, shape: request.shape, ...(here ? {place: {file: request.file, line: request.selection?.from ?? request.place.line}} : {}),
        ...(request.dir ? {dir: request.dir} : {}),
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
      this.running = null;
    }
    await this.finish(request, failure);
    const next = this.queue.shift();
    if (next) await this.run(next);
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
    if (!this.askModel || !brief || briefEmpty(brief) || !request.pieces.length) return {contradicts: [], guessed: []};
    try {
      const answer = await this.askModel(CHECK_PROMPT, checkInput({...brief, asAsked: request.asAsked}, request.words, request.pieces, this.root));
      return parseCheck(answer, brief, request.pieces, this.exceptions);
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
    if (failure || request.over) {
      const why = failure ? `Pair could not finish it: ${failure}` : `stopped: ${request.over}`;
      this.book(request, {note: request.pieces.length ? `${plural(request.pieces.length, 'piece')} · ${why}` : why});
      if (!request.pieces.length) {
        this.book(request, {undo: false});
        return this.end(request, 'failed', `${n} · ${why}.`);
      }
      session.message('system', `${n} · ${why}; what it proposed so far shows.`);
    }
    if (!request.pieces.length) {
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
      ...(!files.length ? [] : shown ? ['In Neovim, :w in one writes it to its path; :Pair gen list lists them.'] : ['No Neovim shows them now: they open there as buffers once one connects.']),
    ];
    session.message('pair', lines.join('\n'), {gen: request.n});
    if (request.pieces.some(piece => piece.state === 'proposed')) this.setState(request, 'ready');
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
      opened ? `In Neovim: ${relative(request.dir, main.file)} in a split, outside the project. ${ran ? 'Your run key runs it again; ' : ''}/keep <path> moves it into the project, as a buffer to review. The folder stays ${plural(this.keepTries, 'day')} after it last changed (/gen tries).`
        : `No Neovim to open it in: it is in ${request.dir}. /keep <path> moves it into the project once one connects.`,
    ];
    if (!cut || files.length) session.message('pair', lines.join('\n'), {gen: request.n});
    this.setState(request, 'done');
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
    const tried = this.tryOfPath(file);
    return tried ? relative(tried.dir, file) : relative(this.root, file);
  }

  /** Writes the request's ledger entry anew: `data` merged, and its pieces as they are now. */
  book(request, data = {}) {
    if (!request.action) return;
    const pieces = request.pieces.map(({i, kind, file, line, endLine, insert, text, note, state, patch, from, to, written, source}) => ({i, kind, file, line, endLine, insert, text, note, state, patch, from, to, written, source}));
    const check = request.check ? {contradicts: request.check.contradicts, guessed: request.check.guessed, debrief: request.debrief ?? []} : {};
    this.session.ledger.update(request.action, {data, detail: {words: request.words, pieces, ...check}});
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
    this.session.ledger.update(action, {data, detail: {...(entry.detail ?? {}), pieces}});
  }

  /**
   * Asks the user about `request` where they asked for it: in Neovim as a dialog, else in the chat. `kind` 'shape'
   * resolves with a shape (the `guess` first) or null; 'question' with the answer, `answer` when they keep the one
   * given, or null when they leave it to Pair; 'brief', about a `conflict` with the brief at `place`, with y (as
   * asked), n (follow the brief) or e (open the brief there).
   */
  async question(request, {kind, title, guess = null, answer = '', conflict = null, place = null}) {
    const session = this.session;
    const id = ++this.asked;
    const choices = kind === 'shape' ? [guess, ...SHAPES.filter(shape => shape !== guess)]
      : kind === 'brief' ? ['n', 'y', ...(conflict.source === 'note' ? ['e'] : [])] : null;
    const waiting = new Promise(resolve => { request.question = {id, kind, title, choices, answer, conflict, place, resolve}; });
    const options = kind === 'shape' ? choices.map(shape => ({shape, what: SHAPE_WHAT[shape], built: BUILT.has(shape), guessed: shape === guess}))
      : kind === 'brief' ? choices.map(key => ({
        key,
        what: {n: `follow the brief: ${conflict.says}`, y: `as asked: ${conflict.asked}`, e: `open ${place}`}[key],
        ...(key === 'e' ? {file: request.brief.note.path, line: conflict.line} : {}),
      })) : undefined;
    const asked = request.from === 'editor' && session.notify('editor', {
      type: 'gen_ask', gen: request.n, id, kind, title, answer, choices: options,
      ...(conflict ? {quote: conflict.text, place} : {}),
    });
    if (request.state === 'generating') this.pause(request);
    this.setState(request, request.state === 'generating' ? 'asks' : 'asking');
    if (asked) {
      if (kind === 'question') session.message('system', `${title} (default: ${answer || 'none'}; answer in Neovim)`);
      if (kind === 'brief') session.message('system', `${title}: "${conflict.text}" ${place}. ${conflict.asked} anyway? (answer in Neovim)`);
    } else {
      this.inChat(request, request.question);
    }
    const result = await waiting;
    request.question = null;
    if (request.state === 'asks') {
      this.setState(request, 'generating');
      this.clock(request);
    }
    return result;
  }

  /**
   * The question as the chat asks it: y keeps the guess or the answer given, n leaves it, other words answer. About
   * the brief: y as asked, n (or Esc) follows the brief, e opens it.
   */
  inChat(request, question) {
    const session = this.session;
    const {kind, title, choices, answer} = question;
    if (kind === 'brief') {
      const {conflict, place} = question;
      const open = choices.includes('e') ? ` · e open ${place}` : '';
      const asking = session.confirm(`${title}:\n│ "${conflict.text}" ${place}\n${conflict.asked} anyway?`, choices.includes('e') ? ['e'] : [], {
        timeoutMs: null, hint: `y as asked · n follow the brief (${conflict.says})${open}`, said: () => null,
      });
      question.confirm = session.lastConfirmation;
      asking.then(result => this.answered(request, question.id, result === true ? 'y' : result === 'e' ? 'e' : 'n'));
      return;
    }
    const others = choices?.slice(1).join(', ');
    const text = kind === 'shape' ? `${title} y: ${choices[0]}, or type ${others}; n cancels.` : `${title} y keeps \`${answer}\`, n leaves it to Pair, or type your answer.`;
    const asking = session.confirm(text, choices ?? [], {
      free: kind === 'question', timeoutMs: null,
      hint: kind === 'shape' ? `y: ${choices[0]} · ${others} · n cancels` : `y keeps ${answer} · n leaves it to Pair · or your answer`,
      said: result => (result === false && kind === 'question' ? `gen #${request.n}: left to Pair.` : null), // a cancel says so itself
    });
    question.confirm = session.lastConfirmation;
    asking.then(result => this.answered(request, question.id, result === true ? (choices?.[0] ?? answer) : result || null));
  }

  /** The user's answer to question `id` of request `n` (Neovim's gen_answer): the first answer counts. */
  answer(n, id, text) {
    const request = this.requests.get(n);
    if (!request?.question || request.question.id !== id) return;
    this.answered(request, id, typeof text === 'string' ? text : null);
  }

  answered(request, id, text) {
    const question = request.question;
    if (!question || question.id !== id) return;
    if (question.kind === 'shape') return question.resolve(SHAPES.includes(text) ? text : null);
    if (question.kind === 'brief') return question.resolve(question.choices.includes(text) ? text : null);
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
    if (name === 'read') return session.read(args);
    if (name === 'recall') return session.recall(args);
    if (name === 'search') {
      if (++request.commands > request.limits.commands) return `That is ${request.limits.commands} searches for this request (gen.limits.commands): propose with what you found.`;
      return session.search(args, {gen: true}).catch(error => `Not searched: ${error.message}`);
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
    const path = await projectFile(this.root, file);
    if (!path) return `No file ${file} in the project`;
    if (request.shape === 'here' && path !== request.file) return `This request is /gen here in ${relative(this.root, request.file)}: propose there.`;
    if (endLine < line) return `end_line ${endLine} is before line ${line}`;
    const buffer = (await session.bufferText(path)).split('\n');
    const count = buffer.length;
    if (line > count) return `Line ${line} is past the end of ${file}, which has ${count} lines. Read it first.`;
    const lines = lineCount(text);
    if (!lines) return 'propose needs the code: text has no lines.';
    if (request.lines + lines > request.limits.lines) return `That is more than ${request.limits.lines} lines for this request (gen.limits.lines): propose less, or say what is left.`;
    if (!request.files.has(path) && request.files.size >= request.limits.files) return `That is ${request.limits.files} files for this request (gen.limits.files).`;
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
    if (request.shape !== 'file') return `This request is /gen ${request.shape}: draft makes new files only in a /gen file request. Call propose.`;
    const at = await draftPath(this.root, path);
    if (!at) return `Cannot draft ${path}: not a path inside the project.`;
    const name = relative(this.root, at.path);
    if (at.exists) return `${name} exists already, and draft makes new files only. To change it, read it and call propose there: the user gets that as a suggestion.`;
    const body = text.replace(/\n$/, '');
    const lines = lineCount(body);
    if (!lines) return 'draft needs the file: text has no lines.';
    const old = request.pieces.find(piece => piece.kind === 'file' && piece.file === at.path);
    if (request.lines - (old ? lineCount(old.text) : 0) + lines > request.limits.lines) return `That is more than ${request.limits.lines} lines for this request (gen.limits.lines): draft less, or say what is left.`;
    if (!request.files.has(at.path) && request.files.size >= request.limits.files) return `That is ${request.limits.files} files for this request (gen.limits.files).`;
    request.lines += lines - (old ? lineCount(old.text) : 0);
    request.files.add(at.path);
    if (old) Object.assign(old, {text: body, note, endLine: lines});
    else request.pieces.push({i: request.pieces.length, n: request.n, kind: 'file', file: at.path, line: 1, endLine: lines, insert: false, text: body, note, state: 'proposed'});
    this.book(request);
    return `Drafted ${name}${old ? ' anew' : ''}, ${plural(lines, 'line')}. Once you are done, the user reviews it as an unsaved buffer and writes it to ${name}, or not.`;
  }

  /** A file of a try request's sample, written in its folder at once: the folder is Pair's, not the project. */
  async write(request, {path, text}) {
    if (request.shape !== 'try') return `This request is /gen ${request.shape}: write works only in a /gen try request. ${request.shape === 'file' ? 'Call draft.' : 'Call propose.'}`;
    const at = await pathIn(request.dir, path);
    if (!at) return `Cannot write ${path}: not a path inside your folder ${request.dir}.`;
    const name = relative(request.dir, at);
    const body = text.replace(/\n$/, '');
    const lines = lineCount(body);
    if (!lines) return 'write needs the file: text has no lines.';
    const old = request.pieces.find(piece => piece.kind === 'try' && piece.file === at);
    if (request.lines - (old ? lineCount(old.text) : 0) + lines > request.limits.lines) return `That is more than ${request.limits.lines} lines for this request (gen.limits.lines): write less, or say what is left.`;
    if (!request.files.has(at) && request.files.size >= request.limits.files) return `That is ${request.limits.files} files for this request (gen.limits.files).`;
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
    if (request.shape !== 'try') return 'run works only in a /gen try request, in its own folder. Here Pair checks your code once the user takes it: do not run anything.';
    if (++request.commands > request.limits.commands) return `That is ${request.limits.commands} commands for this request (gen.limits.commands): say what you have.`;
    const result = await this.runIn(request, request.dir, command);
    if (typeof result === 'string') return result;
    request.ran = {command, exit: result.exit, timedOut: result.timedOut};
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
    if (policy.verdict === 'ask' && !sandboxed && !byUser
      && !(await session.allowed(command, `May I run \`${command}\` in gen #${request.n}'s folder, outside the project (${policy.reason})? There is no sandbox here.`))) {
      return 'The user did not allow it. Do not run it another way.';
    }
    let result;
    try {
      result = await session.inPane(tryLine(dir, command, {sandboxed, network: this.network}), {gen: true});
    } catch (error) {
      return `Not run: ${error.message}.`;
    }
    session.ledger.add('ran', `${command} (gen #${request.n}'s try)`, {
      data: {note: result.timedOut ? 'stopped' : result.exit ? `exit ${result.exit}` : undefined, result: result.exit === 0 && !result.timedOut ? 'pass' : 'fail'},
      detail: {output: keptOutput(result.output)},
    });
    return result;
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
   * (else its path in the folder), as a buffer to review that :w takes, like a file request's. Only a new file.
   */
  async keep({path = '', file = null, n = null} = {}) {
    const session = this.session;
    const found = await this.tryOf({n, file});
    if (!found) return this.said('No /gen try to keep from: /gen try <what> makes one.');
    const name = `gen #${found.n}`;
    const scratch = found.pieces.filter(piece => piece.kind === 'try');
    const source = file && this.tryOfPath(file)?.n === found.n && this.tryOfPath(file).inside ? file : mainFile(scratch)?.file ?? join(found.dir, (await filesIn(found.dir))[0]);
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
    const shown = await this.showFiles(found.action, found.n, [piece], {open: true});
    return this.said(shown ? `${name}: ${keptName} opened, unsaved, generated. :w takes it; /undo takes back ${name}.`
      : `${name}: ${keptName} kept as a buffer to review; it opens in Neovim once one connects.`);
  }

  /** The user runs try `n` (or the one of `file`, or the newest) again; what it showed, for the chat and Neovim. */
  async rerun({n = null, file = null} = {}) {
    const session = this.session;
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
    const tried = this.tryOfPath(file);
    if (!tried) return null;
    if (!tried.inside) {
      const files = await filesIn(tried.dir);
      return files.length ? files.join('\n') : `${file} is empty, or gone.`;
    }
    const at = await pathIn(tried.dir, file);
    if (!at) return `Cannot read ${file}: not a file of gen #${tried.n}'s folder.`;
    const text = await this.session.bufferText(at).catch(() => null) ?? (await readFile(at, 'utf8').catch(() => null));
    if (text === null) return `${file} does not exist.`;
    return numberedLines(text, from ?? 1, to);
  }

  /** What the user's questions in the chat are told of the newest try this daemon made, while its folder is there. */
  async tryContext() {
    const request = [...this.requests.values()].reverse().find(one => one.shape === 'try' && one.dir && one.pieces.some(piece => piece.kind === 'try'));
    if (!request) return '';
    const files = await filesIn(request.dir);
    if (!files.length) return '';
    return `\n\nThe last /gen try, gen #${request.n} ("${request.words}"), is a sample outside the project, in ${request.dir}: ${files.join(', ')}. read takes its files by their full path, such as ${join(request.dir, files[0])}.`;
  }

  /** Shows the pieces that wait, once the user pauses typing: like an unasked remark, they never land mid-thought. */
  showDue() {
    if (!this.due.length || this.session.typing()) return;
    for (const piece of this.due.splice(0)) this.show(piece);
  }

  show(piece) {
    const session = this.session;
    const request = this.requests.get(piece.n);
    if (!request || piece.state !== 'proposed') return;
    const origin = `gen:#${piece.n}`;
    const shown = session.notify('editor', {
      type: 'suggest', file: piece.file, line: piece.line, endLine: piece.endLine, insert: piece.insert, text: piece.text,
      note: `gen #${piece.n} · ${piece.note}`, action: request.action, piece: piece.i, gen: piece.n, origin, aim: true,
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
    Object.assign(piece, {state: 'taken', patch: {file: piece.file, before, after}, from, to});
    const pieces = request?.pieces ?? entry.detail.pieces;
    const taken = pieces.filter(one => one.state === 'taken').length;
    if (request) this.book(request, {note: `${taken} of ${plural(pieces.length, 'piece')} taken`, undo: true});
    else session.ledger.update(action, {data: {note: `${taken} of ${plural(pieces.length, 'piece')} taken`, undo: true}, detail: {...entry.detail, pieces}});
    session.ledger.update(action, {state: 'applied'});
    session.notify('chat', {type: 'applied', action});
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
    const files = found.pieces.filter(one => one.kind === 'file');
    const taken = files.filter(one => one.state === 'taken').length;
    this.rebook(action, found, {note: `${taken} of ${plural(files.length, 'file')} taken`, undo: true});
    this.session.ledger.update(action, {state: 'applied'});
    this.session.notify('chat', {type: 'applied', action});
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
    for (const piece of undone ? taken : [...taken].reverse()) {
      const [base, other] = undone ? [piece.patch.before, piece.patch.after] : [piece.patch.after, piece.patch.before];
      const reply = await session.requestEditor({type: 'revert', file: piece.file, base, other, origin: `gen:#${n}`}).catch(error => ({error: error.message}));
      if (reply?.error) failed.push(`${relative(this.root, piece.file)}: ${reply.error}`);
      else piece.state = undone ? 'taken' : 'undone';
    }
    const files = pieces.filter(piece => piece.kind === 'file' && piece.state === (undone ? 'undone' : 'taken'));
    for (const piece of files) {
      if (undone) {
        piece.state = 'proposed';
        continue;
      }
      const reply = await session.requestEditor({type: 'gen_unwrite', file: piece.file, text: piece.written}).catch(error => ({error: error.message}));
      if (reply?.error) failed.push(`${relative(this.root, piece.file)}: ${reply.error}`);
      else piece.state = 'undone';
    }
    for (const piece of pieces) if (!undone && piece.state === 'proposed') piece.state = 'dropped';
    const again = undone ? files : [];
    const back = taken.length + files.length - failed.length;
    const left = pieces.filter(piece => piece.state === (undone ? 'undone' : 'taken')).length;
    const state = undone ? (back ? 'applied' : 'undone') : left ? 'applied' : 'undone';
    session.ledger.update(action.id, {state, data: {undo: true}, detail: {...(action.detail ?? {}), pieces: pieces.map(({n: _n, ...piece}) => piece)}});
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

  /**
   * The file requests of the last REVIEW_DAYS days, newest first, as :Pair gen list shows them: each file, with its
   * text while it is still to review, so Neovim can open it again after either of them restarted.
   */
  review() {
    const {store} = this.session;
    const rows = store.actions(this.root, this.session.now() - REVIEW_DAYS * DAY).filter(row => row.kind === 'generated' && ['file', 'try'].includes(row.data?.shape));
    const requests = rows.reverse().map(row => {
      const entry = store.action(row.id);
      const pieces = entry.detail?.pieces ?? [];
      if (row.data.shape === 'try' && !pieces.some(piece => piece.kind === 'file')) return null; // a try with nothing kept
      const live = this.requests.get(row.data.gen);
      return {
        action: row.id, gen: row.data.gen, shape: row.data.shape, words: entry.detail?.words ?? row.text, at: row.at, state: row.state, note: row.data.note ?? '',
        running: Boolean(live?.action === row.id && ['asking', 'asks', 'queued', 'generating'].includes(live.state)),
        brief: row.data.brief ?? null, check: row.data.check ?? null,
        files: pieces.filter(piece => piece.kind === 'file').map(piece => ({
          piece: piece.i, file: piece.file, name: relative(this.root, piece.file), lines: lineCount(piece.text), state: piece.state, note: piece.note ?? '',
          ...(piece.state === 'proposed' ? {text: piece.text} : {}),
        })),
        changes: pieces.filter(piece => !['file', 'try'].includes(piece.kind)).map(piece => ({name: relative(this.root, piece.file), line: piece.line, state: piece.state})),
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

  /** What /gen alone shows: today's requests in this project, one line each. */
  list() {
    const rows = this.session.store.actions(this.root, startOfDay(this.session.now())).filter(action => action.kind === 'generated');
    if (!rows.length) return this.session.message('system', 'No /gen requests here today. /gen here <what> asks for code at your cursor in Neovim; /gen file <what> for new files; /gen try <what> for a sample to run.');
    const lines = rows.map(row => `${new Date(row.at).toTimeString().slice(0, 5)}  ${row.text}${row.data?.note ? ` · ${row.data.note}` : ''}${row.state === 'undone' ? ' (undone)' : ''}`);
    this.session.message('system', `${lines.join('\n')}\n/undo takes back the last one; u in :Pair today any of them.`);
  }

  /** The session ends: nothing runs or waits any more. */
  close() {
    for (const request of this.requests.values()) {
      if (['asking', 'asks', 'queued', 'generating'].includes(request.state)) this.stop(request, 'cancelled');
    }
  }
}
