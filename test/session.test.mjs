import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {PairSession} from '../src/session.mjs';

function session({score = async () => ({value: 9, reason: 'worth it'}), answer = 'Line 2 is off.'} = {}) {
  const asked = [];
  const sent = [];
  const store = {addMessage() {}, setGoal() {}, setLevel() {}, endSession() {}, addRemark: () => 1, dropRemark() {}};
  const partner = {ask: async (_id, input) => { asked.push(input); return answer; }};
  const pair = new PairSession({
    record: {id: 1, root: '/project', conversation_id: 7, goal: 'fix it', level: 'normal'},
    store, partner, score, typingPauseMs: 2000,
    notify: (role, message) => sent.push({role, ...message}),
    requestEditor: async () => null,
    now: () => 100_000,
  });
  return {pair, asked, sent};
}

const failTwice = pair => {
  for (const at of [90_000, 95_000]) pair.receive({kind: 'command_end', cmd: 'npm test', exit: 1, output: 'Error: boom', at});
};

test('overlapping ticks raise one remark, and its trigger fires once', async () => {
  let release;
  const slowScore = () => new Promise(resolve => { release = () => resolve({value: 9, reason: 'worth it'}); });
  const {pair, asked} = session({score: slowScore});
  failTwice(pair);
  const first = pair.tick();
  const second = pair.tick(); // while the Watcher still thinks about the first
  release();
  await Promise.all([first, second]);
  await pair.tick();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^\[watch\] repeated_error:/);
});

test('a SILENT answer reaches nobody and costs no budget', async () => {
  const {pair, sent} = session({answer: 'SILENT'});
  failTwice(pair);
  await pair.tick();
  assert.deepEqual(sent.filter(message => message.role === 'chat'), []);
  assert.equal(pair.budget.allows(100_000).ok, true);
});

test('a delivered remark spends the budget', async () => {
  const {pair, sent} = session();
  failTwice(pair);
  await pair.tick();
  assert.ok(sent.some(message => message.text === 'Line 2 is off.'));
  assert.equal(pair.budget.allows(100_000).ok, false);
});

test('a say of SILENT is silence, also with an explanation before it', async () => {
  const {pair, sent} = session();
  assert.equal(pair.say('SILENT'), 'shown');
  assert.equal(pair.say('src/ws.mjs is the goal\'s own file, so no drift — SILENT.'), 'shown');
  assert.deepEqual(sent, []);
});

test('an unasked remark that arrives while the user types again waits for their next pause', async () => {
  let clock = 100_000;
  const sent = [];
  const pair = new PairSession({
    record: {id: 1, root: process.cwd(), conversation_id: 7, goal: 'fix it', level: 'normal'},
    store: {addMessage() {}, addRemark: () => 1, dropRemark() {}},
    // The Partner takes 6 s; the user types again half a second before it answers.
    partner: {ask: async () => {
      clock += 5500;
      pair.receive({kind: 'typing'});
      clock += 500;
      await pair.point({file: 'package.json', line: 1, note: 'look here'});
      return 'The name is wrong.';
    }},
    score: async () => ({value: 9, reason: 'worth it'}),
    typingPauseMs: 2000,
    notify: (role, message) => sent.push({role, at: clock, ...message}),
    requestEditor: async () => null,
    now: () => clock,
  });
  pair.receive({kind: 'typing', at: 90_000});
  pair.receive({kind: 'command_end', cmd: 'npm test', exit: 1, output: 'Error: boom', at: 95_000});
  pair.receive({kind: 'command_end', cmd: 'npm test', exit: 1, output: 'Error: boom', at: 96_000});

  await pair.tick();
  clock += 1000; // still within the typing pause
  await pair.tick();
  assert.deepEqual(sent, [], 'nothing is shown while the user types');

  clock += 2000;
  await pair.tick();
  const lastKey = 105_500;
  assert.deepEqual(sent.map(message => [message.role, message.type, message.text]), [
    ['editor', 'point', undefined],
    ['chat', 'message', 'package.json:1 look here'],
    ['chat', 'message', 'The name is wrong.'],
    ['chat', 'remark', undefined],
    ['editor', 'remark', 'The name is wrong.'],
  ]);
  assert.ok(sent.every(message => message.at - lastKey >= 2000), 'everything waited for a 2 s pause');
});

