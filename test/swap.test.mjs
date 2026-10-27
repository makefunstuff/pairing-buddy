// Two models on a server that holds one at a time and does not say which: the daemon sees the reloads in the
// Watcher's timing and moves the Watcher to the Partner's model. End to end, with a fake server that swaps.
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {client} from './daemon-client.mjs';

const SWAP_MS = 2100; // just over what the daemon takes for a reload

/** The fake server: `small` loaded first, `SWAP_MS` to load the other; `asked` lists each completion's model. */
async function swappingServer() {
  const asked = [];
  let loaded = 'small';
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', chunk => { text += chunk; }).on('end', () => {
      if (request.url === '/v1/models') return response.end(JSON.stringify({data: [{id: 'small'}, {id: 'large'}]}));
      const {model} = JSON.parse(text);
      asked.push(model);
      const delay = model === loaded ? 20 : SWAP_MS;
      loaded = model;
      setTimeout(() => {
        response.writeHead(200, {'content-type': 'text/event-stream'});
        const chunk = (delta, extra = {}) => `data: ${JSON.stringify({id: '1', object: 'chat.completion.chunk', created: 0, model, choices: [{index: 0, ...delta}], ...extra})}\n\n`;
        response.end(`${chunk({delta: {role: 'assistant', content: '1'}})}${chunk({delta: {}, finish_reason: 'stop'})}data: [DONE]\n\n`);
      }, delay);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {url: `http://127.0.0.1:${server.address().port}/v1`, asked, close: () => server.close()};
}

async function until(check) {
  for (const started = Date.now(); !check(); await new Promise(resolve => setTimeout(resolve, 20))) {
    if (Date.now() - started > 15_000) throw new Error('timed out waiting');
  }
}

test('after two reload-slow Watcher calls that follow Partner turns, the Watcher scores with the Partner\'s model', {timeout: 60_000}, async () => {
  const server = await swappingServer();
  const project = mkdtempSync(join(tmpdir(), 'pair-project-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'pair-data-'));
  const entry = model => ({api: 'openai', baseUrl: server.url, model, contextWindow: 32768});
  const config = parseConfig({dataDir, socket: join(dataDir, 'pair.sock'), typingPauseMs: 50, keepWarm: false,
    models: {watcher: entry('small'), partner: {...entry('large'), reasoning: false}}});
  const logged = [];
  const daemon = await startDaemon(config, {probe: async () => ({ok: true}), log: line => logged.push(line)});
  const editor = client(config.socket, {type: 'hello', role: 'editor', cwd: project});
  const chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project});
  try {
    await chat.next(message => message.type === 'welcome');
    chat.send({type: 'goal', text: 'fix the cart'});
    await chat.next(message => message.text === 'Goal: fix the cart');
    /** The same failure again: a repeated error, which the Watcher scores 1, so no remark is made. */
    const failAndScore = async () => {
      const before = server.asked.length;
      for (let i = 0; i < 2; i++) editor.send({type: 'command', cwd: project, pane: null, cmd: 'npm test', exit: 1});
      await until(() => server.asked.length > before);
      await new Promise(resolve => setTimeout(resolve, 2500)); // the score, a reload included
    };
    // Two scores with no Partner turn before them: how long the Watcher's calls usually take.
    for (let i = 0; i < 2; i++) await failAndScore();
    for (let round = 1; round <= 3; round++) {
      chat.send({type: 'ask', text: `question ${round}`});
      await until(() => server.asked.filter(model => model === 'large').length >= round);
      await chat.next(message => message.sender === 'pair' && chat.received.filter(each => each.sender === 'pair').length >= round);
      await failAndScore();
    }
    // Two usual scores; then question, score, question, score, each a reload. The third score uses the model the
    // question loaded.
    assert.deepEqual(server.asked, ['small', 'small', 'large', 'small', 'large', 'small', 'large', 'large']);
    assert.ok(logged.some(line => /seems to reload on each switch/.test(line)), logged.join('\n'));
  } finally {
    editor.close();
    chat.close();
    await daemon.close();
    server.close();
  }
});
