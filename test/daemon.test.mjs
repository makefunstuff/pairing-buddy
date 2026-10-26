// The daemon end to end over its socket, with scripted models in place of real ones.
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall} from '@earendil-works/pi-ai';
import {parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {requestDaemon} from '../src/protocol.mjs';
import {openStore} from '../src/store.mjs';
import {client} from './daemon-client.mjs';
import {fakeHerdr} from './fake-herdr.mjs';

const answers = async () => ({ok: true}); // the scripted models are not probed

/** Scripted Watcher and Partner; `partnerModel` names the Partner's model, as the config would. */
function scriptedModels(partnerModel) {
  const watcher = fauxProvider({provider: 'faux-watcher'});
  const partner = fauxProvider({provider: 'faux-partner', ...(partnerModel ? {models: [{id: partnerModel}]} : {})});
  const models = createModels();
  models.setProvider(watcher.provider);
  models.setProvider(partner.provider);
  return {watcher, partner, pairModels: {models, watcher: watcher.getModel(), partner: partner.getModel()}};
}

function testConfig(dataDir) {
  return parseConfig({
    dataDir,
    socket: join(dataDir, 'pair.sock'),
    typingPauseMs: 50,
    agents: false, // never the real board of the machine running the tests
    models: {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'w'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'p'}},
  });
}

test('a repeated failure becomes a pointed remark; a question is answered; :Pair end writes a note', {timeout: 20_000}, async () => {
  const project = mkdtempSync(join(tmpdir(), 'pair-project-'));
  writeFileSync(join(project, 'ws.test.js'), 'test("reconnect", () => {\n  expect(timeout).toBe(30)\n})\n');
  const config = testConfig(mkdtempSync(join(tmpdir(), 'pair-data-')));
  const {watcher, partner, pairModels} = scriptedModels();
  const daemon = await startDaemon(config, {pairModels, probe: answers, log: () => {}});

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
  let daemon = await startDaemon(config, {pairModels: first.pairModels, probe: answers, log: () => {}});
  let chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project});
  first.partner.setResponses([fauxAssistantMessage([fauxText('It is in ws.ts.')])]);
  await chat.next(message => message.type === 'welcome');
  chat.send({type: 'goal', text: 'fix reconnect'});
  chat.send({type: 'ask', text: 'where is the timeout?'});
  await chat.next(message => message.text === 'It is in ws.ts.');
  chat.close();
  await daemon.close();

  const second = scriptedModels();
  daemon = await startDaemon(config, {pairModels: second.pairModels, probe: answers, log: () => {}});
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
  const daemon = await startDaemon(config, {pairModels, probe: answers, log: () => {}});
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
  const daemon = await startDaemon(config, {pairModels, probe: answers, log: () => {}});
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

test('a dead Partner is said once, to the chat and the statusline; Pair then stays quiet instead of failing on every remark', {timeout: 30_000}, async () => {
  const project = mkdtempSync(join(tmpdir(), 'pair-project-'));
  const config = testConfig(mkdtempSync(join(tmpdir(), 'pair-data-')));
  const {watcher, partner, pairModels} = scriptedModels();
  const daemon = await startDaemon(config, {pairModels, probe: answers, log: () => {}});
  const editor = client(config.socket, {type: 'hello', role: 'editor', cwd: project});
  const chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project});
  try {
    assert.deepEqual((await chat.next(message => message.type === 'welcome')).models, {watcher: null, partner: null});
    chat.send({type: 'goal', text: 'fix reconnect'});
    partner.setResponses([]); // every Partner call fails from here on
    chat.send({type: 'ask', text: 'where is the timeout?'});
    await chat.next(message => message.text?.startsWith('Pair could not answer'));
    const notice = await chat.next(message => message.type === 'health');
    assert.equal(notice.models.partner !== null, true);
    assert.match(notice.text, /^The Partner model is not answering \(.+\)\. Pair stays quiet until it answers again/);
    assert.deepEqual((await editor.next(message => message.type === 'health')).models, notice.models);

    // Failures that would each be a remark: the Watcher is not even asked while the Partner is down.
    watcher.setResponses(Array(5).fill(fauxAssistantMessage([fauxText('{"score": 9, "reason": "failing"}')])));
    for (const cmd of ['npm test', 'npm test', 'cargo build', 'cargo build']) editor.send({type: 'command', cwd: project, pane: null, cmd, exit: 1});
    await new Promise(resolve => setTimeout(resolve, 2500)); // two ticks
    assert.equal(watcher.state.callCount, 0);
    assert.equal(chat.received.filter(message => message.type === 'health').length, 1, 'one notice, not one per failure');
    assert.equal(chat.received.filter(message => message.text?.startsWith('Pair could not answer')).length, 1, 'only the question got an error');

    const status = await requestDaemon(config.socket, {type: 'status'});
    assert.equal(status.models.partner, notice.models.partner);
  } finally {
    editor.close();
    chat.close();
    await daemon.close();
  }
});

