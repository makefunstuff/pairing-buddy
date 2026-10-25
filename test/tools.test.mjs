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
import {insideRoot, numberedLines} from '../src/files.mjs';
import {openPartner} from '../src/partner.mjs';
import {ALLOWED_TOOLS, navigatorExtension, toolPolicy} from '../src/tools.mjs';

const project = () => mkdtempSync(join(tmpdir(), 'pair-tools-'));

function recordingHands() {
  const calls = [];
  const hand = name => async (conversationId, args) => { calls.push([name, args]); return `${name} done`; };
  return {calls, hands: {say: hand('say'), point: hand('point'), open: hand('open'), read: hand('read')}};
}

function fauxModels() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return {faux, models, model: faux.getModel()};
}

test('the Navigator has exactly say, point, open and read', () => {
  const {hands} = recordingHands();
  assert.deepEqual(navigatorExtension(hands).tools.map(tool => tool.name).sort(), ['open', 'point', 'read', 'say']);
  assert.deepEqual([...ALLOWED_TOOLS].sort(), ['open', 'point', 'read', 'say']);
});

test('the policy blocks every other tool name', () => {
  for (const name of ALLOWED_TOOLS) assert.equal(toolPolicy({name}), undefined);
  for (const name of ['write', 'edit', 'bash', 'save', 'Say', 'read_file']) assert.match(toolPolicy({name}).block, /only say, point, open and read/);
});

test('the policy holds even if file-writing tools are installed and selected by mistake', async () => {
  const root = project();
  const {faux, models, model} = fauxModels();
  const {calls, hands} = recordingHands();
  const navigator = navigatorExtension(hands);
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

test('the Partner offers the model only the Navigator tools and answers with its final text', async () => {
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
  assert.equal(await insideRoot(root, '.'), null);
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'secret');
});

test('numberedLines numbers the lines and says how to read on', () => {
  const text = Array.from({length: 500}, (_, i) => `line ${i + 1}`).join('\n');
  assert.equal(numberedLines('a\nb\nc', 2, 3), '2: b\n3: c');
  const first = numberedLines(text).split('\n');
  assert.equal(first.length, 301);
  assert.equal(first.at(-1), '(200 more lines; ask for start_line 301)');
});
