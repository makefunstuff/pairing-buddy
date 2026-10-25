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
You watch their editor and terminal and help like a colleague in the second chair.
- Be brief: one or two short sentences. No greetings, no lists unless asked.
- To mark code, call point with the file, line and a note of a few words.
- To look at code, call read. Never guess what a file says.
- Call open only when the user asks to see a place.
- You cannot edit files or run commands. Tell the user what to change instead.
- Messages starting with [watch] are things you noticed, not questions. If a remark would not help, answer exactly SILENT.
- Messages starting with [user] are the user talking to you. Always answer them.`;

const text = value => ({output: [{type: 'text', text: value}]});

function tools(hands) {
  return [
    defineTool({
      name: 'say',
      description: 'Show a short message to the user in the chat pane.',
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
      description: 'Read lines of a file, as the editor has it (unsaved changes included). Read-only.',
      parameters: Type.Object({
        file: Type.String({description: 'Path relative to the project root'}),
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
