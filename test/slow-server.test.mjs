// A server slow on every request: once the Watcher's calls take long, the daemon stops asking about the kinds of
// moment you can see for yourself, and keeps asking about the rest. End to end, with a fake server of set latency.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {test} from 'node:test';
import {parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {requestDaemon} from '../src/protocol.mjs';
import {client} from './daemon-client.mjs';
import {scratch} from './temp.mjs';

const LATENCY_MS = 1700; // over SLOW_MS: a slow server, not a very slow one

/** The fake server: every completion answers "1" after LATENCY_MS; `asked` lists the Watcher's questions. */
async function slowServer() {
  const asked = [];
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', chunk => { text += chunk; }).on('end', () => {
      if (request.url === '/v1/models') return response.end(JSON.stringify({data: [{id: 'one'}]}));
      const {messages} = JSON.parse(text);
      asked.push(messages.at(-1).content);
      setTimeout(() => {
        response.writeHead(200, {'content-type': 'text/event-stream'});
        const chunk = (delta, extra = {}) => `data: ${JSON.stringify({id: '1', object: 'chat.completion.chunk', created: 0, model: 'one', choices: [{index: 0, ...delta}], ...extra})}\n\n`;
        response.end(`${chunk({delta: {role: 'assistant', content: '1'}})}${chunk({delta: {}, finish_reason: 'stop'})}data: [DONE]\n\n`);
      }, LATENCY_MS);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {url: `http://127.0.0.1:${server.address().port}/v1`, asked, close: () => server.close()};
}

async function until(check, what) {
  for (const started = Date.now(); !check(); await new Promise(resolve => setTimeout(resolve, 20))) {
    if (Date.now() - started > 20_000) throw new Error(`timed out waiting for ${typeof what === 'function' ? what() : what}`);
  }
}

test('on a slow server the daemon stops asking the Watcher about drift, and still asks about failures', {timeout: 60_000}, async () => {
  const server = await slowServer();
  const project = scratch('pair-project-');
  const dataDir = scratch('pair-data-');
  writeFileSync(join(project, 'invoice.js'), 'export const total = items => items.length;\n');
  const config = parseConfig({dataDir, socket: join(dataDir, 'pair.sock'), typingPauseMs: 50, keepWarm: false,
    model: {api: 'openai', baseUrl: server.url, model: 'one', contextWindow: 32768}});
  const logged = [];
  const daemon = await startDaemon(config, {probe: async () => ({ok: true}), log: line => logged.push(line)});
  const editor = client(config.socket, {type: 'hello', role: 'editor', cwd: project});
  const chat = client(config.socket, {type: 'hello', role: 'chat', cwd: project});
  try {
    await chat.next(message => message.type === 'welcome');
    chat.send({type: 'goal', text: 'fix the reconnect after sleep'});
    await chat.next(message => message.text === 'Goal: fix the reconnect after sleep');
    // Five failures, each failing twice: five repeated errors the Watcher is asked about, each in LATENCY_MS.
    for (const [i, cmd] of ['npm test', 'cargo build', 'make', 'pytest', 'go vet'].entries()) {
      for (let n = 0; n < 2; n++) editor.send({type: 'command', cwd: project, pane: null, cmd, exit: 1});
      await until(() => server.asked.length > i, `score ${i + 1}`);
    }
    await until(() => logged.some(line => /Pair is not asking about/.test(line)), 'the pace to change');
    assert.match(logged.find(line => /Pair is not asking about/.test(line)), /takes 1\.7 s a call: Pair is not asking about fresh_code, note_drift, note_stall, drift, search_trail while the server is this slow/);
    const status = await requestDaemon(config.socket, {type: 'status'});
    assert.deepEqual([status.pace.level, status.pace.givenUp], ['slow', ['fresh_code', 'note_drift', 'note_stall', 'drift', 'search_trail']]);

    // Work on a file off the goal: drift, which costs no call now.
    const before = server.asked.length;
    editor.send({type: 'event', event: {kind: 'edit', file: join(project, 'invoice.js'), from: 1, to: 1}});
    await until(() => logged.some(line => /\] drift: drop \(the Watcher takes/.test(line)), () => `drift to be given up:\n${logged.join('\n')}`);
    // A failure you did not see is still asked about.
    for (let n = 0; n < 2; n++) editor.send({type: 'command', cwd: project, pane: null, cmd: 'go test', exit: 1});
    await until(() => server.asked.length > before, 'the failure to be scored');
    assert.equal(server.asked.length, before + 1, 'one call, for the failure, none for drift');
    assert.doesNotMatch(server.asked.at(-1), /^drift/);
  } finally {
    editor.close();
    chat.close();
    await daemon.close();
    server.close();
  }
});