test('an answer to the user\'s own question is shown at once, even while they type', async () => {
  const {pair, sent} = session();
  pair.receive({kind: 'typing', at: 99_900});
  await pair.ask('what is wrong?');
  assert.ok(sent.some(message => message.text === 'Line 2 is off.'));
});

/** A session in the Scout role with a stand-in for Pair's pane that records what it was asked to run. */
function scoutSession({results = {}, chat = true} = {}) {
  const ran = [];
  const sent = [];
  const roles = [];
  const pane = {
    opened: false,
    open: async () => { pane.opened = true; },
    close: async () => { pane.opened = false; },
    run: async command => { ran.push(command); return {exit: 0, output: '', timedOut: false, ...results[command]}; },
  };
  const pair = new PairSession({
    record: {id: 1, root: process.cwd(), conversation_id: 7, goal: 'fix it', level: 'normal', role: 'scout'},
    store: {addMessage() {}, setRole: (_id, role) => roles.push(role)},
    partner: {ask: async () => 'ok', setRole: async () => {}},
    score: async () => ({value: 9, reason: 'worth it'}),
    typingPauseMs: 2000,
    notify: (to, message) => { sent.push({to, ...message}); return to === 'chat' && !chat ? 0 : 1; },
    requestEditor: async () => null,
    now: () => 100_000,
  });
  pair.scout = pane;
  return {pair, pane, ran, sent, roles};
}

test('Scout runs allowed commands at once and reports exit, parsed tests and output', async () => {
  const output = 'FAIL src/ws.test.js\n  ● reconnect › waits\n\n    Expected: 30000\n\nTests:       1 failed, 2 passed, 3 total';
  const {pair, ran} = scoutSession({results: {'npm test': {exit: 1, output}}});
  const report = await pair.run({command: 'npm test'});
  assert.deepEqual(ran, ['npm test']);
  assert.match(report, /^exit 1\nTests \(jest\): 1 failed \(reconnect › waits\): Expected: 30000\nFAIL src/);
  assert.equal(pair.state.tests.by, 'pair');
  assert.equal(pair.state.tests.failedCount, 1);
  assert.deepEqual(pair.state.commands, [], 'Pair\'s own runs are not the user\'s commands, so they raise no remark');
});

test('Scout never runs a refused command and tells the user why', async () => {
  const {pair, ran, sent} = scoutSession();
  assert.match(await pair.run({command: 'git commit -am wip'}), /^Refused: git commit changes git history/);
  assert.deepEqual(ran, []);
  assert.ok(sent.some(message => /may not run `git commit -am wip`/.test(message.text)));
});

test('a command that writes asks the user in the chat and runs only on yes', async () => {
  const {pair, ran, sent} = scoutSession();
  const denied = pair.run({command: 'rm -rf build'});
  await Promise.resolve();
  const question = sent.find(message => message.type === 'confirm');
  assert.match(question.text, /`rm -rf build`.*rm writes or deletes files/);
  pair.answer(question.id, false);
  assert.match(await denied, /did not allow/);
  assert.deepEqual(ran, []);

  const allowed = pair.run({command: 'rm -rf build'});
  await Promise.resolve();
  pair.answer(sent.filter(message => message.type === 'confirm').at(-1).id, true);
  assert.match(await allowed, /^exit 0/);
  assert.deepEqual(ran, ['rm -rf build']);
});

test('a declined delete cannot be done another way through a read-only program', async () => {
  const {pair, ran, sent} = scoutSession();
  for (const command of ['rm precious.txt', 'fd precious -x rm', 'sort -onew.txt package.json']) {
    const reply = pair.run({command});
    await Promise.resolve();
    pair.answer(sent.filter(message => message.type === 'confirm').at(-1).id, false);
    assert.match(await reply, /did not allow/, command);
  }
  assert.deepEqual(ran, []);
});

test('without a chat pane to ask in, a command that writes does not run', async () => {
  const {pair, ran} = scoutSession({chat: false});
  assert.match(await pair.run({command: 'npm install'}), /did not allow/);
  assert.deepEqual(ran, []);
});

