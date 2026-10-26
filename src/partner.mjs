// The Partner: one durable pi-durable conversation per pairing session, stored in SQLite.
import {BACKGROUND_CONTEXT as C} from '@earendil-works/chord/context';
import {createRegistry, Harness} from '@earendil-works/pi-durable';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {pairExtension, ROLE_PROMPTS, ROLE_TOOLS} from './tools.mjs';

const STREAM_TIMEOUT_MS = 90_000;

// Small local context windows need smaller margins than the library's cloud-sized defaults.
function compactionFor(contextWindow) {
  return {
    reserveTokens: Math.min(16384, Math.floor(contextWindow / 4)),
    keepRecentTokens: Math.min(20000, Math.floor(contextWindow / 4)),
    backgroundTokens: Math.floor(contextWindow / 8),
  };
}

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
 * `hands` carries out the tools; see tools.mjs.
 */
export async function openPartner({storage, models, model, thinking = 'off', hands}) {
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
      compaction: compactionFor(model.contextWindow),
      afterFailedRun: 'continue',
      // A model that does not answer fails the turn within minutes, not the SDK's default of hours.
      stream: {timeoutMs: STREAM_TIMEOUT_MS, maxRetries: 0},
      retry: {maxRetries: 2},
    },
  }, C);
  harness.resume();
  // The model is offered only its role's tools; the policy hook refuses the others anyway.
  // Always with the configured model: a conversation stored under a model since renamed in the config gets the new one.
  const roleAgent = (role, previousNote) => ({
    model: {provider: model.provider, modelId: model.id},
    thinkingLevel: thinking,
    tools: extension.tools.filter(tool => ROLE_TOOLS[role].includes(tool.name)),
    instructions: previousNote ? `${ROLE_PROMPTS[role]}\n\n${memoryPrompt(previousNote)}` : ROLE_PROMPTS[role],
  });

  return {
    /** A new conversation, in the Navigator role. */
    async createConversation() {
      const conversation = await harness.createConversation({ownership: {kind: 'ownerless'}, agent: roleAgent('navigator')}, C);
      return conversation.id;
    },

    /**
     * Gives the conversation the configured model and the tools and instructions of `role`, from its next request on,
     * with the note of the project's last session when there is one.
     */
    async setRole(conversationId, role, previousNote = null) {
      const conversation = await harness.conversation(conversationId, C);
      await conversation.configure(roleAgent(role, previousNote), C);
    },

    /** Sends one input and resolves with the Partner's final text (tool calls happen on the way). */
    async ask(conversationId, content) {
      const conversation = await harness.conversation(conversationId, C);
      if (!conversation) throw new Error(`No conversation ${conversationId}`);
      const settled = await (await conversation.submit({type: 'input', content}, C)).wait(C);
      if (settled.status !== 'done') throw new Error(`The Partner did not answer (${settled.reason}${settled.detail ? `: ${settled.detail}` : ''})`);
      const page = await conversation.entries({maxEntryId: settled.answer}, 1, undefined, C);
      return answerText(page.items[0]);
    },

    close: () => harness.close(C),
  };
}
