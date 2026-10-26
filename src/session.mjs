// One pairing session: folds its events, decides when Pair speaks and carries out the Partner's tools.
import {readFile} from 'node:fs/promises';
import {isAbsolute, relative} from 'node:path';
import {Budget} from './budget.mjs';
import {commandPolicy} from './command-policy.mjs';
import {describeState} from './describe.mjs';
import {insideRoot, numberedLines, projectFile, readProjectPath} from './files.mjs';
import {fold, initialState} from './fold.mjs';
import {decide} from './gate.mjs';
import {gitStatus} from './git.mjs';
import {plainLine} from './herdr.mjs';
import {RUN_TIMEOUT_MS, shellQuote} from './scout-pane.mjs';
import {parseTestOutput, testSummary} from './test-output.mjs';
import {detectTriggers} from './triggers.mjs';
import {tuning, WINDOW_MS} from './tuning.mjs';

const SILENT = /^\W*silent\W*$/i;

// What the Partner should check for each kind of trigger. Small models follow an instruction in the
// message far better than a general rule in the system prompt.
const CHECKS = {
  failed_command: 'Find the cause of the failure, point at it and say it in one sentence.',
  repeated_error: 'The same error came back. Find the cause, point at it and say it in one sentence.',
  new_code_diagnostic: 'Point at the line and say the fix in a few words.',
  stall: 'The user seems stuck on this failure. Give one concrete next step.',
  drift: 'Do not help with the goal itself. If the recent work is related to the goal, answer exactly SILENT. If it is unrelated, say in one sentence what drifted.',
};

export function watchInput(trigger, description) {
  return `[watch] ${trigger.kind}: ${trigger.detail}\n\nNow:\n${description}\n\n${CHECKS[trigger.kind]} If no remark would help, answer exactly SILENT.`;
}

/**
 * What the Partner is asked when the user hands over the wheel: `words` are theirs ("you take it, ...",
 * "your turn"), or empty for a bare :Pair drive.
 */
export function driveInput(words, description) {
  const request = words ? `The user said: "${words}"` : 'The user gave no request: make the change you two talked about last.';
  return `[drive] The user handed you the wheel for one change. ${request}\n\nNow:\n${description}\n\n`
    + 'If they said "your turn", they just wrote a failing test (see the recent edits): read it and the code it tests, '
    + 'and make it pass by changing the code, not the test. Read before you edit. If you do not know what to change, '
    + 'ask one short question instead of editing.';
}

const ROLE_NOTES = {
  navigator: 'Role: Navigator. Pair watches, comments and points at code.',
  scout: 'Role: Scout. Pair can also search and run read-only, test and build commands in its own pane; anything else asks you first.',
  driver: 'Role: Driver. Pair has the wheel for one change; any key in Neovim takes it back.',
};

const CONFIRM_MS = 60_000;
const PANE_USES_PER_TURN = 4; // small steps: a few searches or commands per question, not a long plan
const SEARCH_LINES = 50;
const RUN_OUTPUT_CHARS = 3000;

/** The last `max` characters of `text`, saying so when it is cut. */
const tail = (text, max) => (text.length > max ? `(earlier output cut)\n${text.slice(-max)}` : text);

/** What the Partner is told about a command Scout ran. */
export function runReport(result) {
  const lines = [result.timedOut ? `Still running after ${RUN_TIMEOUT_MS / 1000} s, so it was stopped with Ctrl-C.` : `exit ${result.exit}`];
  const tests = parseTestOutput(result.output);
  if (tests) lines.push(`Tests (${tests.runner}): ${testSummary(tests)}`);
  lines.push(tail(result.output, RUN_OUTPUT_CHARS) || '(no output)');
  return lines.join('\n');
}

const NOTE_CHANGES = 20; // lines of git status the note request shows

