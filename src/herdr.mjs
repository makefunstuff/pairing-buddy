// What Pair learns from herdr: which pane has focus, which commands run in the user's panes, and their output.
// Focus, panes and scrolling come pushed from herdr's event stream. herdr says nothing about commands or keys
// (see docs/herdr.md), so Pair looks at the focused pane twice a second and at panes running a command once a
// second, and at nothing while the user is in another workspace with nothing running: a foreground process other
// than the shell is a running command, and the prompt line tells typing from a command too short to be seen
// running (pane-text.mjs). Exit codes come from the optional shell hook.
// The one thing Pair sends to a user's pane is the Driver's `type`: plain text, never Enter.
import {connect} from 'node:net';
import {subscribe} from './herdr-events.mjs';
import {commandOutput, linesOf, promptChange} from './pane-text.mjs';
import {readMessages, sendMessage} from './protocol.mjs';

const EDITORS = new Set(['nvim', 'vim', 'vi']);
const FOCUSED_MS = 500; // the focused pane: typing, and commands as short as this
const RUNNING_MS = 1000; // panes with a command running, while the user is elsewhere
const PROMPT_LINES = 50; // read at the prompt; more when a command's output pushed its line out of them
const OUTPUT_LINES = 1000; // the most herdr's pane.read returns
// Focus moving, panes coming and going or changing (a title the shell sets), and for the focused pane its scroll.
const EVENTS = ['pane.focused', 'pane.created', 'pane.closed', 'pane.updated', 'tab.focused', 'workspace.focused'];

/** One request to herdr's socket. herdr answers one request per connection. */
export function herdrRequest(socketPath, method, params = {}, {timeoutMs = 3000} = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`herdr ${method} timed out`)); }, timeoutMs);
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('connect', () => sendMessage(socket, {id: '1', method, params}));
    readMessages(socket, message => {
      clearTimeout(timer);
      socket.destroy();
      if (message.error) reject(new Error(`herdr ${method}: ${message.error.message ?? JSON.stringify(message.error)}`));
      else resolve(message.result);
    });
  });
}

/** The command a pane is running, or null when its shell is at the prompt. */
export function foregroundCommand(info) {
  const command = (info.foreground_processes ?? []).find(process => process.pid !== info.shell_pid);
  return command ? (command.argv?.join(' ') || command.name) : null;
}

/** Whether `text` is one line of plain text: no Enter, no Ctrl-C or other control keys, no escape sequences. */
export const plainLine = text => text.trim() !== '' && !/[\x00-\x1f\x7f]/.test(text);

export class PaneWatch {
  /**
   * `emit(event)` gets focus, typing and command_end events for the panes of `workspaceId`, except Pair's own:
   * `chatPane` and the pane of `scout` (a ScoutPane), whose commands are Pair's, not the user's.
   */
  constructor({socketPath, workspaceId, chatPane, scout = null, emit, log = () => {}}) {
    Object.assign(this, {socketPath, workspaceId, chatPane, scout, emit, log});
    this.panes = new Map(); // pane id -> what Pair knows of the user's pane (see paneState)
    this.hooked = new Set();
    this.typedByPair = new Map(); // pane id -> the text the Driver typed there, which is not the user typing
    this.focused = null; // the workspace's focused pane: {pane, scrolled}
    this.focus = null;
    this.failing = null; // the error of the last request, if it failed
    this.timer = null;
  }

  start() {
    this.stopped = false;
    this.listen(null);
  }

  stop() {
    this.stopped = true;
    this.stream?.close();
    clearTimeout(this.timer);
  }

  /** Subscribes to herdr's events, with the scroll of `pane` (the focused one) among them. */
  listen(pane) {
    this.stream?.close();
    this.scrollPane = pane;
    const subscriptions = [...EVENTS.map(type => ({type})), ...(pane ? [{type: 'pane.scroll_changed', pane_id: pane}] : [])];
    this.stream = subscribe(this.socketPath, subscriptions, {
      onEvent: event => this.heard(event),
      onStart: () => this.refresh(),
      onError: error => this.failed(error),
    });
  }

