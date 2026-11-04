// The panel opened bare: by its key or Pair in the + menu (`pane.split {direction: "right", mod: "pair"}`), with no
// props. It takes them from where the window's focus was as it opened (its init runs before the window gives the new
// pane the focus, and before panes() lists it): the focused terminal, its folder, space and tab; Pair fills in the rest
// (`pair panel --props`: the daemon started as `pair` starts it, herdr-core's socket and session, the panel file). Then
// a panel with those props takes its place, as `pair` would have opened it, so the window keeps them with the tab. With
// a panel of this mod in that tab already, that one gets the focus instead.

/** Whether these props lack what the panel connects with: it was opened bare. */
export const isBare = (p) => !p?.cwd || !p?.panel;

/**
 * Where a bare panel goes, from `focused()` and `panes()` as its init sees them: `{space, tab, before, existing,
 * target}`. `before`: the tab's panes then (the new one is not among them); `existing`: a pane of this mod already in
 * the tab; `target`: the terminal it opens beside `{pane, terminal, cwd}`: the focused one, else the tab's first.
 */
export function bareTarget({ focused, panes, mod }) {
  if (!focused?.tab) return { space: null, tab: null, before: [], existing: null, target: null };
  const mine = (panes ?? []).filter((p) => p.tab === focused.tab);
  const existing = mine.find((p) => p.mod === mod)?.pane ?? null;
  const pane = focused.terminal && focused.pane ? mine.find((p) => p.pane === focused.pane) : null;
  const target = pane ? { pane: pane.pane, terminal: focused.terminal, cwd: focused.cwd ?? pane.cwd ?? null }
    : ((first) => (first ? { pane: first.pane, terminal: first.terminal, cwd: first.cwd ?? null } : null))(mine.find((p) => p.terminal));
  return { space: focused.space ?? null, tab: focused.tab, before: mine.map((p) => p.pane), existing, target };
}

/** The bare panel's own pane: the pane of this mod in its tab that was not there as it opened, or null. */
export function ownPane({ panes, at, mod }) {
  return (panes ?? []).find((p) => p.tab === at.tab && p.mod === mod && !at.before.includes(p.pane))?.pane ?? null;
}

/** The props of the panel that takes the bare one's place: what `pair` passes (src/herdr-panel.mjs, openPanel). */
export function fullProps(at, filled, mod) {
  return {
    cwd: filled.cwd ?? at.target.cwd, terminal: at.target.terminal, space: at.space, tab: at.tab,
    core: filled.core ?? null, session: filled.session ?? null, panel: filled.panel,
    ...(filled.history ? { history: filled.history } : {}), ...(mod === "pair" ? {} : { mod }),
  };
}

/** What `pair panel --props` said: its props, or throws with its error. */
export function parseFilled({ code, stdout, stderr }) {
  let filled = null;
  try { filled = JSON.parse(String(stdout ?? "").trim().split("\n").pop() || "null"); } catch {}
  if (filled?.error) throw new Error(filled.error);
  if (code !== 0 || !filled?.panel) throw new Error(String(stderr ?? "").trim().split("\n").pop() || `pair exited with ${code}`);
  return filled;
}
