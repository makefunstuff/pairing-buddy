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

test('a repeated failure becomes a pointed remark; a question is answered; :Pair end writes a note', {timeout: 20_000}, async () => {
  const project = mkdtempSync(join(tmpdir(), 'pair-project-'));
  writeFileSync(join(project, 'ws.test.js'), 'test("reconnect", () => {\n  expect(timeout).toBe(30)\n})\n');
  const dataDir = mkdtempSync(join(tmpdir(), 'pair-data-'));
  const config = parseConfig({
    dataDir,
    socket: join(dataDir, 'pair.sock'),
    typingPauseMs: 50,
    models: {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'w'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'p'}},
  });
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