test('a remark nobody asked for may search but not run commands', async () => {
  const {pair, ran} = scoutSession({results: {"rg --line-number --no-heading --color never --max-columns 200 --max-count 20 -- 'TIMEOUT' '.'": {output: 'src/ws.ts:1:TIMEOUT'}}});
  pair.unasked = true;
  assert.match(await pair.run({command: 'npm test'}), /^Not now/);
  assert.equal(await pair.search({pattern: 'TIMEOUT'}), 'src/ws.ts:1:TIMEOUT\n\nName these places (file:line) in your answer.');
  assert.equal(ran.length, 1);
});

test('search quotes the pattern, stays in the project and says when nothing matched', async () => {
  const {pair, ran} = scoutSession({results: {"rg --line-number --no-heading --color never --max-columns 200 --max-count 20 -- 'it'\\''s' 'src'": {exit: 1}}});
  assert.equal(await pair.search({pattern: "it's", path: 'src'}), 'No matches.');
  assert.match(await pair.search({pattern: 'x', path: '..'}), /not inside the project/);
  assert.equal(ran.length, 1);
});

test('switching to Scout opens Pair\'s pane and tells the editor and the chat; switching back closes it', async () => {
  const {pair, pane, sent, roles} = scoutSession();
  pair.role = 'navigator';
  await pair.setRole('scout');
  assert.equal(pane.opened, true);
  assert.deepEqual(sent.filter(message => message.type === 'role').map(message => [message.to, message.role]), [['editors', 'scout'], ['chat', 'scout']]);
  await pair.setRole('navigator');
  assert.equal(pane.opened, false);
  assert.deepEqual(roles, ['scout', 'navigator']);
  assert.equal(pair.role, 'navigator');
});

test('without herdr there is no pane, so the role stays Navigator', async () => {
  const {pair, sent} = scoutSession();
  pair.role = 'navigator';
  pair.scout = null;
  await pair.setRole('scout');
  assert.equal(pair.role, 'navigator');
  assert.ok(sent.some(message => /Scout needs its own herdr pane/.test(message.text)));
});

test('a question gets at most four searches or commands; the next turn starts again', async () => {
  const {pair, ran} = scoutSession();
  for (let i = 0; i < 4; i++) await pair.run({command: 'git log -1'});
  await assert.rejects(pair.search({pattern: 'x'}), /That is 4 commands for this question/);
  assert.equal(ran.length, 4);
  await pair.talk('[user] again');
  await pair.run({command: 'git log -1'});
  assert.equal(ran.length, 5);
});

test('after a switch back to Navigator, a call still in flight does not reopen Pair\'s pane', async () => {
  const {pair, pane, ran} = scoutSession();
  await pair.setRole('navigator');
  await assert.rejects(pair.run({command: 'npm test'}), /need the Scout role/);
  assert.deepEqual(ran, []);
  assert.equal(pane.opened, false);
});

/**
 * A session with an editor that applies edits to `buffer` (unless `editorRefuses`), a stand-in for the
 * user's herdr panes that records what is typed, and a Partner that runs `turn(pair)` as its answer.
 */
function driverSession({turn = async () => 'ok', editor = true, role = 'navigator'} = {}) {
  const sent = [];
  const typed = [];
  const roles = [];
  const edits = [];
  const toolsOf = []; // the roles whose tools the conversation was given, in order
  const pair = new PairSession({
    record: {id: 1, root: process.cwd(), conversation_id: 7, goal: 'fix it', level: 'normal', role},
    store: {addMessage() {}, setRole: (_id, stored) => roles.push(stored)},
    partner: {ask: async (_id, input) => turn(pair, input), setRole: async (_id, given) => { toolsOf.push(given); }},
    score: async () => ({value: 9, reason: 'worth it'}),
    typingPauseMs: 2000,
    notify: (to, message) => { sent.push({to, ...message}); return to === 'editors' && !editor ? 0 : 1; },
    requestEditor: async message => { edits.push(message); return {ok: true}; },
    now: () => 100_000,
  });
  pair.panes = {type: async (pane, text) => typed.push([pane, text])};
  const roleChanges = () => sent.filter(message => message.type === 'role' && message.to === 'editors').map(message => message.role);
  return {pair, sent, typed, roles, edits, toolsOf, roleChanges};
}

const lastConfirm = sent => sent.filter(message => message.type === 'confirm').at(-1);

