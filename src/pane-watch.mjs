// What Pair learns from the user's terminals: which pane has focus, which commands run in them, and their output.
// The panes come from a `source`: herdr's socket (src/herdr.mjs), a tmux server (src/tmux.mjs), or the :terminal
// buffers of the session's Neovims (src/nvim-panes.mjs), or several of them as one (Panes): Neovim's terminals in
// herdr or tmux. The source lists them, says what runs in one, reads its text and types into it; herdr pushes focus,
// pane and scroll events, tmux is polled, and Neovim says when the user goes into one of its terminals or out of it.
// The prompt line tells typing from a command too short to be seen running (pane-text.mjs); the shell hook reports
// commands with their exit codes.
// The one thing Pair sends to a user's terminal is the Driver's `type`: plain text, never Enter.
import {commandOutput, linesOf, promptChange} from './pane-text.mjs';

const EDITORS = new Set(['nvim', 'vim', 'vi']);
const FOCUSED_MS = 500; // the focused pane: typing, and commands as short as this
const RUNNING_MS = 1000; // panes with a command running, while the user is elsewhere
const PROMPT_LINES = 50; // read at the prompt; more when a command's output pushed its line out of them
const OUTPUT_LINES = 1000; // the most a source reads at once (herdr's pane.read maximum)
const SETTLE_MS = 100; // after a command ended, between reads until the prompt is back
const SETTLE_TRIES = 6;

/** Whether `text` is one line of plain text: no Enter, no Ctrl-C or other control keys, no escape sequences. */
export const plainLine = text => text.trim() !== '' && !/[\x00-\x1f\x7f]/.test(text);

/**
 * Several sources as one: herdr or tmux, and the :terminal buffers of the Neovims in them. A pane belongs to the
 * source that `owns` it, else to the one that owns no ids of its own (herdr). Of the focused panes the one with the
 * highest `weight` has the focus: the Neovim terminal you are in (2), else herdr's or tmux's focused pane (1), else
 * a Neovim itself (0), which is all there is to say outside herdr and tmux.
 */
export class Panes {
  constructor(sources) {
    this.sources = sources;
    this.name = sources.map(source => source.name).join(' and ');
  }

  sourceOf(pane) {
    return this.sources.find(source => source.owns?.(pane)) ?? this.sources.find(source => !source.owns);
  }

  start(look, scrolled, failed) {
    for (const source of this.sources) source.start(look, scrolled, failed);
  }

  stop() {
    for (const source of this.sources) source.stop();
  }

  /** The panes of every source that answers: herdr closed leaves Neovim's terminals watched. None answering fails. */
  async list() {
    const lists = await Promise.allSettled(this.sources.map(source => source.list()));
    if (lists.every(list => list.status === 'rejected')) throw lists[0].reason;
    const panes = lists.flatMap(list => list.value ?? []);
    const top = Math.max(-1, ...panes.filter(pane => pane.focused).map(pane => pane.weight ?? 1));
    let given = false;
    return panes.map(pane => {
      const focused = pane.focused && !given && (pane.weight ?? 1) === top;
      given ||= focused;
      return {...pane, focused};
    });
  }

  focused(pane) {
    for (const source of this.sources) source.focused?.(pane && this.sourceOf(pane) === source ? pane : null);
  }

  paneOfShell(pid) {
    for (const source of this.sources) {
      const pane = source.paneOfShell?.(pid);
      if (pane) return pane;
    }
    return null;
  }

  commandOf(pane) { return this.sourceOf(pane).commandOf(pane); }
  read(pane, lines) { return this.sourceOf(pane).read(pane, lines); }
  send(pane, text) { return this.sourceOf(pane).send(pane, text); }
}

export class PaneWatch {
  /**
   * `source` is the user's panes as one set: `{name, list() -> [{pane, focused, scrolled}], commandOf(pane),
   * read(pane, lines), send(pane, text), start(look, scrolled, failed), stop(), focused(pane)}`. It calls `look()`
   * when something may have changed (herdr's events, a tmux timer, Neovim saying the user went into a terminal),
   * `scrolled(pane, isScrolled)` when the focused pane's scroll moved, and `failed(error)` when it stops answering.
   * `emit(event)` gets focus, typing and command_end events for the panes of `source`, except Pair's own:
   * `chatPane` and the pane of `scout` (a ScoutPane), whose commands are Pair's, not the user's.
   */
  constructor({source, chatPane = null, scout = null, emit, log = () => {}}) {
    Object.assign(this, {source, chatPane, scout, emit, log});
    this.panes = new Map(); // pane id -> what Pair knows of the user's pane (see paneState)
    this.hooked = new Set();
    this.typedByPair = new Map(); // pane id -> the text the Driver typed there, which is not the user typing
    this.focused = null; // the source's focused pane: {pane, scrolled}
    this.focus = null;
    this.failing = null; // the error of the last request, if it failed
    this.timer = null;
  }

