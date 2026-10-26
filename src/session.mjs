// One pairing session: folds its events, decides when Pair speaks and carries out the Partner's tools.
import {readFile} from 'node:fs/promises';
import {isAbsolute, relative} from 'node:path';
import {BlankPage} from './blank-page.mjs';
import {Budget} from './budget.mjs';
import {commandPolicy} from './command-policy.mjs';
import {contextCard} from './context-card.mjs';
import {Delight, LONG_RED_MS} from './delight.mjs';
import {describeState} from './describe.mjs';
import {insideRoot, MAX_LINES, newProjectFile, numberedLines, projectFile, readProjectPath} from './files.mjs';
import {failed, fold, initialState} from './fold.mjs';
import {decide} from './gate.mjs';
import {gitStatus} from './git.mjs';
import {Breakpoints, placeOf, stillTrue, urgent} from './held.mjs';
import {plainLine} from './herdr.mjs';
import {keptOutput, Ledger, ledgerDetail, today} from './ledger.mjs';
import {placeRun} from './run-places.mjs';
import {crashText, hasNews, readingSummary, readRun} from './run-output.mjs';
import {RUN_TIMEOUT_MS, shellQuote} from './scout-pane.mjs';
import {asksBack, oneQuestion, PROSE_CHECKS} from './prose-triggers.mjs';
import {parseTestOutput, testSummary} from './test-output.mjs';
import {TestRuns} from './test-runs.mjs';
import {currentTrail, trailMatches, trailSummary} from './trail.mjs';
import {detectTriggers} from './triggers.mjs';
import {tuning, WINDOW_MS} from './tuning.mjs';
import {KEEP, splitTeaching, teachInput} from './tone.mjs';

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
  search_trail: 'The user searched for one thing several ways and has not found it: their words are not the code\'s words. From what '
    + 'is failing and what the project has for their words, work out what they look for, read the code, and point at the place '
    + '(file, line, and as code the code\'s own word for it). Then say in one sentence where it is, in the code\'s own word, '
    + 'and, if something fails, how that place causes it. If you cannot tell what they look for, answer exactly SILENT.',
  crash: 'The program crashed. Read the code at the innermost place of its stack in the project (if it printed no stack, '
    + 'the code the run executes that the user changed last) and find why it crashes there, with the real values if you can. '
    + 'Point at that line, with the few characters that are wrong as code, and say why in one sentence.',
  new_warning: 'A build printed a warning that was not there before. Read its line. Only if it points at a real bug, point '
    + 'at it and say why in one sentence; if it is harmless while exploring (an unused variable, a parameter not used yet), '
    + 'answer exactly SILENT.',
  ...PROSE_CHECKS,
};