test('handing over makes Pair the Driver for one answer with one edit, which goes to the editor; then it hands back by itself', async () => {
  let input;
  let replies;
  let roleAfterEdit;
  const {pair, edits, roles, roleChanges} = driverSession({turn: async (pair, given) => {
    input = given;
    const reply = await pair.edit({file: 'package.json', line: 2, endLine: 2, text: '  "name": "x",'});
    roleAfterEdit = pair.role;
    const again = await pair.edit({file: 'package.json', line: 3, endLine: 3, text: 'more'});
    replies = [reply, again];
    return 'Renamed the package.';
  }});
  await pair.drive('your turn');
  assert.match(input, /^\[drive\] The user handed you the wheel for one change\. The user said: "your turn"/);
  assert.match(input, /make it pass by changing the code, not the test/);
  assert.deepEqual(edits.map(({type, line, endLine, text}) => ({type, line, endLine, text})), [{type: 'edit', line: 2, endLine: 2, text: '  "name": "x",'}]);
  assert.match(replies[0], /^Changed, as one undo step\. The file on disk changes only when the user saves, so do not run the tests now\. That was your one edit/);
  assert.match(replies[1], /^You already made your one change/, 'one edit per hand-over');
  assert.equal(roleAfterEdit, 'driver', 'the wheel stays until the answer ends, so tools do not vanish mid-answer');
  assert.deepEqual(roleChanges(), ['driver', 'navigator']);
  assert.equal(pair.role, 'navigator');
  assert.deepEqual(roles, ['navigator', 'navigator'], 'a drive is stored as Navigator, where it ends, so a restart during one does too');
});

test('an edit the editor refuses does not use up the one edit, and two at once cannot both pass', async () => {
  let replies;
  const {pair, edits} = driverSession({turn: async pair => {
    const failed = pair.requestEditor;
    pair.requestEditor = async () => ({error: 'line 99 is past the end of the buffer (3 lines)'});
    const first = await pair.edit({file: 'package.json', line: 99, endLine: 99, text: 'x'});
    pair.requestEditor = failed;
    replies = [first, ...await Promise.all([
      pair.edit({file: 'package.json', line: 1, endLine: 1, text: 'a'}),
      pair.edit({file: 'package.json', line: 2, endLine: 2, text: 'b'}),
    ])];
    return 'ok';
  }});
  await pair.drive('you take it');
  assert.match(replies[0], /^Not changed: line 99 is past the end/);
  assert.equal(replies.filter(reply => reply.startsWith('Changed')).length, 1);
  assert.equal(edits.length, 1);
});

test('a turn without an edit also ends with Pair back as Navigator', async () => {
  const {pair, roleChanges} = driverSession({turn: async () => 'What should I change?'});
  await pair.drive('');
  assert.deepEqual(roleChanges(), ['driver', 'navigator']);
  assert.equal(pair.role, 'navigator');
});

test('a key from the user takes the wheel back at once: an edit still on its way is refused', async () => {
  let reply;
  let toolsDuring;
  const {pair, edits, sent, toolsOf, roleChanges} = driverSession({turn: async pair => {
    await pair.takeBack(); // the user pressed a key while the model was thinking
    reply = await pair.edit({file: 'package.json', line: 1, endLine: 1, text: 'x'});
    toolsDuring = [...toolsOf];
    return 'ok';
  }});
  await pair.drive('you take it');
  assert.match(reply, /^The user has the wheel now/);
  assert.deepEqual(edits, []);
  assert.deepEqual(roleChanges(), ['driver', 'navigator']);
  assert.equal(pair.role, 'navigator');
  assert.ok(sent.some(message => message.text === 'You have the wheel back.'));
  // The answer keeps its tools, so the policy refuses with a reason; they change once it ends.
  assert.deepEqual(toolsDuring, ['driver']);
  assert.deepEqual(toolsOf, ['driver', 'navigator']);
});

test('without Neovim there is no wheel to hand over', async () => {
  let asked = false;
  const {pair, sent} = driverSession({editor: false, turn: async () => { asked = true; return 'ok'; }});
  await pair.drive('you take it');
  assert.equal(asked, false);
  assert.equal(pair.role, 'navigator');
  assert.ok(sent.some(message => /drives only in Neovim/.test(message.text ?? '')));
});

