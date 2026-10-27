// Pair's hands and the roles that may use them. The Navigator has say, point, open, a read-only read,
// recall (the project's earlier sessions) and suggest, which only shows a change for the user to accept;
// Scout adds search and run, which work only in Pair's own herdr pane. The Driver, which Pair is only while
// the user hands it the wheel, also has edit (one change in the user's buffer, never saved) and type (into
// the user's terminal, after a yes, without Enter). Nothing here can write a file or save a buffer. Each
// conversation is offered only its role's tools, and the policy hook refuses any other name, so a model that
// invents `bash` or `write` gets an error, not an effect.
import {Type} from '@earendil-works/pi-ai';
import {defineExtension, defineTool, hook, section, ToolTask} from '@earendil-works/pi-durable';
import {TONE} from './tone.mjs';

/** The roles the user switches between; Driver is entered only by handing over (see PairSession.drive). */
export const ROLES = ['navigator', 'scout'];

const NAVIGATOR_TOOLS = ['say', 'point', 'open', 'read', 'recall', 'suggest'];

export const ROLE_TOOLS = {
  navigator: NAVIGATOR_TOOLS,
  scout: [...NAVIGATOR_TOOLS, 'search', 'run'],
  driver: [...NAVIGATOR_TOOLS, 'search', 'run', 'edit', 'type'],
};

// What the model is told when it calls a tool its role does not have.
const NEEDS_ROLE = {
  search: 'search needs the Scout role; the user can switch with /scout.',
  run: 'run needs the Scout role; the user can switch with /scout.',
  edit: 'edit works only while the user hands you the wheel; call suggest instead.',
  type: 'type works only while the user hands you the wheel; say the command instead.',
};

/** The `beforeTool` policy: a block reason for anything outside the tools of the conversation's role. */
export function toolPolicy(call, role) {
  if (ROLE_TOOLS[role].includes(call.name)) return undefined;
  return {block: NEEDS_ROLE[call.name] ?? `Pair has no tool "${call.name}". It can only ${ROLE_TOOLS[role].join(', ')}.`};
}

const PAIR = `You are Pair, a pair programmer in the second chair. The user drives: they edit, save and commit.
You see their editor and terminal through short notes, and you help like a colleague next to them.

Messages starting with [watch] are things you noticed. Speak only about a concrete problem the user seems to have missed:
a failing command, a wrong value, a bug in code they just wrote. If there is none, or you would only offer help or ask
a question, answer exactly: SILENT
Messages starting with [user] are the user talking to you. Always answer them, and answer what they asked first.

How to answer:
- Your reply is shown in the chat pane, and a remark also under the line the user is on.
- To mark code, call point with the file, the line, a note of a few words and the exact code you mean. The user jumps there with one key.
- Before you talk about code, call read. Never guess what a file says. read(".") lists the project.
- Call open only when the user asks to see a place.
- When the user asks about an earlier session (what you tried last week, a decision made before), call recall with a few
  words to look for: it searches this project's earlier notes and chats. Never make up what happened before.
- To propose a change, call suggest with the lines and their new text: the user sees it in the editor and accepts it with one key.
- You never save files, and you change the user's code only when they hand you the wheel.

${TONE}`;

// The role part of the prompt, sent as the conversation's instructions so a switch takes effect on the next turn.
export const ROLE_PROMPTS = {
  navigator: `Your role now: Navigator. You cannot search or run commands.
If an answer needs a search or a test run, say so in one sentence: the user can switch you to Scout with /scout.`,
  scout: `Your role now: Scout. You have your own terminal pane next to the chat; the user sees everything you run there.
- search finds text in the project. Use it for "where is", "who calls" and "where else": its file:line results are the answer,
  so read a file only when the question needs more than where.
- run runs one shell command line in your pane, for example the tests, a build, git log or git diff.
- Take small steps: one search or one command usually answers the question. Run only what the question needs.
- Read-only, test and build commands run at once. Commands that write, delete or install ask the user first.
  git commit, push and reset are refused: the user does those. If a command is refused or not allowed, do not try another way.
- For [watch] messages, do not run commands: read and search only.
- After a search, name the places it found as file:line. After a run, say what it showed. Then point at the most relevant line.`,
  driver: `Your role now: Driver. The user handed you the wheel for one change in their editor.
- First read the file, so your line numbers are right.
- Then call edit once: it replaces lines line..end_line with new_text, the complete new lines with their indentation.
  Change as little as the request needs. You get one edit per hand-over.
- After the edit, say in one sentence what you changed. Its result says whether Pair ran the project's tests, or
  the user's build and run, on the unsaved buffer: if so, also say whether they pass, or what the run printed for
  what the user expects. Do not run them yourself: until the user saves, the file on disk still has the old code.
  When your answer ends, you are Navigator again.
- To put a command in the user's terminal, call type: they confirm it and press Enter themselves.
- search and run work in your own pane, as for Scout.`,
};

const text = value => ({output: [{type: 'text', text: value}]});
/** Whether the conversation's model reads images; pi-ai would swap an image for a note for one that does not. */
async function readsImages(api, context) {
  const ref = (await api.agent(context)).model;
  const model = ref && api.models.getModel(ref.provider, ref.modelId);
  return model?.input.includes('image') ?? false;
}

/**
 * A tool's answer that may carry the picture a run wrote (`{text, picture}`): attached for a model that reads images,
 * else only named, so the words never promise a picture the model does not get.
 */
export async function withPicture(value, api, context) {
  if (typeof value === 'string') return text(value);
  const {file, data, mimeType} = value.picture;
  if (!(await readsImages(api, context))) return text(`${value.text}\n\nThe run wrote the picture ${file}; your model does not read images, so it is not attached.`);
  return {output: [{type: 'text', text: `${value.text}\n\nThe run wrote the picture ${file}, attached.`}, {type: 'image', data, mimeType}]};
}