  start() {
    this.stopped = false;
    this.source.start(() => this.refresh(), (pane, scrolled) => this.scrolled(pane, scrolled), error => this.failed(error));
  }

  stop() {
    this.stopped = true;
    this.source.stop();
    clearTimeout(this.timer);
  }

  /** The user scrolled pane `pane` (the focused one) away from the bottom, or back to it. */
  scrolled(pane, isScrolled) {
    if (pane !== this.focused?.pane) return;
    this.focused = {...this.focused, scrolled: isScrolled};
    this.emitFocus();
  }

  /** One line when the source starts failing (herdr was closed, say) and one when it is back, not one per request. */
  failed(error) {
    if (this.failing !== error.message) this.log(`${this.source.name}: ${error.message}`);
    this.failing = error.message;
  }

  answered() {
    if (this.failing) this.log(`${this.source.name} answers again`);
    this.failing = null;
  }

  /** Looks at the source's panes and focus again, after an event or a (re)subscription. One look at a time. */
  refresh() {
    if (this.refreshing) return (this.again = true);
    this.refreshing = this.listPanes().then(() => this.answered(), error => this.failed(error)).finally(() => {
      this.refreshing = null;
      this.schedule();
      if (this.again) { this.again = false; this.refresh(); }
    });
  }

  async listPanes() {
    const panes = await this.source.list();
    const ids = new Set(panes.map(({pane}) => pane));
    for (const id of this.panes.keys()) if (!ids.has(id)) this.panes.delete(id);
    for (const {pane} of panes) {
      // A new pane is looked at once, for an editor in it; then only while it has focus or runs a command.
      if (this.isUsers(pane) && !this.panes.has(pane)) await this.pollPane(pane);
    }
    const focused = panes.find(pane => pane.focused);
    this.focused = focused ? {pane: focused.pane, scrolled: focused.scrolled} : null;
    this.source.focused?.(this.focused?.pane ?? null); // herdr follows the focus with its scroll subscription
    this.emitFocus();
  }

  /** Looks again in FOCUSED_MS or RUNNING_MS, or not before the next event when nothing needs looking at. */
  schedule() {
    if (this.ticking) return; // the look under way schedules the next one when it is done
    clearTimeout(this.timer);
    const focused = this.focused && this.isUsers(this.focused.pane);
    const running = [...this.panes.values()].some(pane => pane.running);
    if (this.stopped || (!focused && !running)) return;
    this.timer = setTimeout(() => this.tick(), focused ? FOCUSED_MS : RUNNING_MS);
  }

  async tick() {
    this.ticking = true;
    const panes = [...this.panes].filter(([id, pane]) => pane.running || id === this.focused?.pane).map(([id]) => id);
    try {
      for (const pane of panes) await this.pollPane(pane);
      this.answered();
    } catch (error) {
      this.failed(error);
    } finally {
      this.ticking = false;
    }
    this.schedule();
  }

  /** What Pair knows of the user's pane `id`: an editor, the command running in it, its text at the prompt. */
  paneState(id) {
    if (!this.panes.has(id)) this.panes.set(id, {editor: false, running: null, before: null, anchor: null, prompt: null});
    return this.panes.get(id);
  }

  /** Panes with the shell hook report their own commands, exit codes included; Pair then only reads their output. */
  markHooked(pane) {
    this.hooked.add(pane);
    if (this.panes.has(pane)) this.paneState(pane).running = null;
  }

  read(pane, lines) {
    return this.source.read(pane, lines);
  }

  /**
   * The pane a shell hook's command ran in: the terminal whose shell has process id `shell`, else the herdr or tmux
   * pane of its environment. The shell's pid comes first, as a Neovim's :terminal inherits the Neovim's pane.
   */
  async paneOf({shell = null, pane = null}) {
    if (!shell || !this.source.paneOfShell) return pane;
    if (!this.source.paneOfShell(shell)) await this.listPanes().catch(() => {}); // a terminal opened since the last look
    return this.source.paneOfShell(shell) ?? pane;
  }