  heard({event, data}) {
    if (event !== 'pane.scroll_changed') return this.refresh();
    if (data.pane_id !== this.focused?.pane) return;
    this.focused = {...this.focused, scrolled: data.scroll.offset_from_bottom > 0};
    this.emitFocus();
  }

  /** One line when herdr starts failing (it was closed, say) and one when it is back, not one per request. */
  failed(error) {
    if (this.failing !== error.message) this.log(`herdr: ${error.message}`);
    this.failing = error.message;
  }

  answered() {
    if (this.failing) this.log('herdr answers again');
    this.failing = null;
  }

  /** Looks at the workspace's panes and focus again, after an event or a (re)subscription. One look at a time. */
  refresh() {
    if (this.refreshing) return (this.again = true);
    this.refreshing = this.listPanes().then(() => this.answered(), error => this.failed(error)).finally(() => {
      this.refreshing = null;
      if (this.again) { this.again = false; this.refresh(); }
    });
  }

  async listPanes() {
    const {panes} = await herdrRequest(this.socketPath, 'pane.list', {workspace_id: this.workspaceId});
    const ids = new Set(panes.map(pane => pane.pane_id));
    for (const id of this.panes.keys()) if (!ids.has(id)) this.panes.delete(id);
    for (const {pane_id: id} of panes) {
      // A new pane is looked at once, for an editor in it; then only while it has focus or runs a command.
      if (this.isUsers(id) && !this.panes.has(id)) await this.pollPane(id);
    }
    const focused = panes.find(pane => pane.focused);
    this.focused = focused ? {pane: focused.pane_id, scrolled: (focused.scroll?.offset_from_bottom ?? 0) > 0} : null;
    if (!this.stopped && (this.focused?.pane ?? null) !== this.scrollPane) this.listen(this.focused?.pane ?? null);
    this.emitFocus();
    this.schedule();
  }

  /** Looks again in FOCUSED_MS or RUNNING_MS, or not before the next event when nothing needs looking at. */
  schedule() {
    clearTimeout(this.timer);
    const focused = this.focused && this.isUsers(this.focused.pane);
    const running = [...this.panes.values()].some(pane => pane.running);
    if (this.stopped || (!focused && !running)) return;
    this.timer = setTimeout(() => this.tick(), focused ? FOCUSED_MS : RUNNING_MS);
  }

  async tick() {
    const panes = [...this.panes].filter(([id, pane]) => pane.running || id === this.focused?.pane).map(([id]) => id);
    try {
      for (const pane of panes) await this.pollPane(pane);
      this.answered();
    } catch (error) {
      this.failed(error);
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
    return herdrRequest(this.socketPath, 'pane.read', {pane_id: pane, source: 'recent_unwrapped', lines}).then(({read}) => read.text);
  }

  /** The output of `cmd`, which just ended in `pane`. Test runners print the failed tests far above their summary. */
  async output(pane, cmd) {
    const state = this.paneState(pane);
    return commandOutput(await this.read(pane, OUTPUT_LINES), {before: state.anchor ?? state.before, cmd});
  }

  async pollPane(pane) {
    const {process_info: info} = await herdrRequest(this.socketPath, 'pane.process_info', {pane_id: pane});
    const state = this.paneState(pane);
    const cmd = foregroundCommand(info);
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
      const text = await this.read(pane, OUTPUT_LINES);
      this.emit({kind: 'command_end', pane, cmd: ended, exit: null, output: commandOutput(text, {before: state.anchor, cmd: ended})});
      Object.assign(state, {before: text, prompt: linesOf(text).at(-1)});
      return;
    }
    if (pane === this.focused?.pane) await this.atPrompt(pane, state, hooked);
  }

  /** The focused pane's shell waits at the prompt: whether the user typed, or ran a command too short to be seen. */
  async atPrompt(pane, state, hooked) {
    let text = await this.read(pane, PROMPT_LINES);
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

  /** `focused` is the focused pane of the workspace; none means the user is in another workspace. */
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
    await herdrRequest(this.socketPath, 'pane.send_text', {pane_id: pane, text});
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
