// How the Partner's context window is shared: its reply (thinking and answer), what pi-ai keeps free, and the
// conversation, which pi-durable compacts before it crowds out the reply. A small model often has a small window,
// so every share follows `contextWindow` instead of the library's cloud-sized defaults.

export const MIN_CONTEXT = 16384; // the instructions, the tools, a file read in full and a reply that thinks a little
export const SMALL_CONTEXT = 32768; // below this, the conversation is compacted every few turns
const SAFETY_TOKENS = 4096; // pi-ai keeps this much of the window free under its estimate of the prompt

/** The most of the window the Partner's reply may take: a third, so the conversation keeps the rest. */
export const replyRoom = contextWindow => Math.floor(contextWindow / 3);

/**
 * pi-durable's compaction settings: the conversation is compacted before it leaves less than the reply's room, so
 * thinking never uses up the answer. `background` compactions run beside the conversation's turns; on a server
 * that answers one request at a time they would hold up the Watcher, so there they wait for the next turn.
 */
export function compactionFor(contextWindow, maxTokens, {background = true} = {}) {
  const reserveTokens = Math.min(maxTokens, replyRoom(contextWindow)) + SAFETY_TOKENS;
  return {
    reserveTokens,
    keepRecentTokens: Math.min(20000, Math.floor((contextWindow - reserveTokens) / 2)),
    backgroundTokens: background ? Math.floor(contextWindow / 8) : 0,
  };
}
