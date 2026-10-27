// Where Pair's own pane lives: a herdr pane below the chat, or without herdr a :terminal buffer in Neovim. Either
// host only opens, finds, types into and closes the pane; its shell writes down each command itself (pane-runs.mjs),
// so Pair reads commands the same way in both. A host never types into a pane it did not open.
import {herdrRequest} from './herdr.mjs';

const LABEL = 'pair scout';

/** Pair's pane in herdr: split below `besidePane` (the chat pane) in `workspaceId`, labelled so a later daemon finds it. */
export class HerdrPaneHost {
  constructor({socketPath, workspaceId, besidePane}) {
    Object.assign(this, {socketPath, workspaceId, besidePane});
    this.key = workspaceId; // with the project, names the pane's folder: the same after a restart
    this.hidden = [socketPath]; // a command in the sandbox must not reach herdr's API
  }

  request(method, params, timeoutMs) {
    return herdrRequest(this.socketPath, method, params, {timeoutMs});
  }

  async panes() {
    return (await this.request('pane.list', {workspace_id: this.workspaceId})).panes;
  }

  async has(id) {
    return (await this.panes()).some(pane => pane.pane_id === id);
  }

  /** The pane an earlier daemon opened, or null. */
  async find() {
    return (await this.panes()).find(pane => pane.label === LABEL)?.pane_id ?? null;
  }

  /** Opens a pane in `cwd` whose shell runs `line`; its id. */
  async open({cwd, line}) {
    const {pane} = await this.request('pane.split', {target_pane_id: this.besidePane, direction: 'down', ratio: 0.5, cwd, focus: false});
    await this.request('pane.rename', {pane_id: pane.pane_id, label: LABEL});
    await this.send(pane.pane_id, `${line}\r`);
    return pane.pane_id;
  }

  send(id, text) {
    return this.request('pane.send_text', {pane_id: id, text});
  }

  close(id) {
    return this.request('pane.close', {pane_id: id});
  }
}

/**
 * Pair's pane without herdr: a :terminal buffer in a Neovim of the session (lua/pair/pane.lua), in a split along
 * its bottom. `editors()` lists the session's Neovims, the one the user is in first; `ask(editor, message)` asks
 * one and resolves with its reply. The pane stays with the Neovim it opened in; once that one is gone, the next open
 * opens it in another.
 */
export class EditorPaneHost {
  constructor({editors, ask}) {
    Object.assign(this, {editors, ask});
    this.key = 'nvim';
    this.hidden = [];
    this.editor = null; // the Neovim that has the pane
  }

  pane(editor, message) {
    return this.ask(editor, {type: 'pane', ...message});
  }

  async has(id) {
    if (!this.editors().includes(this.editor)) return false;
    return (await this.pane(this.editor, {action: 'has', buf: id}))?.open === true;
  }

  /** The pane an earlier daemon opened in one of the Neovims, or null. */
  async find() {
    for (const editor of this.editors()) {
      const {buf = null} = (await this.pane(editor, {action: 'find'}).catch(() => null)) ?? {};
      if (buf !== null) {
        this.editor = editor;
        return buf;
      }
    }
    return null;
  }

  async open({cwd, line}) {
    const [editor] = this.editors();
    if (!editor) throw new Error('Pair\'s pane opens in Neovim without herdr: run :Pair start in Neovim first');
    const reply = await this.pane(editor, {action: 'open', cwd, line});
    if (reply?.error || typeof reply?.buf !== 'number') throw new Error(`Neovim could not open Pair's pane: ${reply?.error ?? 'no answer'}`);
    this.editor = editor;
    return reply.buf;
  }

  async send(id, text) {
    const reply = await this.pane(this.editor, {action: 'send', buf: id, text});
    if (!reply?.ok) throw new Error('Pair\'s pane in Neovim is gone');
  }

  async close(id) {
    if (this.editors().includes(this.editor)) await this.pane(this.editor, {action: 'close', buf: id});
    this.editor = null;
  }
}
