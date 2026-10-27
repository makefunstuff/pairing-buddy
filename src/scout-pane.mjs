// Pair's own pane, where Scout's commands are typed and run in plain sight: in herdr, or in Neovim without it
// (pane-hosts.mjs). Its shell writes down each command's output and exit code (see pane-runs.mjs): that is how Pair
// knows when a command ended and how, which herdr cannot say, and reads all of its output, not the screen's last 1000 lines.
// Its prompt shows them too: "scout[3] exit 1 $ ". How it starts (your rc file or none, in a sandbox or not) is
// scout-shell.mjs. Scout's text is only ever sent to this pane, never to one of the user's.
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {PaneRuns} from './pane-runs.mjs';
import {rcNames, scoutPaneConfig, shellLine} from './scout-shell.mjs';

export {shellQuote} from './scout-shell.mjs';

const READY_MS = 5000;
const RC_READY_MS = 15_000; // an rc file may take its time (version managers, completions)
export const RUN_TIMEOUT_MS = 120_000;

export class ScoutPane {
  /**
   * The pane opens on `host` (pane-hosts.mjs), in `cwd`. `setup` is the config's `scoutPane`; in the sandbox,
   * `writable` are folders it may write besides the project, `hidden` sockets it must not reach besides the host's.
   * Its shell writes its files to a folder of its own in `runsDir`, the same for the host and project after a
   * restart, so a later daemon reads the pane it finds.
   */
  constructor({host, cwd, runsDir, setup = scoutPaneConfig(), writable = [], hidden = [], log = () => {}}) {
    Object.assign(this, {host, cwd, setup, writable, hidden, log});
    const key = createHash('sha256').update(`${host.key}\0${cwd}`).digest('hex').slice(0, 16);
    this.runs = new PaneRuns(join(runsDir, key));
    this.paneId = null;
    this.queue = Promise.resolve();
    this.names = null;
  }

  /**
   * Opens the pane, or finds the one an earlier daemon opened, or keeps the open one. A pane whose shell does not
   * write its files (a busy one, or one of an older Pair) is closed and opened anew.
   */
  async open() {
    if (this.paneId !== null && (await this.host.has(this.paneId))) return;
    this.paneId = await this.host.find();
    if (this.paneId !== null && (await this.runs.next()) !== null) return;
    if (this.paneId !== null) await this.close();
    // Its folder first, which the sandbox binds only if it is there; then the line, before the pane, since it throws
    // when the config asks for a sandbox that cannot be made.
    await this.runs.prepare();
    const {line, sandboxed} = shellLine({setup: this.setup, cwd: this.cwd, runs: this.runs.dir, writable: this.writable, hidden: [...this.host.hidden, ...this.hidden]});
    this.paneId = await this.host.open({cwd: this.cwd, line});
    await this.runs.ready(this.setup.rc ? RC_READY_MS : READY_MS).catch(error => {
      if (this.setup.rc) throw new Error(`Pair's pane shows no prompt after loading ${this.setup.rc}: does it start another shell?`);
      // A shell that never reached its prompt: most often the sandbox could not start here, which the pane shows.
      throw sandboxed ? new Error('its pane shows no prompt: the sandbox may not start here (the pane says why); "scoutPane": {"sandbox": false} in the config runs without it') : error;
    });
    this.log(`opened Pair's pane ${this.paneId}${sandboxed ? ' in the sandbox' : ''}${this.setup.rc ? ` with ${this.setup.rc}` : ''}`);
  }

  /**
   * The aliases and functions the pane's shell has from the user's rc file, for the command policy: `{aliases,
   * functions}`, `{unknown: true}` when they cannot be listed, or undefined without an rc file. Listed once.
   */
  rcNames() {
    if (!this.setup.rc) return Promise.resolve(undefined);
    this.names ??= rcNames(this.setup.rc, this.cwd).catch(error => {
      this.log(error.message);
      return {unknown: true};
    });
    return this.names;
  }

  async close() {
    if (this.paneId === null) return;
    const paneId = this.paneId;
    this.paneId = null;
    await this.host.close(paneId).catch(() => {});
    await this.runs.remove();
  }

  /**
   * Types `command` in the pane and resolves with `{exit, output, timedOut, cancelled}` once it ends. A command
   * still running after `timeoutMs`, or when `signal` aborts, is stopped with Ctrl-C; one aborted before its turn
   * is never typed. Commands run one at a time.
   */
  run(command, {timeoutMs = RUN_TIMEOUT_MS, signal} = {}) {
    const result = this.queue.then(() => (signal?.aborted ? {exit: null, output: '', timedOut: false, cancelled: true} : this.runNow(command, timeoutMs, signal)));
    this.queue = result.catch(() => {});
    return result;
  }

  async runNow(command, timeoutMs, signal) {
    await this.open();
    const {runs} = this;
    const number = await runs.next();
    if (number === null) throw new Error('Pair\'s pane is busy: its shell is not at the prompt');
    await runs.clearLog();
    // Aborted while the pane got ready: never typed.
    if (signal?.aborted) return {exit: null, output: '', timedOut: false, cancelled: true};
    // Ctrl-U first clears anything typed at the prompt by hand.
    const typed = this.host.send(this.paneId, `\x15${command}\r`);
    let timedOut = false;
    let cancelled = false;
    // Ctrl-C once the command is typed, so it stops the command and not the prompt before it.
    const cancel = () => {
      cancelled = true;
      typed.then(() => this.host.send(this.paneId, '\x03')).catch(() => {});
    };
    signal?.addEventListener('abort', cancel, {once: true});
    await typed.catch(error => { signal?.removeEventListener('abort', cancel); throw error; });
    await runs.ended(number, timeoutMs).catch(async () => {
      timedOut = true;
      await this.host.send(this.paneId, '\x03');
      await runs.ended(number, READY_MS).catch(() => { throw new Error('The command did not end in Pair\'s pane, not even after Ctrl-C'); });
    }).finally(() => signal?.removeEventListener('abort', cancel));
    return {...(await runs.result(number)), timedOut, cancelled};
  }
}
