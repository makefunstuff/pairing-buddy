import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {BACKGROUND_CONTEXT as C} from '@earendil-works/chord/context';
import {createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall} from '@earendil-works/pi-ai';
import {createRegistry, Harness, MemoryStorage} from '@earendil-works/pi-durable';
import {NodeExecutionEnv} from '@earendil-works/pi-durable/env/node';
import {CodingTools} from '@earendil-works/pi-durable/tools';
import {insideRoot, numberedLines, readProjectPath} from '../src/files.mjs';
import {openPartner} from '../src/partner.mjs';
import {pairExtension, ROLE_TOOLS, toolPolicy} from '../src/tools.mjs';

const project = () => mkdtempSync(join(tmpdir(), 'pair-tools-'));

function recordingHands(role = 'navigator') {
  const calls = [];
  const hand = name => async (conversationId, args) => { calls.push([name, args]); return `${name} done`; };
  const hands = Object.fromEntries(ROLE_TOOLS.driver.map(name => [name, hand(name)]));
  return {calls, hands: {...hands, roleOf: () => role}};
}

function fauxModels() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return {faux, models, model: faux.getModel()};
}

test('the Navigator has say, point, open, read, recall and suggest; Scout adds search and run; the Driver edit and type; nothing else exists', () => {
  const {hands} = recordingHands();
  assert.deepEqual(ROLE_TOOLS.navigator, ['say', 'point', 'open', 'read', 'recall', 'suggest']);
  assert.deepEqual(ROLE_TOOLS.scout, ['say', 'point', 'open', 'read', 'recall', 'suggest', 'search', 'run']);
  assert.deepEqual(ROLE_TOOLS.driver, ['say', 'point', 'open', 'read', 'recall', 'suggest', 'search', 'run', 'edit', 'type']);
  assert.deepEqual(pairExtension(hands).tools.map(tool => tool.name), ROLE_TOOLS.driver);
});

test('the policy blocks every tool outside the role', () => {
  for (const role of ['navigator', 'scout', 'driver']) {
    for (const name of ROLE_TOOLS[role]) assert.equal(toolPolicy({name}, role), undefined, `${role} ${name}`);
  }
  for (const name of ['search', 'run']) assert.match(toolPolicy({name}, 'navigator').block, /needs the Scout role/);
  for (const role of ['navigator', 'scout']) {
    assert.match(toolPolicy({name: 'edit'}, role).block, /only while the user hands you the wheel; call suggest instead/);
    assert.match(toolPolicy({name: 'type'}, role).block, /only while the user hands you the wheel; say the command instead/);
  }
  for (const name of ['write', 'bash', 'save', 'Say', 'read_file', 'Edit']) {
    assert.match(toolPolicy({name}, 'navigator').block, /only say, point, open, read, recall, suggest\.$/);
    assert.match(toolPolicy({name}, 'scout').block, /only say, point, open, read, recall, suggest, search, run\.$/);
    assert.match(toolPolicy({name}, 'driver').block, /only say, point, open, read, recall, suggest, search, run, edit, type\.$/);
  }
});

test('edit runs only while driving: not offered otherwise, and refused by the hook once the wheel is taken back', async () => {
  const {faux, models, model} = fauxModels();
  let role = 'navigator';
  const {calls, hands} = recordingHands();
  const partner = await openPartner({storage: new MemoryStorage(), models, model, hands: {...hands, roleOf: () => role}});
  const id = await partner.createConversation();
  const results = [];
  const edit = fauxAssistantMessage([fauxToolCall('edit', {file: 'a.js', line: 1, new_text: 'x'})], {stopReason: 'toolUse'});
  const answer = context => { results.push(context.messages.at(-1).content[0].text); return fauxAssistantMessage([fauxText('ok')]); };
  faux.setResponses([edit, answer, edit, answer, edit, answer]);

  await partner.ask(id, '[user] change it'); // a Navigator conversation is not offered edit at all
  await partner.setRole(id, 'driver');
  await partner.ask(id, '[drive] change it'); // still offered, but the user took the wheel back: the hook says no
  role = 'driver';
  await partner.ask(id, '[drive] change it');
  await partner.close();

  assert.match(results[0], /not available/);
  assert.match(results[1], /only while the user hands you the wheel/);
  assert.equal(results[2], 'edit done');
  assert.deepEqual(calls, [['edit', {file: 'a.js', line: 1, endLine: 1, text: 'x', old: undefined, more: false}]]);
});

test('the Partner offers the model only its role\'s tools and answers with its final text', async () => {
  const {faux, models, model} = fauxModels();
  const {calls, hands} = recordingHands();
  const partner = await openPartner({storage: new MemoryStorage(), models, model, hands});
  const id = await partner.createConversation();
  let offered;
  faux.setResponses([
    context => {
      // pi-durable announces tools in system messages, so only changes are sent again.
      offered = context.messages.flatMap(message => message.toolsAdded ?? []).map(tool => tool.name).sort();
      return fauxAssistantMessage([fauxToolCall('edit', {path: 'a.js', oldText: 'a', newText: 'b'}), fauxToolCall('point', {file: 'a.js', line: 3, note: 'off by one', code: 'i <= n'})], {stopReason: 'toolUse'});
    },
    fauxAssistantMessage([fauxText('Line 3 loops one too far.')]),
  ]);
  assert.equal(await partner.ask(id, '[user] what is wrong?'), 'Line 3 loops one too far.');
  assert.deepEqual(calls, [['point', {file: 'a.js', line: 3, endLine: 3, note: 'off by one', code: 'i <= n'}]]);
  assert.deepEqual(offered, ['open', 'point', 'read', 'recall', 'say', 'suggest']);
  await partner.close();
});