  /** The output of `cmd`, which just ended in `pane`. Test runners print the failed tests far above their summary. */
  async output(pane, cmd) {
    const state = this.paneState(pane);
    return commandOutput(await this.read(pane, OUTPUT_LINES), {before: state.anchor ?? state.before, cmd}).output;
  }

  async pollPane(pane) {
    const cmd = await this.source.commandOf(pane);
    const state = this.paneState(pane);
    state.editor = EDITORS.has(cmd?.split(/[\s/]/).filter(Boolean)[0]);
    if (state.editor) return;
    const hooked = this.hooked.has(pane);
    if (cmd) {
      if (!state.running && !hooked) Object.assign(state, {running: cmd, anchor: state.before});
      return;
    }
    if (state.running) {
      const ended = state.running;
      state.running = null;
      const text = await this.promptBack(pane, state.prompt);
      // Named as typed when its line is found: a source names only the process it saw first (`sleep 2` of `sleep 2; make`).
      this.emit({kind: 'command_end', pane, exit: null, ...commandOutput(text, {before: state.anchor, cmd: ended, prompt: state.prompt})});
      Object.assign(state, {before: text, prompt: linesOf(text).at(-1)});
      return;
    }
    if (pane === this.focused?.pane) await this.atPrompt(pane, state, hooked);
  }

  /**
   * The pane's text once its command ended: once the empty prompt `prompt` is back on its last line (or, with no
   * prompt known, once two reads agree), or as it is after SETTLE_TRIES reads. A Neovim terminal shows what its shell
   * printed a little later, and the shell may still print after the command it ran in the foreground (`echo` of
   * `sleep 1; echo done`).
   */
  async promptBack(pane, prompt) {
    let text = await this.read(pane, OUTPUT_LINES);
    let last = null;
    for (let tries = 1; tries < SETTLE_TRIES && (prompt ? linesOf(text).at(-1) !== prompt : text !== last); tries++) {
      await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
      last = text;
      text = await this.read(pane, OUTPUT_LINES);
    }
    return text;
  }

  /** The focused pane's shell waits at the prompt: whether the user typed, or ran a command too short to be seen. */
  async atPrompt(pane, state, hooked) {
    let text = await this.read(pane, PROMPT_LINES);
    if (state.before === null && !text.trim()) return; // the shell has yet to show its prompt
    // At the first look the last line is taken for the empty prompt; each Enter shows it anew.
    if (state.before === null) state.prompt = linesOf(text).at(-1);
    let change = state.before === null ? null : promptChange(state.before, text, state.prompt);
    if (change?.lost) {
      text = await this.read(pane, OUTPUT_LINES);
      change = promptChange(state.before, text, state.prompt);
    }
    if (change && !change.typed) Object.assign(state, {anchor: state.before, prompt: linesOf(text).at(-1)});
    state.before = text;
    // The first change after the Driver's type is its text arriving, not the user typing.
    if (change?.typed && !this.typedByPair.delete(pane)) this.emit({kind: 'typing', source: 'terminal', pane});
    if (change?.ran && !hooked) this.emit({kind: 'command_end', pane, cmd: change.ran.cmd, exit: null, output: change.ran.output});
  }

  /** `focused` is the focused pane of the source; none means the user is elsewhere. */
  emitFocus() {
    const {pane = null, scrolled = false} = this.focused ?? {};
    const event = {kind: 'focus', target: pane ? this.targetOf(pane) : 'elsewhere', pane, scrolled};
    const key = `${event.pane}:${event.target}:${event.scrolled}`;
    if (key === this.focus) return;
    this.focus = key;
    this.emit(event);
  }

  /** Types `text` at the prompt of the user's terminal pane `pane`. Enter stays with the user. */
  async type(pane, text) {
    if (!plainLine(text)) throw new Error('Only one line of plain text can be typed');
    if (this.targetOf(pane) !== 'terminal') throw new Error(`Pane ${pane} is not one of the user's terminals`);
    this.typedByPair.set(pane, text);
    await this.source.send(pane, text);
  }

  /** The ids of the user's terminal panes seen so far. */
  terminals() {
    return [...this.panes.keys()].filter(pane => this.targetOf(pane) === 'terminal');
  }

  isUsers(pane) {
    return ![this.chatPane, this.scout?.paneId].includes(pane);
  }

  targetOf(pane) {
    if (pane === this.chatPane) return 'chat';
    if (pane === this.scout?.paneId) return 'scout';
    return this.panes.get(pane)?.editor ? 'editor' : 'terminal';
  }
}
