// One pairing session: folds its events, decides when Pair speaks and carries out the Partner's tools.
import {isAbsolute, relative} from 'node:path';
import {Budget} from './budget.mjs';
import {commandPolicy} from './command-policy.mjs';
import {describeState} from './describe.mjs';
import {insideRoot, numberedLines, projectFile, readProjectPath} from './files.mjs';
import {fold, initialState} from './fold.mjs';
import {decide} from './gate.mjs';
import {RUN_TIMEOUT_MS, shellQuote} from './scout-pane.mjs';
import {parseTestOutput, testSummary} from './test-output.mjs';
import {detectTriggers} from './triggers.mjs';

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

const ROLE_NOTES = {
  navigator: 'Role: Navigator. Pair watches, comments and points at code.',
  scout: 'Role: Scout. Pair can also search and run read-only, test and build commands in its own pane; anything else asks you first.',
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

const NOTE_REQUEST = `[end] The session is over. Write a short session note in plain text, at most 6 lines:
the goal, what changed, and loose ends. No tool calls.`;

export class PairSession {
  /**
   * `record` is the stored session row. `notify(target, message)` sends to the "editor" or the "chat"
   * clients of this session and returns how many got it; `requestEditor(message)` asks the editor and
   * resolves with its reply.
   */
  constructor({record, store, partner, score, typingPauseMs, notify, requestEditor, log = () => {}, now = Date.now}) {
    Object.assign(this, {record, store, partner, score, typingPauseMs, notify, requestEditor, log, now});
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
    if (this.held.length && !this.typing()) this.held.splice(0).forEach(action => action());
    if (this.ticking || this.busy) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const trigger of detectTriggers(this.state, now, this.fired)) {
        const decision = await decide({trigger, state: this.state, now, budget: this.budget, score: this.score, typingPauseMs: this.typingPauseMs});
        this.log(`${trigger.kind}: ${decision.verdict} (${decision.reason})`);
        if (decision.verdict === 'wait') return;
        this.fired.add(trigger.key);
        if (decision.verdict === 'speak') return await this.remark(trigger);
      }
    } finally {
      this.ticking = false;
    }
  }

  async remark(trigger) {
    // The gate saw a pause, but a Partner turn takes seconds: the user may be typing again by the time it answers.
    this.unasked = true;
    const spoke = await this.talk(watchInput(trigger, describeState(this.state, this.now()))).finally(() => { this.unasked = false; });
    if (spoke) this.budget.spend(this.now());
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
      this.message('system', `Pair could not answer: ${error.message}`);
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

  /** Switches Pair's role; Scout needs Pair's own herdr pane, which opens with the switch. */
  async setRole(role) {
    if (role === 'scout' && !this.scout) {
      return this.message('system', 'Scout needs its own herdr pane: start Pair with `pair` inside herdr.');
    }
    if (role === 'scout') {
      const opened = await this.scout.open().then(() => true, error => {
        this.message('system', `Could not open Pair's pane: ${error.message}`);
        return false;
      });
      if (!opened) return;
    } else {
      await this.scout?.close();
    }
    this.role = role;
    this.store.setRole(this.id, role);
    await this.partner.setRole(this.conversationId, role);
    this.notify('editor', {type: 'role', role});
    this.notify('chat', {type: 'role', role});
    this.message('system', ROLE_NOTES[role]);
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

  async end() {
    await this.scout?.close();
    const note = await this.partner.ask(this.conversationId, NOTE_REQUEST).catch(error => `(no note: ${error.message})`);
    this.store.endSession(this.id, note, this.now());
    this.message('pair', `Session note:\n${note}`);
    this.notify('editor', {type: 'clear'});
  }

  greet() {
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

  async read({file, from, to}) {
    const source = await readProjectPath(this.root, file);
    if (source.error || source.listing !== undefined) return source.error ?? source.listing;
    // The editor's buffer wins over the disk: it holds what the user sees, unsaved changes included.
    const buffer = await this.requestEditor({type: 'read', file: await projectFile(this.root, file)}).catch(() => null);
    return numberedLines(typeof buffer?.text === 'string' ? buffer.text : source.text, from, to);
  }

  // Scout's tools: they work only in Pair's own pane, where the user sees each command typed and run.

  async inPane(command) {
    // Also covers a turn that started as Scout when the user has switched back since: its pane is closed.
    if (this.role !== 'scout') throw new Error('Searching and running need the Scout role; the user can switch with /scout.');
    if (!this.scout) throw new Error('Pair has no pane of its own: start Pair with `pair` inside herdr');
    if (++this.paneUses > PANE_USES_PER_TURN) throw new Error(`That is ${PANE_USES_PER_TURN} commands for this question. Answer with what you found.`);
    const result = await this.scout.run(command);
    this.receive({kind: 'scout_run', cmd: command, exit: result.exit, output: result.output});
    return result;
  }

  async search({pattern, path = '.'}) {
    if (!(await insideRoot(this.root, path))) return `Cannot search ${path}: not inside the project`;
    const where = path === '.' ? '' : ` ${shellQuote(path)}`;
    const result = await this.inPane(`rg --line-number --color never --max-columns 200 --max-count 20 -- ${shellQuote(pattern)}${where}`);
    if (result.exit === 1) return 'No matches.';
    const lines = result.output.split('\n');
    const more = lines.length > SEARCH_LINES ? `\n(${lines.length - SEARCH_LINES} more lines; search a narrower path)` : '';
    return (result.exit === 0 ? '' : `exit ${result.exit}\n`) + lines.slice(0, SEARCH_LINES).join('\n') + more;
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
}
