// /gen: requests with a number, a shape guessed by rule and confirmed, a conversation of their own, proposals shown at
// the user's pause, booked in the ledger as one line, and undone as one unit. A session on a store in memory, with a
// stand-in Partner and editor.
import assert from 'node:assert/strict';
import {realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {guessShape, parseGen} from '../src/gen.mjs';
import {PairSession} from '../src/session.mjs';
import {openStore} from '../src/store.mjs';
import {scratch} from './temp.mjs';

const NOON = new Date(2026, 9, 28, 12, 0).getTime();
const SUM = 'function sum(a, b) {\n  return a + b\n}';

/**
 * A session in a scratch project with math.js. Each /gen request's turn runs the next of `turns` with its
 * conversation id; `editor(message)` answers what the session asks Neovim (reverts are fine by default).
 */
function genSession(turns = [], {editor = async () => null, limits} = {}) {
  const root = realpathSync(scratch('pair-gen-'));
  writeFileSync(join(root, 'math.js'), 'const x = 1\n\nexport {x}\n');
  writeFileSync(join(root, 'other.js'), 'const y = 2\n');
  const store = openStore(':memory:');
  const clock = {now: NOON};
  const sent = [];
  const asked = []; // {conversation, input, kind}
  const roles = new Map();
  const stopped = [];
  let conversations = 0;
  const reverts = [];
  const pair = new PairSession({
    record: store.createSession({root, conversationId: 'main', goal: 'add helpers', level: 'normal', at: clock.now}),
    store,
    partner: {
      thinkingOf: () => 'off',
      createConversation: async () => `gen-${++conversations}`,
      setRole: async (id, role) => { roles.set(id, role); },
      ask: async (conversation, input, options = {}) => {
        asked.push({conversation, input, kind: options.kind});
        return conversation === 'main' ? 'SILENT' : (await turns.shift()?.(conversation, pair)) ?? 'SILENT';
      },
      stop: async conversation => { stopped.push(conversation); },
    },
    score: async () => ({value: 9, reason: 'test'}),
    typingPauseMs: 2000,
    genLimits: limits,
    notify: (to, message) => { sent.push({via: to, ...message}); return 1; },
    requestEditor: async message => {
      if (message.type === 'revert') {
        reverts.push(message);
        return {ok: true};
      }
      return editor(message);
    },
    now: () => clock.now,
  });
  const of = type => sent.filter(message => message.type === type);
  const said = () => sent.filter(message => message.type === 'message').map(message => message.text);
  return {root, pair, store, clock, sent, asked, roles, stopped, reverts, of, said};
}

const tool = (pair, conversation, name, args) => pair.useTool(name, args, conversation);

/** Waits until `check()` holds: a request goes through a few awaits (files, the editor) before its turn starts. */
async function until(check) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(check(), 'timed out');
}

test('the shape word comes first, or the rule guesses one; scaffold is never more than a guess', () => {
  assert.deepEqual(parseGen('here a sum function'), {shape: 'here', words: 'a sum function'});
  assert.deepEqual(parseGen('Scaffold an admin page'), {shape: 'scaffold', words: 'an admin page'});
  assert.deepEqual(parseGen('a sum function'), {shape: null, words: 'a sum function'});
  assert.deepEqual(guessShape('a sum function', {selection: true}), {shape: 'here', why: 'over the selection'});
  assert.equal(guessShape('a sum function').shape, 'here', 'no clue: at the cursor');
  assert.equal(guessShape('a list handler with paging, below this').shape, 'here');
  assert.equal(guessShape('a migration adding status to orders, and its test').shape, 'file');
  assert.equal(guessShape('db/schema.sql for the orders').shape, 'file');
  assert.equal(guessShape('an admin page for orders, wired into the router').shape, 'scaffold');
  assert.equal(guessShape('a sample LRU cache to try').shape, 'try');
  assert.match(guessShape('a migration for orders').why, /new files: "migration"/);
  // In a note the selection is the request, not a place.
  assert.equal(guessShape('a migration for orders', {selection: true, note: true}).shape, 'file');
});

