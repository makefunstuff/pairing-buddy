// One pairing session: folds its events, decides when Pair speaks and carries out the Partner's tools.
import {readFile} from 'node:fs/promises';
import {isAbsolute, relative} from 'node:path';
import {BlankPage} from './blank-page.mjs';
import {Budget} from './budget.mjs';
import {commandPolicy} from './command-policy.mjs';
import {describeState} from './describe.mjs';
import {insideRoot, MAX_LINES, newProjectFile, numberedLines, projectFile, readProjectPath} from './files.mjs';
import {fold, initialState} from './fold.mjs';
import {decide} from './gate.mjs';
import {gitStatus} from './git.mjs';
import {plainLine} from './herdr.mjs';
import {RUN_TIMEOUT_MS, shellQuote} from './scout-pane.mjs';
import {parseTestOutput, testSummary} from './test-output.mjs';
import {TestRuns} from './test-runs.mjs';
import {detectTriggers} from './triggers.mjs';
import {tuning, WINDOW_MS} from './tuning.mjs';

const SILENT = /^\W*silent\W*$/i;
// "…so no drift here — SILENT.": a model that explains its SILENT still means silence.
const silent = text => SILENT.test(text) || /\bSILENT\W*$/.test(text);

// What the Partner should check for each kind of trigger. Small models follow an instruction in the
// message far better than a general rule in the system prompt.
const CHECKS = {
  failed_command: 'Find the cause of the failure, point at it and say it in one sentence.',
  repeated_error: 'The same error came back. Find the cause, point at it and say it in one sentence.',
  new_code_diagnostic: 'Point at the line and say the fix in a few words.',
  stall: 'The user seems stuck on this failure. Give one concrete next step.',
  drift: 'Do not help with the goal itself: the only question is whether the file the user now edits belongs to the goal. '
    + 'If it could, answer exactly SILENT. If it is unrelated, that drift is the problem: say in one sentence what drifted.',
  edit_while_red: 'The test run is older than the user\'s change. Read the lines they changed, the failing test and the code it tests, '
    + 'then trace the test through the code as it is now, step by step with the real numbers. If the trace passes, their change '
    + 'fixed it; if you are not sure, say nothing: in both cases answer exactly SILENT. Only if the trace still fails, somewhere other '
    + 'than their change, point at that place (file, line, and as code the few characters that are wrong, such as an operator) '
    + 'and say why in one or two short sentences, without the trace.',
  regression: 'Pair ran the tests when the user saved, and a test that did not fail before fails now. Read the failing test, '
    + 'the code it tests and the lines the user changed, and find how the change breaks it. The user made that change for a '
    + 'reason, often another test: the fix has to keep it working, so undo their change only if it is plainly wrong. If a small '
    + 'change fixes it, call suggest with it (the lines and their complete new text); else point at the cause. Then say why in '
    + 'one or two short sentences, without a trace.',
};

export function watchInput(trigger, description) {
  return `[watch] ${trigger.kind}: ${trigger.detail}\n\nNow:\n${description}\n\n${CHECKS[trigger.kind]} If no remark would help, answer exactly SILENT.`;
}

/**
 * What the Partner is asked when the user hands over the wheel: `words` are theirs ("you take it, ...",
 * "your turn"), or empty for a bare :Pair drive.
 */