test('an edit outside the Driver role, or in a remark nobody asked for, changes nothing', async () => {
  const {pair, edits} = driverSession();
  assert.match(await pair.edit({file: 'package.json', line: 1, endLine: 1, text: 'x'}), /^The user has the wheel now/);
  pair.role = 'driver';
  pair.unasked = true;
  assert.match(await pair.edit({file: 'package.json', line: 1, endLine: 1, text: 'x'}), /^Not in a remark nobody asked for/);
  pair.unasked = false;
  assert.match(await pair.edit({file: '../outside.js', line: 1, endLine: 1, text: 'x'}), /^No file/);
  assert.deepEqual(edits, []);
});

test('no remark starts while Pair has the wheel', async () => {
  const {pair} = driverSession();
  let asked = 0;
  pair.partner.ask = async () => { asked++; return 'remark'; };
  failTwice(pair);
  pair.role = 'driver';
  await pair.tick();
  assert.equal(asked, 0);
});

test('a suggestion goes to the editor as an inline diff, in any role', async () => {
  const {pair, sent} = driverSession();
  assert.match(await pair.suggest({file: 'package.json', line: 2, endLine: 3, text: 'a\nb', note: 'rename'}), /accepts it with one key/);
  const shown = sent.find(message => message.type === 'suggest');
  assert.deepEqual({line: shown.line, endLine: shown.endLine, text: shown.text, note: shown.note}, {line: 2, endLine: 3, text: 'a\nb', note: 'rename'});
  assert.ok(shown.file.endsWith('package.json'));
  assert.ok(sent.some(message => message.text === 'package.json:2-3 suggestion: rename\na\nb'));
  assert.match(await pair.suggest({file: 'package.json', line: 3, endLine: 2, text: '', note: 'x'}), /before line/);
  const count = (await readFile('package.json', 'utf8')).split('\n').length;
  assert.match(await pair.suggest({file: 'package.json', line: count + 1, endLine: count + 1, text: 'x', note: 'x'}), /past the end of package\.json/);
  assert.equal(sent.filter(message => message.type === 'suggest').length, 1, 'a line past the end is not shown');
});

test('the Driver types into the user\'s terminal only after a yes, never Enter, and never what the policy refuses', async () => {
  const {pair, sent, typed} = driverSession();
  pair.role = 'driver';
  pair.receive({kind: 'focus', target: 'terminal', pane: 'w1:p1', scrolled: false});
  pair.receive({kind: 'focus', target: 'chat', pane: 'w1:p2', scrolled: false});

  const denied = pair.type({text: 'npm test'});
  await Promise.resolve();
  assert.match(lastConfirm(sent).text, /type `npm test` into your terminal \(pane w1:p1\), without pressing Enter/);
  pair.answer(lastConfirm(sent).id, false);
  assert.match(await denied, /did not allow/);

  const allowed = pair.type({text: 'npm test'});
  await Promise.resolve();
  pair.answer(lastConfirm(sent).id, true);
  assert.match(await allowed, /^Typed/);

  for (const text of ['npm test\r', 'npm test\n', 'rm -rf x\x03', '\x1b[A', '   ']) {
    assert.match(await pair.type({text}), /one line of plain text/, JSON.stringify(text));
  }
  assert.match(await pair.type({text: 'git push --force'}), /^Refused: git push/);
  assert.deepEqual(typed, [['w1:p1', 'npm test']]);
});

test('type needs the Driver role, a known terminal pane, and the wheel still in Pair\'s hands after the yes', async () => {
  const {pair, sent, typed} = driverSession();
  assert.match(await pair.type({text: 'npm test'}), /^The user has the wheel now/);
  pair.role = 'driver';
  assert.match(await pair.type({text: 'npm test'}), /No terminal pane/);
  pair.receive({kind: 'command_end', pane: 'w1:p3', cmd: 'ls', exit: 0, output: ''});
  const reply = pair.type({text: 'npm test'});
  await Promise.resolve();
  await pair.takeBack();
  pair.answer(lastConfirm(sent).id, true);
  assert.match(await reply, /^The user has the wheel now/);
  assert.deepEqual(typed, []);
});

test('a session is active for five minutes after the user last typed, edited or ran something', () => {
  const {pair} = session();
  assert.equal(pair.active(10 * 60_000), false, 'nothing yet');
  pair.receive({kind: 'command_end', cmd: 'ls', exit: 0, output: '', at: 50_000});
  assert.equal(pair.active(50_000 + 5 * 60_000 - 1), true);
  assert.equal(pair.active(50_000 + 5 * 60_000), false);
});

