// `pair doctor` against a test daemon and a fake OpenAI-compatible server: what it says, in plain words.
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {connect} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createModels, fauxProvider} from '@earendil-works/pi-ai';
import {loadConfig, parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {contextCheck, daemonCheck, doctor, rolesCheck, serviceCheck} from '../src/doctor.mjs';
import {sendMessage} from '../src/protocol.mjs';
import {VERSION} from '../src/version.mjs';

/** An OpenAI-compatible server that serves `model` and answers each completion after `delayMs`, thinking first if it `thinks`. */
async function fakeServer({model, delayMs = 0, thinks = false}) {
  const server = createServer((request, response) => {
    if (request.url === '/v1/models') return response.end(JSON.stringify({data: [{id: model}]}));
    request.resume().on('end', () => setTimeout(() => {
      response.writeHead(200, {'content-type': 'text/event-stream'});
      const chunk = delta => `data: ${JSON.stringify({id: '1', object: 'chat.completion.chunk', created: 0, model, choices: [{index: 0, ...delta}]})}\n\n`;
      const thinking = thinks ? chunk({delta: {role: 'assistant', reasoning_content: 'Let me see.'}}) : '';
      response.end(`${thinking}${chunk({delta: {role: 'assistant', content: 'OK'}})}${chunk({delta: {}, finish_reason: 'stop'})}data: [DONE]\n\n`);
    }, delayMs));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {url: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close()};
}

async function run(options) {
  const checks = [];
  for await (const check of doctor(options)) checks.push(check);
  // The last check of each name, and every line of the thinking check, which can say more than one thing.
  return {...Object.fromEntries(checks.map(check => [check.name, check])), thinking: checks.filter(check => check.name === 'thinking')};
}

const installed = async () => ({installed: true, enabled: true, active: true, node: process.execPath});

test('all well: each check says ok, and a slow Watcher gets advice', {timeout: 20_000}, async () => {
  const fast = await fakeServer({model: 'small', thinks: true});
  const slow = await fakeServer({model: 'big', delayMs: 1700});
  const dir = mkdtempSync(join(tmpdir(), 'pair-doctor-'));
  const path = join(dir, 'config.json');
  const entry = (url, model) => ({api: 'openai', baseUrl: url, model});
  const partner = {...entry(fast.url, 'small'), compat: {supportsReasoningEffort: true}}; // each level reaches it
  writeFileSync(path, JSON.stringify({dataDir: dir, socket: join(dir, 'pair.sock'), models: {watcher: entry(slow.url, 'big'), partner}}));
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
    assert.equal(checks.thinking.length, 1);
    assert.equal(checks.thinking[0].level, 'ok');
    assert.match(checks.thinking[0].text, /^the Partner thinks \(up to "medium"\), \d\.\d s for a short sum$/);
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

test('thinking: a model that thinks anyway, one that does not, and levels the server cannot tell apart each get the fix', {timeout: 30_000}, async () => {
  const thinker = await fakeServer({model: 'thinker', thinks: true});
  const plain = await fakeServer({model: 'plain'});
  const dir = mkdtempSync(join(tmpdir(), 'pair-doctor-'));
  const path = join(dir, 'config.json');
  /** The thinking lines for a Partner `entry` (the Watcher thinks anyway), and the Watcher's last line. */
  const doctorFor = async entry => {
    const server = entry.model === 'thinker' ? thinker : plain;
    writeFileSync(path, JSON.stringify({socket: join(dir, 'pair.sock'), models: {watcher: {api: 'openai', baseUrl: thinker.url, model: 'thinker'}, partner: {api: 'openai', baseUrl: server.url, ...entry}}}));
    const checks = await run({path, env: {PATH: ''}, service: installed, nvimPlugin: async () => 'yes'});
    return {watcher: checks.watcher, thinking: checks.thinking.map(({level, text}) => [level, text])};
  };
  try {
    const plainDefault = await doctorFor({model: 'plain'});
    assert.equal(plainDefault.watcher.level, 'warn');
    assert.match(plainDefault.watcher.text, /thinks although the Watcher's thinking is off/);
    assert.equal(plainDefault.thinking.length, 1);
    assert.match(plainDefault.thinking[0][1], /^plain answered with no thinking at "medium": if it can think, set its server's thinking switch/);

    const [thinks, same] = (await doctorFor({model: 'thinker'})).thinking;
    assert.equal(thinks[0], 'ok');
    assert.deepEqual(same, ['warn', '"medium", "low" send thinker the same request, so thinking is only on or off: if its server takes a level, '
      + 'set "compat": {"supportsReasoningEffort": true} (it is then sent as reasoning_effort) or {"thinkingTokenBudgetField": "<the server\'s field>"} (a token budget)']);

    assert.deepEqual((await doctorFor({model: 'plain', thinking: 'off'})).thinking, [['ok', 'off for every kind of turn, as configured']]);
    assert.match((await doctorFor({model: 'thinker', thinking: 'off'})).thinking[0][1], /^thinker thinks although "thinking" is off/);
    assert.match((await doctorFor({model: 'thinker', reasoning: false})).thinking[0][1], /^"reasoning" is false: thinker thinks as it always does/);
    assert.match((await doctorFor({model: 'plain', reasoning: false})).thinking[0][1], /^"reasoning" is false and plain answered without thinking/);
  } finally {
    thinker.close();
    plain.close();
  }
});

test('one model: one line checks it, the roles line explains how it serves both, and its thinking is checked', {timeout: 20_000}, async () => {
  const server = await fakeServer({model: 'one', thinks: true});
  const dir = mkdtempSync(join(tmpdir(), 'pair-doctor-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({socket: join(dir, 'pair.sock'), model: {api: 'openai', baseUrl: server.url, model: 'one', reasoning: true, compat: {supportsReasoningEffort: true}}}));
  try {
    const checks = await run({path, env: {PATH: ''}, service: installed, nvimPlugin: async () => 'yes'});
    assert.equal(checks.watcher, undefined);
    assert.equal(checks.partner, undefined);
    assert.match(checks.models.text, /^one at http:\/\/127\.0\.0\.1:\d+\/v1 /);
    assert.equal(checks.roles.level, 'ok');
    assert.match(checks.roles.text, /^one model serves both: the Watcher asks it for one number without thinking, the Partner thinks/);
    assert.equal(checks.thinking[0].level, 'ok');
    assert.equal(checks.context.text, '32768 tokens: 10240 for the Partner\'s reply, the rest for its conversation');
  } finally {
    server.close();
  }
});

test('the roles line says what the daemon measured, and nudges two models on one server toward one', () => {
  const one = parseConfig({model: {api: 'openai', baseUrl: 'http://box/v1', model: 'm'}}).models;
  const slot = {exclusive: true, scores: 12, scoreMedianMs: 640, cancelled: {scores: 1, remarks: 2}};
  assert.match(rolesCheck(one, slot).text, /\. Since the daemon started: 12 scores, 0\.6 s each \(median\); your questions cancelled 1 score and 2 remarks still at work$/);
  const two = parseConfig({models: {watcher: {api: 'openai', baseUrl: 'http://box/v1', model: 's'}, partner: {api: 'openai', baseUrl: 'http://box/v1', model: 'm'}}}).models;
  assert.match(rolesCheck(two, null).text, /^two models on one server: .*give both roles one model \("model" in the config\), so it never reloads$/);
});

test('the context check says when the reply cannot hold the thinking, and when compaction will come often', () => {
  const partner = entry => parseConfig({model: {api: 'openai', baseUrl: 'http://box/v1', model: 'm', ...entry}}).models.partner;
  assert.match(contextCheck(partner({contextWindow: 16384})).text, /^the Partner's reply has room for 5461 tokens, and thinking at "medium" takes up to 10240 with the answer/);
  assert.equal(contextCheck(partner({contextWindow: 16384})).level, 'warn');
  const small = contextCheck(partner({contextWindow: 16384, thinking: 'low'}));
  assert.deepEqual([small.level, small.text], ['warn', '16384 tokens: the Partner\'s conversation is compacted every few turns; 32768 or more works better']);
  assert.equal(contextCheck(partner({contextWindow: 65536, reasoning: false})).level, 'ok');
});

test('the service and daemon checks name the fix', () => {
  assert.match(serviceCheck({installed: true, active: true, enabled: true, node: '/gone/node'}).text, /which is gone: run `pair setup` again/);
  assert.match(serviceCheck({installed: true, active: false, enabled: true, node: process.execPath}).text, /not running: see `journalctl --user -u pairing-buddy.service/);
  assert.match(daemonCheck({version: '0.0.1', startedAt: Date.now(), sessions: []}, {}).text, /runs version 0\.0\.1 .*systemctl --user restart pairing-buddy\.service/);
});
