// The user's terminals the Driver's `type` can go to: herdr's panes (herdr.mjs) and the :terminal buffers of the
// session's Neovims (lua/pair/pane.lua), in herdr or without it. A Neovim terminal is "nvim:<pid>:<buffer>", and
// the chat names it "nvim:<buffer>".
import {plainLine} from './herdr.mjs';

const NVIM = /^nvim:(\d+):(\d+)$/;

export class Terminals {
  /**
   * `editors()` lists the session's Neovims (daemon clients with the `pid` of their hello), `ask(editor, message)`
   * asks one and resolves with its reply, `herdr()` is the session's PaneWatch, or null without herdr.
   */
  constructor({editors, ask, herdr}) {
    Object.assign(this, {editors, ask, herdr});
  }

  /** How the chat names terminal `pane`. */
  name(pane) {
    const nvim = NVIM.exec(pane);
    return nvim ? `nvim:${nvim[2]}` : pane;
  }

  /** Every terminal of the user known now, as `{pane, name}`: herdr's first, then each Neovim's. */
  async list() {
    const found = this.herdr()?.terminals() ?? [];
    for (const editor of this.editors()) {
      const reply = await this.ask(editor, {type: 'terminals'}).catch(() => null);
      for (const {pane} of reply?.terminals ?? []) found.push({pane, name: this.name(pane)});
    }
    return found;
  }

  /** Types `text` at the prompt of terminal `pane`. Enter stays with the user. */
  async type(pane, text) {
    if (!plainLine(text)) throw new Error('Only one line of plain text can be typed');
    const nvim = NVIM.exec(pane);
    if (!nvim) {
      if (!this.herdr()) throw new Error(`Pane ${pane} is in herdr, which Pair does not watch now`);
      return this.herdr().type(pane, text);
    }
    const editor = this.editors().find(client => client.pid === Number(nvim[1]));
    if (!editor) throw new Error(`The Neovim of terminal ${this.name(pane)} is gone`);
    const reply = await this.ask(editor, {type: 'type_text', buf: Number(nvim[2]), text});
    if (!reply?.ok) throw new Error(`Neovim did not type it: ${reply?.error ?? 'no answer'}`);
  }
}
