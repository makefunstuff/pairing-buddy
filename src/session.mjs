// One pairing session: folds its events, decides when Pair speaks and carries out the Partner's tools.
import {isAbsolute, relative} from 'node:path';
import {Budget} from './budget.mjs';
import {describeState} from './describe.mjs';
import {numberedLines, projectFile, readProjectPath} from './files.mjs';
import {fold, initialState} from './fold.mjs';
import {decide} from './gate.mjs';
import {detectTriggers} from './triggers.mjs';

const SILENT = /^\W*silent\W*$/i;

// What the Partner should check for each kind of trigger. Small models follow an instruction in the
// message far better than a general rule in the system prompt.
const CHECKS = {
  failed_command: 'Find the cause of the failure, point at it and say it in one sentence.',
  repeated_error: 'The same error came back. Find the cause, point at it and say it in one sentence.',
  new_code_diagnostic: 'Point at the line and say the fix in a few words.',
  stall: 'The user seems stuck on this failure. Give one concrete next step.',
  drift: 'Do not help with the goal itself. Only answer this: are the recently edited files and the branch unrelated to the goal? If they are related, answer SILENT. If not, say in one sentence what drifted.',
};

export function watchInput(trigger, description) {
  return `[watch] ${trigger.kind}: ${trigger.detail}\n\nNow:\n${description}\n\n${CHECKS[trigger.kind]} If no remark would help, answer exactly SILENT.`;
}

const NOTE_REQUEST = `[end] The session is over. Write a short session note in plain text, at most 6 lines:
the goal, what changed, and loose ends. No tool calls.`;

export class PairSession {
  /**
   * `record` is the stored session row. `notify(target, message)` sends to the "editor" or the "chat"
   * clients of this session; `requestEditor(message)` asks the editor and resolves with its reply.
   */
  constructor({record, store, partner, score, typingPauseMs, notify, requestEditor, log = () => {}, now = Date.now}) {
    Object.assign(this, {record, store, partner, score, typingPauseMs, notify, requestEditor, log, now});
    this.state = initialState({root: record.root, goal: record.goal});
    this.budget = new Budget(record.level);
    this.fired = new Set();
    this.busy = false; // a Partner turn is running
    this.ticking = false;
    this.spoke = false; // anything reached the user this turn
    this.said = false; // the say tool was used this turn
  }

  get id() { return this.record.id; }
  get root() { return this.record.root; }
  get conversationId() { return this.record.conversation_id; }

  receive(event) {
    const file = event.file && isAbsolute(event.file) ? relative(this.root, event.file) : event.file;
    this.state = fold(this.state, {at: this.now(), ...event, ...(file ? {file} : {})});
  }

  /** Looks for a trigger worth a remark; called about once a second. Ticks never overlap. */
  async tick() {
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
    const spoke = await this.talk(watchInput(trigger, describeState(this.state, this.now())));
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
    try {
      const answer = await this.partner.ask(this.conversationId, input);
      // After a say, local models tend to end with filler or a repeat; the say already was the answer.
      if (answer && !SILENT.test(answer) && !this.said) {
        this.message('pair', answer);
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

  async end() {
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
    this.spoke = true;
    this.said = true;
    this.message('pair', text);
    return 'shown';
  }

  async point({file, line, endLine, note}) {
    const path = await projectFile(this.root, file);
    if (!path) return `No file ${file} in the project`;
    this.spoke = true;
    this.notify('editor', {type: 'point', file: path, line, endLine, note});
    this.message('pair', `${file}:${line} ${note}`);
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
}
