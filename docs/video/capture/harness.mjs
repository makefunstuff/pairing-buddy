// The capture harness: the real daemon on a scratch socket, a fake herdr whose pane really runs the project's
// tests, and two scripted models, so every take says the same words. Only the models' words are scripted:
// the plugin, the daemon, the triggers, the test runs and their results are the shipped code at work.
// Usage: node harness.mjs <scratch dir>   (run.sh starts it; the dir holds the project copy, hookd/)
import {execFile} from 'node:child_process';
import {connect} from 'node:net';
import {join} from 'node:path';
import {createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall} from '@earendil-works/pi-ai';
import {parseConfig} from '../../../src/config.mjs';
import {startDaemon} from '../../../src/daemon.mjs';
import {readMessages, sendMessage} from '../../../src/protocol.mjs';
import {fakeHerdr} from '../../../test/fake-herdr.mjs';

const dir = process.argv[2];
// Never the owner's daemon: only a socket inside a scratch directory made by run.sh.
if (!/^\/tmp\/pbcap\.[\w-]+$/.test(dir ?? '')) throw new Error('usage: node harness.mjs /tmp/pbcap.XXXX');
const project = join(dir, 'hookd');
const socket = join(dir, 'pair.sock');
const config = parseConfig({
  dataDir: join(dir, 'data'), socket,
  testOnSave: {[project]: 'go test -json ./...'},
  models: {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'watcher'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'partner'}},
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const textOf = message => (typeof message.content === 'string' ? message.content
  : message.content.map(block => block.text ?? JSON.stringify(block.arguments ?? '')).join('\n'));

// The Watcher scores the two moments high and everything else low.
const watcher = fauxProvider({provider: 'faux-watcher'});
const scoreFor = context => {
  const asked = textOf(context.messages.at(-1));
  return fauxAssistantMessage([fauxText(/\((edit_while_red|regression)\)/.test(asked) ? '8' : '0')]);
};
watcher.setResponses(Array.from({length: 500}, () => scoreFor));

// The Partner's words, step by step for each moment.
const TEST = 'internal/retry/backoff_test.go';
const CASES = [
  '\t\t{"first retry waits the base", 1, time.Second},',
  '\t\t{"second retry doubles", 2, 2 * time.Second},',
  '\t\t{"fifth retry", 5, 16 * time.Second},',
  '\t\t{"capped at Max", 7, time.Minute},',
  '\t\t{"no attempt yet", 0, 0},',
  '\t\t{"negative attempt", -1, 0},',
  '\t\t{"shift past 63 bits", 64, time.Minute},',
].join('\n');
const tool = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], {stopReason: 'toolUse'});
const words = text => fauxAssistantMessage([fauxText(text)]);
const SCRIPTS = {
  wrongTurn: [
    [900, tool('read', {file: 'internal/delivery/worker.go', start_line: 22, end_line: 39})],
    [700, tool('point', {file: 'internal/delivery/worker.go', line: 34, note: '15s is not over a 15s budget', code: '>='})],
    [300, words('the shift is fine: 1s 2s 4s 8s, as the test wants. Attempt 5 starts at exactly 15s, and `worker.go:34` gives up on `>=`.')],
  ],
  regression: [
    [800, tool('read', {file: 'internal/queue/queue.go', start_line: 16, end_line: 24})],
    [600, tool('suggest', {file: 'internal/queue/queue.go', line: 19, new_text: '\tif until, ok := q.leased[event]; ok && now <= until {', note: 'the lease holds through its last instant'})],
    [300, words('delivery passes now, queue doesn\'t: attempt 5 starts at 15s, the instant evt_42\'s lease runs out, so a second worker takes it.')],
  ],
  drive: [
    [700, tool('read', {file: TEST})],
    [800, tool('read', {file: 'internal/retry/backoff.go'})],
    [900, tool('edit', {file: TEST, line: 15, new_text: CASES})],
    [300, words('six cases, one undo step, and they pass. `64` shifts past the top bit: `Next` caps it, so that one is a guard.')],
  ],
  takeBack: [
    [600, tool('edit', {file: TEST, line: 15, new_text: CASES})],
    [200, words('Okay, yours.')],
  ],
};
let drives = 0;
const turns = new Map(); // the user message that opened a turn → its script
const partner = fauxProvider({provider: 'faux-partner'});
const answer = async context => {
  const start = context.messages.findLastIndex(message => message.role === 'user');
  const opening = context.messages[start];
  if (!turns.has(opening)) {
    const asked = textOf(opening);
    turns.set(opening, /edit_while_red|is red/.test(asked) ? 'wrongTurn'
      : /regression|not in Pair's run before/.test(asked) ? 'regression'
        : /edge cases/.test(asked) ? (drives++ ? 'takeBack' : 'drive') : null);
  }
  const script = SCRIPTS[turns.get(opening)];
  const step = context.messages.slice(start + 1).filter(message => message.role === 'assistant').length;
  if (!script || !script[step]) return words('SILENT');
  const [delay, message] = script[step];
  await sleep(delay);
  return message;
};
partner.setResponses(Array.from({length: 500}, () => answer));

const models = createModels();
models.setProvider(watcher.provider);
models.setProvider(partner.provider);
await startDaemon(config, {
  pairModels: {models, watcher: watcher.getModel(), partner: partner.getModel()},
  probe: async () => ({ok: true}),
  log: line => console.error(line),
});

// Pair's pane: a fake herdr pane that runs the on-save command for real, in the project.
const runIn = cwd => command => new Promise(resolve => {
  execFile('bash', ['-c', command], {cwd}, (error, stdout, stderr) => resolve({output: stdout + stderr, exit: error ? error.code ?? 1 : 0}));
});
const herdrSocket = join(dir, 'herdr.sock');
await fakeHerdr(herdrSocket, {commands: runIn(project)});

// The chat pane, with the session's goal.
const chat = connect(socket);
readMessages(chat, message => console.error('chat <-', JSON.stringify(message).slice(0, 240)));
chat.on('connect', () => {
  sendMessage(chat, {type: 'hello', role: 'chat', cwd: project, herdr: {socket: herdrSocket, workspace: 'w1', pane: 'w1:p2'}});
  setTimeout(() => sendMessage(chat, {type: 'goal', text: 'failed webhooks retry until the budget is spent'}), 500);

});
console.error('harness ready');
