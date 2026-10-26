// One model for both roles: each role asks it its own way, the Watcher waits while the Partner works, and the
// user's question goes before a remark nobody asked for. The daemon runs end to end with one scripted model.
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createModels, fauxAssistantMessage, fauxProvider, fauxText} from '@earendil-works/pi-ai';
import {MemoryStorage} from '@earendil-works/pi-durable';
import {parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {initialState} from '../src/fold.mjs';
import {createPairModels} from '../src/models.mjs';
import {openPartner} from '../src/partner.mjs';
import {requestDaemon} from '../src/protocol.mjs';
import {openStore} from '../src/store.mjs';
import {createWatcher} from '../src/watcher.mjs';
import {client} from './daemon-client.mjs';

const LONG = Array(60).fill('word').join(' '); // streams for about three seconds

test('one model, two ways of asking: the Watcher without thinking for 8 tokens at temperature 0, the Partner with thinking', async () => {
  const config = parseConfig({model: {api: 'openai', baseUrl: 'http://box/v1', model: 'm', compat: {thinkingFormat: 'deepseek', supportsReasoningEffort: true}}});
  const pairModels = createPairModels(config);
  const bodies = [];
  const fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); throw new Error('not sent'); };
  const models = {completeSimple: (model, context, options) => pairModels.models.completeSimple(model, context, {...options, fetch, maxRetries: 0})};
  await createWatcher({models, model: pairModels.watcher})({kind: 'stall', detail: 'nothing for 90 s'}, initialState());
  // pi-durable sends the Partner's thinking level as pi-ai's `reasoning`.
  await models.completeSimple(pairModels.partner, {messages: [{role: 'user', content: 'x', timestamp: 0}]}, {reasoning: config.models.partner.thinking.navigator}).catch(() => {});
  const [watcher, partner] = bodies;
  assert.equal(watcher.model, partner.model, 'one model: the server never switches');
  assert.deepEqual([watcher.max_tokens, watcher.temperature, watcher.thinking, watcher.reasoning_effort], [8, 0, {type: 'disabled'}, undefined]);
  assert.deepEqual([partner.max_tokens, partner.thinking, partner.reasoning_effort], [10240, {type: 'enabled'}, 'medium']);
});

test('a cancelled turn resolves null, and the conversation answers the next input as usual', async () => {
  const faux = fauxProvider({tokensPerSecond: 20});
  const models = createModels();
  models.setProvider(faux.provider);
  const partner = await openPartner({storage: new MemoryStorage(), models, model: faux.getModel(), hands: {roleOf: () => 'navigator'}});
  try {
    const id = await partner.createConversation();
    faux.setResponses([fauxAssistantMessage([fauxText(LONG)]), fauxAssistantMessage([fauxText('The timeout is 5 s.')])]);
    const remark = partner.ask(id, '[watch] ...', {kind: 'remark'});
    await new Promise(resolve => setTimeout(resolve, 200));
    await partner.cancel(id);
    assert.equal(await remark, null);
    assert.equal(await partner.ask(id, 'where is the timeout?'), 'The timeout is 5 s.');
    await partner.cancel(id); // after the turn is done: the next turn is not taken for cancelled
    faux.setResponses([fauxAssistantMessage([fauxText('Still here.')])]);
    assert.equal(await partner.ask(id, 'and now?'), 'Still here.');
  } finally {
    await partner.close();
  }
});

/**
 * One scripted model for both roles. The Watcher's calls score 9; the Partner's take `partnerAnswers` in turn,
 * streamed slowly enough to be at work for a while. `calls` lists each role as the model is asked.
 */
function oneModel(partnerAnswers) {
  const faux = fauxProvider({provider: 'faux-one', tokensPerSecond: 20});
  const models = createModels();
  models.setProvider(faux.provider);
  const calls = [];
  const answer = context => {
    const system = context.messages.find(message => message.role === 'system')?.content;
    const watcher = typeof system === 'string' && system.startsWith('Score 0-10');
    calls.push(watcher ? 'watcher' : 'partner');
    return fauxAssistantMessage([fauxText(watcher ? '9' : partnerAnswers.shift() ?? 'SILENT')]);
  };
  faux.setResponses(Array(40).fill(answer));
  const model = faux.getModel();
  return {calls, pairModels: {models, watcher: model, partner: model}};
}

function oneModelConfig() {
  const dataDir = mkdtempSync(join(tmpdir(), 'pair-data-'));
  return parseConfig({dataDir, socket: join(dataDir, 'pair.sock'), typingPauseMs: 50, model: {api: 'openai', baseUrl: 'http://unused', model: 'm'}});
}

