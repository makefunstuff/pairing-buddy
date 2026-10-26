// The daemon end to end over its socket, with scripted models in place of real ones.
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {connect} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall} from '@earendil-works/pi-ai';
import {parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {readMessages, sendMessage} from '../src/protocol.mjs';
import {fakeHerdr} from './fake-herdr.mjs';

function scriptedModels() {
  const watcher = fauxProvider({provider: 'faux-watcher'});
  const partner = fauxProvider({provider: 'faux-partner'});
  const models = createModels();
  models.setProvider(watcher.provider);
  models.setProvider(partner.provider);
  return {watcher, partner, pairModels: {models, watcher: watcher.getModel(), partner: partner.getModel()}};
}

/** A socket client that collects what the daemon sends and can wait for a message. */
function client(socketPath, hello) {
  const socket = connect(socketPath);
  const received = [];
  const waiters = [];
  readMessages(socket, message => {
    received.push(message);
    for (const waiter of [...waiters]) if (waiter.match(message)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
  });
  socket.on('connect', () => sendMessage(socket, hello));
  return {
    received,
    send: message => sendMessage(socket, message),
    next: match => new Promise(resolve => {
      const found = received.find(match);
      if (found) resolve(found); else waiters.push({match, resolve});
    }),
    close: () => socket.destroy(),
  };
}

function testConfig(dataDir) {
  return parseConfig({
    dataDir,
    socket: join(dataDir, 'pair.sock'),
    typingPauseMs: 50,
    models: {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'w'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'p'}},
  });
}

test('a repeated failure becomes a pointed remark; a question is answered; :Pair end writes a note', {timeout: 20_000}, async () => {
  const project = mkdtempSync(join(tmpdir(), 'pair-project-'));
  writeFileSync(join(project, 'ws.test.js'), 'test("reconnect", () => {\n  expect(timeout).toBe(30)\n})\n');
  const config = testConfig(mkdtempSync(join(tmpdir(), 'pair-data-')));
  const {watcher, partner, pairModels} = scriptedModels();
  const daemon = await startDaemon(config, {pairModels, log: () => {}});

  const editor = client(config.socket, {type: 'hello', role: 'editor', cwd: project});
  const chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project});
  try {
    await chat.next(message => message.type === 'welcome');
    chat.send({type: 'goal', text: 'reconnect drops after sleep'});
    await chat.next(message => message.text === 'Goal: reconnect drops after sleep');

    watcher.setResponses([fauxAssistantMessage([fauxText('{"score": 9, "reason": "same failure twice"}')])]);
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('point', {file: 'ws.test.js', line: 2, note: 'test expects 30 s, code uses 5 s'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('The test waits 30 s but the code times out after 5 s.')]),
    ]);
    const failure = {type: 'command', cwd: project, pane: null, cmd: 'npm test', exit: 1};
    editor.send(failure);
    editor.send(failure);

    const point = await editor.next(message => message.type === 'point');
    assert.equal(point.file, join(project, 'ws.test.js'));
    assert.equal(point.line, 2);
    await chat.next(message => message.text === 'The test waits 30 s but the code times out after 5 s.');

    partner.setResponses([fauxAssistantMessage([fauxText('Line 2 of ws.test.js.')])]);
    chat.send({type: 'ask', text: 'where is the timeout set?'});
    await chat.next(message => message.sender === 'pair' && message.text === 'Line 2 of ws.test.js.');

    partner.setResponses([fauxAssistantMessage([fauxText('Goal: reconnect. Changed: nothing yet. Loose end: timeout.')])]);
    chat.send({type: 'end'});
    await chat.next(message => message.type === 'ended');
    assert.ok(chat.received.some(message => message.text?.startsWith('Session note:\nGoal: reconnect.')));
    await editor.next(message => message.type === 'clear');
  } finally {
    editor.close();
    chat.close();
    await daemon.close();
  }
});

test('the session, its chat and its conversation survive a daemon restart', {timeout: 20_000}, async () => {
  const project = mkdtempSync(join(tmpdir(), 'pair-project-'));
  const config = testConfig(mkdtempSync(join(tmpdir(), 'pair-data-')));

  const first = scriptedModels();
  let daemon = await startDaemon(config, {pairModels: first.pairModels, log: () => {}});
  let chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project});
  first.partner.setResponses([fauxAssistantMessage([fauxText('It is in ws.ts.')])]);
  await chat.next(message => message.type === 'welcome');
  chat.send({type: 'goal', text: 'fix reconnect'});
  chat.send({type: 'ask', text: 'where is the timeout?'});
  await chat.next(message => message.text === 'It is in ws.ts.');
  chat.close();
  await daemon.close();

  const second = scriptedModels();
  daemon = await startDaemon(config, {pairModels: second.pairModels, log: () => {}});
  chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project});
  try {
    const welcome = await chat.next(message => message.type === 'welcome');
    assert.equal(welcome.goal, 'fix reconnect');
    await chat.next(message => message.history && message.text === 'It is in ws.ts.');
    let earlier;
    second.partner.setResponses([context => {
      earlier = context.messages.filter(message => message.role === 'user').map(message => message.content);
      return fauxAssistantMessage([fauxText('Still ws.ts.')]);
    }]);
    chat.send({type: 'ask', text: 'and now?'});
    await chat.next(message => message.text === 'Still ws.ts.');
    assert.match(earlier[0], /^\[user\] where is the timeout\?/);
    assert.match(earlier.at(-1), /^\[user\] and now\?/);
  } finally {
    chat.close();
    await daemon.close();
  }
});