export function driveInput(words, description, selection = '') {
  const request = words ? `The user said: "${words}"` : 'The user gave no request: make the change you two talked about last.';
  return `[drive] The user handed you the wheel for one change. ${request}${selection}\n\nNow:\n${description}\n\n`
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

const SELECTION_LINES = 80; // of a selection the user asks about, the Partner gets this many lines at most

/** What the Partner is told about the lines the user selected: where they are, and the lines themselves. */
export function selectionInput({file, from, to}, text) {
  const shown = numberedLines(text, from, Math.min(to, from + SELECTION_LINES - 1));
  return `\n\nAbout lines ${from}-${to} of ${file}, which the user selected:\n${shown}`;
}

const NAME_CHARS = 32; // of a failing test's name in the statusline

/** Whether a finished test run failed: its exit code, a timeout or a failing test say so. */
const isRed = ({exit, timedOut, tests}) => exit !== 0 || timedOut || !!tests?.failedCount;

const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** One short line for the statusline about a finished run: "4 tests, 3 packages" or "1 failing · TestX". */
export function runText({exit, timedOut, tests}) {
  if (timedOut) return 'stopped after 2 min';
  if (!tests?.failedCount) {
    if (exit !== 0) return `exit ${exit}`;
    const scope = tests?.packages ? `, ${count(tests.packages, 'package')}` : tests?.files ? `, ${count(tests.files, 'file')}` : '';
    return tests?.passed ? `${count(tests.passed, 'test')}${scope}` : 'passed';
  }
  const [first] = tests.failed;
  if (!first) return tests.runner === 'go' ? 'does not build' : `${tests.failedCount} failing`;
  const name = first.length > NAME_CHARS ? `${first.slice(0, NAME_CHARS - 1)}…` : first;
  return `${tests.failedCount} failing · ${name}${tests.failedCount > 1 ? ` +${tests.failedCount - 1}` : ''}`;
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

// "Session note:", "# Session Notes", "**Session note**" and the like, alone on the first line or before the text.
const HEADING = /^[\s#*_]*session notes?[*_]*[ \t]*(:[*_]*[ \t]*|\n|$)/i;

export const NOTE_CHARS = 1200; // six lines and some: the next session's instructions carry it on every turn

/**
 * The Partner's note, without a heading of its own (the chat adds one) and without SILENT, cut to whole lines
 * within NOTE_CHARS; null when nothing is left.
 */
export function cleanNote(text) {
  const note = text?.replace(HEADING, '').trim();
  if (!note || SILENT.test(note)) return null;
  if (note.length <= NOTE_CHARS) return note;
  const cut = note.slice(0, NOTE_CHARS);
  return cut.slice(0, cut.lastIndexOf('\n') > 0 ? cut.lastIndexOf('\n') : NOTE_CHARS).trim();
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
  constructor({record, store, partner, score, typingPauseMs, notify, requestEditor, previousNote = null, autoTune = false, health = {ok: () => true}, testOnSave = null, log = () => {}, now = Date.now}) {
    Object.assign(this, {record, store, partner, score, typingPauseMs, notify, requestEditor, previousNote, autoTune, health, log, now});
    this.state = initialState({root: record.root, goal: record.goal});
    this.budget = new Budget(record.level);
    this.role = record.role ?? 'navigator';
    this.scout = null; // Pair's own pane (a ScoutPane), once herdr is known
    this.confirmations = new Map(); // id -> resolve(ok), for commands waiting for the user's yes or no
    this.lastConfirmation = 0;
    this.paneUses = 0; // searches and commands in the running turn
    this.fired = new Set();
    this.deferred = new Set(); // keys of lasting triggers the budget holds back
    this.waitReason = null; // why the last tick waited, logged once
    this.waits = new Map(); // trigger key -> {since} while it waits for the model, then {ms} it waited
    this.busy = false; // a Partner turn is running
    this.remarking = null; // the unasked remark being made, which the user's question cancels
    this.thinks = false; // that turn thinks
    this.ticking = false;
    this.spoke = false; // anything reached the user this turn
    this.said = false; // the say tool was used this turn
    this.unasked = false; // the running turn is a remark nobody asked for
    this.words = []; // what Pair said this turn: an unasked remark shows it under the user's line too
    this.target = null; // where the user's jump key goes: Pair's suggestion this turn, else where it pointed last
    this.held = []; // parts of an unasked remark that came while the user was typing
    this.panes = null; // the user's herdr panes (a PaneWatch), for the Driver's type
    this.edited = false; // the Driver made its one edit in this hand-over
    this.handback = null; // that edit's lines and how the tests went on them: {file, line, endLine, tests}
    this.remarkId = null; // the stored remark of the running unasked turn
    this.lastRemark = null; // the last remark that reached the user: what feedback without an id rates
    this.tickedAt = null;
    this.activeMs = 0; // active time not yet stored
    this.activeAt = 0; // when active time was last counted: what it is stored under
    // The tests run on save, with `testOnSave` ({command, outputFile}); what the editors last heard of them.
    this.testRuns = testOnSave && new TestRuns({...testOnSave, root: record.root, pane: () => this.scout, report: run => this.testRun(run)});
    this.testsShown = null;
    this.runError = null; // the last run that could not run, said once in the chat
    this.wasRed = false; // the last run failed
    this.blankPage = null; // the questions of :Pair new and their slice (see blank-page.mjs)
  }

  get id() { return this.record.id; }
  get root() { return this.record.root; }
  get conversationId() { return this.record.conversation_id; }

  receive(event) {
    const file = event.file && isAbsolute(event.file) ? relative(this.root, event.file) : event.file;
    this.state = fold(this.state, {at: this.now(), ...event, ...(file ? {file} : {})});
    if (event.kind === 'save' && file && !file.startsWith('..')) this.testRuns?.saved(file);
  }

  /** A test run on save starts or ends (see test-runs.mjs): the editors show it, and the session state takes it in. */
  testRun(run) {
    if (run.unsaved) return this.unsavedRun(run);
    if (run.state === 'error') {
      this.log(`tests on save: ${run.error}`);
      if (run.error !== this.runError) this.message('system', `Pair could not run \`${run.label}\`: ${run.error}.`);
      this.runError = run.error;
      return this.showTests({type: 'tests', state: 'error', label: run.label, text: run.short});
    }
    this.runError = null;
    if (run.state === 'run') return this.showTests({type: 'tests', state: 'run', label: run.label});
    const red = isRed(run);
    const failing = run.placed.filter(test => !test.ok);
    const files = [...new Set(failing.map(test => relative(this.root, test.failure?.file ?? test.file)))];
    this.receive({kind: 'test_run', cmd: run.label, tests: run.tests, files, saved: run.saved});
    const text = runText(run);
    this.showTests({type: 'tests', state: red ? 'fail' : 'pass', label: run.label, text, results: run.placed});
    // The chat hears of a run when it turns red or green, or finds new failures; a run like the last one is no news.
    if (red && (!this.wasRed || (run.tests && this.state.tests.newly.length))) this.message('system', `\`${run.label}\` after you saved ${run.saved}: ${run.tests ? testSummary(run.tests) : text}`);
    else if (!red && this.wasRed) this.message('system', `\`${run.label}\` passes again: ${text}.`);
    this.wasRed = red;
  }

  /**
   * The run on the unsaved buffer after the Driver's edit: the editors show it like a run on save, but it is no
   * baseline for the next one, and a run that could not start leaves the last run on save in the statusline.
   */
  unsavedRun(run) {
    const label = `${run.label} (unsaved)`;
    if (run.state === 'run') return this.notify('editors', {type: 'tests', state: 'run', label});
    if (run.state === 'error') {
      this.log(`tests on the unsaved buffer: ${run.error}`);
      return this.notify('editors', this.testsShown ?? {type: 'tests', state: 'idle'});
    }
    const text = runText(run);
    this.showTests({type: 'tests', state: isRed(run) ? 'fail' : 'pass', label, text, results: run.placed});
    this.message('system', `\`${label}\` after Pair's edit: ${run.tests ? testSummary(run.tests) : text}`);
  }

  /** Sends a test run's state to every editor, and keeps it for editors that connect later. */
  showTests(message) {
    this.testsShown = message;
    this.notify('editors', message);
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
    if (this.ticking || this.role === 'driver' || this.blankPage?.open || !this.health.ok()) return;
    const now = this.now();
    const triggers = detectTriggers(this.state, now, this.fired);
    this.waits = new Map([...this.waits].filter(([key]) => triggers.some(trigger => trigger.key === key)));
    // While the Partner is at work, what comes up waits for the model; how long goes with the remark it becomes.
    if (this.busy) return triggers.forEach(trigger => this.waitFor(trigger, now));
    this.ticking = true;
    try {
      if (triggers.length && this.autoTune) this.budget.tune(tuning(this.store.remarks(now - WINDOW_MS), now));
      for (const trigger of triggers) {
        const decision = await decide({trigger, state: this.state, now, budget: this.budget, score: this.score, typingPauseMs: this.typingPauseMs});
        if (!this.repeats(trigger, decision)) this.log(`${trigger.kind}: ${decision.verdict} (${decision.reason})`);
        if (decision.held) this.waitFor(trigger, now);
        else this.waited(trigger, now);
        if (decision.verdict === 'wait') return;
        if (decision.verdict === 'later') {
          this.deferred.add(trigger.key); // logged once, looked at again each tick until the budget allows
          continue;
        }
        this.fired.add(trigger.key);
        if (decision.verdict === 'speak') return await (this.remarking = this.remark(trigger, decision.score, this.waits.get(trigger.key)?.ms));
      }
    } finally {
      this.ticking = false;
    }
  }

  /** `trigger` waits for the model, from `now` unless it already did. */
  waitFor(trigger, now) {
    if (!this.waits.has(trigger.key)) this.waits.set(trigger.key, {since: now});
  }

  /** The model is free for `trigger`: how long it waited is kept for its remark. */
  waited(trigger, now) {
    const wait = this.waits.get(trigger.key);
    if (wait?.since !== undefined) this.waits.set(trigger.key, {ms: now - wait.since});
  }

  /**
   * Whether `decision` repeats what an earlier tick logged: a wait for the same reason (typing, or the Partner has
   * the model), or a lasting trigger the budget still holds back.
   */
  repeats(trigger, decision) {
    if (decision.verdict === 'later') return this.deferred.has(trigger.key);
    const repeated = decision.verdict === 'wait' && this.waitReason === decision.reason;
    this.waitReason = decision.verdict === 'wait' ? decision.reason : null;
    return repeated;
  }

  /** Whether the user typed, edited or ran a command in the last few minutes. */
  active(now = this.now()) {
    const lastActivity = Math.max(this.state.lastKeyAt, this.state.lastEditAt, this.state.commands.at(-1)?.endedAt ?? 0);
    return now - lastActivity < IDLE_AFTER_MS;
  }

  /** Adds the time since the last tick to the active time while the user is at work, for `pair stats`. */
  countActive() {
    const now = this.now();
    if (this.tickedAt !== null && this.active(now)) {
      this.activeMs += Math.min(now - this.tickedAt, MAX_TICK_GAP_MS);
      this.activeAt = now;
    } else {
      this.storeActive(); // the user went away: what they did is stored under when they did it
    }
    this.tickedAt = now;
    if (this.activeMs >= ACTIVE_FLUSH_MS) this.storeActive();
  }

  storeActive() {
    if (this.activeMs) this.store.addActive(this.activeAt, this.activeMs);
    this.activeMs = 0;
  }

  /**
   * One unasked remark. It is stored so the user can rate it (dropped again if Pair stays silent), with how long
   * its trigger `waitedMs` for the model, and costs budget.
   */
  async remark(trigger, score, waitedMs = null) {
    // The gate saw a pause, but a Partner turn takes seconds: the user may be typing again by the time it answers.
    this.unasked = true;
    const id = this.remarkId = this.store.addRemark({sessionId: this.id, trigger: trigger.kind, score, at: this.now(), waitedMs});
    try {
      const input = watchInput(trigger, describeState(this.state, this.now()));
      if (!(await this.talk(input, {kind: 'remark'}))) return this.store.dropRemark(id);
      this.budget.spend(this.now());
      this.lastRemark = id;
      // After the remark's own words, also when they wait for a pause in the user's typing. The editor shows
      // the words under the line the user is on, with a way to the place Pair pointed at.
      const {words, target} = this;
      this.show(() => {
        this.notify('chat', {type: 'remark', id});
        this.notify('editor', {type: 'remark', id, text: words.join('\n'), target});
      });
    } finally {
      this.unasked = false;
      this.remarkId = null;
      this.remarking = null;
    }
  }

  /**
   * The user goes first: an unasked remark the Partner is still making is cancelled, and its turn ends before
   * theirs starts. What it already showed stays.
   */
  async yieldRemark() {
    const remark = this.remarking;
    if (!remark) return;
    this.log('remark cancelled: the user asked');
    await this.partner.cancel(this.conversationId);
    await remark;
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

  /** The user's remark seen: they edited after it showed. Neither useful nor noise; a verdict still replaces it. */
  seen(id) {
    this.store.seeRemark(id);
  }

  /**
   * A question from the user, in the chat pane or Neovim: always answered, outside the budget. `selection`
   * ({file, from, to}) is the lines they asked about.
   */
  async ask(text, selection = null) {
    this.message('user', selection ? `${text} (${relative(this.root, selection.file)}:${selection.from}-${selection.to})` : text);
    if (!this.state.goal && !selection) return this.setGoal(text);
    await this.yieldRemark();
    await this.talk(`[user] ${text}${await this.selected(selection)}\n\nNow:\n${describeState(this.state, this.now())}`);
  }

  /** The lines the user selected, for the Partner's input; '' without a selection. */
  async selected(selection) {
    const path = selection && (await projectFile(this.root, selection.file));
    if (!path) return '';
    return selectionInput({...selection, file: relative(this.root, path)}, await this.bufferText(path));
  }

  /**
   * Runs one Partner turn (`options` as for the Partner's ask); true when anything reached the user. While the model
   * of a turn that thinks is at work, the statusline says so: thinking takes seconds, and the user should not take
   * it for silence. While one of its tools runs (it types an edit, reads, runs a command) it says what that does.
   */
  async talk(input, options = {}) {
    this.busy = true;
    this.spoke = false;
    this.said = false;
    this.paneUses = 0;
    this.words = [];
    this.target = null;
    this.thinks = this.partner.thinkingOf(this.conversationId, options.kind) !== 'off';
    this.showThinking(true);
    try {
      const answer = await this.partner.ask(this.conversationId, input, options);
      // After a say, local models tend to end with filler or a repeat; the say already was the answer.
      if (answer && !silent(answer) && !this.said) {
        this.show(() => this.message('pair', answer));
        this.words.push(answer);
        this.spoke = true;
      }
    } catch (error) {
      // A remark nobody asked for fails quietly: the statusline already says that the model is down.
      if (this.unasked) this.log(`remark failed: ${error.message}`);
      else this.message('system', `Pair could not answer: ${error.message}`);
    } finally {
      this.busy = false;
      this.showThinking(false);
      this.thinks = false;
    }
    return this.spoke;
  }

  /** Tells the editors whether the Partner's model is thinking now, in a turn that thinks. */
  showThinking(on) {
    if (this.thinks) this.notify('editors', {type: 'thinking', on});
  }

  /** Carries out one of the Partner's tools: the model waits for it meanwhile, and is not thinking. */
  async useTool(name, args) {
    this.showThinking(false);
    try {
      return await this[name](args);
    } finally {
      if (this.busy) this.showThinking(true);
    }
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
    if (role === 'navigator') await this.closePane();
    if (!this.notify('editors', {type: 'role', role}) && role === 'driver') {
      this.message('system', 'Pair drives only in Neovim: run :Pair start there first.');
      return false;
    }
    this.role = role;
    await this.configurePartner(role);
    this.announce(role);
    return true;
  }

  /** Closes Pair's pane as Scout's work ends, unless the tests on save run in it. */
  async closePane() {
    if (!this.testRuns) await this.scout?.close();
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
  async drive(words = '', selection = null) {
    if (words) this.message('user', words);
    await this.yieldRemark();
    if (this.busy) return this.message('system', 'Pair is still answering; hand over again once it is done.');
    if (!(await this.setRole('driver'))) return;
    this.edited = false;
    this.handback = null;
    await this.talk(driveInput(words, describeState(this.state, this.now()), await this.selected(selection)));
    await this.handBack();
    // The hand-back line: what Pair says it did, under the lines it changed, with how the tests went on them.
    if (this.handback) this.notify('editor', {type: 'handback', ...this.handback, text: this.words.join('\n')});
    // Only now does the conversation lose the Driver's tools. After a take-back during the answer, the policy
    // hook refused edit and type with a reason; a tool that vanished mid-answer leaves small models writing
    // the call as plain text, and the user sees nothing.
    await this.configurePartner(this.role);
  }

  /** :Pair new: one question at a time about `idea`, then the first slice, shown in the note `file` (see blank-page.mjs). */
  async startNew(idea, file) {
    const note = (await projectFile(this.root, file)) ?? (await newProjectFile(this.root, file));
    if (!note) return this.message('system', `Pair keeps its notes inside the project, not in ${file}.`);
    if (this.blankPage?.open) this.blankPage.close();
    this.blankPage = new BlankPage({session: this, file: note});
    await this.blankPage.start(idea);
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
    await this.closePane();
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
    await this.yieldRemark();
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
    if (silent(text)) return 'shown'; // some models say their SILENT instead of answering it
    // A question or slice of :Pair new is the blank page's to show, once it has checked it.
    if (this.blankPage?.consulting) {
      this.words.push(text);
      return 'noted';
    }
    this.spoke = true;
    this.said = true;
    this.words.push(text);
    this.show(() => this.message('pair', text));
    return 'shown';
  }

  /** Marks lines in the editor, with `code` on the first one underlined; the last point of a turn is where the jump key goes. */
  async point({file, line, endLine, note, code}) {
    const path = await projectFile(this.root, file);
    if (!path) return `No file ${file} in the project`;
    this.spoke = true;
    if (!this.target?.suggestion) this.target = {file: path, line, endLine, note, code};
    this.show(() => {
      this.notify('editor', {type: 'point', file: path, line, endLine, note, code});
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
    // The jump key goes to a suggestion before a point: that is where the one key that takes it works.
    this.target = {file: path, line, endLine, note, suggestion: true};
    const remark = this.remarkId; // now: a suggestion held for the user's pause is shown after the turn ended
    this.show(() => {
      this.notify('editor', {type: 'suggest', file: path, line, endLine, text, note, remark});
      this.message('pair', `${file}:${line}${endLine > line ? `-${endLine}` : ''} suggestion: ${note}\n${text}`);
    });
    return 'Shown in the editor. The user accepts it with one key or ignores it.';
  }

  /** Reads a file as the editor has it; the editor shows where Pair reads (its gaze) as it does. */
  async read({file, from, to}) {
    const source = await readProjectPath(this.root, file);
    if (source.error) return this.readNew(file, from, to, source.error);
    if (source.listing !== undefined) return source.listing;
    const path = await projectFile(this.root, file);
    const text = await this.bufferText(path, source.text);
    const first = Math.max(1, from ?? 1);
    this.notify('editor', {type: 'look', file: path, from: first, to: Math.min(text.split('\n').length, to ?? first + MAX_LINES - 1)});
    return numberedLines(text, from, to);
  }

  /** Reads a file that is only a buffer so far, such as one the Driver typed and the user has not saved. */
  async readNew(file, from, to, error) {
    const path = await newProjectFile(this.root, file);
    if (!path) return error;
    const buffer = await this.requestEditor({type: 'read', file: path}).catch(() => null);
    if (typeof buffer?.text === 'string') return numberedLines(buffer.text, from, to);
    return `${file} does not exist yet. As Driver, an edit of line 1 creates it in the editor; the user saves it.`;
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
    // A file not written yet opens as a new buffer: the disk has it once the user saves it.
    const path = (await projectFile(this.root, file)) ?? (await newProjectFile(this.root, file));
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
    // The editor says which lines it changed: lines the edit kept as they were are not Pair's.
    const count = text === '' ? 0 : text.replace(/\n$/, '').split('\n').length;
    this.handback = {file: path, line: reply.from ?? line, endLine: reply.to ?? line + Math.max(count, 1) - 1, tests: null};
    const done = 'Changed, as one undo step. That was your one edit: say in one sentence what you changed';
    // The tests on save read the saved file, so a check there would see the old code and send small models in circles.
    if (!this.testRuns) return `${done}. The file on disk changes only when the user saves, so do not run the tests now.`;
    const run = await this.testRuns.unsaved(path, await this.bufferText(path));
    if (run.state === 'error') return `${done}. The tests could not run on the unsaved buffer: ${run.error}.`;
    this.handback.tests = isRed(run) ? 'fail' : 'pass';
    return `${done}, and whether the tests pass. \`${run.label}\` on the unsaved buffer: ${run.tests ? testSummary(run.tests) : runText(run)}.`;
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