/** What the Partner is asked at the end: the note the next session in this project starts from. */
export function noteInput(state, changes) {
  const lines = changes ? changes.split('\n') : [];
  const shown = lines.length > NOTE_CHANGES ? [...lines.slice(0, NOTE_CHANGES), `(${lines.length - NOTE_CHANGES} more)`] : lines;
  return `[end] The session is over. Write a short session note in plain text, at most 6 lines, for the next session in this project:
the goal, what changed, and loose ends. No heading and no tool calls.

Goal: ${state.goal ?? '(not set)'}
Uncommitted changes (git status): ${shown.length ? `\n${shown.join('\n')}` : 'none'}`;
}

/** The Partner's note, without a heading of its own (the chat adds one) and without SILENT; null when nothing is left. */
export function cleanNote(text) {
  const note = text?.replace(/^\W*session note\W*(\n|$)/i, '').trim();
  return note && !SILENT.test(note) ? note : null;
}

const IDLE_AFTER_MS = 5 * 60_000; // no key, edit or command for this long: the user is away, and active time stops
const ACTIVE_FLUSH_MS = 60_000;
const MAX_TICK_GAP_MS = 5000; // a longer gap between ticks (a suspended laptop) is not active time

export class PairSession {
  /**
   * `record` is the stored session row. `notify(target, message)` sends to this session's "chat" clients,
   * all its "editors", or the "editor" the user used last, and returns how many got it; `requestEditor(message)`
   * asks the editor and resolves with its reply. While `health` says a model is down, Pair makes no remarks.
   * `previousNote` is the note of the last session in this project. With `autoTune`, the user's verdicts on
   * past remarks tune the budget (see tuning.mjs).
   */
  constructor({record, store, partner, score, typingPauseMs, notify, requestEditor, previousNote = null, autoTune = false, health = {ok: () => true}, log = () => {}, now = Date.now}) {
    Object.assign(this, {record, store, partner, score, typingPauseMs, notify, requestEditor, previousNote, autoTune, health, log, now});
    this.state = initialState({root: record.root, goal: record.goal});
    this.budget = new Budget(record.level);
    this.role = record.role ?? 'navigator';
    this.scout = null; // Pair's own pane (a ScoutPane), once herdr is known
    this.confirmations = new Map(); // id -> resolve(ok), for commands waiting for the user's yes or no
    this.lastConfirmation = 0;
    this.paneUses = 0; // searches and commands in the running turn
    this.fired = new Set();
    this.busy = false; // a Partner turn is running
    this.ticking = false;
    this.spoke = false; // anything reached the user this turn
    this.said = false; // the say tool was used this turn
    this.unasked = false; // the running turn is a remark nobody asked for
    this.held = []; // parts of an unasked remark that came while the user was typing
    this.panes = null; // the user's herdr panes (a PaneWatch), for the Driver's type
    this.edited = false; // the Driver made its one edit in this hand-over
    this.remarkId = null; // the stored remark of the running unasked turn
    this.lastRemark = null; // the last remark that reached the user: what feedback without an id rates
    this.tickedAt = null;
    this.activeMs = 0; // active time not yet stored
  }

  get id() { return this.record.id; }
  get root() { return this.record.root; }
  get conversationId() { return this.record.conversation_id; }

  receive(event) {
    const file = event.file && isAbsolute(event.file) ? relative(this.root, event.file) : event.file;
    this.state = fold(this.state, {at: this.now(), ...event, ...(file ? {file} : {})});
  }

  typing() {
    return this.now() - this.state.lastKeyAt < this.typingPauseMs;
  }

  /** Shows `action` now, or, for an unasked remark while the user types, at their next pause. */
  show(action) {
    if (this.unasked && this.typing()) this.held.push(action);
    else action();
  }

