// What the session tells the full-screen chat pane besides the words: what Pair does now (activity), what its tools
// do, the answer as it streams, how long a turn took, the remark and the place each message is about, a suggestion
// as a diff, and the user's stop, mute, follow-up and undo. With a real store in memory and a scratch project.
import assert from 'node:assert/strict';
import {realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {PairSession, streamable, toolWhat} from '../src/session.mjs';
import {openStore} from '../src/store.mjs';
import {scratch} from './temp.mjs';

const WORKER = 'package delivery\n\nfunc Run() {\n\tif elapsed+wait >= budget {\n\t\treturn\n\t}\n}\n';

/** A session whose Partner runs `turns` in order, each with the session and the ask's options (to stream). */
function pairSession(turns = [], {partner = {}} = {}) {
  const root = realpathSync(scratch('pair-chat-session-'));
  writeFileSync(join(root, 'worker.go'), WORKER);
  const store = openStore(':memory:');
  const clock = {now: 1_000_000};
  const sent = [];
  const editorAsks = [];
  const pair = new PairSession({
    record: store.createSession({root, conversationId: 'c1', goal: 'retries pass', level: 'normal', at: clock.now}),
    store,
    partner: {
      thinkingOf: () => 'off',
      ask: async (_id, _input, options) => turns.shift()?.(pair, options) ?? 'SILENT',
      setRole: async () => {},
      modelName: () => 'qwen3-coder',
      ...partner,
    },
    score: async () => ({value: 9, reason: 'test'}),
    typingPauseMs: 2000,
    notify: (to, message) => { sent.push({via: to, ...message}); return 1; },
    requestEditor: async message => { editorAsks.push(message); return null; },
    now: () => clock.now,
  });
  return {root, pair, store, clock, sent, editorAsks};
}

const chat = sent => sent.filter(message => message.via === 'chat');

test('a question: the chat hears Pair think, use its tools, stream the answer, and how long the turn took', async () => {
  const {pair, sent, clock} = pairSession([async (pair, options) => {
    await pair.useTool('read', {file: 'worker.go', from: 3, to: 5});
    options.onEvent({type: 'text', text: 'SIL'}); // could still be SILENT: not shown
    options.onEvent({type: 'text', text: 'The check is'});
    options.onEvent({type: 'text', text: 'The check is `>=` on line 4.'});
    options.onEvent({type: 'usage', tokens: 1234, cost: 0.002});
    clock.now += 2100;
    return 'The check is `>=` on line 4.';
  }]);
  await pair.ask('why does attempt 5 stop?');
  const seen = chat(sent).map(({type, state, tool, what, text, sender}) => [type, state ?? tool ?? sender, what ?? text].filter(Boolean).join(' '));
  assert.deepEqual(seen, [
    'message user why does attempt 5 stop?',
    'activity thinking',
    'activity tool worker.go 3-5',
    'tool read worker.go 3-5',
    'activity thinking',
    'partial The check is',
    'partial The check is `>=` on line 4.',
    'message pair The check is `>=` on line 4.',
    'turn',
    'activity idle',
  ]);
  const turn = chat(sent).find(message => message.type === 'turn');
  assert.deepEqual({ms: turn.ms, model: turn.model, tokens: turn.tokens, cost: turn.cost, asked: turn.asked}, {ms: 2100, model: 'qwen3-coder', tokens: 1234, cost: 0.002, asked: true});
});

test('a question with no answer says so; a failed one is an error that says what to check', async () => {
  const {pair, sent} = pairSession([async () => 'SILENT', async () => { throw new Error('connection refused'); }]);
  await pair.ask('anything?');
  assert.ok(chat(sent).some(message => message.text === 'Pair had nothing to add to that.'));
  await pair.ask('and now?');
  const error = chat(sent).find(message => message.meta?.error);
  assert.match(error.text, /^Pair could not answer: connection refused\. `pair doctor` checks the models\.$/);
});

test('an unasked remark: its words carry the remark and its kind, its tools show only in the status row', async () => {
  const {pair, sent, clock, store} = pairSession([async pair => {
    await pair.useTool('read', {file: 'worker.go'});
    await pair.point({file: 'worker.go', line: 4, endLine: 4, note: 'gives up on >=', code: '>='});
    return 'Attempt 5 lands at 15s exactly.';
  }]);
  pair.receive({kind: 'command_end', cmd: 'go test ./...', exit: 1, output: 'FAIL', at: clock.now - 10_000});
  await pair.tick();
  const [remark] = store.remarks(0);
  const messages = chat(sent);
  assert.ok(!messages.some(message => message.type === 'tool'), 'no tool lines for what nobody asked');
  assert.deepEqual(messages.filter(message => message.type === 'activity').map(message => message.state), ['remark', 'tool', 'remark', 'idle']);
  assert.equal(messages.find(message => message.type === 'activity').what, 'failed_command');
  const words = messages.filter(message => message.type === 'message' && message.sender === 'pair');
  assert.deepEqual(words.map(message => message.meta), [
    {remark: remark.id, trigger: 'failed_command', place: {file: 'worker.go', line: 4}},
    {remark: remark.id, trigger: 'failed_command'},
  ]);
  assert.deepEqual(messages.find(message => message.type === 'remark'), {via: 'chat', type: 'remark', id: remark.id, trigger: 'failed_command', place: {file: 'worker.go', line: 4}});
  assert.deepEqual(messages.filter(message => message.type === 'presence').at(-1), {via: 'chat', type: 'presence', looked: 1, spoke: 1, lastAt: clock.now});
  assert.deepEqual(store.messages(pair.id).at(-1).meta, {remark: remark.id, trigger: 'failed_command'}, 'the history keeps what the pane shows it with');
});

test('a suggestion reaches the chat as a diff of the lines it replaces; taking it in Neovim says so', async () => {
  const {pair, sent} = pairSession([async pair => {
    await pair.suggest({file: 'worker.go', line: 4, endLine: 4, text: '\tif elapsed+wait > budget {', note: 'the last attempt fits'});
    return '';
  }]);
  await pair.ask('fix it?');
  const message = chat(sent).find(m => m.meta?.suggestion);
  assert.equal(message.text, 'worker.go:4 suggestion: the last attempt fits\n\tif elapsed+wait > budget {');
  assert.deepEqual(message.meta, {place: {file: 'worker.go', line: 4}, suggestion: {action: message.meta.suggestion.action, old: ['\tif elapsed+wait >= budget {'], new: ['\tif elapsed+wait > budget {']}});
  pair.applied(message.meta.suggestion.action, ['a'], ['b']);
  assert.deepEqual(chat(sent).at(-1), {via: 'chat', type: 'applied', action: message.meta.suggestion.action});
});

test('a confirmation shows as waiting, and the turn goes on after the answer', async () => {
  const {pair, sent} = pairSession();
  pair.busy = true;
  const asked = pair.confirm('Run `go test ./...` in your pane?');
  assert.deepEqual(chat(sent).filter(m => m.type === 'activity').at(-1).state, 'waiting');
  pair.answer(1, true);
  assert.equal(await asked, true);
  assert.equal(chat(sent).filter(m => m.type === 'activity').at(-1).state, 'thinking');
});

test('stop cancels the running question, and says so; with nothing running it says that', async () => {
  let release;
  const stopped = [];
  const {pair, sent} = pairSession([() => new Promise(resolve => { release = resolve; })], {partner: {stop: async id => { stopped.push(id); release(null); }}});
  await pair.stop();
  assert.equal(chat(sent).at(-1).text, 'Pair is not answering anything now.');
  const asking = pair.ask('a long one');
  await new Promise(resolve => setImmediate(resolve));
  await pair.stop();
  await asking;
  assert.deepEqual(stopped, ['c1']);
  const texts = chat(sent).filter(m => m.type === 'message').map(m => m.text);
  assert.ok(texts.includes('Stopped. Ask again, or ask something else.'));
  assert.ok(!texts.includes('Pair had nothing to add to that.'), 'a stopped answer is not an empty one');
  assert.equal(chat(sent).find(m => m.type === 'turn').cancelled, true);
});

test('/mute keeps a kind of remark quiet for the session, /unmute lets it speak again', async () => {
  const {pair, sent, clock, store} = pairSession([async () => 'It failed.', async () => 'It failed again.']);
  pair.mute();
  assert.match(chat(sent).at(-1).text, /^Pair has made no remark to mute yet/);
  pair.mute('nonsense');
  assert.match(chat(sent).at(-1).text, /^There is no remark kind nonsense/);
  pair.mute('failed_command');
  assert.deepEqual(chat(sent).find(m => m.type === 'muted').kinds, ['failed_command']);
  pair.receive({kind: 'command_end', cmd: 'make', exit: 2, output: 'error', at: clock.now - 10_000});
  await pair.tick();
  assert.equal(store.remarks(0).length, 0, 'muted: not even scored');
  pair.unmute();
  assert.equal(chat(sent).at(-1).text, 'Pair may speak about failed_command again.');
  clock.now += 1000;
  pair.receive({kind: 'command_end', cmd: 'make', exit: 2, output: 'error', at: clock.now - 10_000});
  await pair.tick();
  assert.equal(store.remarks(0).length, 1);
  pair.mute(); // the last remark's kind
  assert.equal(chat(sent).at(-1).text, `Muted ${store.remarks(0)[0].trigger}: Pair says nothing about it for the rest of this session. /unmute brings it back.`);
});

test('a follow-up on a remark sends the remark\'s words along, and counts as seeing it', async () => {
  const inputs = [];
  const {pair, clock, store, sent} = pairSession([], {
    partner: {ask: async (_id, input) => { inputs.push(input); return inputs.length === 1 ? 'The build failed on `main.c:3`.' : 'Because the object is stale.'; }},
  });
  pair.receive({kind: 'command_end', cmd: 'make', exit: 2, output: 'error', at: clock.now - 10_000});
  await pair.tick();
  const [remark] = store.remarks(0);
  await pair.ask('why is that?', null, {about: remark.id});
  assert.match(inputs[1], /^\[user\] why is that\?\n\nThis is about your remark \(failed_command\): "The build failed on `main\.c:3`\."/);
  assert.equal(store.remarks(0)[0].verdict, 'seen');
  assert.deepEqual(chat(sent).find(m => m.sender === 'user').meta, {about: remark.id});
});

test('/undo undoes Pair\'s last change that can be undone, and says when there is none', async () => {
  const {pair, sent, editorAsks, root} = pairSession();
  await pair.undoLast();
  assert.equal(chat(sent).at(-1).text, 'Pair has changed nothing today that can be undone.');
  const file = join(root, 'worker.go');
  const id = pair.ledger.add('suggested', 'worker.go:4, fits', {data: {place: {file, line: 4}}});
  pair.applied(id, ['a'], ['b']);
  await pair.undoLast();
  assert.deepEqual(editorAsks.at(-1), {type: 'revert', file, base: ['b'], other: ['a']});
});

test('what a tool does, in a few words; streamed text shows once it cannot be SILENT', () => {
  assert.equal(toolWhat('read', {file: 'a.go', from: 3, to: 9}), 'a.go 3-9');
  assert.equal(toolWhat('read', {file: 'a.go'}), 'a.go');
  assert.equal(toolWhat('search', {pattern: 'lease', path: 'internal'}), '"lease" in internal');
  assert.equal(toolWhat('run', {command: 'go test ./...'}), 'go test ./...');
  assert.equal(toolWhat('point', {file: 'a.go', line: 4}), 'a.go:4');
  assert.equal(toolWhat('say', {words: 'hi'}), null);
  for (const text of ['', ' ', 'S', 'SILEN', 'SILENT', 'silent.', 'ok <tool_call>{']) assert.equal(streamable(text), false, text);
  for (const text of ['Sure', 'The lease', 'SILENTLY? no']) assert.equal(streamable(text), true, text);
});

test('a new talk level reaches the chat pane\'s header', () => {
  const {pair, sent} = pairSession();
  pair.setLevel('quiet');
  assert.deepEqual(chat(sent).find(message => message.type === 'level'), {via: 'chat', type: 'level', level: 'quiet'});
});

test('a command Pair asks to run gets its tool line only once it ran, and none when you decline', async () => {
  const {pair, sent} = pairSession([], {partner: {}});
  pair.run = async ({command}) => (command === 'rm x' ? 'The user did not allow it. Do not run it another way.' : 'exit 0');
  pair.busy = true;
  await pair.useTool('run', {command: 'rm x'});
  assert.ok(!chat(sent).some(message => message.type === 'tool'), 'declined: no line');
  await pair.useTool('run', {command: 'make'});
  assert.deepEqual(chat(sent).filter(message => message.type === 'tool').map(message => message.what), ['make']);
});
