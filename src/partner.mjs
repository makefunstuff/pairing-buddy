// The Partner: one durable pi-durable conversation per pairing session, stored in SQLite.
import {BACKGROUND_CONTEXT as C} from '@earendil-works/chord/context';
import {createRegistry, Harness} from '@earendil-works/pi-durable';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {mostThinking, THINKING_DEFAULTS} from './config.mjs';
import {compactionFor} from './context.mjs';
import {pairExtension, ROLE_PROMPTS, ROLE_TOOLS} from './tools.mjs';

// How long the model may take to start its answer. A server that holds its reply until the thinking is done
// (some proxies do) needs longer when the Partner thinks.
const STREAM_TIMEOUT_MS = 90_000;
const THINKING_STREAM_TIMEOUT_MS = 240_000;

/** The last session's note, as the instructions carry it into a new session in the same project. */
export function memoryPrompt(note) {
  return `The last session in this project ended with this note. The user may pick up where it left off;
use it when they ask about the last session or its loose ends, and do not bring it up otherwise.
---
${note}
---`;
}

function answerText(entry) {
  return (entry?.model ?? [])
    .flatMap(message => (Array.isArray(message.content) ? message.content : []))
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    // Local servers sometimes pass a malformed tool call through as text; it is not meant for the user.
    .replace(/<tool_call>[\s\S]*$/, '')
    .trim();
}

/**
 * Opens the Partner over `storage` (a SQLite file path, or a pi-durable Storage for tests).
 * `thinking` is its level for each kind of turn (see THINKING_DEFAULTS); `hands` carries out the tools, see tools.mjs.
 * Without `backgroundCompaction`, a conversation is compacted only between its turns (see context.mjs).
 */
export async function openPartner({storage, models, model, thinking = THINKING_DEFAULTS, hands, backgroundCompaction = true}) {
  // A model without `reasoning` thinks as it always does: pi-ai sends it no thinking level.
  const levelOf = kind => (model.reasoning ? thinking[kind] : 'off');
  const extension = pairExtension(hands);
  const registry = createRegistry();
  registry.install(extension);
  const opened = typeof storage === 'string' ? await openNodeSqliteStorage(storage) : storage;
  const harness = await Harness.open(opened, {
    models,
    registry,
    identity: {attribution: null},
    settings: {
      extensions: [extension],
      compaction: compactionFor(model.contextWindow, model.maxTokens, {background: backgroundCompaction}),
      afterFailedRun: 'continue',
      // A model that does not answer fails the turn within minutes, not the SDK's default of hours.
      stream: {timeoutMs: model.reasoning && mostThinking(thinking) !== 'off' ? THINKING_STREAM_TIMEOUT_MS : STREAM_TIMEOUT_MS, maxRetries: 0},
      retry: {maxRetries: 2},
    },
  }, C);
  harness.resume();
  // The model is offered only its role's tools; the policy hook refuses the others anyway.
  // Always with the configured model: a conversation stored under a model since renamed in the config gets the new one.
  const agents = new Map(); // conversation id -> the agent it was last configured with
  const roleAgent = (role, previousNote) => ({
    model: {provider: model.provider, modelId: model.id},
    thinkingLevel: levelOf(role),
    tools: extension.tools.filter(tool => ROLE_TOOLS[role].includes(tool.name)),
    instructions: previousNote ? `${ROLE_PROMPTS[role]}\n\n${memoryPrompt(previousNote)}` : ROLE_PROMPTS[role],
  });
  /** The thinking level of a turn of `kind` ("remark", or by default the conversation's role). */
  const thinkingOf = (conversationId, kind) => (kind ? levelOf(kind) : (agents.get(conversationId)?.thinkingLevel ?? 'off'));
  const cancelled = new Set(); // conversations whose running turn was cancelled

  return {
    /** A new conversation, in the Navigator role. */
    async createConversation() {
      const agent = roleAgent('navigator');
      const conversation = await harness.createConversation({ownership: {kind: 'ownerless'}, agent}, C);
      agents.set(conversation.id, agent);
      return conversation.id;
    },

    /**
     * Gives the conversation the configured model and the tools and instructions of `role`, from its next request on,
     * with the note of the project's last session when there is one.
     */
    async setRole(conversationId, role, previousNote = null) {
      const conversation = await harness.conversation(conversationId, C);
      const agent = roleAgent(role, previousNote);
      await conversation.configure(agent, C);
      agents.set(conversationId, agent);
    },

    thinkingOf,

    /**
     * Sends one input and resolves with the Partner's final text (tool calls happen on the way), or null when the
     * turn was cancelled. It thinks as a turn of `kind` does, and from the next input on as its role does again.
     */
    async ask(conversationId, content, {kind} = {}) {
      const conversation = await harness.conversation(conversationId, C);
      if (!conversation) throw new Error(`No conversation ${conversationId}`);
      cancelled.delete(conversationId); // a cancel that came after the last turn was done
      const agent = agents.get(conversationId);
      const level = thinkingOf(conversationId, kind);
      const switched = agent && level !== agent.thinkingLevel;
      if (switched) await conversation.configure({...agent, thinkingLevel: level}, C);
      try {
        const settled = await (await conversation.submit({type: 'input', content}, C)).wait(C);
        if (cancelled.delete(conversationId)) return null; // what it wrote before is not for the user
        if (settled.status !== 'done') throw new Error(`The Partner did not answer (${settled.reason}${settled.detail ? `: ${settled.detail}` : ''})`);
        const page = await conversation.entries({maxEntryId: settled.answer}, 1, undefined, C);
        return answerText(page.items[0]);
      } finally {
        if (switched) await conversation.configure(agent, C);
      }
    },

    /** Stops the conversation's running turn: its ask resolves null, and it is no failure of the model. */
    async cancel(conversationId) {
      const conversation = await harness.conversation(conversationId, C);
      cancelled.add(conversationId);
      await conversation?.abort(C);
    },

    close: () => harness.close(C),
  };
}