  /** Looks for a trigger worth a remark; called about once a second. Ticks never overlap. */
  async tick() {
    this.countActive();
    if (this.held.length && !this.typing()) this.held.splice(0).forEach(action => action());
    if (this.ticking || this.busy || this.role === 'driver' || !this.health.ok()) return;
    this.ticking = true;
    try {
      const now = this.now();
      const triggers = detectTriggers(this.state, now, this.fired);
      if (triggers.length && this.autoTune) this.budget.tune(tuning(this.store.remarks(now - WINDOW_MS), now));
      for (const trigger of triggers) {
        const decision = await decide({trigger, state: this.state, now, budget: this.budget, score: this.score, typingPauseMs: this.typingPauseMs});
        this.log(`${trigger.kind}: ${decision.verdict} (${decision.reason})`);
        if (decision.verdict === 'wait') return;
        this.fired.add(trigger.key);
        if (decision.verdict === 'speak') return await this.remark(trigger, decision.score);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Adds the time since the last tick to the active time while the user is at work, for `pair stats`. */
  countActive() {
    const now = this.now();
    const lastActivity = Math.max(this.state.lastKeyAt, this.state.lastEditAt, this.state.commands.at(-1)?.endedAt ?? 0);
    if (this.tickedAt !== null && now - lastActivity < IDLE_AFTER_MS) this.activeMs += Math.min(now - this.tickedAt, MAX_TICK_GAP_MS);
    this.tickedAt = now;
    if (this.activeMs >= ACTIVE_FLUSH_MS) this.storeActive();
  }

  storeActive() {
    if (this.activeMs) this.store.addActive(this.id, this.activeMs);
    this.activeMs = 0;
  }

  /** One unasked remark. It is stored so the user can rate it (dropped again if Pair stays silent), and costs budget. */
  async remark(trigger, score) {
    // The gate saw a pause, but a Partner turn takes seconds: the user may be typing again by the time it answers.
    this.unasked = true;
    const id = this.remarkId = this.store.addRemark({sessionId: this.id, trigger: trigger.kind, score, at: this.now()});
    try {
      if (!(await this.talk(watchInput(trigger, describeState(this.state, this.now()))))) return this.store.dropRemark(id);
      this.budget.spend(this.now());
      this.lastRemark = id;
      // After the remark's own words, also when they wait for a pause in the user's typing.
      this.show(() => {
        this.notify('chat', {type: 'remark', id});
        this.notify('editors', {type: 'remark', id});
      });
    } finally {
      this.unasked = false;
      this.remarkId = null;
    }
  }

  /**
   * The user's verdict on a remark: on remark `id`, else on the last one. Accepting or dismissing a suggestion
   * is `implicit` feedback, which the chat does not confirm.
   */
  feedback({useful, id = this.lastRemark, implicit = false}) {
    const rated = id !== null && this.store.rateRemark(id, useful ? 'useful' : 'dismissed');
    if (implicit) return;
    if (!rated) return this.message('system', 'There is no remark of Pair to rate yet.');
    this.message('system', useful ? 'Noted: useful.' : 'Noted: not useful.');
  }

  /** A message from the user in the chat pane: always answered, outside the budget. */
  async ask(text) {
    this.message('user', text);
    if (!this.state.goal) return this.setGoal(text);
    await this.talk(`[user] ${text}\n\nNow:\n${describeState(this.state, this.now())}`);
  }

  /** Runs one Partner turn; true when anything reached the user. */
  async talk(input) {
    this.busy = true;
    this.spoke = false;
    this.said = false;
    this.paneUses = 0;
    try {
      const answer = await this.partner.ask(this.conversationId, input);
      // After a say, local models tend to end with filler or a repeat; the say already was the answer.
      if (answer && !SILENT.test(answer) && !this.said) {
        this.show(() => this.message('pair', answer));
        this.spoke = true;
      }
    } catch (error) {
      // A remark nobody asked for fails quietly: the statusline already says that the model is down.
      if (this.unasked) this.log(`remark failed: ${error.message}`);
      else this.message('system', `Pair could not answer: ${error.message}`);
    } finally {
      this.busy = false;
    }
    return this.spoke;
  }

  setGoal(goal) {
    this.store.setGoal(this.id, goal);
    this.receive({kind: 'goal', text: goal});
    this.message('system', `Goal: ${goal}`);
  }

  setLevel(level) {
    this.budget.setLevel(level);
    this.store.setLevel(this.id, level);
    this.message('system', `Talk level: ${level}`);
  }

  /**
   * Switches Pair's role; true when it did. Scout needs Pair's own herdr pane, which opens with the switch
   * and closes with the switch back to Navigator. Driver needs Neovim, where any key takes the wheel back.
   */
  async setRole(role) {
    if (role === 'scout' && !this.scout) {
      this.message('system', 'Scout needs its own herdr pane: start Pair with `pair` inside herdr.');
      return false;
    }
    if (role === 'scout') {
      const opened = await this.scout.open().then(() => true, error => {
        this.message('system', `Could not open Pair's pane: ${error.message}`);
        return false;
      });
      if (!opened) return false;
    }
    if (role === 'navigator') await this.scout?.close();
    if (!this.notify('editors', {type: 'role', role}) && role === 'driver') {
      this.message('system', 'Pair drives only in Neovim: run :Pair start there first.');
      return false;
    }
    this.role = role;
    await this.configurePartner(role);
    this.announce(role);
    return true;
  }

  /** Tells the chat about the new role, and stores it unless it is the Driver's. */
  announce(role) {
    // The wheel is never handed over across a restart: a drive ends in Navigator, so a restart during one does too.
    this.store.setRole(this.id, role === 'driver' ? 'navigator' : role);
    this.notify('chat', {type: 'role', role});
    this.message('system', ROLE_NOTES[role]);
  }

  /**
   * The user hands Pair the wheel for one change (:Pair drive, "you take it", "your turn"). Pair answers as
   * Driver, with at most one edit, and is Navigator again when the answer is done.
   */
  async drive(words = '') {
    if (words) this.message('user', words);
    if (this.busy) return this.message('system', 'Pair is still answering; hand over again once it is done.');
    if (!(await this.setRole('driver'))) return;
    this.edited = false;
    await this.talk(driveInput(words, describeState(this.state, this.now())));
    await this.handBack();
    // Only now does the conversation lose the Driver's tools. After a take-back during the answer, the policy
    // hook refused edit and type with a reason; a tool that vanished mid-answer leaves small models writing
    // the call as plain text, and the user sees nothing.
    await this.configurePartner(this.role);
  }

  /** Gives the Partner `role`'s tools and instructions, with the last session's note to start from. */
  configurePartner(role) {
    return this.partner.setRole(this.conversationId, role, this.previousNote);
  }

  /** Pair goes back to Navigator, if it is driving. */
  async handBack(note) {
    if (this.role !== 'driver') return;
    this.role = 'navigator'; // at once: an edit or type still on its way is refused from here on
    if (note) this.message('system', note);
    this.notify('editors', {type: 'role', role: 'navigator'});
    await this.scout?.close();
    this.announce('navigator');
  }

  /** A key the user pressed in Neovim while Pair was driving. */
  takeBack() {
    return this.handBack('You have the wheel back.');
  }

  /** Asks the user in the chat pane; resolves false without a chat pane, on no, or after a minute. */
  confirm(text) {
    const id = ++this.lastConfirmation;
    if (!this.notify('chat', {type: 'confirm', id, text})) return Promise.resolve(false);
    return new Promise(resolve => {
      const timer = setTimeout(() => this.answer(id, false, 'No answer, so no.'), CONFIRM_MS);
      this.confirmations.set(id, ok => { clearTimeout(timer); resolve(ok); });
    });
  }

  /** The user's answer to confirmation `id`. */
  answer(id, ok, note = ok ? 'Allowed.' : 'Not allowed.') {
    const resolve = this.confirmations.get(id);
    if (!resolve) return;
    this.confirmations.delete(id);
    this.notify('chat', {type: 'confirmed', id});
    this.message('system', note);
    resolve(ok);
  }

  /** Ends the session with a note, which the next session in this project starts from. */
  async end() {
    await this.scout?.close();
    this.storeActive();
    const input = noteInput(this.state, await gitStatus(this.root));
    const note = await this.partner.ask(this.conversationId, input).then(cleanNote, error => {
      this.message('system', `No session note: ${error.message}`);
      return null;
    });
    this.store.endSession(this.id, note, this.now());
    if (note) this.message('pair', `Session note:\n${note}`);
    this.notify('editors', {type: 'clear'});
  }

  greet() {
    if (this.previousNote) this.message('system', `Last time:\n${this.previousNote}`);
    if (this.state.goal) this.message('system', `Goal: ${this.state.goal}`);
    else this.message('system', 'What are we doing this session? Type the goal here.');
  }

  message(sender, text) {
    const at = this.now();
    this.store.addMessage(this.id, sender, text, at);
    this.notify('chat', {type: 'message', sender, text, at});
  }

  // The Partner's tools (see tools.mjs). Each returns what the model is told.

  say(text) {
    if (SILENT.test(text)) return 'shown'; // some models say their SILENT instead of answering it
    this.spoke = true;
    this.said = true;
    this.show(() => this.message('pair', text));
    return 'shown';
  }

  async point({file, line, endLine, note}) {
    const path = await projectFile(this.root, file);
    if (!path) return `No file ${file} in the project`;
    this.spoke = true;
    this.show(() => {
      this.notify('editor', {type: 'point', file: path, line, endLine, note});
      this.message('pair', `${file}:${line} ${note}`);
    });
    return 'highlighted';
  }

  async open({file, line}) {
    const path = await projectFile(this.root, file);
    if (!path) return `No file ${file} in the project`;
    const typing = this.now() - this.state.lastKeyAt < this.typingPauseMs;
    this.notify('editor', {type: 'open', file: path, line, ask: typing});
    return typing ? 'The user is typing; they were asked to open it.' : 'opened in a split';
  }

  /** Shows a change as an inline diff in the editor; the user accepts it with one key or ignores it. */
  async suggest({file, line, endLine, text, note}) {
    const path = await projectFile(this.root, file);
    if (!path) return `No file ${file} in the project`;
    if (endLine < line) return `end_line ${endLine} is before line ${line}`;
    const count = (await this.bufferText(path)).split('\n').length;
    if (line > count) return `Line ${line} is past the end of ${file}, which has ${count} lines. Read it first.`;
    this.spoke = true;
    const remark = this.remarkId; // now: a suggestion held for the user's pause is shown after the turn ended
    this.show(() => {
      this.notify('editor', {type: 'suggest', file: path, line, endLine, text, note, remark});
      this.message('pair', `${file}:${line}${endLine > line ? `-${endLine}` : ''} suggestion: ${note}\n${text}`);
    });
    return 'Shown in the editor. The user accepts it with one key or ignores it.';
  }

  async read({file, from, to}) {
    const source = await readProjectPath(this.root, file);
    if (source.error || source.listing !== undefined) return source.error ?? source.listing;
    return numberedLines(await this.bufferText(await projectFile(this.root, file), source.text), from, to);
  }

  /** The text of the file at `path` as the user sees it: the editor's buffer wins over the disk, unsaved changes included. */
  async bufferText(path, onDisk) {
    const buffer = await this.requestEditor({type: 'read', file: path}).catch(() => null);
    return typeof buffer?.text === 'string' ? buffer.text : onDisk ?? (await readFile(path, 'utf8'));
  }

  // Scout's tools: they work only in Pair's own pane, where the user sees each command typed and run.

  async inPane(command) {
    // Also covers a turn that started as Scout when the user has switched back since: its pane is closed.
    if (!['scout', 'driver'].includes(this.role)) throw new Error('Searching and running need the Scout role; the user can switch with /scout.');
    if (!this.scout) throw new Error('Pair has no pane of its own: start Pair with `pair` inside herdr');
    if (++this.paneUses > PANE_USES_PER_TURN) throw new Error(`That is ${PANE_USES_PER_TURN} commands for this question. Answer with what you found.`);
    const result = await this.scout.run(command);
    this.receive({kind: 'scout_run', cmd: command, exit: result.exit, output: result.output});
    return result;
  }

  async search({pattern, path = '.'}) {
    if (!(await insideRoot(this.root, path))) return `Cannot search ${path}: not inside the project`;
    // Always with a path: rg without one searches its stdin when that is not a terminal.
    const result = await this.inPane(`rg --line-number --no-heading --color never --max-columns 200 --max-count 20 -- ${shellQuote(pattern)} ${shellQuote(path)}`);
    if (result.exit === 1) return 'No matches.';
    const lines = result.output.split('\n');
    const more = lines.length > SEARCH_LINES ? `\n(${lines.length - SEARCH_LINES} more lines; search a narrower path)` : '';
    // Small models follow an instruction next to the result far better than one in the system prompt.
    return `${result.exit === 0 ? '' : `exit ${result.exit}\n`}${lines.slice(0, SEARCH_LINES).join('\n')}${more}\n\nName these places (file:line) in your answer.`;
  }

  async run({command}) {
    // A remark nobody asked for may read and search, but not start commands.
    if (this.unasked) return 'Not now: run commands only when the user asks. Read and search instead.';
    const policy = commandPolicy(command);
    if (policy.verdict === 'refuse') {
      this.message('system', `Pair may not run \`${command}\`: ${policy.reason}.`);
      return `Refused: ${policy.reason}. Do not try another way; tell the user.`;
    }
    if (policy.verdict === 'ask' && !(await this.confirm(`Pair wants to run \`${command}\` in its pane (${policy.reason}). Allow?`))) {
      return 'The user did not allow it. Do not run it another way.';
    }
    return runReport(await this.inPane(command));
  }

  // The Driver's tools: they work only while the user hands Pair the wheel, and only in plain sight.

  /** Whether this turn may still change something for the user; a reason for the model when not. */
  wheel() {
    if (this.role !== 'driver') return 'The user has the wheel now: suggest the change or say it instead.';
    if (this.unasked) return 'Not in a remark nobody asked for.';
    return null;
  }

  /** The Driver's one change in the user's buffer, as one undo step and unsaved. */
  async edit({file, line, endLine, text}) {
    const path = await projectFile(this.root, file);
    if (!path) return `No file ${file} in the project`;
    if (endLine < line) return `end_line ${endLine} is before line ${line}`;
    const refused = this.wheel(); // after the await: the user may have taken the wheel back meanwhile
    if (refused) return refused;
    if (this.edited) return 'You already made your one change. Say in one sentence what you changed.';
    this.edited = true; // before the await, so two calls in one step cannot both pass
    const reply = await this.requestEditor({type: 'edit', file: path, line, endLine, text}).catch(error => ({error: error.message}));
    if (reply?.error) {
      this.edited = false;
      return `Not changed: ${reply.error}.`;
    }
    this.message('pair', `Changed ${file}:${line}${endLine > line ? `-${endLine}` : ''} (u undoes it).`);
    // Tests read the saved file, so a check now would see the old code and send small models in circles.
    return 'Changed, as one undo step. The file on disk changes only when the user saves, so do not run the tests now. '
      + 'That was your one edit: say in one sentence what you changed.';
  }

  /** Types one line into the user's terminal pane once they allow it; Enter stays with them. */
  async type({text}) {
    const refused = this.wheel();
    if (refused) return refused;
    if (!plainLine(text)) return 'Refused: type takes one line of plain text, and the user presses Enter.';
    const pane = this.state.terminalPane;
    if (!this.panes || !pane) return 'No terminal pane of the user is known yet; say the command instead.';
    const policy = commandPolicy(text);
    if (policy.verdict === 'refuse') return `Refused: ${policy.reason}. Do not try another way; tell the user.`;
    if (!(await this.confirm(`Pair wants to type \`${text}\` into your terminal (pane ${pane}), without pressing Enter. Allow?`))) {
      return 'The user did not allow it.';
    }
    const after = this.wheel();
    if (after) return after;
    await this.panes.type(pane, text);
    return 'Typed. The user decides whether to press Enter.';
  }
}
