// herdr as a source of panes (src/pane-watch.mjs): what Pair learns from herdr's socket API, which pane has focus,
// which commands run in the user's panes, and their output. Focus, panes coming and going or changing (a title the
// shell sets), and scrolling come pushed from herdr's event stream. herdr says nothing about commands or keys (see
// docs/herdr.md): the optional shell hook reports them, and for panes without it PaneWatch looks at the focused pane
// twice a second and at panes running a command once a second, and at nothing while the user is in another
// workspace with nothing running. The Driver's `type` is the one thing Pair sends to a user's pane.
import {connect} from 'node:net';
import {subscribe} from './herdr-events.mjs';
import {PaneWatch as PaneWatchBase, plainLine} from './pane-watch.mjs';
import {readMessages, sendMessage} from './protocol.mjs';

// Focus moving, panes coming and going or changing, and for the focused pane its scroll.
const EVENTS = ['pane.focused', 'pane.created', 'pane.closed', 'pane.updated', 'tab.focused', 'workspace.focused'];
const SCROLL = 'pane.scroll_changed';

export {plainLine};

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

/** herdr's panes of one workspace, for PaneWatch. */
export class HerdrPanes {
  name = 'herdr';

  constructor({socketPath, workspaceId}) {
    Object.assign(this, {socketPath, workspaceId});
    this.scrollPane = null;
    this.stream = null;
    this.look = () => {};
    this.reportScroll = () => {};
    this.failure = () => {};
  }

  request(method, params) {
    return herdrRequest(this.socketPath, method, params);
  }

  start(look, reportScroll, failure) {
    this.stopped = false;
    this.look = look;
    this.reportScroll = reportScroll;
    this.failure = failure;
    this.listen(null);
  }

  stop() {
    this.stopped = true;
    this.stream?.close();
  }

  /** Subscribes to herdr's events, with the scroll of `pane` (the focused one) among them. */
  listen(pane) {
    this.stream?.close();
    this.scrollPane = pane;
    const subscriptions = [...EVENTS.map(type => ({type})), ...(pane ? [{type: SCROLL, pane_id: pane}] : [])];
    this.stream = subscribe(this.socketPath, subscriptions, {
      onEvent: event => this.heard(event),
      onStart: () => this.look(),
      onError: error => this.failure(error),
    });
  }

  heard({event, data}) {
    if (event !== SCROLL) return this.look();
    this.reportScroll(data.pane_id, data.scroll.offset_from_bottom > 0);
  }

  /** Called with the pane that has focus, so the subscription can follow it. */
  focused(pane) {
    if (!this.stopped && (pane ?? null) !== this.scrollPane) this.listen(pane ?? null);
  }

  async list() {
    const {panes} = await this.request('pane.list', {workspace_id: this.workspaceId});
    return panes.map(pane => ({
      pane: pane.pane_id,
      focused: pane.focused === true,
      scrolled: (pane.scroll?.offset_from_bottom ?? 0) > 0,
    }));
  }

  async commandOf(pane) {
    const {process_info: info} = await this.request('pane.process_info', {pane_id: pane});
    return foregroundCommand(info);
  }

  read(pane, lines) {
    return this.request('pane.read', {pane_id: pane, source: 'recent_unwrapped', lines}).then(({read}) => read.text);
  }

  send(pane, text) {
    return this.request('pane.send_text', {pane_id: pane, text});
  }
}

/**
 * Watches one herdr workspace: `emit(event)` gets focus, typing and command_end events for the user's panes,
 * except Pair's own: `chatPane` and the pane of `scout` (a ScoutPane), whose commands are Pair's, not the user's.
 */
export class PaneWatch extends PaneWatchBase {
  constructor({socketPath, workspaceId, chatPane, scout = null, emit, log = () => {}}) {
    super({source: new HerdrPanes({socketPath, workspaceId}), chatPane, scout, emit, log});
  }
}