test('in Scout, Pair runs tests in its own pane, asks before deleting and is refused git history', {timeout: 20_000}, async () => {
  const project = mkdtempSync(join(tmpdir(), 'pair-project-'));
  const config = testConfig(mkdtempSync(join(tmpdir(), 'pair-data-')));
  const herdrSocket = join(mkdtempSync(join(tmpdir(), 'pair-herdr-')), 'herdr.sock');
  const tests = 'FAIL ws.test.js\n  ● reconnect › waits\n\n    Expected: 30000\n\nTests:       1 failed, 1 passed, 2 total';
  const herdr = await fakeHerdr(herdrSocket, {commands: {'npm test': {output: tests, exit: 1}}});
  const {partner, pairModels} = scriptedModels();
  const daemon = await startDaemon(config, {pairModels, log: () => {}});
  const editor = client(config.socket, {type: 'hello', role: 'editor', cwd: project});
  const chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project, herdr: {socket: herdrSocket, workspace: 'w1', pane: 'w1:p2'}});
  const toolResults = context => context.messages.filter(message => message.role === 'toolResult').map(message => message.content[0].text);
  try {
    assert.equal((await chat.next(message => message.type === 'welcome')).role, 'navigator');
    chat.send({type: 'goal', text: 'fix reconnect'});
    chat.send({type: 'role', role: 'scout'});
    await chat.next(message => message.type === 'role' && message.role === 'scout');
    await editor.next(message => message.type === 'role' && message.role === 'scout');
    const scoutPane = [...herdr.panes].find(([, pane]) => pane.label === 'pair scout')[0];

    let results;
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('run', {command: 'npm test'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxToolCall('run', {command: 'rm -rf coverage'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxToolCall('run', {command: 'git push'})], {stopReason: 'toolUse'}),
      context => { results = toolResults(context); return fauxAssistantMessage([fauxText('One test fails: it waits 5 s, not 30 s.')]); },
    ]);
    chat.send({type: 'ask', text: 'run the tests and clean up'});
    const question = await chat.next(message => message.type === 'confirm');
    assert.match(question.text, /`rm -rf coverage`/);
    chat.send({type: 'confirm', id: question.id, ok: false});
    await chat.next(message => message.text === 'One test fails: it waits 5 s, not 30 s.');

    assert.match(results.at(-3), /^exit 1\nTests \(jest\): 1 failed \(reconnect › waits\): Expected: 30000/);
    assert.match(results.at(-2), /did not allow/);
    assert.match(results.at(-1), /^Refused: git push changes git history/);
    assert.deepEqual(herdr.sent.filter(([pane]) => pane !== scoutPane), [], 'only Pair\'s own pane was typed into');
    assert.deepEqual(herdr.sent.filter(([, text]) => !text.startsWith('exec env')).map(([, text]) => text), ['\x15npm test\r']);

    let state;
    partner.setResponses([context => { state = context.messages.at(-1).content; return fauxAssistantMessage([fauxText('ok')]); }]);
    chat.send({type: 'ask', text: 'what failed?'});
    await chat.next(message => message.text === 'ok');
    assert.match(state, /Last test run: `npm test` by Pair, \d+ s ago: 1 failed \(reconnect › waits\)/);

    chat.send({type: 'role', role: 'navigator'});
    await editor.next(message => message.type === 'role' && message.role === 'navigator');
    assert.equal(herdr.panes.has(scoutPane), false, 'Pair\'s pane closes with the switch back');
  } finally {
    editor.close();
    chat.close();
    await daemon.close();
    await herdr.close();
  }
});

test('handed the wheel from the chat, Pair types into the user\'s pane after a yes, without Enter, and hands back', {timeout: 20_000}, async () => {
  const project = mkdtempSync(join(tmpdir(), 'pair-project-'));
  const config = testConfig(mkdtempSync(join(tmpdir(), 'pair-data-')));
  const herdrSocket = join(mkdtempSync(join(tmpdir(), 'pair-herdr-')), 'herdr.sock');
  const herdr = await fakeHerdr(herdrSocket);
  const {partner, pairModels} = scriptedModels();
  const daemon = await startDaemon(config, {pairModels, log: () => {}});
  const editor = client(config.socket, {type: 'hello', role: 'editor', cwd: project});
  const chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project, herdr: {socket: herdrSocket, workspace: 'w1', pane: 'w1:p2'}});
  try {
    await chat.next(message => message.type === 'welcome');
    await editor.next(message => message.type === 'welcome');
    chat.send({type: 'goal', text: 'fix reconnect'});
    await new Promise(resolve => setTimeout(resolve, 1500)); // a herdr poll: the user's pane w1:p1 has focus

    let result;
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('type', {text: 'npm test'})], {stopReason: 'toolUse'}),
      context => {
        result = context.messages.filter(message => message.role === 'toolResult').at(-1).content[0].text;
        return fauxAssistantMessage([fauxText('It is in your terminal; press Enter to run it.')]);
      },
    ]);
    chat.send({type: 'drive', text: 'you take it: put the test command in my terminal'});
    await editor.next(message => message.type === 'role' && message.role === 'driver');
    const question = await chat.next(message => message.type === 'confirm');
    assert.match(question.text, /type `npm test` into your terminal \(pane w1:p1\)/);
    chat.send({type: 'confirm', id: question.id, ok: true});
    await chat.next(message => message.text === 'It is in your terminal; press Enter to run it.');
    await editor.next(message => message.type === 'role' && message.role === 'navigator');

    assert.match(result, /^Typed/);
    assert.deepEqual(herdr.sent, [['w1:p1', 'npm test']], 'typed once, into the user\'s pane, without Enter');
  } finally {
    editor.close();
    chat.close();
    await daemon.close();
    await herdr.close();
  }
});
