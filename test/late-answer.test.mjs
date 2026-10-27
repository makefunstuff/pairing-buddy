// A question the daemon was answering when it stopped: finished on restart and shown late; a remark is dropped.
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {test} from 'node:test';
import {createModels, fauxAssistantMessage, fauxProvider, fauxText} from '@earendil-works/pi-ai';
import {parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {openPartner} from '../src/partner.mjs';
import {client} from './daemon-client.mjs';
import {scratch} from './temp.mjs';

/** A model that never answers, until the daemon stops and aborts its request. */
const hang = (context, options) => new Promise((resolve, reject) => {
  options?.signal?.addEventListener('abort', () => reject(new Error('stopped')));
});

function scriptedModels() {
  const watcher = fauxProvider({provider: 'faux-watcher'});
  const partner = fauxProvider({provider: 'faux-partner'});
  const models = createModels();
  models.setProvider(watcher.provider);
  models.setProvider(partner.provider);
  return {partner, pairModels: {models, watcher: watcher.getModel(), partner: partner.getModel()}};
}

async function until(check) {
  while (!check()) await new Promise(resolve => setTimeout(resolve, 20));
}

test('a question the daemon was answering when it stopped is answered late, in the chat and in Neovim', {timeout: 20_000}, async () => {
  const project = scratch('pair-project-');
  const dataDir = scratch('pair-data-');
  const config = parseConfig({
    dataDir,
    socket: join(dataDir, 'pair.sock'),
    models: {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'w'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'p'}},
  });
  const options = {probe: async () => ({ok: true}), log: () => {}};

  const first = scriptedModels();
  let daemon = await startDaemon(config, {...options, pairModels: first.pairModels});
  let chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project});
  await chat.next(message => message.type === 'welcome');
  chat.send({type: 'goal', text: 'fix reconnect'});
  first.partner.setResponses([hang]);
  chat.send({type: 'ask', text: 'where is the timeout?'});
  await until(() => first.partner.getPendingResponseCount() === 0); // the model has the question
  chat.close();
  await daemon.close();

  const second = scriptedModels();
  second.partner.setResponses([fauxAssistantMessage([fauxText('In ws.ts, line 12.')])]);
  daemon = await startDaemon(config, {...options, pairModels: second.pairModels});
  chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project, resume: true});
  let editor;
  try {
    await chat.next(message => message.sender === 'system' && message.text.includes('answering "where is the timeout?"'));
    await chat.next(message => message.sender === 'pair' && message.text === 'In ws.ts, line 12.');
    // A Neovim that reconnects after the answer still gets it.
    editor = client(config.socket, {type: 'hello', role: 'editor', cwd: project});
    const late = await editor.next(message => message.type === 'message');
    assert.equal(late.text, 'Late answer to "where is the timeout?": In ws.ts, line 12.');
  } finally {
    chat.close();
    editor?.close();
    await daemon.close();
  }
});

test('a remark the daemon was making when it stopped is dropped, not finished', {timeout: 20_000}, async () => {
  const storage = join(scratch('pair-partner-'), 'partner.sqlite');
  const hands = {roleOf: () => 'navigator'};
  const open = faux => {
    const models = createModels();
    models.setProvider(faux.provider);
    return openPartner({storage, models, model: faux.getModel(), hands});
  };

  const first = fauxProvider({provider: 'faux-partner'});
  first.setResponses([hang, hang]);
  let partner = await open(first);
  const asked = await partner.createConversation();
  const unasked = await partner.createConversation();
  const stopped = [
    partner.ask(asked, '[user] what is up?\n\nNow:\nediting ws.ts').catch(() => {}),
    partner.ask(unasked, '[watch] failed_command: npm test', {kind: 'remark'}).catch(() => {}),
  ];
  await until(() => first.getPendingResponseCount() === 0);
  await partner.close();
  await Promise.all(stopped);

  const second = fauxProvider({provider: 'faux-partner'});
  second.setResponses([fauxAssistantMessage([fauxText('Not much.')]), fauxAssistantMessage([fauxText('A late remark.')])]);
  partner = await open(second);
  try {
    assert.deepEqual(partner.interrupted.map(turn => [turn.conversationId, turn.question]), [[asked, 'what is up?']]);
    await partner.resume();
    const [{conversationId, submissionId}] = partner.interrupted;
    assert.equal(await partner.finish(conversationId, submissionId), 'Not much.');
    assert.equal(second.getPendingResponseCount(), 1); // one request: the remark was not finished
  } finally {
    await partner.close();
  }
});
