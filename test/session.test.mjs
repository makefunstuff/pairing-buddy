import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {PairSession, runReport} from '../src/session.mjs';

function session({score = async () => ({value: 9, reason: 'worth it'}), answer = 'Line 2 is off.'} = {}) {
  const asked = [];
  const sent = [];
  const store = {addMessage() {}, addAction: () => 1, updateAction() {}, setGoal() {}, setLevel() {}, endSession() {}, lastRemark: () => null, showRemark() {}, addRemark: () => 1, dropRemark() {}};
  const partner = {thinkingOf: () => 'off', ask: async (_id, input) => { asked.push(input); return answer; }};
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
    store: {addMessage() {}, addAction: () => 1, updateAction() {}, lastRemark: () => null, showRemark() {}, addRemark: () => 1, dropRemark() {}},
    // The Partner takes 6 s; the user types again half a second before it answers.
    partner: {thinkingOf: () => 'off', ask: async () => {
      clock += 5500;
      pair.receive({kind: 'typing'});
      clock += 500;
      await pair.point({file: 'package.json', line: 1, note: 'look here'});
      return 'The name is wrong.';
    }},
    score: async () => ({value: 9, reason: 'worth it'}),
    typingPauseMs: 2000,
    // The ledger's list and the statusline's run line follow along at once: they interrupt nobody.
    notify: (role, message) => ['ledger_changed', 'run_line'].includes(message.type) || sent.push({role, at: clock, ...message}),
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
    ['editor', 'earcon', undefined],
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
    store: {addMessage() {}, addAction: () => 1, updateAction() {}, lastRemark: () => null, setRole: (_id, role) => roles.push(role)},
    partner: {thinkingOf: () => 'off', ask: async () => 'ok', setRole: async () => {}},
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

test('with the user\'s rc file, Scout\'s commands are judged by what their aliases stand for', async () => {
  const {pair, pane, ran} = scoutSession();
  pane.rcNames = async () => ({aliases: {ship: 'git push', ll: 'ls -l'}, functions: []});
  assert.match(await pair.run({command: 'ship'}), /^Refused: git push changes git history/);
  assert.match(await pair.run({command: 'll src'}), /^exit 0/);
  assert.deepEqual(ran, ['ll src']);
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
    store: {addMessage() {}, addAction: () => 1, updateAction() {}, lastRemark: () => null, setRole: (_id, stored) => roles.push(stored)},
    partner: {thinkingOf: () => 'off', ask: async (_id, input) => turn(pair, input), setRole: async (_id, given) => { toolsOf.push(given); }},
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
  const {pair, edits, roles, sent, roleChanges} = driverSession({turn: async (pair, given) => {
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
  assert.match(replies[0], /^Changed, as one undo step\. That was your one edit: say in one sentence what you changed\. Nothing ran on the unsaved buffer: no command on save, and no build or run in the user's terminal yet\. The file on disk changes only when the user saves, so do not run anything now\.$/);
  assert.match(replies[1], /^You already made your one change/, 'one edit per hand-over');
  assert.equal(roleAfterEdit, 'driver', 'the wheel stays until the answer ends, so tools do not vanish mid-answer');
  assert.deepEqual(roleChanges(), ['driver', 'navigator']);
  assert.equal(pair.role, 'navigator');
  assert.deepEqual(roles, ['navigator', 'navigator'], 'a drive is stored as Navigator, where it ends, so a restart during one does too');
  const handback = sent.find(message => message.type === 'handback');
  assert.deepEqual(handback, {to: 'editor', type: 'handback', file: join(process.cwd(), 'package.json'), line: 2, endLine: 2, tests: null, check: null, text: 'Renamed the package.'},
    'the hand-back line: Pair\'s words under the lines it changed; no tests without a command for the project');
  assert.ok(sent.indexOf(handback) > sent.findLastIndex(message => message.type === 'role'), 'after the wheel is back');
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
  assert.equal(sent.some(message => message.type === 'handback'), false, 'no hand-back line without an edit');
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
    store: {addMessage() {}, addAction: () => 1, updateAction() {}, lastRemark: () => null, showRemark() {}, addRemark: () => 1, dropRemark() {}},
    partner: {thinkingOf: () => 'off', ask: async () => 'SILENT'},
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

test('drift is judged by what the file is about, and again after a new goal', async () => {
  let clock = 100_000;
  const scored = [];
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pair-drift-')));
  mkdirSync(join(root, 'src/billing'), {recursive: true});
  writeFileSync(join(root, 'src/billing/ranking.ts'), '// Ranks overdue invoices for the dunning run.\nexport function rankOverdue(invoices) {}\n');
  const pair = new PairSession({
    record: {id: 1, root, conversation_id: 7, goal: 'better search ranking', level: 'normal'},
    store: {addMessage() {}, addAction: () => 1, updateAction() {}, setGoal() {}, lastRemark: () => null, showRemark() {}, addRemark: () => 1, dropRemark() {}},
    partner: {thinkingOf: () => 'off', ask: async () => 'SILENT'},
    score: async trigger => { scored.push([trigger.kind, trigger.gist]); return {value: 2}; },
    typingPauseMs: 2000, notify: () => 1, requestEditor: async () => null, now: () => clock,
  });
  pair.receive({kind: 'edit', file: 'src/billing/ranking.ts', from: 1, to: 1, text: 'x', at: clock});
  clock += 5000;
  await pair.tick();
  const gist = 'Ranks overdue invoices for the dunning run. It defines rankOverdue.';
  assert.deepEqual(scored, [['drift', gist]], 'a path word in common with the goal no longer skips the Watcher; it is told what the file does');
  pair.setGoal('reconnect waits 30 s after the phone sleeps');
  pair.receive({kind: 'edit', file: 'src/billing/ranking.ts', from: 2, to: 2, text: 'y', at: clock});
  clock += 5000;
  await pair.tick();
  assert.deepEqual(scored.map(([kind]) => kind), ['drift', 'drift'], 'judged again under the new goal');
});

/**
 * A session with tests on save in a small Go project, and a stand-in for Pair's pane that writes `report` (a
 * fixture of go test -json, as the project's real run would print it) to the output file the command names.
 */
function saveSession({partner = {thinkingOf: () => 'off', ask: async () => 'SILENT', setRole: async () => {}}, requestEditor = async () => null} = {}) {
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
      writeFileSync(/> '([^']+)' 2>&1$/.exec(command)[1], report.replaceAll('/home/you/shop', root));
      return {exit: report.includes('"Action":"fail"') ? 1 : 0, output: '', timedOut: false};
    },
  };
  const pair = new PairSession({
    record: {id: 1, root, conversation_id: 7, goal: 'totals', level: 'normal'},
    store: {addMessage() {}, addAction: () => 1, updateAction() {}, setRole() {}, lastRemark: () => null, showRemark() {}, addRemark: () => 1, dropRemark() {}},
    partner,
    score: async () => ({value: 9, reason: 'worth it'}),
    typingPauseMs: 2000,
    testOnSave: {command: 'go test -json ./...', outputFile},
    notify: (to, message) => { sent.push({to, ...message}); return 1; },
    requestEditor,
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
  assert.deepEqual(ran, [`cd '${root}' && (go test -json ./...) > '${outputFile}' 2>&1`], 'from the root, whatever Scout\'s cd did');
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

test('a regression found on save: Pair checks it as a remark, suggests the fix, and the jump key goes to the suggestion', async () => {
  let input;
  let options;
  const partner = {
    thinkingOf: () => 'off',
    setRole: async () => {},
    ask: async (_id, text, opts) => {
      input = text;
      options = opts;
      await pair.suggest({file: 'cart/cart_test.go', line: 5, endLine: 5, text: 'func TestTotal(t *testing.T) {', note: 'start at 0'});
      return 'Total skips the first price.';
    },
  };
  const {pair, root, sent, setReport, advance, tests} = saveSession({partner});
  setReport('go-test-pass'); // the session's first run: green, the baseline
  pair.receive({kind: 'save', file: join(root, 'cart/cart_test.go')});
  await until(() => tests().length === 2, 'the first run to end');
  setReport('go-test');
  pair.receive({kind: 'save', file: join(root, 'cart/cart.go')});
  await until(() => tests().length === 4, 'the second run to end');
  advance(3000);
  await pair.tick();
  assert.match(input, /^\[watch\] regression: Pair ran `go test \.\/\.\.\.` when the user saved cart\/cart\.go\. Now failing, and not in Pair's run before: TestRate, TestTotal\/two_items/);
  assert.match(input, /If a small change fixes it, call suggest/);
  assert.deepEqual(options, {kind: 'remark'});
  const remark = sent.find(message => message.type === 'remark' && message.to === 'editor');
  assert.deepEqual([remark.text, remark.target.suggestion, remark.target.line], ['Total skips the first price.', true, 5]);
});

test('the session\'s first run is the baseline: tests that were red already raise no regression', async () => {
  const {pair, root, sent, setReport, advance} = saveSession();
  setReport('go-test');
  pair.receive({kind: 'save', file: join(root, 'cart/cart.go')});
  await until(() => pair.state.tests, 'the run to end');
  assert.deepEqual(pair.state.tests.newly, []);
  advance(3000);
  await pair.tick();
  assert.equal(sent.some(message => message.type === 'remark'), false);
});

test('green after a long red: the editor glows and says what passes again, the chat says how long it was red, and a regression sounds', async () => {
  const {pair, root, sent, setReport, advance, tests} = saveSession();
  const to = type => sent.filter(message => message.type === type).map(({to: target, type: _type, ...rest}) => [target, rest]);
  setReport('go-test'); // the session's first run: red, the baseline
  pair.receive({kind: 'save', file: join(root, 'cart/cart.go')});
  await until(() => tests().length === 2, 'the first run');
  assert.equal(tests()[1].redSince, 100_000, 'the statusline can say how long it has been red');
  assert.deepEqual(to('earcon'), [], 'a red baseline is no regression');
  advance(23 * 60_000);
  setReport('go-test-pass');
  pair.receive({kind: 'save', file: join(root, 'cart/cart.go')});
  await until(() => tests().length === 4, 'the green run');
  assert.equal(tests()[3].redSince, undefined);
  assert.deepEqual(to('delight'), [['editor', {text: '`TestRate` and `TestTotal/two_items` pass again, after 23 min of red.'}]]);
  assert.deepEqual(to('earcon'), [['editor', {sound: 'green'}]]);
  assert.equal(sent.filter(message => message.to === 'chat').at(-1).text, '`go test ./...` passes again, after 23 min of red: 4 tests, 2 packages.');

  setReport('go-test');
  pair.receive({kind: 'save', file: join(root, 'cart/cart.go')});
  await until(() => tests().length === 6, 'the regression');
  assert.deepEqual(to('earcon').at(-1), ['editor', {sound: 'red'}]);
});

test('a number in the output of a command you run, holding still and then much better, is a delight; a long-failing build that passes is too', () => {
  const {pair, sent} = session();
  const ran = (output, extra = {}) => pair.receive({kind: 'command_end', cmd: './probe', exit: 0, output, at: 100_000, ...extra});
  for (const probe of ['23.7', '23.8', '1.1']) ran(`avg probe ${probe}\n`);
  assert.deepEqual(sent.filter(message => message.type === 'delight').map(message => message.text), ['avg probe 23.8 → 1.1, after 2 runs at 23.8.']);
  pair.receive({kind: 'command_end', cmd: 'make', exit: 2, output: 'cc: error: x', at: 0});
  pair.receive({kind: 'command_end', cmd: 'make', exit: 0, output: '', at: 15 * 60_000});
  assert.equal(sent.filter(message => message.type === 'delight').at(-1).text, '`make` passes again, after 15 min of red.');
  assert.deepEqual(sent.filter(message => message.type === 'earcon').map(message => message.sound), ['green', 'green']);
});

test('without Pair\'s pane, a save says once in the chat why the tests did not run, and the editors say it too', async () => {
  const {pair, root, sent, tests} = saveSession();
  pair.scout = null;
  pair.receive({kind: 'save', file: join(root, 'a.go')});
  pair.receive({kind: 'save', file: join(root, 'a.go')});
  await until(() => sent.length >= 3, 'both saves');
  assert.deepEqual(sent.filter(message => message.to === 'chat').map(message => message.text), [
    'Pair could not run `go test ./...`: tests on save need Pair\'s own herdr pane: start Pair with `pair` inside herdr.',
  ]);
  assert.deepEqual(tests().at(-1), {to: 'editors', type: 'tests', state: 'error', label: 'go test ./...', text: 'needs `pair` in herdr'});
});

test('after the Driver\'s edit, the tests run on the unsaved buffer: the Partner hears how, the hand-back line shows it, and no baseline changes', async () => {
  const buffer = 'package cart\n\nimport "testing"\n\nfunc TestTotal(t *testing.T) {\n}\n\nfunc TestEmptyCart(t *testing.T) {\n}\n';
  let reply;
  const partner = {
    thinkingOf: () => 'off',
    setRole: async () => {},
    ask: async () => { reply = await pair.edit({file: 'cart/cart_test.go', line: 6, endLine: 6, text: '\t// a case\n}'}); return 'Added a case; the tests pass.'; },
  };
  // The edit keeps line 6 as it was: the editor says it changed line 7 only.
  const requestEditor = async message => (message.type === 'read' ? {text: buffer} : {ok: true, from: 7, to: 7});
  const {pair, root, ran, sent, setReport, tests} = saveSession({partner, requestEditor});
  setReport('go-test-pass');
  await pair.drive('your turn');
  const overlay = `${join(root, 'run.out')}.unsaved/overlay.json`;
  assert.deepEqual(ran, [`cd '${root}' && (go test -overlay '${overlay}' -json ./...) > '${root}/run.out.unsaved/run.out' 2>&1`]);
  assert.match(reply, /^Changed, as one undo step\. That was your one edit: say in one sentence what you changed, and whether the tests pass\. `go test \.\/\.\.\.` on the unsaved buffer: 4 passed\.$/);
  const [start, end] = tests();
  assert.deepEqual(start, {to: 'editors', type: 'tests', state: 'run', label: 'go test ./... (unsaved)'});
  assert.deepEqual([end.state, end.label, end.text], ['pass', 'go test ./... (unsaved)', '4 tests, 2 packages']);
  assert.ok(sent.some(message => message.to === 'chat' && message.text === '`go test ./... (unsaved)` after Pair\'s edit: 4 passed'));
  const handback = sent.find(message => message.type === 'handback');
  assert.deepEqual([handback.line, handback.endLine, handback.tests, handback.text], [7, 7, 'pass', 'Added a case; the tests pass.']);
  assert.equal(pair.state.tests, null, 'a run on the buffer is no baseline for the next run on save');
});

test('when the tests cannot run on the buffer, the Partner is told why, and the statusline keeps the last run on save', async () => {
  let reply;
  const partner = {thinkingOf: () => 'off', setRole: async () => {}, ask: async () => { reply = await pair.edit({file: 'notes.txt', line: 1, endLine: 1, text: 'x'}); return 'Done.'; }};
  const {pair, root, sent, tests} = saveSession({partner, requestEditor: async message => (message.type === 'read' ? {text: 'x\n'} : {ok: true})});
  writeFileSync(join(root, 'notes.txt'), 'old\n');
  pair.testRuns.command = 'npm test'; // not go test: it runs in a copy of the project, which needs git
  await pair.drive('your turn');
  assert.match(reply, /`go test \.\/\.\.\.` could not run on the unsaved buffer: the project is not a git repository/);
  assert.deepEqual(tests().map(message => message.state), ['run', 'idle']);
  assert.equal(sent.find(message => message.type === 'handback').tests, null);
});

test('a moment that comes up while the Partner answers waits for it; its remark says how long. A question cancels a remark', async () => {
  let clock = 100_000;
  const remarks = [];
  const finish = [];
  const cancelled = [];
  const partner = {
    thinkingOf: () => 'off',
    ask: (_id, input) => new Promise(resolve => finish.push(() => resolve(input.startsWith('[user]') ? 'The timeout is 5 s.' : 'Line 2 is off.'))),
    cancel: async () => { cancelled.push(true); finish.shift()(null); },
  };
  const store = {addMessage() {}, setGoal() {}, lastRemark: () => null, showRemark() {}, addRemark: remark => remarks.push(remark), dropRemark() {}};
  const pair = new PairSession({
    record: {id: 1, root: '/project', conversation_id: 7, goal: 'fix it', level: 'normal'},
    store, partner, score: async () => ({value: 9, reason: 'worth it'}), typingPauseMs: 2000,
    notify: () => 1, requestEditor: async () => null, now: () => clock,
  });
  const question = pair.ask('where is the timeout?');
  await new Promise(setImmediate);
  failTwice(pair);
  await pair.tick();
  clock += 4000;
  await pair.tick();
  finish.shift()();
  await question;
  clock += 1000;
  const tick = pair.tick();
  await new Promise(setImmediate);
  assert.deepEqual(remarks.map(remark => [remark.trigger, remark.waitedMs]), [['repeated_error', 5000]]);

  const next = pair.ask('and the test?'); // the remark is still being written
  await tick;
  assert.equal(cancelled.length, 1);
  assert.equal(pair.unasked, false, 'the remark ended before the question started');
  await new Promise(setImmediate);
  finish.shift()();
  await next;
});

/**
 * A session in a small C project whose run on save is `make run`, with a stand-in for Pair's pane that writes
 * `output` to the output file and ends with `exit`, as the real run would.
 */
function buildSession() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pair-build-')));
  mkdirSync(join(root, 'src'));
  for (const file of ['probe.c', 'src/table.c']) writeFileSync(join(root, file), 'int main(void) {\n  return 0;\n}\n'.repeat(8));
  const sent = [];
  const result = {output: '', exit: 0};
  const pair = new PairSession({
    record: {id: 1, root, conversation_id: 7, goal: 'spread the keys', level: 'normal'},
    store: {addMessage() {}, addAction: () => 1, updateAction() {}, setRole() {}, lastRemark: () => null, showRemark() {}, addRemark: () => 1, dropRemark() {}},
    partner: {thinkingOf: () => 'off', ask: async () => 'SILENT', setRole: async () => {}},
    score: async () => ({value: 0, reason: 'no'}),
    typingPauseMs: 2000,
    testOnSave: {command: 'make run', outputFile: join(root, 'run.out')},
    notify: (to, message) => { sent.push({to, ...message}); return 1; },
    requestEditor: async () => null,
    now: () => 100_000,
  });
  pair.scout = {
    close: async () => {},
    run: async command => {
      writeFileSync(/> '([^']+)' 2>&1$/.exec(command)[1], result.output.replaceAll('/home/dev/probe', root));
      return {exit: result.exit, output: '', timedOut: false};
    },
  };
  const ends = () => sent.filter(message => message.type === 'tests' && message.state !== 'run');
  /** Saves probe.c with the run printing `output` and ending with `exit`: the editors' last tests and run messages. */
  const save = async (output, exit) => {
    Object.assign(result, {output, exit});
    const count = ends().length;
    const shown = pair.runShown;
    pair.receive({kind: 'save', file: join(root, 'probe.c')});
    await until(() => ends().length > count, 'the run to end');
    await until(() => pair.runShown !== shown, 'its places');
    return {tests: ends().at(-1), run: sent.filter(message => message.type === 'run').at(-1)};
  };
  return {pair, root, sent, save, chat: () => sent.filter(message => message.to === 'chat').map(message => message.text)};
}

const runFixture = name => readFileSync(new URL(`./fixtures/runs/${name}.txt`, import.meta.url), 'utf8');

test('a build on save that does not build: the statusline says where, the editors get each error\'s line', async () => {
  const {root, save, chat} = buildSession();
  const output = runFixture('gcc-errors').replaceAll('bad.c', 'probe.c') + 'src/table.c:5:1: warning: unused function [-Wunused-function]\nmissing.c:1:1: error: gone\n';
  const {tests, run} = await save(output, 2);
  assert.deepEqual([tests.state, tests.text], ['fail', 'does not build · probe.c:3 +2']);
  assert.deepEqual(run.places.map(place => [place.file.slice(root.length), place.line, place.col, place.kind, place.new]), [
    ['/probe.c', 3, 11, 'error', false],
    ['/probe.c', 4, 20, 'error', false],
    ['/src/table.c', 5, 1, 'warning', false],
  ], 'a file that is not in the project is not shown');
  assert.equal(run.places[0].text, '‘undefined_thing’ undeclared (first use in this function)');
  assert.deepEqual(chat(), ['`make run` after you saved probe.c: 3 errors: probe.c:3: ‘undefined_thing’ undeclared (first use in this function)']);
});

test('a run on save that crashes: the signal from the exit code, the frame in the project\'s code, and a clean run clears it', async () => {
  const {pair, root, save, chat} = buildSession();
  let {tests, run} = await save('190000 keys  load 0.72\n', 139);
  assert.deepEqual([tests.state, tests.text, run.places], ['fail', 'Segmentation fault', []], 'the shell said it in Pair\'s pane, not in the output: the exit code says it');
  ({tests, run} = await save(runFixture('asan-segv'), 1));
  assert.deepEqual([tests.state, tests.text], ['fail', 'AddressSanitizer: SEGV · probe.c:10']);
  assert.deepEqual(run.places.map(place => [place.file.slice(root.length), place.line, place.kind, place.text]), [['/probe.c', 10, 'crash', 'AddressSanitizer: SEGV']]);
  assert.deepEqual(chat(), ['`make run` after you saved probe.c: Segmentation fault'], 'red again is no news in the chat');
  ({tests, run} = await save('190000 keys  load 0.72  avg probe 1.3\n', 0));
  assert.deepEqual([tests.state, tests.text, run.places], ['pass', 'passed', []]);
  assert.deepEqual(pair.runShown, {type: 'run', cmd: 'make run', places: []}, 'kept for an editor that connects later');
});

test('a build on save with a new warning says so in the statusline; a warning the first build printed is no news', async () => {
  const {pair, root, save} = buildSession();
  const warning = 'probe.c:9:7: warning: unused variable ‘unused’ [-Wunused-variable]\n';
  let {tests, run} = await save(warning, 0);
  assert.deepEqual([tests.state, tests.text, run.places[0].new], ['pass', 'passed', false]);
  pair.receive({kind: 'edit', file: join(root, 'probe.c'), from: 21, to: 21});
  ({tests, run} = await save(`${warning}probe.c:21:14: warning: comparison of integers of different signs [-Wsign-compare]\n`, 0));
  assert.deepEqual([tests.state, tests.text], ['pass', '1 new warning']);
  assert.deepEqual(run.places.map(place => [place.line, place.new]), [[9, false], [21, true]]);
});

test('a crash in the user\'s terminal shows on its line in the editors, with paths from where the command ran', async () => {
  const {pair, root, sent} = buildSession();
  pair.receive({kind: 'command_end', pane: 'w1:p3', cmd: './table', exit: 134, cwd: join(root, 'src'), output: 'table: table.c:4: main: Assertion `n > 0\' failed.\nAborted (core dumped)'});
  await until(() => sent.some(message => message.type === 'run'), 'the run message');
  const {places} = sent.find(message => message.type === 'run');
  assert.deepEqual(places, [{file: join(root, 'src/table.c'), line: 4, col: null, kind: 'crash', text: 'Assertion `n > 0\' failed (SIGABRT)', new: false}]);
  assert.match(pair.state.commands.at(-1).reading.crash.text, /^Assertion/);
});

test('Scout\'s report of a command says how a build or run went', () => {
  assert.equal(runReport({exit: 139, output: 'avg probe 23.7\n'}), 'exit 139\nCrashed: Segmentation fault\navg probe 23.7\n');
  assert.equal(runReport({exit: 2, output: 'bad.c:3:11: error: x undeclared\n'}).split('\n')[1], 'Build: 1 error: bad.c:3: x undeclared');
});

test('recursive make: an error in a sub-make\'s folder is placed on its file there', async () => {
  const {root, save} = buildSession();
  const output = `make -C src all\nmake[1]: Entering directory '/home/dev/probe/src'\ntable.c:5:3: error: expected ‘;’ before ‘}’ token\nmake[1]: Leaving directory '/home/dev/probe/src'\nmake: *** [Makefile:2: run] Error 2\n`;
  const {tests, run} = await save(output, 2);
  assert.equal(tests.text, 'does not build · table.c:5');
  assert.deepEqual(run.places.map(place => [place.file, place.line, place.kind]), [[join(root, 'src/table.c'), 5, 'error']]);
});