test('drift the budget holds back is judged once the budget allows, if the user is still in that file', async () => {
  let clock = 100_000;
  const scored = [];
  const logged = [];
  const pair = new PairSession({
    record: {id: 1, root: '/project', conversation_id: 7, goal: 'fix reconnect after sleep', level: 'normal'},
    store: {addMessage() {}, addRemark: () => 1, dropRemark() {}},
    partner: {ask: async () => 'SILENT'},
    score: async trigger => { scored.push(trigger.kind); return {value: 2}; },
    typingPauseMs: 2000, notify: () => 1, requestEditor: async () => null, now: () => clock, log: line => logged.push(line),
  });
  pair.budget.spend(clock); // a remark just now
  pair.receive({kind: 'edit', file: 'src/billing/invoice.ts', from: 1, to: 1, text: 'x', at: clock + 1000});
  for (clock += 5000; clock < 100_000 + 60_000; clock += 1000) await pair.tick();
  assert.deepEqual(scored, [], 'held back while the budget is spent');
  assert.equal(logged.filter(line => line.startsWith('drift: later')).length, 1, 'logged once, not every tick');
  clock = 100_000 + 3 * 60_000;
  await pair.tick();
  assert.deepEqual(scored, ['drift'], 'judged once the budget allows');
  await pair.tick();
  assert.deepEqual(scored, ['drift'], 'and only once');
});

test('after a new goal, a file judged under the old one is judged again', async () => {
  let clock = 100_000;
  const scored = [];
  const pair = new PairSession({
    record: {id: 1, root: '/project', conversation_id: 7, goal: 'fix rounding in billing totals', level: 'normal'},
    store: {addMessage() {}, setGoal() {}, addRemark: () => 1, dropRemark() {}},
    partner: {ask: async () => 'SILENT'},
    score: async trigger => { scored.push(trigger.kind); return {value: 2}; },
    typingPauseMs: 2000, notify: () => 1, requestEditor: async () => null, now: () => clock,
  });
  pair.receive({kind: 'edit', file: 'src/billing/totals.ts', from: 1, to: 1, text: 'x', at: clock});
  clock += 5000;
  await pair.tick();
  assert.deepEqual(scored, [], 'on-goal by its path: dropped without the Watcher');
  pair.setGoal('reconnect waits 30 s after the phone sleeps');
  pair.receive({kind: 'edit', file: 'src/billing/totals.ts', from: 2, to: 2, text: 'y', at: clock});
  clock += 5000;
  await pair.tick();
  assert.deepEqual(scored, ['drift'], 'judged again under the new goal');
});

/**
 * A session with tests on save in a small Go project, and a stand-in for Pair's pane that writes `report` (a
 * fixture of go test -json, as the project's real run would print it) to the run's output file.
 */