test('several Neovims and projects at once: each project has its own session, and Pair shows things in the Neovim you used last', {timeout: 20_000}, async () => {
  const shop = mkdtempSync(join(tmpdir(), 'pair-shop-'));
  const blog = mkdtempSync(join(tmpdir(), 'pair-blog-'));
  writeFileSync(join(shop, 'cart.js'), 'const total = 0\n');
  const config = testConfig(mkdtempSync(join(tmpdir(), 'pair-data-')));
  const {partner, pairModels} = scriptedModels();
  const daemon = await startDaemon(config, {pairModels, probe: answers, log: () => {}});
  const shopVim = client(config.socket, {type: 'hello', role: 'editor', cwd: shop});
  const shopVim2 = client(config.socket, {type: 'hello', role: 'editor', cwd: shop});
  const blogVim = client(config.socket, {type: 'hello', role: 'editor', cwd: blog});
  const shopChat = client(config.socket, {type: 'hello', role: 'chat', cwd: shop});
  const blogChat = client(config.socket, {type: 'hello', role: 'chat', cwd: blog});
  try {
    for (const each of [shopVim, shopVim2, blogVim, shopChat, blogChat]) await each.next(message => message.type === 'welcome');
    shopChat.send({type: 'goal', text: 'fix the cart'});
    blogChat.send({type: 'goal', text: 'write a post'});
    await blogChat.next(message => message.text === 'Goal: write a post');
    assert.equal(shopChat.received.some(message => message.text === 'Goal: write a post'), false, 'the blog\'s chat stays in the blog');

    shopVim.send({type: 'event', event: {kind: 'typing'}});
    await new Promise(resolve => setTimeout(resolve, 50));
    shopVim2.send({type: 'event', event: {kind: 'cursor', file: join(shop, 'cart.js'), line: 1, col: 0}}); // the one used last
    let read;
    partner.setResponses([
      fauxAssistantMessage([fauxToolCall('read', {file: 'cart.js'})], {stopReason: 'toolUse'}),
      context => {
        read = context.messages.filter(message => message.role === 'toolResult').at(-1).content[0].text;
        return fauxAssistantMessage([fauxToolCall('point', {file: 'cart.js', line: 1, note: 'starts at 10'})], {stopReason: 'toolUse'});
      },
      fauxAssistantMessage([fauxText('See line 1.')]),
    ]);
    // The Neovim used last does not have cart.js loaded; the other one does, unsaved.
    shopVim2.next(message => message.type === 'read').then(read => shopVim2.send({type: 'reply', id: read.id, result: {text: null}}));
    shopVim.next(message => message.type === 'read').then(read => shopVim.send({type: 'reply', id: read.id, result: {text: 'const total = 10\n'}}));
    shopChat.send({type: 'ask', text: 'why is the total wrong?'});
    await shopChat.next(message => message.text === 'See line 1.');
    assert.match(read, /1: const total = 10/, 'the read came from the Neovim that has the file');
    await shopVim2.next(message => message.type === 'point');
    assert.equal(shopVim.received.some(message => message.type === 'point'), false, 'the point shows in one Neovim only');
    assert.equal(blogVim.received.some(message => message.type === 'point'), false);

    const status = await requestDaemon(config.socket, {type: 'status'});
    const sessions = Object.fromEntries(status.sessions.map(session => [session.goal, session]));
    assert.deepEqual([sessions['fix the cart'].editors, sessions['fix the cart'].chats], [2, 1]);
    assert.deepEqual([sessions['write a post'].editors, sessions['write a post'].chats], [1, 1]);
  } finally {
    for (const each of [shopVim, shopVim2, blogVim, shopChat, blogChat]) each.close();
    await daemon.close();
  }
});

