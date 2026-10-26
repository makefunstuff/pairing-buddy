// `pair doctor` against a test daemon and a fake OpenAI-compatible server: what it says, in plain words.
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {connect} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createModels, fauxProvider} from '@earendil-works/pi-ai';
import {loadConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {daemonCheck, doctor, serviceCheck} from '../src/doctor.mjs';
import {sendMessage} from '../src/protocol.mjs';
import {VERSION} from '../src/version.mjs';

/** An OpenAI-compatible server that serves `model` and answers each completion after `delayMs`. */
async function fakeServer({model, delayMs = 0}) {
  const server = createServer((request, response) => {
    if (request.url === '/v1/models') return response.end(JSON.stringify({data: [{id: model}]}));
    request.resume().on('end', () => setTimeout(() => {
      response.writeHead(200, {'content-type': 'text/event-stream'});
      const chunk = delta => `data: ${JSON.stringify({id: '1', object: 'chat.completion.chunk', created: 0, model, choices: [{index: 0, ...delta}]})}\n\n`;
      response.end(`${chunk({delta: {role: 'assistant', content: 'OK'}})}${chunk({delta: {}, finish_reason: 'stop'})}data: [DONE]\n\n`);
    }, delayMs));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {url: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close()};
}

async function run(options) {
  const checks = [];
  for await (const check of doctor(options)) checks.push(check);
  return Object.fromEntries(checks.map(check => [check.name, check]));
}

const installed = async () => ({installed: true, enabled: true, active: true, node: process.execPath});

test('all well: each check says ok, and a slow Watcher gets advice', {timeout: 20_000}, async () => {
  const fast = await fakeServer({model: 'small'});
  const slow = await fakeServer({model: 'big', delayMs: 1700});
  const dir = mkdtempSync(join(tmpdir(), 'pair-doctor-'));
  const path = join(dir, 'config.json');
  const entry = (url, model) => ({api: 'openai', baseUrl: url, model});
  writeFileSync(path, JSON.stringify({dataDir: dir, socket: join(dir, 'pair.sock'), models: {watcher: entry(slow.url, 'big'), partner: entry(fast.url, 'small')}}));
  const config = loadConfig(path);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const daemon = await startDaemon(config, {pairModels: {models, watcher: faux.getModel(), partner: faux.getModel()}, probe: async () => ({ok: true}), log: () => {}});
  const editor = connect(config.socket);
  editor.on('connect', () => sendMessage(editor, {type: 'hello', role: 'editor', cwd: dir}));
  await new Promise(resolve => editor.once('data', resolve));
  try {
    const checks = await run({path, env: {PATH: ''}, service: installed, nvimPlugin: async () => assert.fail('not started: a Neovim is connected')});
    assert.equal(checks.config.level, 'ok');
    assert.equal(checks.service.text, 'starts at login, running');
    assert.match(checks.daemon.text, new RegExp(`^version ${VERSION}, up 0 min, 1 session$`));
    assert.equal(checks.plugin.text, 'loaded in the connected Neovims');
    assert.match(checks.neovim.text, /^1 connected, in pair-doctor-/);
    assert.match(checks.herdr.text, /^not installed: Pair works without it/);
    assert.equal(checks.partner.level, 'ok');
    assert.match(checks.partner.text, /^small at http:\/\/127\.0\.0\.1:\d+\/v1 answers in \d\.\d s$/);
    assert.equal(checks.watcher.level, 'warn');
    assert.match(checks.watcher.text, /takes \d+\.\d s: the Watcher scores every candidate remark and should take about 1 s/);
  } finally {
    editor.destroy();
    await daemon.close();
    fast.close();
    slow.close();
  }
});

test('broken: no daemon, a dead endpoint and a model the server does not serve, each said plainly', {timeout: 20_000}, async () => {
  const server = await fakeServer({model: 'small'});
  const dead = await fakeServer({model: 'big'});
  dead.close(); // nothing listens on its port any more
  const dir = mkdtempSync(join(tmpdir(), 'pair-doctor-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({
    socket: join(dir, 'pair.sock'),
    models: {watcher: {api: 'openai', baseUrl: server.url, model: 'smal'}, partner: {api: 'openai', baseUrl: dead.url, model: 'big'}},
  }));
  try {
    const checks = await run({path, env: {PATH: ''}, service: async () => ({installed: false}), nvimPlugin: async () => 'no'});
    assert.match(checks.service.text, /^not installed: `pair setup`/);
    assert.equal(checks.daemon.level, 'fail');
    assert.match(checks.daemon.text, /^nothing answers on .*pair\.sock: run `pair setup`/);
    assert.equal(checks.neovim, undefined, 'without a daemon, connections are not checked');
    assert.match(checks.plugin.text, /does not load the plugin/);
    assert.match(checks.watcher.text, /does not serve "smal"; it lists: small/);
    assert.equal(checks.partner.text, `nothing answers at ${dead.url} (ECONNREFUSED): is the server running?`);
  } finally {
    server.close();
  }
});

test('the service and daemon checks name the fix', () => {
  assert.match(serviceCheck({installed: true, active: true, enabled: true, node: '/gone/node'}).text, /which is gone: run `pair setup` again/);
  assert.match(serviceCheck({installed: true, active: false, enabled: true, node: process.execPath}).text, /not running: see `journalctl --user -u pairing-buddy.service/);
  assert.match(daemonCheck({version: '0.0.1', startedAt: Date.now(), sessions: []}, {}).text, /runs version 0\.0\.1 .*systemctl --user restart pairing-buddy\.service/);
});
