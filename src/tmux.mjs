// tmux as a source of panes (src/pane-watch.mjs): the panes of the tmux session a Neovim or the chat runs in, read
// with tmux's own commands. tmux pushes nothing without a control client, so Pair lists the panes every second
// (focus, scrolling, panes coming and going); the command running in one is its shell's foreground process
// (foreground.mjs), and its text comes from capture-pane, wrapped lines joined as herdr's recent_unwrapped does.
import {execFile} from 'node:child_process';
import {foregroundCommand} from './foreground.mjs';

const LIST_MS = 1000;
const PREFIX = 'tmux:';

/** One tmux command against the server at `socketPath`; its output. */
export function tmux(socketPath, args, {timeoutMs = 3000} = {}) {
  return new Promise((resolve, reject) => {
    execFile('tmux', ['-S', socketPath, ...args], {timeout: timeoutMs}, (error, stdout, stderr) => {
      if (error) reject(new Error(`tmux ${args[0]}: ${(stderr || error.message).trim()}`));
      else resolve(stdout);
    });
  });
}

/** The tmux server and pane of a process's environment: `$TMUX` is "<socket>,<server pid>,<session>". */
export function tmuxOf(env) {
  if (!env.TMUX || !env.TMUX_PANE) return null;
  return {socket: env.TMUX.split(',')[0], pane: env.TMUX_PANE};
}

export const tmuxPane = pane => `${PREFIX}${pane}`;

export class TmuxPanes {
  name = 'tmux';

  /** The panes of the tmux session that pane `pane` (tmux's own id, `%3`) is in, on the server at `socketPath`. */
  constructor({socketPath, pane, foreground = foregroundCommand, listMs = LIST_MS}) {
    Object.assign(this, {socketPath, pane, foreground, listMs});
    this.shells = new Map(); // pane id -> its shell's pid, from the last list
    this.timer = null;
  }

  owns(pane) {
    return pane.startsWith(PREFIX);
  }

  run(args) {
    return tmux(this.socketPath, args);
  }

  start(look) {
    this.stopped = false;
    const again = () => {
      if (this.stopped) return;
      look();
      this.timer = setTimeout(again, this.listMs);
    };
    again();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** The session's panes; the focus is in the active pane of its active window while a client shows the session. */
  async list() {
    const format = '#{pane_id}\t#{pane_pid}\t#{pane_active}\t#{window_active}\t#{session_attached}\t#{scroll_position}';
    const out = await this.run(['list-panes', '-s', '-t', this.pane, '-F', format]);
    const shells = new Map();
    const panes = out.split('\n').filter(Boolean).map(line => {
      const [id, pid, active, windowActive, attached, scroll] = line.split('\t');
      shells.set(tmuxPane(id), Number(pid));
      return {
        pane: tmuxPane(id),
        focused: active === '1' && windowActive === '1' && Number(attached) > 0,
        scrolled: Number(scroll) > 0,
        weight: 1,
      };
    });
    this.shells = shells;
    return panes;
  }

  paneOfShell(pid) {
    for (const [pane, shell] of this.shells) if (shell === pid) return pane;
    return null;
  }

  commandOf(pane) {
    return this.foreground(this.shells.get(pane));
  }

  async read(pane, lines) {
    const text = await this.run(['capture-pane', '-p', '-J', '-t', pane.slice(PREFIX.length), '-S', `-${lines}`]);
    return text.replace(/\n+$/, '').split('\n').slice(-lines).join('\n');
  }

  async send(pane, text) {
    await this.run(['send-keys', '-t', pane.slice(PREFIX.length), '-l', '--', text]);
  }
}