test('after the Partner model is changed in the config, an open session answers with the new model', {timeout: 20_000}, async () => {
  const project = mkdtempSync(join(tmpdir(), 'pair-project-'));
  const config = testConfig(mkdtempSync(join(tmpdir(), 'pair-data-')));
  const health = [];
  const first = scriptedModels('your-larger-model');
  let daemon = await startDaemon(config, {pairModels: first.pairModels, probe: answers, log: () => {}});
  let chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project});
  await chat.next(message => message.type === 'welcome');
  chat.send({type: 'goal', text: 'fix reconnect'});
  await chat.next(message => message.text === 'Goal: fix reconnect');
  chat.close();
  await daemon.close();

  const second = scriptedModels('the-real-model');
  daemon = await startDaemon(config, {pairModels: second.pairModels, probe: answers, log: line => health.push(line)});
  chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project});
  try {
    await chat.next(message => message.type === 'welcome');
    let asked;
    second.partner.setResponses([(context, options, state, model) => { asked = model.id; return fauxAssistantMessage([fauxText('In ws.ts.')]); }]);
    chat.send({type: 'ask', text: 'where is the timeout?'});
    await chat.next(message => message.text === 'In ws.ts.' || message.text?.startsWith('Pair could not answer'));
    assert.equal(asked, 'the-real-model');
    assert.equal(chat.received.some(message => message.type === 'health'), false, 'the Partner was never marked down');
    assert.deepEqual(health.filter(line => /model down/.test(line)), []);
  } finally {
    chat.close();
    await daemon.close();
  }
});

test('the next session in a repo starts from the last note; a remark is rated with + in the chat', {timeout: 20_000}, async () => {
  const project = mkdtempSync(join(tmpdir(), 'pair-project-'));
  const config = testConfig(mkdtempSync(join(tmpdir(), 'pair-data-')));
  const {watcher, partner, pairModels} = scriptedModels();
  const daemon = await startDaemon(config, {pairModels, probe: answers, log: () => {}});
  const chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project});
  try {
    await chat.next(message => message.type === 'welcome');
    chat.send({type: 'goal', text: 'fix reconnect'});

    // An unasked remark, then the user's verdict on it.
    watcher.setResponses([fauxAssistantMessage([fauxText('{"score": 9, "reason": "same failure twice"}')])]);
    partner.setResponses([fauxAssistantMessage([fauxText('The timeout is 5 s in the code.')])]);
    const failure = {type: 'command', cwd: project, pane: null, cmd: 'npm test', exit: 1};
    chat.send(failure);
    chat.send(failure);
    const {id} = await chat.next(message => message.type === 'remark');
    chat.send({type: 'feedback', useful: true});
    await chat.next(message => message.text === 'Noted: useful.');

    partner.setResponses([fauxAssistantMessage([fauxText('Goal: fix reconnect. Loose end: the timeout.')])]);
    chat.send({type: 'end'});
    await chat.next(message => message.type === 'ended');
    chat.send({type: 'hello', role: 'chat', cwd: project}); // what the chat pane does after an end
    await chat.next(message => message.text === 'Last time:\nGoal: fix reconnect. Loose end: the timeout.');
    await chat.next(message => message.text === 'What are we doing this session? Type the goal here, or "later".');

    let instructions;
    partner.setResponses([context => {
      instructions = context.messages[0].sections.instructions;
      return fauxAssistantMessage([fauxText('The timeout.')]);
    }]);
    chat.send({type: 'goal', text: 'finish reconnect'});
    chat.send({type: 'ask', text: 'what was left last time?'});
    await chat.next(message => message.text === 'The timeout.');
    assert.match(instructions, /last session in this project ended with this note[\s\S]*Goal: fix reconnect\. Loose end: the timeout\./);

    const store = openStore(join(config.dataDir, 'sessions.sqlite'));
    assert.deepEqual(store.remarks(0).map(remark => [remark.id, remark.trigger, remark.verdict]), [[id, 'repeated_error', 'useful']]);
    store.close();
  } finally {
    chat.close();
    await daemon.close();
  }
});

test('keep-warm asks the Watcher\'s model for one token while someone works, and not while nobody does', {timeout: 20_000}, async () => {
  const project = mkdtempSync(join(tmpdir(), 'pair-project-'));
  const config = testConfig(mkdtempSync(join(tmpdir(), 'pair-data-')));
  const {watcher, pairModels} = scriptedModels();
  const pings = [];
  watcher.setResponses(Array(5).fill(null).map(() => (context, options) => {
    pings.push({prompt: context.messages.at(-1).content, maxTokens: options.maxTokens});
    return fauxAssistantMessage([fauxText('0')]);
  }));
  const daemon = await startDaemon(config, {pairModels, probe: answers, log: () => {}, keepWarmMs: 200});
  const editor = client(config.socket, {type: 'hello', role: 'editor', cwd: project});
  try {
    await editor.next(message => message.type === 'welcome');
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.deepEqual(pings, [], 'a session nobody works in');
    editor.send({type: 'event', event: {kind: 'typing'}});
    while (!pings.length) await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(pings[0], {prompt: 'Nothing happened yet.', maxTokens: 1});
  } finally {
    editor.close();
    await daemon.close();
  }
});
