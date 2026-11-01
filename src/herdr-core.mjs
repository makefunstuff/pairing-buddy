// herdr-core (`hc`), the newer herdr, as a source of terminals (docs/herdr.md). It has terminals (`t7`) where herdr
// has panes, and no window: the Herdr window (`herdr-app`) shows a core's terminals in spaces, tabs and panes, and a
// terminal it shows carries the labels `herdr.space` and `herdr.tab`. So the user's terminals are those of the chat's
// space; the focus is the window's, which Pair asks `herdr-app status` for; terminals coming, going and changing come
// pushed from the core's event stream. A terminal says which process runs in it (`foreground`) and gives its text
// (`terminal.read`), as a herdr pane does, but nothing says it scrolled, and the core cannot type without pressing
// Enter: the Driver's `type` does not reach a herdr-core terminal.
import {execFile} from 'node:child_process';
import {connect} from 'node:net';
import {readMessages, sendMessage} from './protocol.mjs';

export const SPACE = 'herdr.space'; // the window's space a terminal is shown in
export const TAB = 'herdr.tab';
const SCOUT = 'pair.scout'; // the label of Pair's own terminal: its project's folder
const FOCUS_MS = 500; // the window's focus is asked for this often, as herdr's focused pane is looked at
const RETRY_MS = 2000;
const APP_MS = 2000;

/**
 * Which herdr the environment `env` is in: `{kind: 'herdr', socket, workspace, pane}` in a herdr pane,
 * `{kind: 'core', socket, pane, session, appHome}` in a herdr-core terminal (`pane` is its address, `t7`), else null.
 * herdr comes first: a herdr started in a herdr-core terminal has its panes inside it.
 */
export function herdrOf(env = process.env) {
  if (env.HERDR_SOCKET_PATH) return {kind: 'herdr', socket: env.HERDR_SOCKET_PATH, workspace: env.HERDR_WORKSPACE_ID ?? null, pane: env.HERDR_PANE_ID ?? null};
  const socket = env.HC_SOCKET || env.HC_TERMINAL_SOCKET;
  if (socket && env.HC_TERMINAL_ID) return {kind: 'core', socket, pane: env.HC_TERMINAL_ID, session: env.HC_SESSION || null, appHome: env.HERDR_APP_HOME || null};
  return null;
}

/** One request to herdr-core's socket (JSON-RPC 2.0, a line each way); one connection per request. */
export function coreRequest(socketPath, method, params = {}, {timeoutMs = 3000} = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`herdr-core ${method} timed out`)); }, timeoutMs);
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('connect', () => sendMessage(socket, {jsonrpc: '2.0', id: 1, method, params}));
    readMessages(socket, message => {
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.destroy();
      if (message.error) reject(Object.assign(new Error(`herdr-core ${method}: ${message.error.message ?? JSON.stringify(message.error)}`), {kind: message.error.data?.kind ?? null}));
      else resolve(message.result);
    });
  });
}

/** The command a terminal runs, or null when its own program (the shell) is in the foreground. */
export function coreCommand(terminal) {
  const fg = terminal.foreground;
  if (!fg || fg.pid === terminal.pid) return null;
  return fg.argv?.join(' ') || fg.name || null;
}

/**
 * The core's push stream: `events.subscribe` on a connection that then carries only notifications. `onEvent()` for
 * each fact change (and after `missed`), `onStart()` each time it (re)starts, `onError(error)` when it fails or
 * drops, after which it is tried again every RETRY_MS. Returns `{close}`.
 */
export function coreEvents(socketPath, params, {onEvent, onStart = () => {}, onError = () => {}}) {
  let socket = null;
  let retry = null;
  let closed = false;
  const again = error => {
    if (closed || retry) return;
    socket?.destroy();
    onError(error);
    retry = setTimeout(() => { retry = null; open(); }, RETRY_MS);
  };
  function open() {
    socket = connect(socketPath);
    socket.on('error', again);
    socket.on('close', () => again(new Error('herdr-core closed the event stream')));
    socket.on('connect', () => sendMessage(socket, {jsonrpc: '2.0', id: 'subscribe', method: 'events.subscribe', params}));
    readMessages(socket, message => {
      if (message.id === 'subscribe') return message.error ? again(new Error(`herdr-core events.subscribe: ${message.error.message}`)) : onStart();
      if (message.method === 'event' || message.method === 'missed') onEvent(message.params ?? {});
    });
  }
  open();
  return {
    close() {
      closed = true;
      clearTimeout(retry);
      socket?.destroy();
    },
  };
}

/**
 * The Herdr window, through its command (`herdr-app status`, `ls`, `do`), which talks to the running window and never
 * opens one. `env` picks the window as the chat's terminal has it (HC_SESSION, HERDR_APP_HOME). Without a window,
 * or without the command, each call fails.
 */