test('/gen here from Neovim: its own conversation, the code at the next pause, taken with one key, undone as one request', async () => {
  const {root, pair, store, clock, sent, asked, roles, reverts, of, said} = genSession([async (conversation, pair) => {
    assert.equal(pair.roleOf(conversation), 'gen', 'the request\'s conversation has the gen tools');
    assert.equal(pair.role, 'navigator', 'and the session keeps its role');
    await tool(pair, conversation, 'read', {file: 'math.js'});
    const result = await tool(pair, conversation, 'propose', {file: 'math.js', line: 1, endLine: 1, insert: true, text: SUM, note: 'sum'});
    assert.match(result, /at the user's next pause/);
    return 'A sum of two numbers; I guessed plain numbers, no BigInt.';
  }]);
  pair.receive({kind: 'typing', at: clock.now}); // the user types on after asking
  await pair.gen.request({text: 'here a sum function', place: {file: join(root, 'math.js'), line: 1}, token: 4, from: 'editor'});

  const [turn] = asked;
  assert.equal(turn.conversation, 'gen-1');
  assert.equal(turn.kind, 'gen');
  assert.equal(roles.get('gen-1'), 'gen');
  assert.match(turn.input, /^\[gen\] gen #1, here\. The user asked: "a sum function"/);
  assert.match(turn.input, /cursor is on line 1 of math\.js: propose with insert true and line 1/);
  assert.match(turn.input, /1: const x = 1\n2: \n3: export \{x\}/);
  assert.match(turn.input, /The session's goal: add helpers/);
  assert.equal(pair.gen.owns('gen-1'), false, 'its conversation is done');

  assert.deepEqual(of('suggest'), [], 'nothing lands while the user types');
  assert.ok(of('gen').some(message => message.state === 'generating' && message.token === 4), 'the editor binds its mark to #1');
  clock.now += 2500;
  await pair.tick();
  const [suggestion] = of('suggest');
  assert.deepEqual({...suggestion, action: undefined}, {
    via: 'editor', type: 'suggest', file: join(root, 'math.js'), line: 1, endLine: 1, insert: true, text: SUM,
    note: 'gen #1 · sum', action: undefined, piece: 0, gen: 1, origin: 'gen:#1', aim: true,
  });
  assert.ok(said().includes('gen #1 · here · 3 lines at math.js:1: A sum of two numbers; I guessed plain numbers, no BigInt.'));
  assert.equal(of('gen').at(-1).state, 'ready');

  let [row] = pair.today().rows;
  assert.deepEqual([row.label, row.text, row.note, row.undo], ['generated', 'gen #1 · here · a sum function', '3 lines proposed', true]);

  // Alt-y took it: the ledger keeps the buffer before and after, and the check says so under the lines.
  const before = ['const x = 1', '', 'export {x}', ''];
  const after = ['const x = 1', ...SUM.split('\n'), '', 'export {x}', ''];
  await pair.applied(suggestion.action, before, after, {piece: 0, from: 2, to: 4});
  [row] = pair.today().rows;
  assert.deepEqual([row.state, row.note], ['applied', '1 of 1 piece taken']);
  const handback = of('handback').at(-1);
  assert.deepEqual([handback.line, handback.endLine, handback.text], [2, 4, 'gen #1: 3 lines taken, unsaved']);
  assert.equal(of('gen').at(-1).state, 'done');
  assert.deepEqual(store.action(suggestion.action).detail.pieces[0].patch, {file: join(root, 'math.js'), before, after});

  // /undo takes the request back as one: merged into the buffer as it is now, tagged as the request's.
  await pair.undoLast();
  assert.deepEqual(reverts.map(({file, base, other, origin}) => ({file, base, other, origin})), [{file: join(root, 'math.js'), base: after, other: before, origin: 'gen:#1'}]);
  assert.equal(pair.today().rows[0].state, 'undone');
  assert.ok(said().includes('Undid gen #1: took back 1 piece, unsaved.'));
  // And u in :Pair today again makes it again.
  await pair.undo(suggestion.action);
  assert.deepEqual(reverts[1].base, before);
  assert.equal(pair.today().rows[0].state, 'applied');
  assert.ok(sent.every(message => message.type !== 'remark'), 'no remark about any of it');
});

test('no remark nobody asked for starts while a request runs; the chat\'s questions still get answers', async () => {
  let release;
  const {root, pair, asked} = genSession([() => new Promise(resolve => { release = resolve; })]);
  const running = pair.gen.request({text: 'here a sum', place: {file: join(root, 'math.js'), line: 1}, from: 'editor'});
  await until(() => asked.length === 1);
  assert.ok(pair.gen.running, 'the request runs');
  for (const at of [NOON - 6000, NOON - 5000]) pair.receive({kind: 'command_end', cmd: 'npm test', exit: 1, output: 'Error: boom', at});
  await pair.tick();
  assert.deepEqual(asked.map(turn => turn.conversation), ['gen-1'], 'the failure waits');
  await pair.ask('what is x?');
  assert.deepEqual(asked.map(turn => turn.conversation), ['gen-1', 'main'], 'a question is answered in the session\'s own conversation');
  release('nothing to add');
  await running;
  await pair.tick();
  assert.match(asked.at(-1).input, /^\[watch\] repeated_error/, 'once the request is done, the moment is looked at');
});

test('a guessed shape is asked first, in the chat for a chat request: y takes the guess, a shape word another, n cancels', async () => {
  const {pair, of, said} = genSession([], {editor: async message => (message.type === 'gen_place' ? {file: 'math.js', line: 2} : null)});
  const first = pair.gen.request({text: 'a migration for orders'});
  await new Promise(resolve => setImmediate(resolve));
  const confirm = of('confirm').at(-1);
  assert.match(confirm.text, /^gen #1 · new files: "migration"\. Shape\? y: file, or type here, scaffold, try; n cancels\.$/);
  assert.equal(confirm.hint, 'y: file · here, scaffold, try · n cancels');
  pair.answer(confirm.id, true);
  await first;
  assert.ok(said().includes('gen #1: /gen file (new files to review) is not built yet; this version has /gen here.'));
  assert.equal(pair.today().rows.length, 0, 'a request that never ran is not booked');

  const second = pair.gen.request({text: 'a migration for orders'});
  await new Promise(resolve => setImmediate(resolve));
  pair.answer(of('confirm').at(-1).id, false, undefined, 'n');
  await second;
  assert.ok(said().includes('gen #2 cancelled.'));

  const third = pair.gen.request({text: 'a migration for orders'});
  await new Promise(resolve => setImmediate(resolve));
  pair.answer(of('confirm').at(-1).id, false, undefined, 'scaffold');
  await third;
  assert.ok(said().includes('gen #3: /gen scaffold (many files, in Pair\'s copy) is not built yet; this version has /gen here.'), 'a shape word takes that shape');

  // A shape typed is never asked; from the chat, the Neovim the user works in gives the place.
  const before = of('confirm').length;
  await pair.gen.request({text: 'here x times two'});
  assert.equal(of('confirm').length, before);
  assert.equal(pair.today().rows[0].place.line, 2);
});

test('from Neovim the shape question is a dialog there; one request runs at a time and the next waits', async () => {
  let release;
  const {root, pair, of, said, asked} = genSession([() => new Promise(resolve => { release = resolve; }), async () => 'second done']);
  const place = {file: join(root, 'math.js'), line: 1};
  const first = pair.gen.request({text: 'a sum function', place, from: 'editor'});
  await until(() => of('gen_ask').length);
  const ask = of('gen_ask').at(-1);
  assert.deepEqual({kind: ask.kind, title: ask.title, gen: ask.gen}, {kind: 'shape', title: 'gen #1 · at the cursor. Shape?', gen: 1});
  assert.deepEqual(ask.choices.map(choice => [choice.shape, choice.guessed, choice.built]), [['here', true, true], ['file', false, false], ['scaffold', false, false], ['try', false, false]]);
  assert.equal(of('confirm').length, 0, 'not asked in the chat as well');
  pair.gen.answer(1, ask.id, 'here');
  await until(() => asked.length === 1);
  const second = pair.gen.request({text: 'here a product function', place, from: 'editor'});
  await until(() => said().includes('gen #2 waits for gen #1.'));
  assert.ok(said().includes('gen #2 waits for gen #1.'));
  assert.equal(of('gen').at(-1).state, 'queued');
  release('first done');
  await Promise.all([first, second]);
  assert.deepEqual(asked.map(turn => turn.conversation), ['gen-1', 'gen-2']);
});

test('the model asks at most two questions, where the request came from; an answer or "left to you" goes back', async () => {
  const results = [];
  const {root, pair, of} = genSession([async (conversation, pair) => {
    const asking = tool(pair, conversation, 'ask', {question: 'statuses of existing rows?', answer: 'new'});
    await new Promise(resolve => setImmediate(resolve));
    const question = of('gen_ask').at(-1);
    assert.deepEqual([question.title, question.answer], ['gen #1 asks: statuses of existing rows?', 'new']);
    assert.equal(of('gen').at(-1).state, 'asks');
    pair.gen.answer(1, question.id, 'paid');
    results.push(await asking);
    const second = tool(pair, conversation, 'ask', {question: 'and the index?', answer: 'yes'});
    await new Promise(resolve => setImmediate(resolve));
    pair.gen.answer(1, of('gen_ask').at(-1).id, null);
    results.push(await second);
    results.push(await tool(pair, conversation, 'ask', {question: 'a third?', answer: 'no'}));
    return 'asked enough';
  }]);
  await pair.gen.request({text: 'here a status column', place: {file: join(root, 'math.js'), line: 1}, from: 'editor'});
  assert.deepEqual(results, [
    'The user answered: "paid"',
    'The user left it to you: decide, and say what you decided.',
    'You asked 2 questions already: decide with what you know, and say what you decided.',
  ]);
});

test('a request is held by its limits and its place: other files, too many lines, too many searches', async () => {
  const results = [];
  const {root, pair} = genSession([async (conversation, pair) => {
    results.push(await tool(pair, conversation, 'propose', {file: 'other.js', line: 1, endLine: 1, insert: true, text: 'x', note: 'n'}));
    results.push(await tool(pair, conversation, 'propose', {file: 'math.js', line: 1, endLine: 1, insert: true, text: 'a\nb\nc', note: 'n'}));
    results.push(await tool(pair, conversation, 'propose', {file: 'math.js', line: 9, endLine: 9, insert: true, text: 'a', note: 'n'}));
    for (let i = 0; i < 2; i++) await tool(pair, conversation, 'search', {pattern: 'x'});
    results.push(await tool(pair, conversation, 'search', {pattern: 'x'}));
    results.push(await tool(pair, conversation, 'edit', {file: 'math.js', line: 1, endLine: 1, text: 'gone'}));
    return 'done';
  }], {limits: {files: 40, lines: 2, commands: 2, minutes: 10}});
  await pair.gen.request({text: 'here helpers', place: {file: join(root, 'math.js'), line: 1}, from: 'editor'});
  assert.deepEqual(results, [
    'This request is /gen here in math.js: propose there.',
    'That is more than 2 lines for this request (gen.limits.lines): propose less, or say what is left.',
    'Line 9 is past the end of math.js, which has 4 lines. Read it first.',
    'That is 2 searches for this request (gen.limits.commands): propose with what you found.',
    'Pair has no tool "edit" in a /gen request.',
  ]);
  assert.equal(pair.today().rows.find(row => row.kind === 'generated').note, 'nothing proposed');
});

test('a request a daemon restart stopped says so in the ledger, and the numbers go on', () => {
  const {pair, store} = genSession();
  pair.ledger.add('generated', 'gen #4 · here · a sum', {data: {gen: 4, shape: 'here', note: 'at math.js:1 · generating', undo: true}});
  const again = new PairSession({record: pair.record, store, partner: pair.partner, score: pair.score, typingPauseMs: 2000, notify: () => 0, requestEditor: async () => null, now: pair.now});
  assert.equal(again.today().rows[0].note, 'stopped: the daemon restarted');
  assert.equal(again.gen.next(), 5);
});

test('/gen cancel and /cancel in the chat stop a running request; a dropped proposal leaves nothing to undo', async () => {
  let release;
  const {root, pair, stopped, of, said} = genSession([
    () => new Promise(resolve => { release = resolve; }),
    async (conversation, pair) => {
      await tool(pair, conversation, 'propose', {file: 'math.js', line: 1, endLine: 1, insert: true, text: 'const z = 3', note: 'z'});
      return 'z';
    },
  ]);
  const place = {file: join(root, 'math.js'), line: 1};
  const running = pair.gen.request({text: 'here a sum', place, from: 'editor'});
  await until(() => release);
  await pair.stop(); // Esc in the chat: Pair answers nothing else
  assert.deepEqual(stopped, ['gen-1']);
  release('late');
  await running;
  assert.ok(said().includes('gen #1 cancelled.'));
  assert.ok(of('gen_drop').some(message => message.gen === 1));
  assert.equal(of('suggest').length, 0);

  await pair.gen.request({text: 'here z', place, from: 'editor'});
  const suggestion = of('suggest').at(-1);
  pair.gen.dropped(suggestion.action, 0); // :Pair dismiss, or the user edited those lines
  assert.equal(pair.today().rows.at(-1).undo, false);
  assert.equal(of('gen').at(-1).state, 'done');
  pair.gen.list();
  assert.match(said().at(-1), /^12:00 {2}gen #1 · here · a sum · cancelled\n12:00 {2}gen #2 · here · z · 1 dropped\n/);
});
