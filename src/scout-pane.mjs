// Pair's own herdr pane, where Scout's commands are typed and run in plain sight.
// Its shell is a plain bash that writes down each command's output and exit code (see pane-runs.mjs): that is
// how Pair knows when a command ended and how, which herdr cannot say, and reads all of its output, not the
// screen's last 1000 lines. Its prompt shows them too: "scout[3] exit 1 $ ".
// Scout's text is only ever sent to this pane, never to one of the user's.
import {join} from 'node:path';
import {herdrRequest} from './herdr.mjs';
import {PaneRuns} from './pane-runs.mjs';

const LABEL = 'pair scout';
const READY_MS = 5000;
export const RUN_TIMEOUT_MS = 120_000;

/** `text` as one shell word. */
export const shellQuote = text => `'${text.replaceAll("'", "'\\''")}'`;

export class ScoutPane {
  /**
   * The pane opens below `besidePane` (the chat pane) in `workspaceId`, in `cwd`. Its shell writes its files to
   * a directory of its own in `runsDir`.
   */
  constructor({socketPath, workspaceId, besidePane, cwd, runsDir, log = () => {}}) {
    Object.assign(this, {socketPath, workspaceId, besidePane, cwd, runsDir, log});
    this.paneId = null;
    this.queue = Promise.resolve();
  }

  request(method, params, timeoutMs) {
    return herdrRequest(this.socketPath, method, params, {timeoutMs});
  }

  get runs() {
    return new PaneRuns(join(this.runsDir, this.paneId.replaceAll(':', '-')));
  }

  /**
   * Opens the pane, or finds the one an earlier daemon opened, or keeps the open one. A pane whose shell does not
   * write its files (a busy one, or one of an older Pair) is closed and opened anew.
   */
  async open() {
    const {panes} = await this.request('pane.list', {workspace_id: this.workspaceId});
    if (panes.some(pane => pane.pane_id === this.paneId)) return;
    this.paneId = panes.find(pane => pane.label === LABEL)?.pane_id ?? null;
    if (this.paneId && (await this.runs.next()) !== null) return;
    if (this.paneId) await this.close();
    const {pane} = await this.request('pane.split', {target_pane_id: this.besidePane, direction: 'down', ratio: 0.5, cwd: this.cwd, focus: false});
    this.paneId = pane.pane_id;
    await this.request('pane.rename', {pane_id: this.paneId, label: LABEL});
    await this.request('pane.send_text', {pane_id: this.paneId, text: `${await this.runs.shellLine()}\r`});
    await this.runs.ready(READY_MS);
    this.log(`opened Pair's pane ${this.paneId}`);
  }

  async close() {
    if (!this.paneId) return;
    const {paneId, runs} = this;
    this.paneId = null;
    await this.request('pane.close', {pane_id: paneId}).catch(() => {});
    await runs.remove();
  }

  /**
   * Types `command` in the pane and resolves with `{exit, output, timedOut}` once it ends. A command still
   * running after `timeoutMs` is stopped with Ctrl-C. Commands run one at a time.
   */
  run(command, {timeoutMs = RUN_TIMEOUT_MS} = {}) {
    const result = this.queue.then(() => this.runNow(command, timeoutMs));
    this.queue = result.catch(() => {});
    return result;
  }

  async runNow(command, timeoutMs) {
    await this.open();
    const {runs} = this;
    const number = await runs.next();
    if (number === null) throw new Error('Pair\'s pane is busy: its shell is not at the prompt');
    await runs.clearLog();
    // Ctrl-U first clears anything typed at the prompt by hand.
    await this.request('pane.send_text', {pane_id: this.paneId, text: `\x15${command}\r`});
    let timedOut = false;
    await runs.ended(number, timeoutMs).catch(async () => {
      timedOut = true;
      await this.request('pane.send_text', {pane_id: this.paneId, text: '\x03'});
      await runs.ended(number, READY_MS).catch(() => { throw new Error('The command did not end in Pair\'s pane, not even after Ctrl-C'); });
    });
    return {...(await runs.result(number)), timedOut};
  }
}