export class HerdrApp {
  constructor({command = 'herdr-app', env = {}} = {}) {
    Object.assign(this, {command});
    this.env = {...process.env, ...Object.fromEntries(Object.entries(env).filter(([, value]) => value))};
    this.panes = new Map(); // pane id -> the terminal it shows, from the last `ls`
  }

  run(args) {
    return new Promise((resolve, reject) => execFile(this.command, args, {env: this.env, timeout: APP_MS}, (error, stdout) => {
      if (error) return reject(error);
      try {
        const answer = JSON.parse(stdout);
        if (answer?.error) reject(new Error(`herdr-app: ${answer.error}`));
        else resolve(answer);
      } catch {
        reject(new Error(`herdr-app ${args[0]} said no JSON`));
      }
    }));
  }

  /** The terminal that has the window's focus, when the window shows space `space`; else null. */
  async focused(space) {
    const status = await this.run(['status']);
    if (!space || status.space !== space || !status.focused_pane) return null;
    if (!this.panes.has(status.focused_pane)) await this.readPanes();
    return this.panes.get(status.focused_pane) ?? null;
  }

  async readPanes() {
    const {spaces = []} = await this.run(['ls']);
    this.panes = new Map(spaces.flatMap(space => space.tabs ?? []).flatMap(tab => tab.terminals ?? []).map(each => [each.pane, each.terminal]));
  }

  /** Shows the agent of terminal `terminal`. */
  focus(terminal) {
    return this.run(['do', 'agent.focus', '--terminal', terminal]);
  }
}

/**
 * The terminals of the window's space the chat terminal `chatPane` is in, for PaneWatch (pane-watch.mjs): the same
 * interface as herdr's panes, with terminal addresses for pane ids. A chat in no space (a core without the window)
 * watches none.
 */
export class CorePanes {
  name = 'herdr-core';

  constructor({socketPath, chatPane, app = new HerdrApp(), focusMs = FOCUS_MS}) {
    Object.assign(this, {socketPath, chatPane, app, focusMs});
    this.space = undefined; // the chat's space, once asked
    this.focus = null; // the terminal the window's focus is on, among the space's
    this.pids = new Map(); // a terminal's own program (its shell) -> the terminal, for the shell hook's reports
    this.stream = null;
    this.timer = null;
  }

  request(method, params) {
    return coreRequest(this.socketPath, method, params);
  }

  async spaceOf() {
    if (this.space === undefined) this.space = (await this.request('terminal.get', {terminal: this.chatPane})).labels?.[SPACE] ?? null;
    return this.space;
  }

  start(look, reportScroll, failure) {
    this.stopped = false;
    Object.assign(this, {look, failure});
    this.retry();
  }

  /** Starts, and while the core does not answer, tries again every RETRY_MS, as herdr's event stream does. */
  retry() {
    this.begin().catch(error => {
      this.failure(error);
      if (!this.stopped) this.timer = setTimeout(() => this.retry(), RETRY_MS);
    });
  }

  /**
   * Once the chat's space is known: the events of its terminals and the window's focus. A start that failed (the core
   * did not answer) is tried again by retry(), or sooner by a look.
   */
  async begin({looking = false} = {}) {
    if (this.stream || this.stopped) return;
    const space = await this.spaceOf().catch(error => {
      this.space = undefined; // asked again at the next look
      throw error;
    });
    if (this.stream || this.stopped) return;
    if (!space) return looking ? undefined : this.look();
    this.stream = coreEvents(this.socketPath, {labels: {[SPACE]: space}}, {onEvent: () => this.look(), onStart: () => this.look(), onError: this.failure});
    this.followFocus(this.look);
  }