const failTwice = (editor, project) => {
  for (let i = 0; i < 2; i++) editor.send({type: 'command', cwd: project, pane: null, cmd: 'npm test', exit: 1});
};

/** Resolves once `check()` holds, looking every 20 ms; fails after 10 s. */
async function until(check) {
  for (const started = Date.now(); !check(); await new Promise(resolve => setTimeout(resolve, 20))) {
    if (Date.now() - started > 10_000) throw new Error('timed out waiting');
  }
}

test('the user\'s question goes first: the remark the model is still writing is cancelled, dropped, and no failure', {timeout: 20_000}, async () => {
  const project = mkdtempSync(join(tmpdir(), 'pair-project-'));
  const config = oneModelConfig();
  const {calls, pairModels} = oneModel([LONG, 'Line 2 sets 5 s.']);
  const daemon = await startDaemon(config, {pairModels, probe: async () => ({ok: true}), log: () => {}});
  const editor = client(config.socket, {type: 'hello', role: 'editor', cwd: project});
  const chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project});
  try {
    await chat.next(message => message.type === 'welcome');
    chat.send({type: 'goal', text: 'reconnect drops after sleep'});
    await chat.next(message => message.text === 'Goal: reconnect drops after sleep');
    failTwice(editor, project);
    await until(() => calls.join() === 'watcher,partner'); // the remark is being written
    chat.send({type: 'ask', text: 'where is the timeout set?'});
    await chat.next(message => message.sender === 'pair' && message.text === 'Line 2 sets 5 s.');

    assert.equal(chat.received.some(message => message.text === LONG || message.type === 'remark'), false, 'the cancelled remark never shows');
    assert.equal(editor.received.some(message => message.type === 'remark'), false);
    const status = await requestDaemon(config.socket, {type: 'status'});
    assert.deepEqual(status.slot.cancelled, {scores: 0, remarks: 1});
    assert.equal(status.slot.exclusive, true);
    assert.equal(status.models.partner, null, 'a cancel is no failure of the model');
    const store = openStore(join(config.dataDir, 'sessions.sqlite'));
    assert.deepEqual(store.remarks(0), [], 'and the remark is not kept for a verdict');
    store.close();
  } finally {
    editor.close();
    chat.close();
    await daemon.close();
  }
});

test('while the Partner answers in one project, the Watcher of another waits, then scores; its remark says how long it waited', {timeout: 20_000}, async () => {
  const shop = mkdtempSync(join(tmpdir(), 'pair-shop-'));
  const blog = mkdtempSync(join(tmpdir(), 'pair-blog-'));
  writeFileSync(join(blog, 'post.md'), '# Draft\n');
  const config = oneModelConfig();
  const {calls, pairModels} = oneModel([LONG, 'The build fails on the front matter.']);
  const daemon = await startDaemon(config, {pairModels, probe: async () => ({ok: true}), log: () => {}});
  const shopChat = client(config.socket, {type: 'hello', role: 'chat', cwd: shop});
  const blogEditor = client(config.socket, {type: 'hello', role: 'editor', cwd: blog});
  const blogChat = client(config.socket, {type: 'hello', role: 'chat', cwd: blog});
  try {
    for (const each of [shopChat, blogEditor, blogChat]) await each.next(message => message.type === 'welcome');
    shopChat.send({type: 'goal', text: 'fix the cart'});
    blogChat.send({type: 'goal', text: 'publish the post'});
    await blogChat.next(message => message.text === 'Goal: publish the post');

    shopChat.send({type: 'ask', text: 'why is the total wrong?'});
    await until(() => calls.length === 1);
    failTwice(blogEditor, blog);
    await shopChat.next(message => message.sender === 'pair' && message.text === LONG);
    await blogChat.next(message => message.sender === 'pair' && message.text === 'The build fails on the front matter.');
    assert.deepEqual(calls, ['partner', 'watcher', 'partner'], 'no Watcher call while the Partner was at work');
    const store = openStore(join(config.dataDir, 'sessions.sqlite'));
    const [remark] = store.remarks(0);
    store.close();
    assert.equal(remark.trigger, 'repeated_error');
    assert.ok(remark.waitedMs > 1000, `it waited for the answer in the shop (${remark.waitedMs} ms)`);
  } finally {
    for (const each of [shopChat, blogEditor, blogChat]) each.close();
    await daemon.close();
  }
});
