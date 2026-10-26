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
  const hands = Object.fromEntries(ROLE_TOOLS.scout.map(name => [name, hand(name)]));
  return {calls, hands: {...hands, roleOf: () => role}};
}

function fauxModels() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return {faux, models, model: faux.getModel()};
}

test('the Navigator has say, point, open and read; Scout adds search and run, and nothing else exists', () => {
  const {hands} = recordingHands();
  assert.deepEqual(ROLE_TOOLS.navigator, ['say', 'point', 'open', 'read']);
  assert.deepEqual(ROLE_TOOLS.scout, ['say', 'point', 'open', 'read', 'search', 'run']);
  assert.deepEqual(pairExtension(hands).tools.map(tool => tool.name), ROLE_TOOLS.scout);
});

test('the policy blocks every tool outside the role', () => {
  for (const name of ROLE_TOOLS.navigator) assert.equal(toolPolicy({name}, 'navigator'), undefined);
  for (const name of ROLE_TOOLS.scout) assert.equal(toolPolicy({name}, 'scout'), undefined);
  for (const name of ['search', 'run']) assert.match(toolPolicy({name}, 'navigator').block, /needs the Scout role/);
  for (const name of ['write', 'edit', 'bash', 'save', 'Say', 'read_file']) {
    assert.match(toolPolicy({name}, 'navigator').block, /only say, point, open, read\.$/);
    assert.match(toolPolicy({name}, 'scout').block, /only say, point, open, read, search, run\.$/);
  }
});

test('the policy holds even if file-writing tools are installed and selected by mistake', async () => {
  const root = project();
  const {faux, models, model} = fauxModels();
  const {calls, hands} = recordingHands();
  const navigator = pairExtension(hands);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(navigator);
  const harness = await Harness.open(new MemoryStorage(), {
    models, registry,
    settings: {extensions: [CodingTools, navigator]},
    env: () => new NodeExecutionEnv({cwd: root}),
  }, C);
  const conversation = await harness.createConversation({ownership: {kind: 'ownerless'}, agent: {model: {provider: model.provider, modelId: model.id}}}, C);
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall('write', {path: join(root, 'pwned.txt'), content: 'x'}),
      fauxToolCall('bash', {command: `touch ${join(root, 'bashed.txt')}`}),
      fauxToolCall('say', {text: 'hello'}),
    ], {stopReason: 'toolUse'}),
    fauxAssistantMessage([fauxText('ok')]),
  ]);
  await (await conversation.submit({type: 'input', content: 'go'}, C)).wait(C);
  await harness.close(C);

  assert.equal(existsSync(join(root, 'pwned.txt')), false);
  assert.equal(existsSync(join(root, 'bashed.txt')), false);
  assert.deepEqual(calls, [['say', 'hello']]);
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
      return fauxAssistantMessage([fauxToolCall('edit', {path: 'a.js', oldText: 'a', newText: 'b'}), fauxToolCall('point', {file: 'a.js', line: 3, note: 'off by one'})], {stopReason: 'toolUse'});
    },
    fauxAssistantMessage([fauxText('Line 3 loops one too far.')]),
  ]);
  assert.equal(await partner.ask(id, '[user] what is wrong?'), 'Line 3 loops one too far.');
  assert.deepEqual(calls, [['point', {file: 'a.js', line: 3, endLine: 3, note: 'off by one'}]]);
  assert.deepEqual(offered, ['open', 'point', 'read', 'say']);
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
  faux.setResponses([look, look, look]);
  await partner.ask(id, '[user] hi');
  await partner.setRole(id, 'scout');
  await partner.ask(id, '[user] where else?');
  await partner.setRole(id, 'navigator');
  await partner.ask(id, '[user] and now?');
  await partner.close();

  assert.deepEqual(seen[0].offered, ['open', 'point', 'read', 'say']);
  assert.deepEqual(seen[1].offered, ['open', 'point', 'read', 'run', 'say', 'search']);
  assert.match(seen[1].system, /Your role now: Scout/);
  assert.deepEqual(seen[2].offered, ['open', 'point', 'read', 'say']);
  assert.match(seen[2].system, /Your role now: Navigator/);
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