  /** The window says nothing when its focus moves: it is asked every focusMs, and a move makes PaneWatch look. */
  followFocus(look) {
    if (this.stopped) return;
    this.app.focused(this.space).catch(() => null).then(focus => {
      if (focus !== this.focus) {
        this.focus = focus;
        look();
      }
      if (!this.stopped) this.timer = setTimeout(() => this.followFocus(look), this.focusMs);
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.stream?.close();
  }

  async list() {
    if (this.space === undefined) await this.begin({looking: true});
    const space = await this.spaceOf();
    if (!space) return [];
    const {terminals} = await this.request('terminal.list', {labels: {[SPACE]: space}});
    const live = terminals.filter(terminal => terminal.state === 'live' && !terminal.address.includes('/'));
    this.pids = new Map(live.filter(terminal => terminal.pid).map(terminal => [terminal.pid, terminal.address]));
    return live.map(terminal => ({pane: terminal.address, focused: terminal.address === this.focus, scrolled: false}));
  }

  paneOfShell(pid) {
    return this.pids.get(pid) ?? null;
  }

  async commandOf(pane) {
    return coreCommand(await this.request('terminal.get', {terminal: pane}));
  }

  /** Its last `lines` lines: the screen, with history above it, without the empty rows below the prompt. */
  async read(pane, lines) {
    const {text} = await this.request('terminal.read', {terminal: pane, lines});
    const all = text.split('\n');
    while (all.length > 1 && !all.at(-1).trim()) all.pop();
    return all.slice(-lines).join('\n');
  }

  send() {
    return Promise.reject(new Error('herdr-core types only with Enter, so Pair cannot type into its terminals'));
  }
}

/**
 * Pair's own terminal on herdr-core, for Scout and the tests on save (scout-pane.mjs): started by the core in the
 * chat's space and tab, so the window shows it beside the chat, and labelled with the project's folder, so a restarted
 * daemon finds it. Started without a parent, it outlives the chat. Its commands go in pasted with Enter.
 */
export class CorePaneHost {
  constructor({socketPath, besidePane, root}) {
    Object.assign(this, {socketPath, besidePane, root});
    this.key = `core:${socketPath}`; // with the project, names the pane's folder: the same after a restart
    this.hidden = [socketPath]; // a command in the sandbox must not reach the core's API
  }

  request(method, params) {
    return coreRequest(this.socketPath, method, params);
  }

  async has(id) {
    const terminal = await this.request('terminal.get', {terminal: id}).catch(error => (error.kind === 'not_found' ? null : Promise.reject(error)));
    return terminal?.state === 'live';
  }

  /** The terminal an earlier daemon opened for this project, or null. */
  async find() {
    const {terminals} = await this.request('terminal.list', {labels: {[SCOUT]: this.root}});
    return terminals.find(terminal => terminal.state === 'live')?.address ?? null;
  }

  /** Starts a terminal in `cwd` whose program is the shell line `line`; its address. */
  async open({cwd, line}) {
    const beside = await this.request('terminal.get', {terminal: this.besidePane}).catch(() => null);
    const shown = Object.fromEntries([SPACE, TAB].filter(key => beside?.labels?.[key]).map(key => [key, beside.labels[key]]));
    const started = await this.request('terminal.run', {line, cwd, labels: {...shown, [SCOUT]: this.root}, no_parent: true, no_notify: true});
    return started.address;
  }

  /** Text as ScoutPane types it: Ctrl-U, a line and Enter (`\x15…\r`), or Ctrl-C alone (`\x03`). */
  async send(id, text) {
    if (text === '\x03') return this.request('terminal.keys', {terminal: id, keys: ['ctrl+c']});
    if (text.startsWith('\x15')) await this.request('terminal.keys', {terminal: id, keys: ['ctrl+u']});
    const line = text.replace(/^\x15/, '').replace(/\r$/, '');
    return this.request('terminal.send', {terminal: id, text: line, force: true});
  }

  close(id) {
    return this.request('terminal.kill', {terminal: id});
  }
}

/**
 * The agents of a core as herdr's `agent.list` has them (agents.mjs): the terminals whose program says what it does
 * (OSC 7501: idle, working, done, blocked or error), each `{pane_id, name, cwd, agent, agent_status, title,
 * terminal_title_stripped}`.
 */
export async function coreAgents(socketPath) {
  const {terminals} = await coreRequest(socketPath, 'terminal.list', {});
  return terminals.filter(terminal => terminal.state === 'live' && terminal.status?.state).map(terminal => ({
    pane_id: terminal.address, name: terminal.name ?? null, cwd: terminal.foreground?.cwd ?? terminal.cwd ?? null,
    agent: terminal.status.app || terminal.foreground?.name || 'agent', agent_status: terminal.status.state,
    title: terminal.status.title || '', terminal_title_stripped: terminal.status.msg || terminal.title || '',
  }));
}

/**
 * `pair` in herdr-core terminal `herdr.pane`: starts `argv` (the chat) in a terminal of its own in the same space and
 * tab of the Herdr window, which shows it beside this one. False when no window shows this terminal: the chat then
 * runs right here.
 */
export async function openCoreChat(herdr, {argv, cwd, env = {}}) {
  const here = await coreRequest(herdr.socket, 'terminal.get', {terminal: herdr.pane}).catch(() => null);
  const shown = Object.fromEntries([SPACE, TAB].filter(key => here?.labels?.[key]).map(key => [key, here.labels[key]]));
  if (!shown[SPACE]) return false;
  await coreRequest(herdr.socket, 'terminal.run', {argv, cwd, env, labels: shown, no_parent: true, no_notify: true});
  return true;
}

/** What `pair doctor` says of a core: its version and terminals. */
export async function coreStatus(socketPath) {
  return coreRequest(socketPath, 'server.status', {});
}