/** The arguments of suggest and edit: which lines of which file, and what they become. */
const lineChange = (extra = {}) => Type.Object({
  file: Type.String({description: 'Path relative to the project root'}),
  line: Type.Integer({minimum: 1, description: 'First line to replace'}),
  end_line: Type.Optional(Type.Integer({minimum: 1, description: 'Last line to replace; default: line'})),
  new_text: Type.String({description: 'The complete new lines, with their indentation; "" deletes the lines'}),
  ...extra,
});

const changeOf = args => ({file: args.file, line: args.line, endLine: args.end_line ?? args.line, text: args.new_text});

function tools(hands) {
  return [
    defineTool({
      name: 'say',
      description: 'Show your answer in the chat pane. After a say, your final reply is not shown, so put the whole answer in it.',
      parameters: Type.Object({text: Type.String()}),
      execute: async (args, api) => text(await hands.say(api.conversationId, args.text)),
    }),
    defineTool({
      name: 'point',
      description: 'Mark lines in the editor with a short note next to them; the user jumps there with one key.',
      parameters: Type.Object({
        file: Type.String({description: 'Path relative to the project root'}),
        line: Type.Integer({minimum: 1}),
        end_line: Type.Optional(Type.Integer({minimum: 1})),
        note: Type.String({description: 'A few words'}),
        code: Type.Optional(Type.String({description: 'The exact code on that line you mean, for example >= or retries + 1'})),
      }),
      execute: async (args, api) => text(await hands.point(api.conversationId, {file: args.file, line: args.line, endLine: args.end_line ?? args.line, note: args.note, code: args.code})),
    }),
    defineTool({
      name: 'open',
      description: 'Open a file at a line in a split next to the user\'s window.',
      parameters: Type.Object({file: Type.String(), line: Type.Integer({minimum: 1})}),
      execute: async (args, api) => text(await hands.open(api.conversationId, {file: args.file, line: args.line})),
    }),
    defineTool({
      name: 'read',
      description: 'Read lines of a file as the editor has it (unsaved changes included), or list a directory. Read-only.',
      parameters: Type.Object({
        file: Type.String({description: 'Path relative to the project root; "." lists the root'}),
        start_line: Type.Optional(Type.Integer({minimum: 1})),
        end_line: Type.Optional(Type.Integer({minimum: 1})),
      }),
      replay: 'safe',
      execute: async (args, api) => text(await hands.read(api.conversationId, {file: args.file, from: args.start_line, to: args.end_line})),
    }),
    defineTool({
      name: 'recall',
      description: 'Search this project\'s earlier sessions (their goals, notes and chats) for words. Read-only.',
      parameters: Type.Object({query: Type.String({description: 'A few words to look for, for example: reconnect timeout'})}),
      replay: 'safe',
      execute: async (args, api) => text(await hands.recall(api.conversationId, {query: args.query})),
    }),
    defineTool({
      name: 'suggest',
      description: 'Show a change in the editor as an inline diff: lines line..end_line would become new_text. The user accepts it with one key or ignores it; nothing changes until they accept.',
      parameters: lineChange({note: Type.String({description: 'A few words on why'})}),
      execute: async (args, api) => text(await hands.suggest(api.conversationId, {...changeOf(args), note: args.note})),
    }),
    defineTool({
      name: 'search',
      description: 'Search the project\'s files for a pattern with ripgrep, in your pane. Answers file:line:text lines.',
      parameters: Type.Object({
        pattern: Type.String({description: 'A regular expression, or plain words'}),
        path: Type.Optional(Type.String({description: 'A file or directory relative to the project root; default: all of it'})),
      }),
      execute: async (args, api) => text(await hands.search(api.conversationId, {pattern: args.pattern, path: args.path})),
    }),
    defineTool({
      name: 'run',
      description: 'Run one shell command line in your pane, in the project root, and get its exit code and output.',
      parameters: Type.Object({
        command: Type.String({description: 'For example: npm test, cargo test, git log --oneline -5'}),
        unsaved: Type.Optional(Type.Boolean({description: 'true runs it on the user\'s unsaved buffers, in a scratch copy of the project: for tests or a build. What it writes stays in the copy.'})),
      }),
      execute: async (args, api) => text(await hands.run(api.conversationId, {command: args.command, unsaved: args.unsaved === true})),
    }),
    defineTool({
      name: 'edit',
      description: 'Replace lines line..end_line of a file in the user\'s editor with new_text, as one undo step. The buffer is not saved.',
      parameters: lineChange(),
      execute: async (args, api, context) => withPicture(await hands.edit(api.conversationId, changeOf(args)), api, context),
    }),
    defineTool({
      name: 'type',
      description: 'Type one command line into the user\'s terminal, once they allow it. Enter is not pressed: the user runs it.',
      parameters: Type.Object({text: Type.String({description: 'One line, for example: npm test'})}),
      execute: async (args, api) => text(await hands.type(api.conversationId, {text: args.text})),
    }),
  ];
}

/**
 * The pi-durable extension with all of Pair's tools. `hands` does the work of each tool for the calling
 * conversation and returns the text the model is told; `hands.roleOf(conversationId)` names its role.
 */
export function pairExtension(hands) {
  return defineExtension({
    name: 'pair',
    tools: tools(hands),
    sections: [section('pair', () => PAIR, {tag: false})],
    hooks: [hook(ToolTask, {beforeTool: (call, api) => toolPolicy(call, hands.roleOf(api.conversationId))})],
  });
}
