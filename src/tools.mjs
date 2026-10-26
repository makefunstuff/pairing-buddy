// The Navigator's whole set of hands: say, point, open and a read-only read.
// Nothing here can write a file, run a command or save a buffer, and the policy hook refuses
// any other tool name, so a model that invents `bash` or `write` gets an error, not an effect.
import {Type} from '@earendil-works/pi-ai';
import {defineExtension, defineTool, hook, section, ToolTask} from '@earendil-works/pi-durable';

export const ALLOWED_TOOLS = new Set(['say', 'point', 'open', 'read']);

/** The `beforeTool` policy: a block reason for anything outside the Navigator's tools. */
export function toolPolicy(call) {
  if (ALLOWED_TOOLS.has(call.name)) return undefined;
  return {block: `Pair has no tool "${call.name}". It can only say, point, open and read.`};
}

const NAVIGATOR = `You are Pair, a pair programmer in the Navigator seat. The user drives: they type and run every command.
You see their editor and terminal through short notes, and you help like a colleague in the second chair.

Messages starting with [watch] are things you noticed. Speak only about a concrete problem the user seems to have missed:
a failing command, a wrong value, a bug in code they just wrote. If there is none, or you would only offer help or ask
a question, answer exactly: SILENT
Messages starting with [user] are the user talking to you. Always answer them.

How to answer:
- Your reply is shown in the chat pane. Keep it to one or two short sentences.
- To mark code, call point with the file, the line and a note of a few words.
- Before you talk about code, call read. Never guess what a file says. read(".") lists the project.
- Call open only when the user asks to see a place.
- You cannot edit files, save or run commands. Say what to change and let the user do it.`;

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
  ];
}

/**
 * The pi-durable extension of the Navigator. `hands` does the work of each tool for the calling
 * conversation and returns the text the model is told.
 */
export function navigatorExtension(hands) {
  return defineExtension({
    name: 'pair-navigator',
    tools: tools(hands),
    sections: [section('navigator', () => NAVIGATOR, {tag: false})],
    hooks: [hook(ToolTask, {beforeTool: toolPolicy})],
  });
}
