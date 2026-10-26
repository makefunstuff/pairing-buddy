// What Pair learns from herdr: which pane has focus, which commands run in the user's panes, and their output.
// herdr's socket API has no command boundaries or exit codes (see docs/herdr.md), so commands are found
// by polling each pane's foreground process, and exit codes come from the optional shell hook.
import {connect} from 'node:net';
import {readMessages, sendMessage} from './protocol.mjs';

const EDITORS = new Set(['nvim', 'vim', 'vi']);
const POLL_MS = 1000;

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

/**
 * The output of `cmd` from the pane's recent text: the lines after the last one that shows the command,
 * without the prompt line at the end.
 */
export function commandOutput(text, cmd) {
  const lines = text.replace(/\s+$/, '').split('\n');
  const probe = cmd.trim().slice(0, 40);
  const start = probe ? lines.findLastIndex(line => line.includes(probe)) : -1;
  return lines.slice(start + 1, -1).join('\n');
}

export class PaneWatch {
  /**
   * `emit(event)` gets focus and command_end events for the panes of `workspaceId`, except Pair's own:
   * `chatPane` and the pane of `scout` (a ScoutPane), whose commands are Pair's, not the user's.
   */
  constructor({socketPath, workspaceId, chatPane, scout = null, emit, log = () => {}}) {
    Object.assign(this, {socketPath, workspaceId, chatPane, scout, emit, log});
    this.running = new Map();
    this.hooked = new Set();
    this.editors = new Set();
    this.focus = null;
  }

  start() {
    this.timer = setInterval(() => this.poll().catch(error => this.log(`herdr: ${error.message}`)), POLL_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Panes with the shell hook report their own commands, exit codes included; polling then skips them. */
  markHooked(pane) {
    this.hooked.add(pane);
    this.running.delete(pane);
  }

  async output(pane, cmd) {
    // Test runners print the failed tests' names far above their summary, so read well back.
    const read = await herdrRequest(this.socketPath, 'pane.read', {pane_id: pane, source: 'recent_unwrapped', lines: 400});
    return commandOutput(read.read.text, cmd);
  }

  async poll() {
    const {panes} = await herdrRequest(this.socketPath, 'pane.list', {workspace_id: this.workspaceId});
    for (const pane of panes) {
      if (!['chat', 'scout'].includes(this.targetOf(pane.pane_id))) await this.pollPane(pane.pane_id);
    }
    this.updateFocus(panes.find(pane => pane.focused));
  }

  async pollPane(pane) {
    const {process_info: info} = await herdrRequest(this.socketPath, 'pane.process_info', {pane_id: pane});
    const cmd = foregroundCommand(info);
    const name = cmd?.split(/[\s/]/).filter(Boolean)[0];
    if (name && EDITORS.has(name)) return this.editors.add(pane);
    this.editors.delete(pane);
    if (this.hooked.has(pane)) return;
    const before = this.running.get(pane);
    if (cmd && !before) this.running.set(pane, cmd);
    if (!cmd && before) {
      this.running.delete(pane);
      this.emit({kind: 'command_end', pane, cmd: before, exit: null, output: await this.output(pane, before)});
    }
  }

  /** `pane` is the focused pane of the workspace; none means the user is in another workspace. */
  updateFocus(pane) {
    const event = pane
      ? {kind: 'focus', target: this.targetOf(pane.pane_id), pane: pane.pane_id, scrolled: (pane.scroll?.offset_from_bottom ?? 0) > 0}
      : {kind: 'focus', target: 'elsewhere', pane: null, scrolled: false};
    const key = `${event.pane}:${event.target}:${event.scrolled}`;
    if (key === this.focus) return;
    this.focus = key;
    this.emit(event);
  }

  targetOf(pane) {
    if (pane === this.chatPane) return 'chat';
    if (pane === this.scout?.paneId) return 'scout';
    return this.editors.has(pane) ? 'editor' : 'terminal';
  }
}
