// What works on a message of Pair's chat, shared by the terminal's chat pane (src/chat-render.mjs) and the Herdr panel
// (this folder): plain JavaScript with no imports, so Node and Herdr's mod runtime both load it.

export const DONE = {read: 'read', search: 'searched', run: 'ran', recall: 'recalled', open: 'opened', edit: 'edited', type: 'typed'};
export const shownTool = tool => tool in DONE;
/** A tool's line under the question: read queue.go 1-40. */
export const toolDone = (tool, what) => `${DONE[tool] ?? tool} ${what}`;

/** The keys that work on a remark once it is picked, as its last line shows them: rate it, take its suggestion, go to its line. */
export function remarkKeys(entries, index) {
  const id = entries[index]?.meta?.remark;
  const group = entries.filter(entry => id && entry.meta?.remark === id);
  return {
    apply: group.find(entry => entry.meta.suggestion && !entry.applied && !entry.gone) ?? null,
    jump: group.findLast(entry => entry.meta.place) ?? null,
  };
}

/** The keys of a gen card, in the order its action line shows them: [key, what, its words on the card]. */
export function cardKeys(card) {
  const keys = card?.keys ?? {};
  return [['k', 'k'], ['enter', 'Enter'], ['d', 'd'], ['u', 'u']].filter(([key]) => keys[key]).map(([key, shown]) => [key, shown, keys[key]]);
}

/** What a relayed line's keys reach of its `item`: its report or pull request, its branch's diff, its worktree. */
export function relayKeys(item) {
  return {key: item.key, title: item.kind === 'task' ? item.id : item.title, live: true, open: item.kind === 'task', diff: Boolean(item.branch), term: Boolean(item.where)};
}

/**
 * The keys of a relayed line (see relayKeys), in the order its action line shows them: [key, shown, what]; none once
 * the line is answered or newer news took its place.
 */
export function relayActions(entry) {
  const agent = entry?.meta?.agent;
  if (!agent?.live) return [];
  return [['o', agent.open, 'open'], ['d', agent.diff, 'diff'], ['t', agent.term, 'terminal']].filter(([, on]) => on).map(([key, , what]) => [key, key, what]);
}

export const GEN_AT_WORK = ['asking', 'asks', 'queued', 'generating'];

/**
 * What the status says of the /gen requests (`cards`, the chat's gen cards, see Gen.card in gen.mjs): the one at
 * work, those that wait for it, and the newest one ready, with what is left of it to take.
 */
export function genStatus(cards = []) {
  const working = cards.filter(card => GEN_AT_WORK.includes(card.state));
  const running = working.find(card => card.state === 'generating') ?? working.find(card => card.state !== 'queued') ?? null;
  const ready = [...cards].reverse().find(card => card.state === 'ready') ?? null;
  const left = !ready ? null
    : ready.shape === 'here' ? 'ready in Neovim'
      : ready.shape === 'scaffold' ? `${ready.taken} of ${ready.of} kept`
        : ready.shape === 'file' ? (ready.left ? `${ready.left} to review` : 'ready in Neovim') : null;
  return {running, queued: working.filter(card => card.state === 'queued').map(card => card.gen), ready: left ? {gen: ready.gen, text: left} : null};
}