function saveSession({partner = {ask: async () => 'SILENT', setRole: async () => {}}} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pair-save-')));
  for (const [path, text] of Object.entries({
    'go.mod': 'module example.com/shop\n',
    'cart/cart_test.go': 'package cart\n\nimport "testing"\n\nfunc TestTotal(t *testing.T) {\n}\n\nfunc TestEmptyCart(t *testing.T) {\n}\n',
    'tax/tax_test.go': 'package tax\n\nimport "testing"\n\nfunc TestRate(t *testing.T) {\n}\n',
  })) {
    mkdirSync(join(root, path, '..'), {recursive: true});
    writeFileSync(join(root, path), text);
  }
  const outputFile = join(root, 'run.out');
  const ran = [];
  const sent = [];
  let report = '';
  let clock = 100_000;
  const pane = {
    close: async () => { pane.closed = true; },
    run: async command => {
      ran.push(command);
      writeFileSync(outputFile, report.replaceAll('/home/you/shop', root));
      return {exit: report.includes('"Action":"fail"') ? 1 : 0, output: '', timedOut: false};
    },
  };
  const pair = new PairSession({
    record: {id: 1, root, conversation_id: 7, goal: 'totals', level: 'normal'},
    store: {addMessage() {}, setRole() {}, addRemark: () => 1, dropRemark() {}},
    partner,
    score: async () => ({value: 9, reason: 'worth it'}),
    typingPauseMs: 2000,
    testOnSave: {command: 'go test -json ./...', outputFile},
    notify: (to, message) => { sent.push({to, ...message}); return 1; },
    requestEditor: async () => null,
    now: () => clock,
  });
  pair.scout = pane;
  return {
    pair, pane, root, ran, sent, outputFile,
    setReport: name => { report = readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'); },
    advance: ms => { clock += ms; },
    tests: () => sent.filter(message => message.type === 'tests'),
  };
}

async function until(check, what) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('saving a source file runs the project\'s tests in Pair\'s pane, and the editors see the run and each test\'s line', async () => {
  const {pair, ran, root, outputFile, sent, setReport, tests} = saveSession();
  setReport('go-test');
  pair.receive({kind: 'save', file: join(root, 'cart/cart.go')});
  pair.receive({kind: 'save', file: join(root, 'docs.md')}); // notes are no reason to run the tests
  await until(() => tests().length === 2, 'the run to end');
  assert.deepEqual(ran, [`go test -json ./... > '${outputFile}' 2>&1`]);
  const [start, end] = tests();
  assert.deepEqual(start, {to: 'editors', type: 'tests', state: 'run', label: 'go test ./...'});
  assert.deepEqual([end.state, end.label, end.text], ['fail', 'go test ./...', '2 failing · TestRate +1']);
  assert.deepEqual(end.results.map(test => [test.name, test.file.slice(root.length), test.line, test.ok, test.failure?.line]), [
    ['TestTotal', '/cart/cart_test.go', 5, false, 17],
    ['TestRate', '/tax/tax_test.go', 5, false, 7],
    ['TestEmptyCart', '/cart/cart_test.go', 8, true, undefined],
  ]);
  assert.deepEqual(pair.state.tests.files, ['cart/cart_test.go', 'tax/tax_test.go']);
  assert.deepEqual(sent.filter(message => message.to === 'chat').map(message => message.text), [
    '`go test ./...` after you saved cart/cart.go: 2 failed (TestRate, TestTotal/two_items): cart_test.go:17: Total([250 100]) = 100, want 350',
  ]);
  assert.deepEqual({to: 'editors', ...pair.testsShown}, end, 'kept for an editor that connects later');
});

test('a save during a run starts one more run after it; switching back to Navigator keeps the pane open', async () => {
  const {pair, pane, ran, root, setReport, tests} = saveSession();
  setReport('go-test');
  for (const file of ['a.go', 'b.go', 'c.go']) pair.receive({kind: 'save', file: join(root, file)});
  await until(() => tests().length === 4, 'two runs');
  assert.equal(ran.length, 2);
  await pair.setRole('navigator');
  assert.equal(pane.closed, undefined);
});

test('a regression found on save: Pair checks it with thinking, suggests the fix, and the jump key goes to the suggestion', async () => {
  let input;
  let options;
  const partner = {
    setRole: async () => {},
    ask: async (_id, text, opts) => {
      input = text;
      options = opts;
      await pair.suggest({file: 'cart/cart_test.go', line: 5, endLine: 5, text: 'func TestTotal(t *testing.T) {', note: 'start at 0'});
      return 'Total skips the first price.';
    },
  };
  const {pair, root, sent, setReport, advance} = saveSession({partner});
  setReport('go-test');
  pair.receive({kind: 'save', file: join(root, 'cart/cart.go')});
  await until(() => pair.state.tests, 'the run to end');
  advance(3000);
  await pair.tick();
  assert.match(input, /^\[watch\] regression: Pair ran `go test \.\/\.\.\.` when the user saved cart\/cart\.go\. Now failing, and not in the run before: TestRate, TestTotal\/two_items/);
  assert.match(input, /If a small change fixes it, call suggest/);
  assert.deepEqual(options, {thinking: 'low'});
  const remark = sent.find(message => message.type === 'remark' && message.to === 'editor');
  assert.deepEqual([remark.text, remark.target.suggestion, remark.target.line], ['Total skips the first price.', true, 5]);
});

test('without Pair\'s pane, a save says once why the tests did not run', async () => {
  const {pair, root, sent} = saveSession();
  pair.scout = null;
  pair.receive({kind: 'save', file: join(root, 'a.go')});
  pair.receive({kind: 'save', file: join(root, 'a.go')});
  await until(() => sent.length >= 3, 'both saves');
  assert.deepEqual(sent.filter(message => message.to === 'chat').map(message => message.text), [
    'Pair could not run `go test ./...`: tests on save need Pair\'s own herdr pane: start Pair with `pair` inside herdr.',
  ]);
});
