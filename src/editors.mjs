// Which of a project's Neovims Pair shows a point, a suggestion or an edit in: the one you are in. A Neovim that has
// focus comes first (the terminal's focus reports, or herdr's focused pane); without one, the Neovim you used or
// went to last. What a Neovim does by itself (its LSP's diagnostics, its colours, anything while it has no focus) does
// not count.

/** Takes in a message from the Neovim `editor` (a daemon client): focus gained or lost, or the user at work in it. */
export function noteEditor(editor, message, now = Date.now()) {
  if (message.type === 'focus') {
    editor.focused = message.on === true;
    if (editor.focused) editor.activeAt = now;
    return;
  }
  if (editor.focused !== false && message.type !== 'accent' && message.event?.kind !== 'diagnostics') editor.activeAt = now;
}

/** herdr says the user went to `pane`: the Neovim in it has focus, and the other Neovims in herdr panes do not. */
export function herdrFocus(editors, pane, now = Date.now()) {
  const focused = editors.find(editor => editor.pane === pane);
  if (!focused) return;
  for (const editor of editors) if (editor.pane) editor.focused = editor === focused;
  focused.activeAt = now;
}

/** `editors` in the order Pair picks them: the one with focus, then the one used last. */
export const byUse = editors => [...editors].sort((a, b) => (b.focused === true) - (a.focused === true) || b.activeAt - a.activeAt);
