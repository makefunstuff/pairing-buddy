// The :terminal buffers of a session's Neovims as a source of panes (src/pane-watch.mjs), in herdr, in tmux or in a
// plain terminal. Each Neovim lists its terminals with their shell's pid and says which one you are in
// (lua/pair/pane.lua); the command running in one is its shell's foreground process (foreground.mjs), and its text
// is the buffer's last lines. Neovim itself is a pane too, `nvim:<pid>`, an editor, with focus while you are in it
// and not in one of its terminals. Neovim says when you go to another buffer or come back to it, which looks again.
import {foregroundCommand} from './foreground.mjs';

const TERMINAL = /^nvim:(\d+):(\d+)$/;
const EDITOR = /^nvim:(\d+)$/;

export class NvimPanes {
  name = 'neovim';

  /**
   * `editors()` lists the session's Neovims (daemon clients with the `pid` of their hello, the one used last first,
   * `focused` false once Neovim lost the terminal's focus: editors.mjs); `ask(editor, message)` asks one and resolves
   * with its reply.
   */
  constructor({editors, ask, foreground = foregroundCommand}) {
    Object.assign(this, {editors, ask, foreground});
    this.shells = new Map(); // pane id -> its shell's pid, from the last list
    this.look = () => {};
  }

  owns(pane) {
    return TERMINAL.test(pane) || EDITOR.test(pane);
  }

  start(look) {
    this.look = look;
  }

  stop() {
    this.look = () => {};
  }

  /** Neovim says something changed: you went to another buffer, into a terminal or out of it. */
  changed() {
    this.look();
  }

  editorOf(pid) {
    return this.editors().find(editor => editor.pid === Number(pid));
  }

  /**
   * Each Neovim and its terminals. The focus is in the Neovim used last that has the terminal's focus: in the
   * terminal you are in there, else in the Neovim itself; `weight` 2 or 0 says which (see Panes).
   */
  async list() {
    const panes = [];
    const shells = new Map();
    let focusGiven = false;
    for (const editor of this.editors()) {
      if (!editor.pid) continue;
      const reply = await this.ask(editor, {type: 'terminals'}).catch(() => null);
      if (!reply) continue;
      const focused = !focusGiven && editor.focused !== false;
      focusGiven ||= focused;
      const current = (reply.terminals ?? []).find(terminal => terminal.pane === reply.current);
      panes.push({pane: `nvim:${editor.pid}`, focused: focused && !current, scrolled: false, weight: 0});
      for (const {pane, pid} of reply.terminals ?? []) {
        shells.set(pane, pid);
        panes.push({pane, focused: focused && pane === current?.pane, scrolled: focused && pane === current?.pane && reply.scrolled === true, weight: 2});
      }
    }
    this.shells = shells;
    return panes;
  }

  /** The pane of the shell with process id `pid`, if it is one of the terminals listed last. */
  paneOfShell(pid) {
    for (const [pane, shell] of this.shells) if (shell === pid) return pane;
    return null;
  }

  async commandOf(pane) {
    if (EDITOR.test(pane)) return 'nvim';
    return this.foreground(this.shells.get(pane));
  }

  async read(pane, lines) {
    const [, pid, buf] = TERMINAL.exec(pane) ?? [];
    const editor = pid && this.editorOf(pid);
    if (!editor) throw new Error(`The Neovim of terminal ${pane} is gone`);
    const reply = await this.ask(editor, {type: 'terminal_text', buf: Number(buf), lines});
    if (typeof reply?.text !== 'string') throw new Error(`Neovim did not read terminal ${pane}: ${reply?.error ?? 'no answer'}`);
    return reply.text;
  }

  async send(pane, text) {
    const [, pid, buf] = TERMINAL.exec(pane) ?? [];
    const editor = pid && this.editorOf(pid);
    if (!editor) throw new Error(`The Neovim of terminal ${pane} is gone`);
    const reply = await this.ask(editor, {type: 'type_text', buf: Number(buf), text});
    if (!reply?.ok) throw new Error(`Neovim did not type it: ${reply?.error ?? 'no answer'}`);
  }
}