test('switching the role changes the tools offered and the instructions, from the next turn on', async () => {
  const {faux, models, model} = fauxModels();
  const {hands} = recordingHands('scout');
  const partner = await openPartner({storage: new MemoryStorage(), models, model, hands});
  const id = await partner.createConversation();
  const seen = [];
  const look = context => {
    // pi-durable announces tool changes in system messages; replaying them gives the tools offered now.
    const offered = new Set();
    for (const message of context.messages) {
      for (const tool of message.toolsAdded ?? []) offered.add(tool.name);
      for (const tool of message.toolsRemoved ?? []) offered.delete(tool.name);
    }
    seen.push({offered: [...offered].sort(), system: JSON.stringify(context.messages.filter(message => message.role === 'system'))});
    return fauxAssistantMessage([fauxText('ok')]);
  };
  faux.setResponses([look, look, look, look]);
  await partner.ask(id, '[user] hi');
  await partner.setRole(id, 'scout');
  await partner.ask(id, '[user] where else?');
  await partner.setRole(id, 'driver');
  await partner.ask(id, '[drive] your turn');
  await partner.setRole(id, 'navigator');
  await partner.ask(id, '[user] and now?');
  await partner.close();

  assert.deepEqual(seen[0].offered, ['open', 'point', 'read', 'recall', 'say', 'suggest']);
  assert.deepEqual(seen[1].offered, ['open', 'point', 'read', 'recall', 'run', 'say', 'search', 'suggest']);
  assert.match(seen[1].system, /Your role now: Scout/);
  assert.deepEqual(seen[2].offered, ['edit', 'open', 'point', 'read', 'recall', 'run', 'say', 'search', 'suggest', 'type']);
  assert.match(seen[2].system, /Your role now: Driver/);
  assert.deepEqual(seen[3].offered, ['open', 'point', 'read', 'recall', 'say', 'suggest']);
  assert.match(seen[3].system, /Your role now: Navigator/);
});

test('read is confined to the project root, symlinks included', async () => {
  const root = project();
  const outside = project();
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.js'), 'one\ntwo\n');
  symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));

  assert.ok(await insideRoot(root, 'src/a.js'));
  assert.equal(await insideRoot(root, '../' + outside.split('/').at(-1) + '/secret.txt'), null);
  assert.equal(await insideRoot(root, join(outside, 'secret.txt')), null);
  assert.equal(await insideRoot(root, 'link.txt'), null);
  assert.equal(await insideRoot(root, 'missing.js'), null);
  assert.deepEqual(await readProjectPath(root, 'link.txt'), {error: 'Cannot read link.txt: not inside the project'});
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'secret');
});

test('read lists a directory, "." being the project root', async () => {
  const root = project();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.js'), '');
  writeFileSync(join(root, 'README.md'), '');
  assert.deepEqual(await readProjectPath(root, '.'), {listing: 'README.md\nsrc/'});
  assert.deepEqual(await readProjectPath(root, 'src'), {listing: 'a.js'});
});

test('numberedLines numbers the lines and says how to read on', () => {
  const text = Array.from({length: 500}, (_, i) => `line ${i + 1}`).join('\n');
  assert.equal(numberedLines('a\nb\nc', 2, 3), '2: b\n3: c');
  const first = numberedLines(text).split('\n');
  assert.equal(first.length, 301);
  assert.equal(first.at(-1), '(200 more lines; ask for start_line 301)');
});

test('each kind of turn thinks at its level, a remark for its turn only; a model that cannot is left alone', async () => {
  const thinking = async reasoning => {
    const faux = fauxProvider({models: [{id: 'm', reasoning}]});
    const models = createModels();
    models.setProvider(faux.provider);
    const seen = [];
    const answer = (_context, options) => { seen.push(options?.reasoning ?? 'off'); return fauxAssistantMessage([fauxText('ok')]); };
    faux.setResponses([answer, answer, answer, answer]);
    const thinking = {navigator: 'medium', scout: 'high', driver: 'medium', remark: 'low'};
    const partner = await openPartner({storage: new MemoryStorage(), models, model: faux.getModel(), thinking, hands: recordingHands().hands});
    const id = await partner.createConversation();
    await partner.ask(id, 'a');
    await partner.ask(id, 'b', {kind: 'remark'});
    await partner.ask(id, 'c');
    await partner.setRole(id, 'scout');
    await partner.ask(id, 'd');
    await partner.close();
    return seen;
  };
  assert.deepEqual(await thinking(true), ['medium', 'low', 'medium', 'high']);
  assert.deepEqual(await thinking(false), ['off', 'off', 'off', 'off']);
});
