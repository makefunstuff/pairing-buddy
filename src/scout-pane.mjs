// Pair's own herdr pane, where Scout's commands are typed and run in plain sight.
// Its shell is a bash whose prompt carries the command number and the last exit code ("scout[3] exit 1 $ "):
// that is how Pair knows when a command ended and how, which herdr cannot say. How it starts (your rc file or
// none, in a sandbox or not) is scout-shell.mjs. Scout's text is only ever sent to this pane, never to one of the user's.
import {herdrRequest} from './herdr.mjs';
import {rcNames, scoutPaneConfig, shellLine} from './scout-shell.mjs';

export {shellQuote} from './scout-shell.mjs';

const LABEL = 'pair scout';
const PROMPT = /^scout\[(\d+)\] exit (\d+) \$/;
const READY_MS = 5000;
const RC_READY_MS = 15_000; // an rc file may take its time (version managers, completions)
const MAX_LINES = 1000; // the most herdr's pane.read returns
export const RUN_TIMEOUT_MS = 120_000;

/** The number of the prompt on the pane's last line, or null when its shell is not at a prompt. */
export function promptNumber(text) {
  const match = PROMPT.exec(text.replace(/\s+$/, '').split('\n').at(-1));
  return match ? Number(match[1]) : null;
}

/**
 * The output and exit code of the command typed at prompt `number`, from the pane's text once prompt
 * `number + 1` is there; null before that.
 */
export function commandResult(text, number) {
  const lines = text.replace(/\s+$/, '').split('\n');
  const numberOf = line => Number(PROMPT.exec(line)?.[1]);
  const end = lines.findLastIndex(line => numberOf(line) === number + 1);
  if (end === -1) return null;
  const start = lines.findLastIndex((line, i) => i < end && numberOf(line) === number);
  const output = lines.slice(start + 1, end).join('\n');
  return {exit: Number(PROMPT.exec(lines[end])[2]), output: start === -1 ? `(earlier output cut)\n${output}` : output};
}

export class ScoutPane {
  /**
   * The pane opens below `besidePane` (the chat pane) in `workspaceId`, in `cwd`. `setup` is the config's
   * `scoutPane`; in the sandbox, `writable` are folders it may write besides the project, `hidden` sockets it must
   * not reach besides herdr's.
   */
  constructor({socketPath, workspaceId, besidePane, cwd, setup = scoutPaneConfig(), writable = [], hidden = [], log = () => {}}) {
    Object.assign(this, {socketPath, workspaceId, besidePane, cwd, setup, writable, hidden, log});
    this.paneId = null;
    this.queue = Promise.resolve();
    this.names = null;
  }

  request(method, params, timeoutMs) {
    return herdrRequest(this.socketPath, method, params, {timeoutMs});
  }

  async lastLines(lines = 5) {
    return (await this.request('pane.read', {pane_id: this.paneId, source: 'recent_unwrapped', lines})).read.text;
  }

  waitForPrompt(number, timeoutMs) {
    const value = `^scout\\[${number ?? '\\d+'}\\] exit \\d+ \\$`;
    return this.request('pane.wait_for_output', {pane_id: this.paneId, source: 'recent_unwrapped', lines: 3, match: {type: 'regex', value}, timeout_ms: timeoutMs}, timeoutMs + 2000);
  }

  /** Opens the pane, or finds the one an earlier daemon opened, or keeps the open one. */
  async open() {
    const {panes} = await this.request('pane.list', {workspace_id: this.workspaceId});
    if (panes.some(pane => pane.pane_id === this.paneId)) return;
    this.paneId = panes.find(pane => pane.label === LABEL)?.pane_id ?? null;
    if (this.paneId && promptNumber(await this.lastLines()) !== null) return;
    if (this.paneId) await this.close();
    // First, since it throws when the config asks for a sandbox that cannot be made.
    const {line, sandboxed} = shellLine({setup: this.setup, cwd: this.cwd, writable: this.writable, hidden: [this.socketPath, ...this.hidden]});
    const {pane} = await this.request('pane.split', {target_pane_id: this.besidePane, direction: 'down', ratio: 0.5, cwd: this.cwd, focus: false});
    this.paneId = pane.pane_id;
    await this.request('pane.rename', {pane_id: this.paneId, label: LABEL});
    await this.request('pane.send_text', {pane_id: this.paneId, text: `${line}\r`});
    await this.waitForPrompt(null, this.setup.rc ? RC_READY_MS : READY_MS).catch(error => {
      throw this.setup.rc ? new Error(`Pair's pane shows no prompt after loading ${this.setup.rc}: does it start another shell?`) : error;
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
    if (!this.paneId) return;
    const paneId = this.paneId;
    this.paneId = null;
    await this.request('pane.close', {pane_id: paneId}).catch(() => {});
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
    const number = promptNumber(await this.lastLines());
    if (number === null) throw new Error('Pair\'s pane is busy: its shell is not at the prompt');
    // Ctrl-U first clears anything typed at the prompt by hand.
    await this.request('pane.send_text', {pane_id: this.paneId, text: `\x15${command}\r`});
    let timedOut = false;
    await this.waitForPrompt(number + 1, timeoutMs).catch(async () => {
      timedOut = true;
      await this.request('pane.send_text', {pane_id: this.paneId, text: '\x03'});
      await this.waitForPrompt(number + 1, READY_MS);
    });
    const result = commandResult(await this.lastLines(MAX_LINES), number);
    if (!result) throw new Error('The command\'s end did not show in Pair\'s pane');
    return {...result, timedOut};
  }
}
