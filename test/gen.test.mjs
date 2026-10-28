// /gen: requests with a number, a shape guessed by rule and confirmed, a conversation of their own, proposals shown at
// the user's pause, booked in the ledger as one line, and undone as one unit. A session on a store in memory, with a
// stand-in Partner and editor.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {existsSync, readFileSync, realpathSync, symlinkSync, lutimesSync, writeFileSync} from 'node:fs';
import {basename, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {CHECK_PROMPT, CONFLICT_PROMPT} from '../src/brief.mjs';
import {guessShape, parseGen} from '../src/gen.mjs';
import {expireTries, projectFolder, tryLine} from '../src/gen-tree.mjs';
import {sandboxWorks} from '../src/sandbox.mjs';
import {PairSession} from '../src/session.mjs';
import {openStore} from '../src/store.mjs';
import {scratch} from './temp.mjs';

const NOON = new Date(2026, 9, 28, 12, 0).getTime();
const SUM = 'function sum(a, b) {\n  return a + b\n}';

/**
 * A session in a scratch project with math.js. Each /gen request's turn runs the next of `turns` with its
 * conversation id; `editor(message)` answers what the session asks Neovim (reverts are fine by default).
 */
function genSession(turns = [], {editor = async () => null, limits, notes = null, askModel = null, store: given = null, root: at = null, genDir = null, sandbox = false} = {}) {
  const root = at ?? realpathSync(scratch('pair-gen-'));
  writeFileSync(join(root, 'math.js'), 'const x = 1\n\nexport {x}\n');
  writeFileSync(join(root, 'other.js'), 'const y = 2\n');
  if (notes !== null) writeFileSync(join(root, 'NOTES.md'), notes);
  const store = given ?? openStore(':memory:');
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
    genDir: genDir ?? scratch('pair-gen-data-'),
    genSandbox: sandbox,
    askModel,
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
  assert.match(turn.input, /The brief: the user's own idea in their words\. Follow it; never edit it\.\nGoal: add helpers/);
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
  const line = sent.find(message => message.text === 'gen #1 · here · 3 lines at math.js:1: A sum of two numbers; I guessed plain numbers, no BigInt.');
  assert.deepEqual(line.meta, {gen: 1, place: {file: 'math.js', line: 1}, suggestion: {action: suggestion.action, old: [], new: SUM.split('\n')}}, 'the chat shows it as a diff, which a takes');
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
  const first = pair.gen.request({text: 'a sample LRU cache to try'});
  await new Promise(resolve => setImmediate(resolve));
  const confirm = of('confirm').at(-1);
  assert.match(confirm.text, /^gen #1 · a sample to run: "sample"\. Shape\? y: try, or type here, file, scaffold; n cancels\.$/);
  assert.equal(confirm.hint, 'y: try · here, file, scaffold · n cancels');
  pair.answer(confirm.id, true);
  await first;
  assert.ok(said().includes('gen #1 · try · nothing proposed.'), 'y took the guess, and it ran');

  const second = pair.gen.request({text: 'a migration for orders'});
  await new Promise(resolve => setImmediate(resolve));
  pair.answer(of('confirm').at(-1).id, false, undefined, 'n');
  await second;
  assert.equal(said().filter(text => text === 'gen #2 cancelled.').length, 1, 'said once');

  const third = pair.gen.request({text: 'a migration for orders'});
  await new Promise(resolve => setImmediate(resolve));
  pair.answer(of('confirm').at(-1).id, false, undefined, 'scaffold');
  await third;
  assert.ok(said().includes('gen #3 · scaffold · nothing proposed.'), 'a shape word takes that shape');
  assert.equal(pair.today().rows.filter(row => row.label === 'generated').length, 2, 'a request that never ran is not booked');

  // A shape typed is never asked; from the chat, the Neovim the user works in gives the place.
  const before = of('confirm').length;
  await pair.gen.request({text: 'here x times two'});
  assert.equal(of('confirm').length, before);
  assert.equal(pair.today().rows.filter(row => row.label === 'generated').at(-1).place.line, 2);
});

test('from Neovim the shape question is a dialog there; one request runs at a time and the next waits', async () => {
  let release;
  const {root, pair, of, said, asked} = genSession([() => new Promise(resolve => { release = resolve; }), async () => 'second done']);
  const place = {file: join(root, 'math.js'), line: 1};
  const first = pair.gen.request({text: 'a sum function', place, from: 'editor'});
  await until(() => of('gen_ask').length);
  const ask = of('gen_ask').at(-1);
  assert.deepEqual({kind: ask.kind, title: ask.title, gen: ask.gen}, {kind: 'shape', title: 'gen #1 · at the cursor. Shape?', gen: 1});
  assert.deepEqual(ask.choices.map(choice => [choice.shape, choice.guessed, choice.built]), [['here', true, true], ['file', false, true], ['scaffold', false, true], ['try', false, true]]);
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

test('a request is told where its mark is when it starts; /undo of code edited since says it could not undo it', async () => {
  let input;
  const {root, pair, of, said, reverts} = genSession([async (conversation, pair) => {
    await tool(pair, conversation, 'propose', {file: 'math.js', line: 3, endLine: 3, insert: true, text: 'const s = 1', note: 's'});
    return 's';
  }], {editor: async message => (message.type === 'gen_where' ? {file: join(root, 'math.js'), line: 3} : null)});
  pair.partner.ask = (ask => async (conversation, text, options) => { input = text; return ask(conversation, text, options); })(pair.partner.ask);
  await pair.gen.request({text: 'here s', place: {file: join(root, 'math.js'), line: 1}, from: 'editor'});
  assert.match(input, /cursor is on line 3 of math\.js/, 'the mark moved from line 1 to 3 meanwhile');
  const suggestion = of('suggest').at(-1);
  await pair.applied(suggestion.action, ['a'], ['a', 'const s = 1'], {piece: 0, from: 4, to: 4});
  pair.requestEditor = async message => (message.type === 'revert' ? (reverts.push(message), {error: 'you changed those lines since'}) : null);
  await pair.undoLast();
  await pair.undoLast();
  assert.deepEqual(said().slice(-2), Array(2).fill('Could not undo gen #1. Not changed: math.js: you changed those lines since.'));
  assert.equal(pair.today().rows.at(-1).state, 'applied');
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

const NOTES = '# Helpers\n\nNumbers are plain: no BigInt.\nEvery helper is pure.\n';
const BIGINT = JSON.stringify([{source: 'note', line: 3, quote: 'no BigInt', brief_says: 'plain numbers', asked: 'BigInt'}]);

/** A stand-in for the model's one answers: `conflict` and `check` by prompt; each call is kept in `calls`. */
function briefModel({conflict = '[]', check = '[]'} = {}) {
  const calls = [];
  const ask = async (prompt, content) => {
    calls.push({prompt: prompt === CONFLICT_PROMPT ? 'conflict' : prompt === CHECK_PROMPT ? 'check' : 'other', content});
    return prompt === CONFLICT_PROMPT ? (typeof conflict === 'function' ? conflict(content) : conflict) : check;
  };
  return {ask, calls};
}

const sumTurn = text => async (conversation, pair) => {
  await tool(pair, conversation, 'propose', {file: 'math.js', line: 1, endLine: 1, insert: true, text, note: 'sum'});
  return 'A sum.';
};

test('every request runs against the brief: NOTES.md by default, said once; the model reads it, numbered', async () => {
  const model = briefModel();
  const {root, pair, asked, said} = genSession([sumTurn(SUM), sumTurn(SUM)], {notes: NOTES, askModel: model.ask});
  const place = {file: join(root, 'math.js'), line: 1};
  await pair.gen.request({text: 'here a sum function', place, from: 'editor'});
  await pair.gen.request({text: 'here another', place, from: 'editor'});
  assert.deepEqual(said().filter(text => /runs against the brief/.test(text)), [
    'gen #1 runs against the brief: NOTES.md + goal "add helpers". /brief <note> pins another note; /brief off leaves it out.',
  ], 'said once, for the first request');
  assert.match(asked[0].input, /Goal: add helpers\nNote NOTES\.md:\n1: # Helpers\n2: \n3: Numbers are plain: no BigInt\.\n4: Every helper is pure\./);
  assert.deepEqual(model.calls.map(call => call.prompt), ['conflict', 'check', 'conflict', 'check']);
  assert.match(model.calls[0].content, /The request: "a sum function"$/);
  assert.match(model.calls[1].content, /Piece 1, for math\.js:1:\n1: function sum\(a, b\) \{/);
  assert.equal(pair.today().rows[0].data?.brief ?? pair.store.action(pair.today().rows[0].id).data.brief, 'NOTES.md + goal "add helpers"');
});

test('a request against the brief asks first in the chat: y goes as asked and is not asked again, n follows the brief', async () => {
  const model = briefModel({conflict: content => (/BigInt/.test(content.split('The request:')[1]) ? BIGINT : '[]')});
  const {root, pair, asked, of, said} = genSession([sumTurn(SUM), sumTurn(SUM), sumTurn(SUM)], {notes: NOTES, askModel: model.ask});
  const editor = {file: join(root, 'math.js'), line: 1};
  pair.gen.placeOf = async request => { request.file = editor.file; request.place = editor; return true; }; // the chat's Neovim, at line 1

  const first = pair.gen.request({text: 'here a sum with BigInt'});
  await until(() => of('confirm').length);
  const confirm = of('confirm').at(-1);
  assert.equal(confirm.text, 'gen #1 · the brief says plain numbers:\n│ "Numbers are plain: no BigInt." NOTES.md:3\nBigInt anyway?');
  assert.equal(confirm.hint, 'y as asked · n follow the brief (plain numbers) · e open NOTES.md:3');
  assert.equal(asked.length, 0, 'nothing generates before the answer');
  pair.answer(confirm.id, true);
  await first;
  assert.ok(said().includes('gen #1: as asked, BigInt, against NOTES.md:3. Pair does not ask about that line again this session.'));
  assert.match(asked[0].input, /The user chose the request over the brief's "Numbers are plain: no BigInt\.": do as asked there\./);
  const row = pair.store.actions(root, 0).find(action => action.kind === 'generated');
  assert.deepEqual(row.data.asAsked, {key: 'note:numbers are plain: no bigint.', source: 'note', line: 3, text: 'Numbers are plain: no BigInt.'});

  await pair.gen.request({text: 'here a product with BigInt'});
  assert.equal(of('confirm').length, 1, 'that line is not asked about again');
  assert.equal(asked.length, 2);

  // Another session in the same project (the daemon restarted): the exception is this session's, so it asks again.
  const conflict = model.calls.filter(call => call.prompt === 'conflict').length;
  assert.equal(conflict, 2);
  pair.gen.exceptions.clear();
  const third = pair.gen.request({text: 'here a max with BigInt'});
  await until(() => of('confirm').length === 2);
  pair.answer(of('confirm').at(-1).id, false, undefined, 'n');
  await third;
  assert.ok(said().includes('gen #3 follows the brief: plain numbers (NOTES.md:3).'));
  assert.match(asked[2].input, /Where the request says BigInt, the user chose the brief: plain numbers \("Numbers are plain: no BigInt\."\)\./);
});

test('e opens the brief at the line and ends the request; from Neovim the question is a dialog of three choices', async () => {
  const model = briefModel({conflict: BIGINT});
  const {root, pair, asked, of, said} = genSession([], {notes: NOTES, askModel: model.ask});
  const place = {file: join(root, 'math.js'), line: 1};
  pair.gen.placeOf = async request => { request.file = place.file; request.place = place; return true; };
  const chat = pair.gen.request({text: 'here a BigInt sum'});
  await until(() => of('confirm').length);
  pair.answer(of('confirm').at(-1).id, false, undefined, 'e');
  await chat;
  assert.deepEqual(of('open').map(({file, line, ask}) => ({file, line, ask})), [{file: join(root, 'NOTES.md'), line: 3, ask: false}]);
  assert.ok(said().includes('gen #1 cancelled: NOTES.md:3 is open in Neovim. Change the brief or the request, then /gen again.'));
  assert.equal(asked.length, 0);

  const fromEditor = pair.gen.request({text: 'here a BigInt sum', place, from: 'editor'});
  await until(() => of('gen_ask').length);
  const ask = of('gen_ask').at(-1);
  assert.deepEqual({kind: ask.kind, title: ask.title, quote: ask.quote, place: ask.place, choices: ask.choices}, {
    kind: 'brief', title: 'gen #2 · the brief says plain numbers', quote: 'Numbers are plain: no BigInt.', place: 'NOTES.md:3',
    choices: [
      {key: 'n', what: 'follow the brief: plain numbers'},
      {key: 'y', what: 'as asked: BigInt'},
      {key: 'e', what: 'open NOTES.md:3', file: join(root, 'NOTES.md'), line: 3},
    ],
  });
  assert.equal(of('confirm').length, 1, 'not asked in the chat as well');
  assert.ok(said().includes('gen #2 · the brief says plain numbers: "Numbers are plain: no BigInt." NOTES.md:3. BigInt anyway? (answer in Neovim)'));
  pair.gen.answer(2, ask.id, 'e'); // Neovim opened the note itself
  await fromEditor;
  assert.equal(of('open').length, 1);
  assert.equal(of('gen').at(-1).state, 'cancelled');
});

test('the debrief says where the code goes against the brief and what it guessed, only what holds up', async () => {
  const check = JSON.stringify([
    {kind: 'contradicts', source: 'note', line: 4, quote: 'Every helper is pure', piece: 1, piece_line: 2, text: 'logs to the console'},
    {kind: 'contradicts', source: 'note', line: 3, quote: 'floats are fine', piece: 1, piece_line: 1, text: 'invented'},
    {kind: 'contradicts', source: 'note', line: 3, quote: 'no BigInt', piece: 4, piece_line: 1, text: 'no such piece'},
    {kind: 'guessed', text: 'the function is named sum'},
  ]);
  const model = briefModel({check});
  const code = 'function sum(a, b) {\n  console.log(a, b)\n  return a + b\n}';
  const {root, pair, of, said} = genSession([sumTurn(code)], {notes: NOTES, askModel: model.ask});
  await pair.gen.request({text: 'here a sum', place: {file: join(root, 'math.js'), line: 1}, from: 'editor'});
  const lines = ['≠ brief "Every helper is pure." NOTES.md:4 · math.js:3 logs to the console', '? guessed the function is named sum'];
  assert.ok(said().includes(`gen #1 · here · 4 lines at math.js:1: A sum.\n${lines.join('\n')}`));
  assert.deepEqual(of('gen_debrief').map(({gen, lines: shown}) => ({gen, lines: shown})), [{gen: 1, lines}], 'Neovim, where it was asked, says it too');
  const [row] = pair.today().rows;
  assert.equal(row.note, '4 lines proposed · ≠1');
  const detail = pair.store.action(row.id).detail;
  assert.deepEqual(detail.guessed, ['the function is named sum']);
  assert.equal(detail.contradicts[0].fileLine, 3);
});

test('without a model for the checks, or with an empty brief, a request asks nothing and checks nothing', async () => {
  const model = briefModel({conflict: BIGINT});
  const {root, pair, asked, of} = genSession([sumTurn(SUM)], {askModel: model.ask});
  pair.state.goal = null;
  await pair.gen.request({text: 'here a BigInt sum', place: {file: join(root, 'math.js'), line: 1}, from: 'editor'});
  assert.equal(model.calls.length, 0, 'no goal, no task, no NOTES.md: nothing to compare with');
  assert.equal(of('gen_ask').length, 0);
  assert.doesNotMatch(asked[0].input, /The brief/);

  const plain = genSession([sumTurn(SUM)], {notes: NOTES});
  await plain.pair.gen.request({text: 'here a BigInt sum', place: {file: join(plain.root, 'math.js'), line: 1}, from: 'editor'});
  assert.equal(plain.of('gen_ask').length, 0);
  assert.match(plain.asked[0].input, /Note NOTES\.md:/, 'the brief still goes with the request');
});

test('/brief shows the brief, pins a note, leaves it out; a pin lasts into the next session of the project', async () => {
  const {root, pair, store, said} = genSession([], {notes: NOTES});
  writeFileSync(join(root, 'plan.md'), 'Plan: one file.\n');
  assert.equal(await pair.gen.pinBrief({}), 'The brief: NOTES.md + goal "add helpers" (NOTES.md by default, gen.brief). /brief <note> pins another note; /brief off leaves the note out.');
  assert.equal(await pair.gen.pinBrief({file: 'nope.md'}), 'No file nope.md in the project to pin as the brief.');
  assert.equal(await pair.gen.pinBrief({file: join(root, 'plan.md')}), 'The brief: plan.md (pinned) + goal "add helpers". Every /gen runs against it; Pair never edits it.');
  assert.equal(said().at(-1), 'The brief: plan.md (pinned) + goal "add helpers". Every /gen runs against it; Pair never edits it.');
  assert.equal(store.lastBrief(root), 'plan.md');
  store.endSession(pair.id, null, NOON);
  const next = genSession([], {store, root});
  assert.equal(next.pair.gen.pin, 'plan.md', 'the next session has the pin');
  assert.equal(await next.pair.gen.pinBrief({off: true}), 'The brief leaves the note out now: goal "add helpers". /brief <note> pins one.');
  assert.equal(store.lastBrief(root), '');
  next.pair.state.goal = null;
  assert.equal(await next.pair.gen.pinBrief({}), 'The brief is empty: no goal, no board task, no note. /goal sets the goal; /brief <note> pins a note.');
});

// /gen file: new files as buffers to review in Neovim, taken by writing them.

/** Neovim for a file request: it makes the buffers (kept in `made`), and deletes a file /undo takes back. */
const filesEditor = (made, unwritten = []) => async message => {
  if (message.type === 'gen_files') made.push(message);
  if (message.type === 'gen_unwrite') unwritten.push(message);
  return ['gen_files', 'gen_unwrite'].includes(message.type) ? {ok: true} : null;
};

const MIGRATION = 'ALTER TABLE orders ADD COLUMN status TEXT;\nCREATE INDEX orders_status ON orders(status);';
const MATH_TEST = 'import {x} from \'./math.js\'\nconsole.assert(x === 1)';

/** A file request's turn: two new files, three drafts refused, and a change to a file that exists. */
const fileTurn = results => async (conversation, pair) => {
  results.push(await tool(pair, conversation, 'draft', {path: 'db/migrations/0007_status.sql', text: 'old draft', note: 'migration'}));
  results.push(await tool(pair, conversation, 'draft', {path: 'db/migrations/0007_status.sql', text: `${MIGRATION}\n`, note: 'migration'}));
  results.push(await tool(pair, conversation, 'draft', {path: 'math.test.js', text: MATH_TEST, note: 'its test'}));
  results.push(await tool(pair, conversation, 'draft', {path: 'math.js', text: 'x', note: 'n'}));
  results.push(await tool(pair, conversation, 'draft', {path: '../outside.js', text: 'x', note: 'n'}));
  results.push(await tool(pair, conversation, 'draft', {path: '.git/config', text: 'x', note: 'n'}));
  results.push(await tool(pair, conversation, 'draft', {path: 'math.js/inner.js', text: 'x', note: 'n'}));
  results.push(await tool(pair, conversation, 'propose', {file: 'other.js', line: 1, endLine: 1, insert: true, text: 'export {y}', note: 'export'}));
  return 'A migration and its test; I guessed TEXT for the status.';
};

test('/gen file: drafts of new files go to Neovim as buffers to review, checked at their real paths; a change to a file you have is a suggestion', async () => {
  const results = [];
  const made = [];
  const {root, pair, asked, of, said} = genSession([fileTurn(results)], {editor: filesEditor(made)});
  const checked = [];
  pair.checkGenerated = async (files, texts) => { checked.push({files, texts: Object.fromEntries(texts)}); return {label: 'npm test', mark: 'pass', text: '3 pass'}; };
  await pair.gen.request({text: 'file a migration adding status to orders, and its test'});

  assert.match(asked[0].input, /^\[gen\] gen #1, file\. The user asked: "a migration adding status to orders, and its test"\nWrite each new file with draft\(path, text\)/);
  assert.equal(of('gen_place').length, 0, 'a file request needs no cursor');
  assert.deepEqual(results, [
    'Drafted db/migrations/0007_status.sql, 1 line. Once you are done, the user reviews it as an unsaved buffer and writes it to db/migrations/0007_status.sql, or not.',
    'Drafted db/migrations/0007_status.sql anew, 2 lines. Once you are done, the user reviews it as an unsaved buffer and writes it to db/migrations/0007_status.sql, or not.',
    'Drafted math.test.js, 2 lines. Once you are done, the user reviews it as an unsaved buffer and writes it to math.test.js, or not.',
    'math.js exists already, and draft makes new files only. To change it, read it and call propose there: the user gets that as a suggestion.',
    'Cannot draft ../outside.js: not a path inside the project.',
    'Cannot draft .git/config: not a path inside the project.',
    'Cannot draft math.js/inner.js: not a path inside the project.',
    'Shown at other.js:1 as ghost lines, at the user\'s next pause in typing. They take it with one key, or not; nothing changes until then.',
  ]);

  const migration = join(root, 'db/migrations/0007_status.sql');
  const [files] = made;
  assert.deepEqual(files.files.map(({piece, file, name, text}) => ({piece, file, name, text})), [
    {piece: 0, file: migration, name: 'db/migrations/0007_status.sql', text: MIGRATION},
    {piece: 1, file: join(root, 'math.test.js'), name: 'math.test.js', text: MATH_TEST},
  ]);
  assert.equal(of('suggest').length, 1, 'only the change to other.js is a suggestion');
  assert.deepEqual(checked, [{files: [migration, join(root, 'math.test.js')], texts: {[migration]: `${MIGRATION}\n`, [join(root, 'math.test.js')]: `${MATH_TEST}\n`}}]);
  assert.ok(said().includes([
    'gen #1 · file · 2 new files to review: db/migrations/0007_status.sql +2, math.test.js +2: A migration and its test; I guessed TEXT for the status.',
    '1 change to files you have, as suggestions there: other.js:1',
    '✓ `npm test` on the unsaved buffers: 3 pass',
    'In Neovim, :w in one writes it to its path; :Pair gen list lists them.',
  ].join('\n')));
  assert.equal(of('gen').at(-1).state, 'ready');
  let [row] = pair.today().rows;
  assert.deepEqual([row.text, row.note], ['gen #1 · file · a migration adding status to orders, and its test', '2 files to review · 1 change']);

  // :Pair gen list, and what a Neovim that connects gets back.
  let [listed] = pair.gen.review().requests;
  assert.deepEqual(listed.files.map(({name, lines, state, text}) => [name, lines, state, text]), [
    ['db/migrations/0007_status.sql', 2, 'proposed', MIGRATION], ['math.test.js', 2, 'proposed', MATH_TEST],
  ]);
  assert.deepEqual(listed.check, {label: 'npm test', mark: 'pass', text: '3 pass'});
  assert.deepEqual(listed.changes, [{name: 'other.js', line: 1, state: 'proposed'}]);
  assert.deepEqual(pair.gen.reopen().map(message => [message.reopen, message.files.length]), [[true, 2]]);

  // :w in one takes it, as you had it then; d drops the other.
  pair.gen.fileTaken(row.id, 0, `${MIGRATION}\n-- mine\n`);
  assert.ok(said().includes('gen #1: db/migrations/0007_status.sql written, taken; 1 more to review. /undo takes back the request.'));
  pair.gen.dropped(row.id, 1);
  assert.ok(said().includes('gen #1: math.test.js dropped.'));
  [row] = pair.today().rows;
  assert.equal(row.state, 'applied');
  [listed] = pair.gen.review().requests;
  assert.deepEqual(listed.files.map(({state, text}) => [state, text]), [['taken', undefined], ['dropped', undefined]], 'no text once it is not to review');
  assert.deepEqual(pair.gen.reopen(), []);
});

test('/undo of a file request deletes a file written from it while it is as written; again makes it a buffer to review again', async () => {
  const made = [];
  const unwritten = [];
  const {pair, of, said, root} = genSession([fileTurn([])], {editor: filesEditor(made, unwritten)});
  await pair.gen.request({text: 'file a migration'});
  const [row] = pair.today().rows;
  pair.gen.fileTaken(row.id, 0, `${MIGRATION}\n`);
  await pair.undoLast();
  assert.deepEqual(unwritten.map(({file, text}) => ({file, text})), [{file: join(root, 'db/migrations/0007_status.sql'), text: `${MIGRATION}\n`}]);
  assert.ok(of('gen_drop').some(message => message.gen === 1), 'what was not taken goes from Neovim');
  assert.ok(said().includes('Undid gen #1: took back 1 piece, 1 file you wrote from it deleted.'));
  assert.equal(pair.today().rows[0].state, 'undone');
  assert.deepEqual(pair.store.action(row.id).detail.pieces.map(piece => piece.state), ['undone', 'dropped', 'dropped']);

  await pair.undo(row.id);
  assert.ok(said().includes('Made gen #1 again: 1 piece, 1 file to review again.'));
  assert.deepEqual(made.at(-1).files.map(file => file.name), ['db/migrations/0007_status.sql']);
});

test('a file request outlives a daemon restart: its files to review go to Neovim again, and are taken or logged from the ledger', async () => {
  const check = JSON.stringify([
    {kind: 'contradicts', source: 'note', line: 3, quote: 'no BigInt', piece: 1, piece_line: 1, text: 'uses BigInt for the status'},
    {kind: 'guessed', text: 'the status is TEXT'},
  ]);
  const made = [];
  const first = genSession([fileTurn([])], {notes: NOTES, askModel: briefModel({check}).ask, editor: filesEditor(made)});
  await first.pair.gen.request({text: 'file a migration'});
  const [marks] = made.map(message => message.files[0].marks);
  assert.deepEqual(marks, [{line: 1, text: '≠ brief "Numbers are plain: no BigInt." NOTES.md:3 · uses BigInt for the status'}], 'the ≠ brief line, in the buffer');
  first.store.endSession(first.pair.id, null, NOON);

  const after = genSession([], {store: first.store, root: first.root});
  const [reopened] = after.pair.gen.reopen();
  assert.deepEqual(reopened.files.map(file => [file.name, file.text]), [['db/migrations/0007_status.sql', MIGRATION], ['math.test.js', MATH_TEST]]);
  assert.equal(reopened.files[0].marks.length, 1);
  const [listed] = after.pair.gen.review().requests;
  assert.deepEqual([listed.contradicts.length, listed.guessed], [1, ['the status is TEXT']]);

  after.pair.gen.fileTaken(listed.action, 1, `${MATH_TEST}\n`);
  assert.deepEqual(after.pair.gen.reopen()[0].files.map(file => file.name), ['db/migrations/0007_status.sql']);

  // Alt-d on a ? guessed line logs it next to the brief's note, in the buffer, for the user to save.
  await after.pair.gen.decide(listed.action, 0);
  const logged = after.of('decision_log').at(-1);
  assert.equal(logged.file, join(first.root, 'decisions.md'));
  assert.match(logged.text, /## \d{4}-\d\d-\d\d · The status is TEXT\n\n- Status: decided\n- Where: db\/migrations\/0007_status\.sql:1\n- Asked: "gen #1: a migration"/);
  assert.ok(after.said().includes('Logged in decisions.md: The status is TEXT. Save it to keep it.'));
});

/** Pair's pane, for real: each command line runs in bash in `cwd`, as the pane's shell would run it. */
const bashPane = (cwd, ran = []) => ({
  run: command => new Promise(resolve => {
    ran.push(command);
    execFile('bash', ['-c', command], {cwd}, (error, stdout, stderr) => resolve({exit: error ? error.code ?? 1 : 0, output: stdout + stderr, timedOut: false}));
  }),
});

const LRU = 'const cache = new Map()\ncache.set("a", 1)\nconsole.log("get a:", cache.get("a"))';

test('/gen try: the sample in a folder of its own outside the project, run there, opened in a split, run again, read in the chat, /keep moves it in', async () => {
  const results = [];
  const made = [];
  const unwritten = [];
  const genDir = realpathSync(scratch('pair-gen-data-'));
  let of;
  const {root, pair, asked, of: sentOf, said, clock} = genSession([async (conversation, pair) => {
    results.push(await tool(pair, conversation, 'write', {path: 'lru.js', text: LRU}));
    results.push(await tool(pair, conversation, 'write', {path: 'package.json', text: '{"type": "module"}'}));
    results.push(await tool(pair, conversation, 'write', {path: '../escape.js', text: 'x'}));
    results.push(await tool(pair, conversation, 'draft', {path: 'lru.js', text: 'x', note: 'x'}));
    const running = tool(pair, conversation, 'run', {command: 'node lru.js'});
    await until(() => of('confirm').length); // no sandbox in this pane: it asks, as Scout does
    pair.answer(of('confirm').at(-1).id, true);
    results.push(await running);
    return 'A Map keeps the order; I guessed plain JavaScript, no class.';
  }], {genDir, editor: async message => {
    if (message.type === 'gen_files') { made.push(message); return {ok: true}; }
    if (message.type === 'gen_unwrite') { unwritten.push(message); return {ok: true}; }
    return null;
  }});
  of = sentOf;
  const ran = [];
  pair.scout = bashPane(root, ran);
  await pair.gen.request({text: 'try a small LRU cache'});

  const dir = join(projectFolder(genDir, root), 'try', '1');
  assert.equal(basename(projectFolder(genDir, root)).replace(/-[0-9a-f]{8}$/, ''), basename(root), 'named after the project, and a hash of its path');
  assert.match(asked[0].input, new RegExp(`^\\[gen\\] gen #1, try\\. The user asked: "a small LRU cache"\\nA sample to read and run, in a folder of its own outside the project: ${dir}\\n`));
  assert.match(asked[0].input, /run\(command\), which runs in that folder in a sandbox where only the folder is writable and it has no network/);
  assert.deepEqual(results.slice(0, 4), [
    'Wrote lru.js in your folder, 3 lines. run runs it there.',
    'Wrote package.json in your folder, 1 line. run runs it there.',
    `Cannot write ../escape.js: not a path inside your folder ${dir}.`,
    'This request is /gen try: write its files in your folder with write.',
  ]);
  assert.equal(results[4], 'exit 0\nget a: 1\n');
  assert.equal(readFileSync(join(dir, 'lru.js'), 'utf8'), `${LRU}\n`, 'written at once: the folder is Pair\'s');
  assert.equal(existsSync(join(root, 'lru.js')), false, 'nothing in the project');
  assert.equal(ran[0], `(cd ${dir} && bash -c 'node lru.js')`, 'in its folder, in a subshell; this pane has no sandbox');

  const [opened] = of('gen_try');
  assert.deepEqual({...opened, files: undefined}, {
    via: 'editor', type: 'gen_try', gen: 1, dir, words: 'a small LRU cache', command: 'node lru.js', keep: 7, open: join(dir, 'lru.js'), files: undefined,
  });
  assert.deepEqual(opened.files.map(file => file.name), ['lru.js', 'package.json']);
  assert.ok(said().includes([
    'gen #1 · try · lru.js +3, package.json +1 · ✓ `node lru.js`: A Map keeps the order; I guessed plain JavaScript, no class.',
    'In Neovim: lru.js in a split, outside the project. Your run key runs it again; /keep <path> moves it into the project, as a buffer to review. The folder stays 7 days after it last changed or ran (/gen tries).',
  ].join('\n')));
  let [row] = pair.today().rows.filter(one => one.label === 'generated');
  assert.deepEqual([row.text, row.note, row.undo], ['gen #1 · try · a small LRU cache', '2 files in its folder · ✓ `node lru.js`', false], 'nothing to undo until something is kept');
  assert.equal(of('gen').at(-1).state, 'done');

  // An edit of it is none of the session's work: the Watcher never sees it.
  pair.receive({kind: 'edit', file: join(dir, 'lru.js'), text: 'x', at: clock.now});
  assert.equal(pair.state.edits.length, 0);

  // The user's questions in the chat read it.
  await pair.ask('why a Map?');
  assert.match(asked.at(-1).input, new RegExp(`The last /gen try, gen #1 \\("a small LRU cache"\\), is a sample outside the project, in ${dir}: lru.js, package.json\\.`));
  assert.equal(await tool(pair, 'main', 'read', {file: join(dir, 'lru.js')}), '1: const cache = new Map()\n2: cache.set("a", 1)\n3: console.log("get a:", cache.get("a"))\n4: ');
  assert.equal(await tool(pair, 'main', 'read', {file: dir}), 'lru.js\npackage.json');
  symlinkSync(root, join(dir, 'project'));
  assert.match(await tool(pair, 'main', 'read', {file: join(dir, 'project', 'math.js')}), /^Cannot read .*: not a file of gen #1's folder\.$/, 'not through a link out of it');

  // Changed and run again: the model's last command, by the user, in the pane.
  writeFileSync(join(dir, 'lru.js'), 'console.log("evicts b")\n');
  assert.equal(await pair.gen.rerun({file: join(dir, 'lru.js')}), 'gen #1 · ✓ `node lru.js`\nevicts b');
  assert.equal(ran.length, 2);

  // /keep: into the project as a buffer to review, opened; not over a file there, not outside it.
  await pair.gen.keep({path: 'math.js'});
  assert.ok(said().includes('gen #1: math.js exists already, and /keep makes a new file. /keep <another path>; or copy what you need from lru.js.'));
  await pair.gen.keep({path: '../out.js'});
  assert.ok(said().includes('gen #1: cannot keep lru.js as ../out.js, not a path inside the project.'));
  assert.equal(await pair.gen.keep({path: 'src/lru.js'}), 'gen #1: src/lru.js opened, unsaved, generated. :w takes it; u on gen #1 in :Pair today takes it back.');
  const [kept] = made;
  assert.deepEqual({open: kept.open, gen: kept.gen, files: kept.files.map(({name, text, note}) => ({name, text, note}))}, {
    open: true, gen: 1, files: [{name: 'src/lru.js', text: 'console.log("evicts b")', note: 'kept from lru.js'}],
  });
  assert.equal(existsSync(join(root, 'src')), false, 'unsaved: nothing on disk until :w');
  [row] = pair.today().rows.filter(one => one.label === 'generated');
  assert.deepEqual([row.note, row.undo], ['kept as src/lru.js', true]);
  const [listed] = pair.gen.review().requests;
  assert.deepEqual([listed.shape, listed.files.map(file => [file.name, file.state])], ['try', [['src/lru.js', 'proposed']]]);

  // :w takes it; /undo deletes what was written, the try folder stays until it expires.
  pair.gen.fileTaken(row.id, kept.files[0].piece, 'console.log("evicts b")\n');
  await pair.undoLast();
  assert.deepEqual(unwritten.map(message => message.file), [join(root, 'src/lru.js')]);
  assert.ok(existsSync(join(dir, 'lru.js')));

  // /gen tries lists it with its days left; after gen.keepTries days without a change, it goes.
  const [listedTry] = await pair.gen.tries();
  assert.deepEqual([listedTry.gen, listedTry.files, listedTry.left, listedTry.kept], [1, ['lru.js', 'package.json'], 7, ['src/lru.js']]);
  assert.match(await pair.gen.triesText(), /^gen #1 · a small LRU cache · lru\.js, package\.json · kept as src\/lru\.js · goes in 7 days\n {2}\//);
  assert.deepEqual(await expireTries(genDir, 7, Date.now() + 6 * 24 * 3600_000), []);
  // Run, it counts as changed: a try 6.5 days old that you run again has its 7 days again.
  const old = new Date(Date.now() - 6.5 * 24 * 3600_000);
  for (const file of ['', 'lru.js', 'package.json', 'project']) lutimesSync(join(dir, file), old, old);
  assert.equal((await pair.gen.tries())[0].left, 1);
  await pair.gen.rerun({});
  assert.equal((await pair.gen.tries())[0].left, 7, 'a run keeps it');
  assert.deepEqual(await expireTries(genDir, 7, Date.now() + 8 * 24 * 3600_000), [dir]);
  assert.equal(await pair.gen.keep({}), 'No /gen try to keep from: /gen try <what> makes one.');
  assert.equal(await pair.gen.rerun({}), 'No /gen try to run: /gen try <what> makes one.');
});

test('a try without the sandbox asks before a command that may write; a here or file request cannot run or write at all', async () => {
  const results = [];
  const {root, pair, of} = genSession([async (conversation, pair) => {
    const running = tool(pair, conversation, 'run', {command: 'node lru.js'});
    await until(() => of('confirm').length);
    pair.answer(of('confirm').at(-1).id, false);
    results.push(await running);
    results.push(await tool(pair, conversation, 'run', {command: 'curl https://example.com'}));
    return 'Not run.';
  }, async (conversation, pair) => {
    results.push(await tool(pair, conversation, 'run', {command: 'ls'}));
    results.push(await tool(pair, conversation, 'write', {path: 'x.js', text: 'x'}));
    return 'SILENT';
  }]);
  pair.scout = bashPane(root);
  await pair.gen.request({text: 'try node streams'});
  assert.match(of('confirm')[0].text, /^May I run `node lru\.js` in gen #1's folder, outside the project \(node runs a script that may change files\)\? There is no sandbox here\.$/);
  await pair.gen.request({text: 'file a config file'});
  assert.deepEqual(results, [
    'The user did not allow it. Do not run it another way.',
    'Refused: curl goes over the network. Do not try another way; tell the user.',
    'run works only in a /gen try or scaffold request, in its own folder. Here Pair checks your code once the user takes it: do not run anything.',
    'This request is /gen file: write works only in a /gen try or scaffold request. Call draft.',
  ]);
});

test('a try\'s run in the sandbox writes only its own folder: the project and the rest stay read-only', {skip: sandboxWorks() ? false : 'bubblewrap cannot make a sandbox here'}, async () => {
  // The project outside /tmp, which the sandbox replaces with an empty one: the write must fail for being read-only.
  const project = realpathSync(scratch('pair-try-project-', fileURLToPath(new URL('.', import.meta.url))));
  const dir = realpathSync(scratch('pair-try-folder-'));
  const line = tryLine(dir, `touch inside.txt; touch ${project}/outside.txt; echo done`, {sandboxed: true});
  assert.match(line, /^\(cd \S+ && bwrap .* --unshare-all --chdir \S+ bash -c /);
  const result = await bashPane(project).run(line);
  assert.match(result.output, /done/);
  assert.match(result.output, /outside\.txt.*Read-only file system/);
  assert.ok(existsSync(join(dir, 'inside.txt')));
  assert.equal(existsSync(join(project, 'outside.txt')), false);
});

test('a try never changes the project; files its runs made are its sample too; links in its way are refused', async () => {
  const results = [];
  const genDir = realpathSync(scratch('pair-gen-data-'));
  const {root, pair, of, said} = genSession([async (conversation, pair) => {
    results.push(await tool(pair, conversation, 'propose', {file: 'math.js', line: 1, endLine: 1, insert: true, text: 'x', note: 'x'}));
    results.push(await tool(pair, conversation, 'run', {command: 'printf "console.log(1)\\n" > made.js # by a run'}));
    return 'Made by a run.';
  }, async () => 'Nothing.'], {genDir, sandbox: false});
  pair.scout = bashPane(root);
  pair.allowed = async () => true;
  await pair.gen.request({text: 'try a thing'});
  assert.equal(results[0], 'This request is /gen try: it never changes the project. Write the sample in your folder with write.');
  assert.equal(results[1], 'exit 0\n(no output)', 'a comment in the command does not swallow the line');
  assert.deepEqual(of('suggest'), []);
  const dir = join(projectFolder(genDir, root), 'try', '1');
  assert.equal(of('gen_try')[0].open, join(dir, 'made.js'));
  assert.ok(said().some(text => text.startsWith('gen #1 · try · made.js +1 · ✓ `printf')));

  // A link in place of the file: /keep does not follow it.
  symlinkSync(join(root, 'math.js'), join(dir, 'leak.js'));
  assert.equal(await pair.gen.keep({file: join(dir, 'leak.js'), path: 'leak.js'}), 'gen #1: cannot keep leak.js, not a file of its folder.');

  // A link in place of the try folders (Scout may write there): the daemon neither makes nor deletes through it.
  const elsewhere = realpathSync(scratch('pair-elsewhere-'));
  const tries = join(projectFolder(genDir, root), 'try');
  const {rmSync} = await import('node:fs');
  rmSync(tries, {recursive: true});
  symlinkSync(elsewhere, tries);
  await pair.gen.request({text: 'try another'});
  assert.ok(said().some(text => /^gen #2: no folder for the try: a link on the way to .*: not made there\.$/.test(text)));
  assert.equal(existsSync(join(elsewhere, '2')), false);
  assert.deepEqual(await pair.gen.tries(), []);
});

test('a data folder behind a link still names a try\'s files by their folder', async () => {
  const real = realpathSync(scratch('pair-gen-real-'));
  const link = join(scratch('pair-gen-link-'), 'data');
  symlinkSync(real, link);
  const results = [];
  const {root, pair, said} = genSession([async (conversation, pair) => {
    results.push(await tool(pair, conversation, 'write', {path: 'main.js', text: 'console.log(1)'}));
    return 'One line.';
  }], {genDir: link});
  pair.scout = bashPane(root);
  await pair.gen.request({text: 'try one line'});
  assert.equal(results[0], 'Wrote main.js in your folder, 1 line. run runs it there.');
  assert.ok(said().some(text => text.startsWith('gen #1 · try · main.js +1 · not run: One line.')));
  assert.match(await pair.gen.keep({}), /^gen #1: main\.js (opened|kept)/);
});

const ADMIN = 'import {x} from \'../math.js\'\nexport const admin = () => x';

/** A scaffold's turn: a new file, a change by propose and one by write, reads and refusals, an install, a run. */
const scaffoldTurn = results => async (conversation, pair) => {
  results.push(await tool(pair, conversation, 'write', {path: 'admin/orders.js', text: ADMIN}));
  results.push(await tool(pair, conversation, 'propose', {file: 'math.js', line: 1, endLine: 1, insert: true, text: 'const z = 3', note: 'z'}));
  results.push(await tool(pair, conversation, 'write', {path: 'other.js', text: 'const y = 3'}));
  results.push(await tool(pair, conversation, 'read', {file: 'math.js'}));
  results.push(await tool(pair, conversation, 'read', {file: '.'}));
  results.push(await tool(pair, conversation, 'write', {path: '../outside.js', text: 'x'}));
  results.push(await tool(pair, conversation, 'write', {path: '.git/config', text: 'x'}));
  results.push(await tool(pair, conversation, 'draft', {path: 'new.js', text: 'x', note: 'x'}));
  results.push(await tool(pair, conversation, 'run', {command: 'npm install zod'}));
  results.push(await tool(pair, conversation, 'run', {command: 'printf "made\\n" > made.txt'}));
  return 'An admin page for orders; node admin/orders.js runs it. I guessed one file per page.';
};

test('/gen scaffold: built and run in a copy of the project, checked there; the debrief; kept a file at a time; x deletes the copy', async () => {
  const results = [];
  const made = [];
  const unwritten = [];
  const genDir = realpathSync(scratch('pair-gen-data-'));
  const {root, pair, asked, of, said, reverts} = genSession([scaffoldTurn(results)], {genDir, editor: filesEditor(made, unwritten)});
  const ran = [];
  pair.scout = bashPane(root, ran);
  pair.allowed = async () => true;
  pair.testRuns = {command: 'ls admin'}; // the project's command on save: the check
  pair.checkGenerated = async () => ({label: 'ls admin', mark: 'pass', text: 'passed'});
  writeFileSync(join(root, 'notes.txt'), 'on disk\n');
  await pair.gen.request({text: 'scaffold an admin page for orders'});

  const dir = join(projectFolder(genDir, root), '1');
  assert.match(asked[0].input, new RegExp(`^\\[gen\\] gen #1, scaffold\\. The user asked: "an admin page for orders"\\nYou build it in a copy of the project in Pair's data folder, at ${dir}, not in the project`));
  assert.match(asked[0].input, /in a sandbox where only the copy is writable and it has no network: install nothing/);
  assert.deepEqual(results.filter((_, i) => i !== 3 && i !== 4), [
    'Wrote admin/orders.js in the copy: a new file, 2 lines. run runs commands there.',
    'Changed math.js in the copy, below line 1: now +1 -0 against the project. read shows it as it is now.',
    'Wrote other.js in the copy: +1 -1 against the project. run runs commands there.',
    'Cannot write ../outside.js: not a file\'s path in the project.',
    'Cannot write .git/config: not a file\'s path in the project.',
    'This request is /gen scaffold: write its files in the copy with write, new or not.',
    'Not run: the copy has no network (gen.network), so nothing can be installed. The user is told to install it; go on without it, and say what needs it.',
    'exit 0\n(no output)',
  ]);
  assert.equal(results[3], '1: const x = 1\n2: const z = 3\n3: \n4: export {x}\n5: ', 'read sees the copy, with its change');
  assert.match(results[4], /^admin\/\nmath\.js\nnotes\.txt\nother\.js$/m);
  assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'on disk\n', 'a copy of the project');
  assert.equal(readFileSync(join(root, 'math.js'), 'utf8'), 'const x = 1\n\nexport {x}\n', 'the project is untouched');
  assert.equal(existsSync(join(root, 'admin')), false);
  assert.ok(ran.every(line => line.startsWith(`(cd ${dir} && `)), 'every run in the copy');

  // The debrief: what it made, where, the runs and the check, the files, what it could not install.
  const card = said().find(text => text.startsWith('gen #1 · scaffold'));
  const lines = card.split('\n');
  assert.match(lines[0], /^gen #1 · scaffold · 4 files, 2 of yours changed · \d+s: An admin page for orders; node admin\/orders\.js runs it\. I guessed one file per page\.$/);
  assert.equal(lines[1], `in Pair's copy ${dir} · ran ✓ \`printf "made\\n" > made.txt\``);
  assert.equal(lines[2], 'check ✓ `ls admin`: passed');
  assert.deepEqual(lines.slice(3, 7), [
    '│ + admin/orders.js  +2', '│ ~ math.js          +1 -0', '│ ~ other.js         +1 -1', '│ + made.txt         +1',
  ]);
  assert.equal(lines[7], 'not run: `npm install zod`: the copy has no network (gen.network), so install it yourself once you keep the files');
  assert.match(lines[8], /^In Neovim, :Pair gen list keeps them one at a time \(k\)/);
  assert.equal(of('gen_scaffold')[0].files, 4);
  assert.equal(of('gen').at(-1).state, 'ready');
  let [row] = pair.today().rows.filter(one => one.label === 'generated');
  assert.deepEqual([row.text, row.note], ['gen #1 · scaffold · an admin page for orders', '4 files · 2 of yours changed · ✓ ls admin']);

  // :Pair gen list shows the files of the copy.
  let [listed] = pair.gen.review().requests;
  assert.deepEqual([listed.shape, listed.dir, listed.mode, listed.deleted], ['scaffold', dir, 'copy', false]);
  assert.deepEqual(listed.tree.map(({name, state, isNew, added, removed}) => [name, state, isNew, added, removed]), [
    ['admin/orders.js', 'proposed', true, 2, 0], ['math.js', 'proposed', false, 1, 0], ['other.js', 'proposed', false, 1, 1], ['made.txt', 'proposed', true, 1, 0],
  ]);

  // /keep without a path, with several left, lists them.
  assert.match(await pair.gen.keep({}), /^gen #1: 4 files to keep: admin\/orders\.js, math\.js, other\.js, made\.txt\. \/keep <path> keeps one/);

  // A new file: a buffer to review, opened.
  assert.equal(await pair.gen.keep({path: 'admin/orders.js'}), 'gen #1: admin/orders.js opened, unsaved, generated. :w takes it.');
  assert.deepEqual(made.at(-1).files.map(({name, text, note}) => ({name, text, note})), [{name: 'admin/orders.js', text: ADMIN, note: 'from gen #1\'s copy'}]);
  assert.equal(made.at(-1).open, true);
  assert.equal(await pair.gen.keep({path: 'admin/orders.js'}), 'gen #1: admin/orders.js is kept already.');

  // A change to a file of yours: hunks as suggestions there, on your buffer as it is now.
  assert.equal(await pair.gen.keep({file: join(dir, 'math.js')}), 'gen #1: math.js: 1 change, shown there as suggestions; Alt-y (:Pair accept) takes each.');
  const [hunk] = of('suggest');
  assert.deepEqual({...hunk, action: undefined}, {
    via: 'editor', type: 'suggest', file: join(root, 'math.js'), line: 1, endLine: 1, insert: true, text: 'const z = 3',
    note: 'gen #1 · math.js', action: undefined, piece: hunk.piece, gen: 1, origin: 'gen:#1', aim: true,
  });
  // You changed other.js since the copy was made: that hunk is not shown.
  writeFileSync(join(root, 'other.js'), 'const y = 22\n');
  assert.equal(await pair.gen.keep({path: 'other.js'}), `gen #1: other.js: no change shown. 1 change not shown: you changed those lines since; copy it from ${join(dir, 'other.js')}.`);
  pair.gen.dropTree(row.id, 3);
  await until(() => said().includes('gen #1: made.txt dropped.'));

  // Alt-y takes the hunk; :w the new file.
  await pair.applied(hunk.action, ['const x = 1', '', 'export {x}', ''], ['const x = 1', 'const z = 3', '', 'export {x}', ''], {piece: hunk.piece, from: 2, to: 2});
  pair.gen.fileTaken(row.id, made.at(-1).files[0].piece, `${ADMIN}\n`);
  [listed] = pair.gen.review().requests;
  assert.deepEqual(listed.tree.map(({name, state, kept, hunks, taken}) => [name, state, kept !== undefined, hunks, taken]), [
    ['admin/orders.js', 'kept', true, undefined, undefined], ['math.js', 'kept', false, 1, 1], ['other.js', 'kept', false, undefined, undefined], ['made.txt', 'dropped', false, undefined, undefined],
  ]);
  assert.deepEqual(listed.files.map(({name, state}) => [name, state]), [['admin/orders.js', 'taken']]);

  // r: the check again; x: the copy goes, and what was not kept with it.
  assert.equal(await pair.gen.checkAgain({action: row.id}), 'gen #1 · ✓ `ls admin` in the copy: passed');
  assert.equal(await pair.gen.deleteCopy({action: row.id}), 'gen #1: its copy is deleted. 3 files kept from it stay.');
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(`${dir}.json`), false, 'and its manifest');
  assert.ok(of('gen_copy_gone').some(message => message.dir === dir));
  [row] = pair.today().rows.filter(one => one.label === 'generated');
  assert.equal(row.note, '3 of 4 files kept · copy deleted');
  assert.equal(await pair.gen.deleteCopy({action: row.id}), 'gen #1: its copy is deleted already.');
  assert.equal(await pair.gen.keep({}), 'No /gen try to keep from: /gen try <what> makes one.', 'nothing left to keep from');

  // /undo takes back what was kept: the hunk out of the buffer, the file written from it deleted.
  await pair.undoLast();
  assert.deepEqual(reverts.map(message => message.file), [join(root, 'math.js')]);
  assert.deepEqual(unwritten.map(message => message.file), [join(root, 'admin/orders.js')]);
});

test('a scaffold is held by its limits; the copy has your unsaved buffers; cancelled, it goes; unused, it expires', async () => {
  const results = [];
  const genDir = realpathSync(scratch('pair-gen-data-'));
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const {root, pair, asked, said} = genSession([async (conversation, pair) => {
    results.push(await tool(pair, conversation, 'read', {file: 'math.js'}));
    results.push(await tool(pair, conversation, 'write', {path: 'a.js', text: 'a\nb'}));
    results.push(await tool(pair, conversation, 'write', {path: 'b.js', text: 'b'}));
    results.push(await tool(pair, conversation, 'write', {path: 'a.js', text: 'a\nb\nc\nd'}));
    results.push(await tool(pair, conversation, 'write', {path: 'a.js', text: 'a'}));
    return 'Two files.';
  }, async () => { await held; return 'Never done.'; }], {
    genDir, limits: {files: 2, lines: 3, commands: 8, minutes: 10},
    editor: async message => (message.type === 'buffers' ? {buffers: [{file: join(root, 'math.js'), text: 'const x = 41\n'}]} : null),
  });
  pair.scout = bashPane(root);
  await pair.gen.request({text: 'scaffold two files'});
  assert.match(asked[0].input, /At most 2 files and 3 lines written \(gen\.limits\)\./);
  assert.equal(results[0], '1: const x = 41\n2: ', 'the copy has your unsaved buffer');
  assert.deepEqual(results.slice(1), [
    'Wrote a.js in the copy: a new file, 2 lines. run runs commands there.',
    'Wrote b.js in the copy: a new file, 1 line. run runs commands there.',
    'That is more than 3 lines for this request (gen.limits.lines): write less, or say what is left.',
    'Wrote a.js in the copy: a new file, 1 line. run runs commands there.',
  ]);
  const one = join(projectFolder(genDir, root), '1');
  assert.ok(existsSync(one));

  // Cancelled while it works: its copy goes.
  const second = pair.gen.request({text: 'scaffold another'});
  const two = join(projectFolder(genDir, root), '2');
  await until(() => existsSync(two) && pair.gen.running?.n === 2);
  pair.gen.cancel();
  release();
  await second;
  await until(() => !existsSync(two));
  assert.ok(said().includes('gen #2 cancelled.'));

  // A copy not used for gen.keepTries days goes, as a try does.
  assert.deepEqual(await expireTries(genDir, 7, Date.now() + 6 * 24 * 3600_000), []);
  assert.deepEqual(await expireTries(genDir, 7, Date.now() + 8 * 24 * 3600_000), [one]);
  assert.equal(existsSync(`${one}.json`), false);
});

test('/gen scaffold --branch: a git worktree on a branch gen/<n>; gen.scaffold "worktree" by default, --copy over it; deleted with its branch', async () => {
  const genDir = realpathSync(scratch('pair-gen-data-'));
  const results = [];
  const {root, pair, asked, said} = genSession([async (conversation, pair) => {
    results.push(await tool(pair, conversation, 'write', {path: 'admin.js', text: 'export const admin = 1'}));
    results.push(await tool(pair, conversation, 'write', {path: 'math.js', text: 'const x = 2\n\nexport {x}'}));
    return 'On a branch.';
  }, async (conversation, pair) => {
    results.push(await tool(pair, conversation, 'write', {path: 'c.js', text: 'c'}));
    return 'In the copy.';
  }], {genDir});
  const git = (...args) => new Promise((resolve, reject) => execFile('git', args, {cwd: root}, (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))));
  await git('init', '-q');
  await git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  await git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start');
  writeFileSync(join(root, 'math.js'), 'const x = 1\n\nexport {x}\n// uncommitted\n');
  pair.scout = bashPane(root);
  await pair.gen.request({text: 'scaffold --branch an admin'});
  const dir = join(projectFolder(genDir, root), '1');
  assert.match(asked[0].input, new RegExp(`You build it in a git worktree of the project on a new branch gen/1, at ${dir}`));
  assert.equal(await git('branch', '--list', '--format=%(refname:short)', 'gen/1'), 'gen/1');
  assert.ok(existsSync(join(dir, '.git')), 'a worktree');
  assert.equal(readFileSync(join(dir, 'math.js'), 'utf8'), 'const x = 2\n\nexport {x}\n');
  const card = said().find(text => text.startsWith('gen #1 · scaffold'));
  assert.match(card, new RegExp(`\\nin the worktree ${dir}, branch gen/1\\n`));
  assert.match(card, /│ ~ math\.js {3}\+1 -1/, 'against HEAD, which the worktree starts from');
  const [listed] = pair.gen.review().requests;
  assert.deepEqual([listed.mode, listed.branch], ['worktree', 'gen/1']);
  assert.deepEqual(await expireTries(genDir, 7, Date.now() + 30 * 24 * 3600_000), [], 'a worktree does not expire');

  // A branch of that name already: it says so.
  await git('branch', 'gen/2');
  await pair.gen.request({text: 'scaffold --branch another'});
  assert.ok(said().includes('gen #2: no worktree for the scaffold: the branch gen/2 exists already.'));

  // gen.scaffold "worktree" makes it the default; --copy goes in Pair's copy anyway.
  pair.gen.scaffold = 'worktree';
  await pair.gen.request({text: 'scaffold --copy a third'});
  assert.ok(existsSync(join(projectFolder(genDir, root), '3', 'c.js')));
  assert.equal(existsSync(join(projectFolder(genDir, root), '3', '.git')), false);

  // x: the worktree goes, and its branch, which has no commit of yours.
  const row = pair.today().rows.find(one => one.text === 'gen #1 · scaffold · an admin');
  assert.equal(await pair.gen.deleteCopy({action: row.id}), 'gen #1: its worktree is deleted, and its branch gen/1. Nothing of it was kept.');
  assert.equal(existsSync(dir), false);
  assert.equal(await git('branch', '--list', '--format=%(refname:short)', 'gen/1'), '');
  assert.equal(results.length, 3);
});

test('the flags make a scaffold; scaffold is guessed only with a question', () => {
  assert.equal(guessShape('an admin page for orders, wired into the router').shape, 'scaffold');
  assert.deepEqual(parseGen('scaffold --branch an admin'), {shape: 'scaffold', words: '--branch an admin'});
});
