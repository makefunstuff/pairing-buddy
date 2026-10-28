// The Partner: one durable pi-durable conversation per pairing session, stored in SQLite.
import {BACKGROUND_CONTEXT as C} from '@earendil-works/chord/context';
import {createRegistry, Harness, watchEvents} from '@earendil-works/pi-durable';
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

/** The text of a user input entry. */
function inputText(entry) {
  return (entry?.model ?? [])
    .flatMap(message => (typeof message.content === 'string' ? [{type: 'text', text: message.content}] : message.content ?? []))
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');
}

const QUESTION = /^\[user\] ([\s\S]*?)(?:\n\n|$)/; // the user's own words in an asked turn's input (see session.mjs)

/** The tokens and the cost of every model call in a conversation's `pi.usage` (pi-durable's UsageState). */
function totalUsage(state) {
  return Object.values(state?.models ?? {}).reduce(
    (sum, usage) => ({tokens: sum.tokens + (usage.totalTokens ?? 0), cost: sum.cost + (usage.cost?.total ?? 0)}),
    {tokens: 0, cost: 0},
  );
}

/**
 * Tells `onEvent` what the turn on `conversationId` does as it streams: `{type: 'text', text}` with the text of the
 * model's message so far (each new message starts again), and at the end `{type: 'usage', tokens, cost}`, what the
 * turn's model calls took. Resolves with a function that stops it; null when the harness cannot stream events.
 */
async function relayEvents(harness, conversationId, onEvent) {
  const stream = await watchEvents(harness, conversationId, C).catch(() => null);
  if (!stream) return null;
  const before = totalUsage(stream.snapshot.usage);
  let after = before;
  let text = '';
  stream.start(async events => {
    for (const event of events) {
      if (event.type === 'message_start' && event.message?.role === 'assistant') text = '';
      if (event.type === 'usage_changed') after = totalUsage(event.usage);
      if (event.type !== 'message_update') continue;
      const delta = event.changes.filter(change => change.type === 'text_delta').map(change => change.delta).join('');
      if (!delta) continue;
      text += delta;
      onEvent({type: 'text', text});
    }
  });
  return async () => {
    await stream.stop().catch(() => {});
    onEvent({type: 'usage', tokens: after.tokens - before.tokens, cost: after.cost - before.cost});
  };
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

  /** The text of the answer a settled submission got, or null when it was cancelled; throws when it got none. */
  async function answerOf(conversation, settled) {
    if (cancelled.delete(conversation.id)) return null; // what it wrote before is not for the user
    if (settled.status !== 'done') throw new Error(`The Partner did not answer (${settled.reason}${settled.detail ? `: ${settled.detail}` : ''})`);
    const page = await conversation.entries({maxEntryId: settled.answer}, 1, undefined, C);
    return answerText(page.items[0]);
  }

  /**
   * The turns the daemon left running when it stopped: `questions`, the user's, as `{conversationId, submissionId,
   * question}`, and `stale`, the conversations of the others (a remark nobody asked for, a hand-over the restart
   * ended). Read before scheduling starts, so nothing runs yet.
   */
  async function interruptedTurns() {
    const questions = [];
    const stale = new Set();
    for (const submission of (await harness.inspect(C)).submissions) {
      if (submission.type !== 'input') continue;
      const conversation = await harness.conversation(submission.conversationId, C);
      const entry = submission.status === 'placed' && (await conversation.entries({maxEntryId: submission.entry}, 1, undefined, C)).items[0];
      const question = QUESTION.exec(inputText(entry))?.[1];
      if (question) questions.push({conversationId: submission.conversationId, submissionId: submission.id, question});
      else stale.add(submission.conversationId);
    }
    return {questions, stale};
  }

  const {questions: interrupted, stale} = await interruptedTurns();

  return {
    /** The user's questions the daemon was answering when it stopped; `finish` gives each one's answer. */
    interrupted,

    /**
     * Lets the Partner go on with its stored work: the interrupted questions, and compactions. The stale turns are
     * aborted: a late remark or hand-over would only confuse. Call it once their sessions can take tool calls.
     */
    async resume() {
      for (const id of stale) await (await harness.conversation(id, C)).abort(C);
      harness.resume();
    },

    /** The answer to interrupted submission `submissionId`, as `ask` resolves it. */
    async finish(conversationId, submissionId) {
      const conversation = await harness.conversation(conversationId, C);
      cancelled.delete(conversationId);
      return answerOf(conversation, await (await harness.submission(submissionId, C)).wait(C));
    },

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
     * `onEvent` hears the answer's text as it streams, and the turn's usage at its end (see relayEvents).
     */
    async ask(conversationId, content, {kind, onEvent} = {}) {
      const conversation = await harness.conversation(conversationId, C);
      if (!conversation) throw new Error(`No conversation ${conversationId}`);
      cancelled.delete(conversationId); // a cancel that came after the last turn was done
      const agent = agents.get(conversationId);
      const level = thinkingOf(conversationId, kind);
      const switched = agent && level !== agent.thinkingLevel;
      if (switched) await conversation.configure({...agent, thinkingLevel: level}, C);
      const stop = onEvent ? await relayEvents(harness, conversationId, onEvent) : null;
      try {
        return await answerOf(conversation, await (await conversation.submit({type: 'input', content}, C)).wait(C));
      } finally {
        await stop?.();
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