export function watchInput(trigger, description) {
  return `[watch] ${trigger.kind}: ${trigger.detail}\n\nNow:\n${description}\n\n${CHECKS[trigger.kind]} ${KEEP.remark} If no remark would help, answer exactly SILENT.`;
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

/** What the Partner is told about a command Scout ran in the project at `root`. */
export function runReport(result, root = null) {
  const lines = [result.timedOut ? `Still running after ${RUN_TIMEOUT_MS / 1000} s, so it was stopped with Ctrl-C.` : `exit ${result.exit}`];
  const tests = parseTestOutput(result.output);
  if (tests) lines.push(`Tests (${tests.runner}): ${testSummary(tests)}`);
  const reading = readRun(result.output, {exit: result.exit, root});
  if (!tests && hasNews(reading)) lines.push(`${reading.crash ? 'Crashed' : 'Build'}: ${readingSummary(reading)}`);
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
const LATE_QUESTION_CHARS = 60; // of the question a late answer names

/** Whether a finished test run failed: its exit code, a timeout, a failing test or a crash (a sanitizer's, also with exit 0) say so. */
const isRed = ({exit, timedOut, tests, reading}) => exit !== 0 || timedOut || !!tests?.failedCount || !!reading?.crash;

const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

const fileLine = place => `${place.file.split('/').at(-1)}:${place.line}`;

/**
 * One short line for the statusline about a finished run: "4 tests, 3 packages", "1 failing · TestX",
 * "Segmentation fault · probe.c:10" or "does not build · bad.c:3 +1".
 */
export function runText({exit, timedOut, tests, reading}) {
  if (timedOut) return 'stopped after 2 min';
  if (!tests?.failedCount) {
    const {crash, errors = []} = reading ?? {};
    if (crash) return `${crashText(crash)}${crash.at ? ` · ${fileLine(crash.at)}` : ''}`;
    const placed = errors.filter(error => error.file);
    if (errors.length) return `does not build${placed.length ? ` · ${fileLine(placed[0])}` : ''}${errors.length > 1 ? ` +${errors.length - 1}` : ''}`;
    if (exit !== 0) return `exit ${exit}`;
    const scope = tests?.packages ? `, ${count(tests.packages, 'package')}` : tests?.files ? `, ${count(tests.files, 'file')}` : '';
    return tests?.passed ? `${count(tests.passed, 'test')}${scope}` : 'passed';
  }
  const [first] = tests.failed;
  if (!first) return tests.runner === 'go' ? 'does not build' : `${tests.failedCount} failing`;
  const name = first.length > NAME_CHARS ? `${first.slice(0, NAME_CHARS - 1)}…` : first;
  return `${tests.failedCount} failing · ${name}${tests.failedCount > 1 ? ` +${tests.failedCount - 1}` : ''}`;
}

/** What a finished run found, for the chat and the models: its tests, else its crash or compiler errors, else `text`. */
const summaryOf = (run, text) => (run.tests ? testSummary(run.tests) : (run.reading && readingSummary(run.reading)) || text);

/** What the gate made of the search trail, for `:Pair trail`. */
export function verdictLine({verdict, reason, score, bar}, level) {
  if (score === undefined) return `Not scored: ${reason}.`;
  return `The Watcher scored it ${score}/10; the bar at ${level} is ${bar}${verdict === 'speak' ? ', so Pair looked for it' : ''}.`;
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

// What the user does, unlike what Pair, herdr's focus or the LSP report: a session nobody uses never ends by itself.
const USER_EVENTS = new Set(['typing', 'edit', 'enter', 'cursor', 'save', 'command_end', 'search']);
// An answer to "What are we doing this session?" that means: no goal, don't ask.
const NO_GOAL = /^\W*(exit|later|skip|none|no|nothing|-)\W*$/i;

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
    this.asksBack = false; // that remark is one question back, and nothing else (see prose-triggers.mjs)
    this.words = []; // what Pair said this turn: an unasked remark shows it under the user's line too
    this.target = null; // where the user's jump key goes: Pair's suggestion this turn, else where it pointed last
    this.held = []; // parts of an urgent unasked remark that came while the user was typing
    this.holding = null; // the parts of the running remark, when it can wait for the user's next breakpoint (see held.mjs)
    this.thought = null; // the held thought, {id, trigger, since, parts}: a remark ready, waiting for that breakpoint
    this.breakpoints = new Breakpoints();
    this.accent = null; // the editor's accent (see style.lua) as #rrggbb, for the chat pane
    this.panes = null; // the user's herdr panes (a PaneWatch), for the Driver's type
    this.edited = false; // the Driver made its one edit in this hand-over
    this.handback = null; // that edit's lines and how the tests went on them: {file, line, endLine, tests}
    this.remarkId = null; // the stored remark of the running unasked turn
    this.lastRemark = null; // the last remark that reached the user: what feedback without an id rates
    this.lastWords = null; // what Pair said in its last turn that said anything: what a teach request without words is about
    this.tickedAt = null;
    this.activeMs = 0; // active time not yet stored
    this.activeAt = 0; // when active time was last counted: what it is stored under
    // The tests run on save, with `testOnSave` ({command, outputFile}); what the editors last heard of them.
    this.testRuns = null;
    this.setTestOnSave(testOnSave);
    this.testsShown = null;
    this.runShown = null; // the places of the last build or run that the editors show (see showRun)
    this.lateForEditors = null; // a late answer no editor was there for, shown to the next one that connects
    this.runError = null; // the last run that could not run, said once in the chat
    this.wasRed = false; // the last run failed
    this.usedAt = null; // when the user last did something in this session (see USER_EVENTS), since the daemon loaded it
    this.goalFrom = null; // where the goal came from when the user did not type it: "the board task repo/12"
    this.goalSkipped = false; // the user said "later" to the goal question
    this.ledger = new Ledger({store, sessionId: record.id, changed: () => this.notify('editors', {type: 'ledger_changed'}), now});
    this.trailVerdict = null; // what the gate decided on the search trail last: {start, verdict, reason, score, bar}
    this.delight = new Delight(); // the moments worth a glow, and the sounds while the user is away
    this.blankPage = null; // the questions of :Pair new and their slice (see blank-page.mjs)
  }

  /** Runs the tests on each save with `testOnSave` ({command, outputFile}) from now on, or none when it is null. */
  setTestOnSave(testOnSave) {
    if (testOnSave?.command === this.testRuns?.command) return;
    this.testRuns = testOnSave && new TestRuns({...testOnSave, root: this.record.root, pane: () => this.scout, report: run => this.testRun(run)});
  }

  get id() { return this.record.id; }
  get root() { return this.record.root; }
  get conversationId() { return this.record.conversation_id; }

  receive(event) {
    const file = event.file && isAbsolute(event.file) ? relative(this.root, event.file) : event.file;
    const {run} = this.state;
    const folded = {at: this.now(), ...event, ...(file ? {file} : {})};
    this.state = fold(this.state, folded);
    this.breakpoints.see(folded);
    if (USER_EVENTS.has(event.kind)) this.usedAt = this.now();
    if (event.kind === 'save' && file && !file.startsWith('..')) this.testRuns?.saved(file);
    if (event.kind === 'command_end') this.delighted(this.delight.command({cmd: event.cmd ?? '', failed: failed(this.state.commands.at(-1)), output: event.output}, folded.at));
    if (this.state.run !== run) this.showRun(this.state.run);
  }

  /**
   * Shows a build or run that crashed or printed compiler errors or warnings on the lines it names, in every
   * editor (see run-places.mjs); a clean run of the same command clears them. Kept for editors that connect later.
   */
  async showRun(run) {
    const places = await placeRun(run, this.root);
    if (this.state.run !== run) return; // a newer run came while this one was placed
    this.runShown = {type: 'run', cmd: run.cmd, places};
    this.notify('editors', this.runShown);
  }

  /**
   * A moment of delight.mjs: the editor the user used last lights up for a green, and says its line if it has one.
   * Its sound plays only while the user is away from that editor, and only if they turned sounds on there.
   */
  delighted(moment) {
    if (!moment) return;
    if (moment.sound === 'green') this.notify('editor', {type: 'delight', text: moment.text});
    this.earcon(moment.sound);
  }

  earcon(sound) {
    this.notify('editor', {type: 'earcon', sound});
  }

  /** A test run on save starts or ends (see test-runs.mjs): the editors show it, and the session state takes it in. */
  testRun(run) {
    if (run.unsaved) return this.unsavedRun(run);
    if (run.state === 'error') {
      this.log(`tests on save: ${run.error}`);
      if (run.error !== this.runError) {
        this.message('system', `Pair could not run \`${run.label}\`: ${run.error}.`);
        this.ledger.add('ran', run.label, {data: {note: run.short, result: 'fail'}});
      }
      this.runError = run.error;
      return this.showTests({type: 'tests', state: 'error', label: run.label, text: run.short});
    }
    this.runError = null;
    if (run.state === 'run') return this.showTests({type: 'tests', state: 'run', label: run.label});
    const red = isRed(run);
    const failing = run.placed.filter(test => !test.ok);
    const files = [...new Set(failing.map(test => relative(this.root, test.failure?.file ?? test.file)))];
    const last = this.state.run;
    this.receive({kind: 'test_run', cmd: run.label, tests: run.tests, files, saved: run.saved, reading: run.reading});
    const fresh = this.state.run !== last ? this.state.run.newWarnings.length : 0; // this run's
    const text = !red && fresh ? `${fresh} new warning${fresh === 1 ? '' : 's'}` : runText(run);
    const moment = this.delight.testRun({red, failed: run.tests?.failed, newly: run.tests ? this.state.tests.newly : []}, this.now())
      ?? (red || run.tests ? null : this.delight.numbers(run.label, run.output));
    this.ledger.add('ran', run.label, {data: {note: text, result: red ? 'fail' : 'pass'}, detail: {output: keptOutput(run.output)}});
    this.showTests({type: 'tests', state: red ? 'fail' : 'pass', label: run.label, text, results: run.placed, ...(red ? {redSince: this.delight.redSince} : {})});
    // The chat hears of a run when it turns red or green, or finds new failures; a run like the last one is no news.
    if (red && (!this.wasRed || (run.tests && this.state.tests.newly.length))) this.message('system', `\`${run.label}\` after you saved ${run.saved}: ${summaryOf(run, text)}`);
    else if (!red && this.wasRed) this.message('system', `\`${run.label}\` passes again${moment?.lasted >= LONG_RED_MS ? `, after ${Math.round(moment.lasted / 60_000)} min of red` : ''}: ${text}.`);
    this.wasRed = red;
    this.delighted(moment);
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
    this.ledger.add('ran', run.label, {data: {note: `${text} · unsaved`, result: isRed(run) ? 'fail' : 'pass'}, detail: {output: keptOutput(run.output)}});
    this.showTests({type: 'tests', state: isRed(run) ? 'fail' : 'pass', label, text, results: run.placed});
    this.message('system', `\`${label}\` after Pair's edit: ${summaryOf(run, text)}`);
  }

  /** The editor's accent (see style.lua), which the chat pane prints Pair in too; one that is no #rrggbb is ignored. */
  setAccent(color) {
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return;
    this.accent = color;
    this.notify('chat', {type: 'accent', color});
  }

  /** Sends a test run's state to every editor, and keeps it for editors that connect later. */
  showTests(message) {
    this.testsShown = message;
    this.notify('editors', message);
  }

  typing() {
    return this.now() - this.state.lastKeyAt < this.typingPauseMs;
  }

  /**
   * Shows `action` now or, for an unasked remark, when it is due: at the user's next pause in typing, or, for a
   * remark that can wait, at their next breakpoint.
   */
  show(action) {
    if (this.unasked && this.holding) this.holding.push(action);
    else if (this.unasked && this.typing()) this.held.push(action);
    else action();
  }

  /** Shows what waits once it is due: the held thought at the user's next breakpoint, other parts at a pause. */
  showDue() {
    if (this.thought && this.breakpoints.last(this.state, this.now()) >= this.thought.since) this.release();
    if (this.held.length && !this.typing()) this.held.splice(0).forEach(action => action());
  }

  /** Holds a finished remark that can wait: the editor shows a dot where it is about until it is due. */
  hold(thought, target) {
    this.thought = thought;
    if (this.breakpoints.last(this.state, this.now()) >= thought.since) return this.release();
    this.log(`${thought.trigger.kind}: held for the next breakpoint`);
    this.notify('editor', {type: 'held', id: thought.id, ...placeOf(target, thought.trigger, this.root)});
  }

  /** Shows the held thought: at a breakpoint, or early when the user asks. One no longer true is dropped. */
  release() {
    const {thought} = this;
    if (!thought) return;
    this.thought = null;
    if (stillTrue(thought.trigger, this.state)) return thought.parts.forEach(action => action());
    this.log(`${thought.trigger.kind}: held thought dropped, no longer true`);
    this.store.dropRemark(thought.id);
    this.notify('editors', {type: 'unheld', id: thought.id});
  }

  /** Looks for a trigger worth a remark; called about once a second. Ticks never overlap. */
  async tick() {
    this.countActive();
    this.showDue();
    if (this.ticking || this.role === 'driver' || !this.health.ok()) return;
    const now = this.now();
    // While :Pair new asks its questions, the note they are in is no place for remarks.
    const triggers = detectTriggers(this.state, now, this.fired).filter(trigger => !this.blankPage?.covers(trigger));
    this.waits = new Map([...this.waits].filter(([key]) => triggers.some(trigger => trigger.key === key)));
    // While the Partner is at work, what comes up waits for the model; how long goes with the remark it becomes.
    if (this.busy) return triggers.forEach(trigger => this.waitFor(trigger, now));
    this.ticking = true;
    try {
      if (triggers.length && this.autoTune) this.budget.tune(tuning(this.store.remarks(now - WINDOW_MS), now));
      for (const trigger of triggers) {
        if (this.thought && !urgent(trigger.kind)) continue; // one held thought at a time
        const decision = await decide({trigger, state: this.state, now, budget: this.budget, score: this.score, typingPauseMs: this.typingPauseMs});
        if (!this.repeats(trigger, decision)) this.log(`${trigger.kind}: ${decision.verdict} (${decision.reason})`);
        if (decision.held) this.waitFor(trigger, now);
        else this.waited(trigger, now);
        if (trigger.kind === 'search_trail' && decision.verdict !== 'wait') this.trailVerdict = {start: trigger.searches[0].at, ...decision, bar: this.budget.barFor(trigger.kind)};
        if (decision.verdict === 'wait') return;
        if (decision.verdict === 'later') {
          this.deferred.add(trigger.key); // logged once, looked at again each tick until the budget allows
          continue;
        }
        this.fired.add(trigger.key);
        if (decision.verdict === 'speak') return await (this.remarking = this.remark(trigger, decision.score, this.waits.get(trigger.key)?.ms));
        this.ledger.quiet(trigger.kind, decision.reason, {budget: decision.score === undefined});
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
    this.asksBack = asksBack(trigger.kind);
    this.holding = urgent(trigger.kind) ? null : [];
    const since = this.now(); // a breakpoint from here on is the one it waits for
    const id = this.remarkId = this.store.addRemark({sessionId: this.id, trigger: trigger.kind, score, at: this.now(), waitedMs});
    try {
      // The trail's queries, searched in the project: which of the user's words the code has, and where.
      const seen = trigger.kind === 'search_trail' ? {...trigger, detail: `${trigger.detail}\n${await trailMatches(this.root, trigger.searches)}`} : trigger;
      const input = watchInput(seen, describeState(this.state, this.now()));
      if (!(await this.talk(input, {kind: 'remark'}))) {
        this.ledger.quiet(trigger.kind, 'Pair looked, and found nothing worth saying');
        return this.store.dropRemark(id);
      }
      // After the remark's own words, also when they wait for a pause in the user's typing. The editor shows
      // the words under the line the user is on, with a way to the place Pair pointed at.
      const {words, target} = this;
      // The budget pays for a remark the user gets to see, when they see it.
      this.show(() => {
        this.budget.spend(this.now());
        this.lastRemark = id;
        this.notify('chat', {type: 'remark', id});
        this.notify('editor', {type: 'remark', id, text: words.join('\n'), target});
        this.earcon('tick');
      });
      if (this.holding) this.hold({id, trigger, since, parts: this.holding}, target);
    } finally {
      this.unasked = false;
      this.asksBack = false;
      this.holding = null;
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
   * ({file, from, to}) is the lines they asked about. Resolves with what Pair said, '' when it only pointed or the
   * text became the goal.
   */
  async ask(text, selection = null) {
    this.message('user', selection ? `${text} (${relative(this.root, selection.file)}:${selection.from}-${selection.to})` : text);
    this.usedAt = this.now();
    if (!this.state.goal && !this.goalSkipped && !selection) {
      if (NO_GOAL.test(text)) {
        this.goalSkipped = true;
        this.message('system', 'No goal then. Ask anything; /goal sets one.');
      } else {
        this.setGoal(text);
      }
      return '';
    }
    await this.yieldRemark();
    await this.talk(`[user] ${text}${await this.selected(selection)}\n\nNow:\n${describeState(this.state, this.now())}\n\n${KEEP.answer}`);
    return this.words.join('\n');
  }

  /**
   * The user's `question` the daemon was answering when it stopped: the Partner finishes it on restart (`answering`
   * resolves with its answer), and it shows as late, in the chat and the editors, also those that reconnect after it.
   */
  async lateAnswer(question, answering) {
    const asked = question.length > LATE_QUESTION_CHARS ? `${question.slice(0, LATE_QUESTION_CHARS - 1)}…` : question;
    this.message('system', `The daemon restarted while Pair was answering "${asked}"; its answer comes late.`);
    await this.talk(null, {}, answering);
    if (!this.words.length) return;
    const message = {type: 'message', sender: 'system', text: `Late answer to "${asked}": ${this.words.join('\n')}`, at: this.now()};
    if (!this.notify('editors', message)) this.lateForEditors = message;
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
   * `answering` resolves with the answer, as the Partner's ask does: by default, it asks.
   */
  async talk(input, options = {}, answering = () => this.partner.ask(this.conversationId, input, options)) {
    this.busy = true;
    this.spoke = false;
    this.said = false;
    this.paneUses = 0;
    this.words = [];
    this.target = null;
    this.thinks = this.partner.thinkingOf(this.conversationId, options.kind) !== 'off';
    this.showThinking(true);
    try {
      const answer = this.voiced(await answering());
      // After a say, local models tend to end with filler or a repeat; the say already was the answer.
      if (answer && !silent(answer) && !this.said) {
        this.show(() => this.message('pair', answer));
        this.words.push(answer);
        this.spoke = true;
      }
      if (this.words.length) {
        this.lastWords = this.words.join('\n');
        this.bookWords();
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

  /** What Pair said this turn, in the ledger: with its remark, rated there, and the place it pointed at. */
  bookWords() {
    const place = this.target ? {file: this.target.file, line: this.target.line} : undefined;
    this.ledger.add('said', this.words.join('\n'), {data: {remark: this.remarkId ?? undefined, place}, detail: {words: this.words.join('\n\n')}});
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

  /** The goal the user set, or one taken `from` the board task or the branch, which the greeting names. */
  setGoal(goal, from = null) {
    this.store.setGoal(this.id, goal);
    this.receive({kind: 'goal', text: goal});
    this.goalFrom = from;
    if (!from) this.message('system', `Goal: ${goal}`);
  }

  /** What the context card shows: the goal, and every source with what it sends (see context-card.mjs). */
  card() {
    return {type: 'context', goal: this.state.goal, goalFrom: this.goalFrom, sections: contextCard(this.state, this.now())};
  }

  /** Whether the user used this session and then did nothing for `ms`. */
  idle(ms, now = this.now()) {
    return this.usedAt !== null && now - this.usedAt >= ms;
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
    this.usedAt = this.now();
    if (this.busy) return this.message('system', 'Pair is still answering; hand over again once it is done.');
    if (!(await this.setRole('driver'))) return;
    this.edited = false;
    this.handback = null;
    await this.talk(driveInput(words, describeState(this.state, this.now()), await this.selected(selection)));
    await this.handBack();
    // The hand-back line: what Pair says it did, under the lines it changed, with how the tests went on them.
    if (this.handback) this.notify('editor', {type: 'handback', ...this.handback, text: this.words.join('\n')});
    this.earcon('handback');
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

  /**
   * The user asks for the idea behind Pair's words (the teach key in Neovim, ? in the chat): `said` is what showed
   * under their line, else what Pair said last. The answer goes to the chat, and to the editor to show under those
   * words, with its link apart; an editor that asked always hears back, with no text when there is none.
   */
  async teach(said = this.lastWords, remark = null) {
    if (remark) this.seen(remark); // asking about a remark answers it, like going where it points
    // Why there is no teaching, for the chat and the editor that asked.
    const unable = note => {
      this.message('system', note);
      this.notify('editor', {type: 'teaching', text: '', link: null, note});
    };
    if (!said) return unable('Pair has said nothing yet to explain.');
    await this.yieldRemark();
    if (this.busy) return unable('Pair is still answering; ask again once it is done.');
    this.message('user', 'why?');
    const lastWords = this.lastWords;
    await this.talk(teachInput(said));
    this.lastWords = lastWords; // asking again is about the same words, not about this answer
    this.notify('editor', {type: 'teaching', ...splitTeaching(this.words.join('\n'))});
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

  /** Asks the user whether Pair may do `what` with question `text`, and books their answer in the ledger. */
  async allowed(what, text) {
    const ok = await this.confirm(text);
    this.ledger.add('asked', what, {data: {answer: ok ? 'yes' : 'no'}});
    return ok;
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

  /** What `:Pair trail` shows: the searches a trail remark would send, oldest first, and what the gate made of them. */
  trail() {
    const now = this.now();
    const trail = currentTrail(this.state, now);
    const verdict = trail.length && this.trailVerdict?.start === trail[0].at ? this.trailVerdict : null;
    return {
      type: 'trail',
      searches: trail.map(({picker, query, results, file, line, at}) => ({picker, query, results, file, line, after: at - trail[0].at})),
      summary: trailSummary(trail),
      verdict: verdict && verdictLine(verdict, this.budget.level),
    };
  }

  /** Forgets the searches so far: none of them goes to a model. */
  forgetTrail() {
    this.receive({kind: 'forget_searches'});
    this.trailVerdict = null;
  }

  /**
   * Ends the session with a note, which the next session in this project starts from. A session that ends by itself
   * without having been used gets none (`withNote` false): there is nothing to note.
   */
  async end({withNote = true} = {}) {
    await this.scout?.close();
    this.storeActive();
    await this.yieldRemark();
    const input = withNote && noteInput(this.state, await gitStatus(this.root));
    const note = !input ? null : await this.partner.ask(this.conversationId, input).then(cleanNote, error => {
      this.message('system', `No session note: ${error.message}`);
      return null;
    });
    this.store.endSession(this.id, note, this.now());
    if (note) this.message('pair', `Session note:\n${note}`);
    this.notify('editors', {type: 'clear'});
  }

  // The ledger (see ledger.mjs): today's list, what an entry opens to, and Pair's edits undone or done again.

  today() {
    return today(this.store, this.root, this.now());
  }

  ledgerDetail(ids) {
    return ledgerDetail(this.store, this.root, ids);
  }

  /**
   * Undoes Pair's edit `id`, or does it again when it is undone: Neovim merges it into the buffer as it is now, as
   * one undo step, unsaved. When the user changed those lines since, nothing changes and they are told why.
   */
  async undo(id) {
    const action = this.store.action(id);
    const patch = action?.root === this.root ? action.detail?.patch : null;
    if (!patch) return;
    const undone = action.state === 'undone';
    const [base, other] = undone ? [patch.before, patch.after] : [patch.after, patch.before];
    const reply = await this.requestEditor({type: 'revert', file: patch.file, base, other}).catch(error => ({error: error.message}));
    const name = relative(this.root, patch.file);
    if (reply?.error) {
      const text = `Pair's change in ${name} was not ${undone ? 'made again' : 'undone'}: ${reply.error}.`;
      this.message('system', text);
      return this.notify('editor', {type: 'message', sender: 'system', text});
    }
    this.ledger.update(id, {state: undone ? (action.kind === 'suggested' ? 'applied' : null) : 'undone'});
    this.message('system', `${undone ? 'Made Pair\'s change again' : 'Undid Pair\'s change'} in ${name}, unsaved.`);
  }

  /** The user accepted Pair's suggestion `id`: from then on the ledger can undo it like the Driver's edit. */
  applied(id, before, after) {
    const action = this.store.action(id);
    if (action?.root !== this.root || action.kind !== 'suggested' || !Array.isArray(before) || !Array.isArray(after)) return;
    this.ledger.update(id, {state: 'applied', data: {undo: true}, detail: {patch: {file: action.data.place.file, before, after}}});
  }

  greet() {
    if (this.previousNote) this.message('system', `Last time:\n${this.previousNote}`);
    if (this.state.goal) this.message('system', `Goal${this.goalFrom ? `, from ${this.goalFrom}` : ''}: ${this.state.goal}`);
    else this.message('system', 'What are we doing this session? Type the goal here, or "later".');
  }

  message(sender, text) {
    const at = this.now();
    this.store.addMessage(this.id, sender, text, at);
    this.notify('chat', {type: 'message', sender, text, at});
  }

  // The Partner's tools (see tools.mjs). Each returns what the model is told.

  /**
   * What of `text` Pair shows: all of it, but in a remark that is one question back, that question alone, once.
   * Null when nothing of it shows.
   */
  voiced(text) {
    if (!this.asksBack || !text) return text;
    return this.said ? null : oneQuestion(text);
  }

  say(words) {
    const text = this.voiced(words);
    if (!text || silent(text)) return 'shown'; // some models say their SILENT instead of answering it
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
    if (this.asksBack) return 'Not in this remark: ask your one question in words.';
    const path = await projectFile(this.root, file);
    if (!path) return `No file ${file} in the project`;
    this.spoke = true;
    if (!this.target?.suggestion) this.target = {file: path, line, endLine, note, code};
    this.ledger.add('pointed', `${relative(this.root, path)}:${line}, ${note}`, {data: {place: {file: path, line}}});
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
    this.ledger.add('showed', `${relative(this.root, path)}:${line}`, {data: {place: {file: path, line}, note: typing ? 'asked first: you were typing' : undefined}});
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
    const action = this.ledger.add('suggested', `${relative(this.root, path)}:${line}, ${note}`, {data: {place: {file: path, line}, remark: remark ?? undefined}});
    this.show(() => {
      this.notify('editor', {type: 'suggest', file: path, line, endLine, text, note, remark, action});
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
    const last = Math.min(text.split('\n').length, to ?? first + MAX_LINES - 1);
    this.ledger.add('read', `${relative(this.root, path)} ${first}-${last}`, {data: {place: {file: path, line: first}}});
    this.notify('editor', {type: 'look', file: path, from: first, to: last});
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
    const lines = result.output.split('\n');
    const found = result.exit === 0 ? `${lines.length} ${lines.length === 1 ? 'match' : 'matches'}` : result.exit === 1 ? 'no matches' : `exit ${result.exit}`;
    this.ledger.add('searched', `${pattern}${path === '.' ? '' : ` in ${path}`}`, {data: {note: found}, detail: {output: keptOutput(result.output)}});
    if (result.exit === 1) return 'No matches.';
    const more = lines.length > SEARCH_LINES ? `\n(${lines.length - SEARCH_LINES} more lines; search a narrower path)` : '';
    // Small models follow an instruction next to the result far better than one in the system prompt.
    return `${result.exit === 0 ? '' : `exit ${result.exit}\n`}${lines.slice(0, SEARCH_LINES).join('\n')}${more}\n\nName these places (file:line) in your answer.`;
  }

  async run({command}) {
    // A remark nobody asked for may read and search, but not start commands.
    if (this.unasked) return 'Not now: run commands only when the user asks. Read and search instead.';
    const policy = commandPolicy(command);
    if (policy.verdict === 'refuse') {
      this.ledger.add('refused', command, {data: {note: policy.reason}});
      this.message('system', `Pair may not run \`${command}\`: ${policy.reason}.`);
      return `Refused: ${policy.reason}. Do not try another way; tell the user.`;
    }
    if (policy.verdict === 'ask' && !(await this.allowed(command, `Pair wants to run \`${command}\` in its pane (${policy.reason}). Allow?`))) {
      return 'The user did not allow it. Do not run it another way.';
    }
    const result = await this.inPane(command);
    const tests = parseTestOutput(result.output);
    const note = result.timedOut ? 'stopped after 2 min' : tests ? runText({...result, tests}) : result.exit ? `exit ${result.exit}` : undefined;
    this.ledger.add('ran', command, {data: {note, result: result.exit === 0 && !result.timedOut ? 'pass' : 'fail'}, detail: {output: keptOutput(result.output)}});
    return runReport(result, this.root);
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
    // With the buffer's text before and after, the ledger can undo the edit later, after other edits too.
    const patch = Array.isArray(reply.before) && Array.isArray(reply.after) ? {file: path, before: reply.before, after: reply.after} : null;
    const name = relative(this.root, path);
    const changed = this.handback.endLine - this.handback.line + 1;
    const typed = count ? `${changed === 1 ? 'a line' : `${changed} lines`} in ${name}` : `lines ${line}-${endLine} of ${name} deleted`;
    this.ledger.add('typed', typed, {data: {place: {file: path, line: this.handback.line}, note: 'one undo step', undo: !!patch}, detail: patch && {patch}});
    const done = 'Changed, as one undo step. That was your one edit: say in one sentence what you changed';
    // The tests on save read the saved file, so a check there would see the old code and send small models in circles.
    if (!this.testRuns) return `${done}. The file on disk changes only when the user saves, so do not run the tests now.`;
    const run = await this.testRuns.unsaved(path, await this.bufferText(path));
    if (run.state === 'error') return `${done}. The tests could not run on the unsaved buffer: ${run.error}.`;
    this.handback.tests = isRed(run) ? 'fail' : 'pass';
    return `${done}, and whether the tests pass. \`${run.label}\` on the unsaved buffer: ${summaryOf(run, runText(run))}.`;
  }

  /** Types one line into the user's terminal pane once they allow it; Enter stays with them. */
  async type({text}) {
    const refused = this.wheel();
    if (refused) return refused;
    if (!plainLine(text)) return 'Refused: type takes one line of plain text, and the user presses Enter.';
    const pane = this.state.terminalPane;
    if (!this.panes || !pane) return 'No terminal pane of the user is known yet; say the command instead.';
    const policy = commandPolicy(text);
    if (policy.verdict === 'refuse') {
      this.ledger.add('refused', text, {data: {note: policy.reason}});
      return `Refused: ${policy.reason}. Do not try another way; tell the user.`;
    }
    if (!(await this.allowed(text, `Pair wants to type \`${text}\` into your terminal (pane ${pane}), without pressing Enter. Allow?`))) {
      return 'The user did not allow it.';
    }
    const after = this.wheel();
    if (after) return after;
    await this.panes.type(pane, text);
    this.ledger.add('typed', text, {data: {note: 'in your terminal, without Enter'}});
    return 'Typed. The user decides whether to press Enter.';
  }
}
