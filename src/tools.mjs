// Pair's hands and the roles that may use them. The Navigator has say, point, open and a read-only read;
// Scout adds search and run, which work only in Pair's own herdr pane. Nothing here can write a file or save
// a buffer. Each conversation is offered only its role's tools, and the policy hook refuses any other name,
// so a model that invents `bash` or `write` gets an error, not an effect.
import {Type} from '@earendil-works/pi-ai';
import {defineExtension, defineTool, hook, section, ToolTask} from '@earendil-works/pi-durable';

export const ROLES = ['navigator', 'scout'];

export const ROLE_TOOLS = {
  navigator: ['say', 'point', 'open', 'read'],
  scout: ['say', 'point', 'open', 'read', 'search', 'run'],
};

/** The `beforeTool` policy: a block reason for anything outside the tools of the conversation's role. */
export function toolPolicy(call, role) {
  if (ROLE_TOOLS[role].includes(call.name)) return undefined;
  if (ROLE_TOOLS.scout.includes(call.name)) return {block: `${call.name} needs the Scout role; the user can switch with /scout.`};
  return {block: `Pair has no tool "${call.name}". It can only ${ROLE_TOOLS[role].join(', ')}.`};
}

const PAIR = `You are Pair, a pair programmer in the second chair. The user drives: they edit, save and commit.
You see their editor and terminal through short notes, and you help like a colleague next to them.

Messages starting with [watch] are things you noticed. Speak only about a concrete problem the user seems to have missed:
a failing command, a wrong value, a bug in code they just wrote. If there is none, or you would only offer help or ask
a question, answer exactly: SILENT
Messages starting with [user] are the user talking to you. Always answer them.

How to answer:
- Your reply is shown in the chat pane. Keep it to one or two short sentences.
- To mark code, call point with the file, the line and a note of a few words.
- Before you talk about code, call read. Never guess what a file says. read(".") lists the project.
- Call open only when the user asks to see a place.
- You cannot edit or save files. Say what to change and let the user do it.`;

// The role part of the prompt, sent as the conversation's instructions so a switch takes effect on the next turn.
export const ROLE_PROMPTS = {
  navigator: `Your role now: Navigator. You cannot search or run commands.
If an answer needs a search or a test run, say so in one sentence: the user can switch you to Scout with /scout.`,
  scout: `Your role now: Scout. You have your own terminal pane next to the chat; the user sees everything you run there.
- search finds text in the project. Use it for "where is", "who calls" and "where else".
- run runs one shell command line in your pane, for example the tests, a build, git log or git diff.
- Take small steps: one search or one command usually answers the question. Run only what the question needs.
- Read-only, test and build commands run at once. Commands that write, delete or install ask the user first.
  git commit, push and reset are refused: the user does those. If a command is refused or not allowed, do not try another way.
- For [watch] messages, do not run commands: read and search only.
- After searching or running, answer in one or two sentences and point at the most relevant line.`,
};

const text = value => ({output: [{type: 'text', text: value}]});

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
      description: 'Highlight lines in the editor with a short note next to them.',
      parameters: Type.Object({
        file: Type.String({description: 'Path relative to the project root'}),
        line: Type.Integer({minimum: 1}),
        end_line: Type.Optional(Type.Integer({minimum: 1})),
        note: Type.String({description: 'A few words'}),
      }),
      execute: async (args, api) => text(await hands.point(api.conversationId, {file: args.file, line: args.line, endLine: args.end_line ?? args.line, note: args.note})),
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
      parameters: Type.Object({command: Type.String({description: 'For example: npm test, cargo test, git log --oneline -5'})}),
      execute: async (args, api) => text(await hands.run(api.conversationId, {command: args.command})),
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
