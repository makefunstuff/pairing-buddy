// The user's terminals the Driver's `type` can go to: the panes the session's PaneWatch sees (herdr's, tmux's and
// Neovim's, pane-watch.mjs) and the :terminal buffers of the session's Neovims (lua/pair/pane.lua), also those it has
// not seen yet. A Neovim terminal is "nvim:<pid>:<buffer>", and
// the chat names it "nvim:<buffer>" unless another Neovim's terminal has that buffer too (see named).
import {plainLine} from './pane-watch.mjs';

const NVIM = /^nvim:(\d+):(\d+)$/;

/** The short name of terminal `pane`: "nvim:<buffer>" for a Neovim's, "tmux:%<n>" for tmux's, the id for herdr's. */
function shortName(pane) {
  const nvim = NVIM.exec(pane);
  return nvim ? `nvim:${nvim[2]}` : pane;
}

/**
 * `{pane, name}` for each of `panes`, names the chat can tell apart: the short name, or the whole id where two
 * terminals share the short one (the same buffer number in two Neovims).
 */
export const named = panes => panes.map(pane => ({
  pane,
  name: panes.some(other => other !== pane && shortName(other) === shortName(pane)) ? pane : shortName(pane),
}));

export class Terminals {
  /**
   * `editors()` lists the session's Neovims (daemon clients with the `pid` of their hello), `ask(editor, message)`
   * asks one and resolves with its reply, `watch()` is the session's PaneWatch, or null.
   */
  constructor({editors, ask, watch}) {
    Object.assign(this, {editors, ask, watch});
  }

  /** The ids of every terminal of the user known now: the PaneWatch's first, then each Neovim's not among them. */
  async list() {
    const found = this.watch()?.terminals() ?? [];
    for (const editor of this.editors()) {
      const reply = await this.ask(editor, {type: 'terminals'}).catch(() => null);
      for (const {pane} of reply?.terminals ?? []) if (!found.includes(pane)) found.push(pane);
    }
    return found;
  }

  /** Types `text` at the prompt of terminal `pane`. Enter stays with the user. */
  async type(pane, text) {
    if (!plainLine(text)) throw new Error('Only one line of plain text can be typed');
    // Through the PaneWatch, which then does not take the text arriving for the user typing.
    if (this.watch()?.terminals().includes(pane)) return this.watch().type(pane, text);
    const nvim = NVIM.exec(pane);
    if (!nvim) throw new Error(`Pair does not watch terminal ${pane} now`);
    const editor = this.editors().find(client => client.pid === Number(nvim[1]));
    if (!editor) throw new Error(`The Neovim of terminal ${shortName(pane)} is gone`);
    const reply = await this.ask(editor, {type: 'type_text', buf: Number(nvim[2]), text});
    if (!reply?.ok) throw new Error(`Neovim did not type it: ${reply?.error ?? 'no answer'}`);
  }
}
