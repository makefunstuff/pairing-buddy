// The daemon takes a saved config without a restart; a config with an error is refused, and the old one stays.
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, renameSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createModels, fauxAssistantMessage, fauxProvider, fauxText} from '@earendil-works/pi-ai';
import {loadConfig, parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {configChanges, watchConfig} from '../src/reload.mjs';
import {client} from './daemon-client.mjs';

const entry = model => ({api: 'openai', baseUrl: 'http://unused', model});

test('the fields that changed, in the order the chat names them', () => {
  const running = parseConfig({model: entry('a'), level: 'quiet'});
  assert.deepEqual(configChanges(running, parseConfig({model: entry('a'), level: 'quiet'})), []);
  assert.deepEqual(configChanges(running, parseConfig({model: entry('b'), level: 'chatty', dataDir: '/elsewhere'})), ['models', 'level', 'dataDir']);
});

test('a saved config is read again; one with an error is reported, and a save that changes nothing is no change', {timeout: 10_000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pair-reload-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({model: entry('a')}));
  const seen = [];
  let wake;
  const next = () => new Promise(resolve => { wake = resolve; });
  const watch = watchConfig(path, {
    onChange: config => { seen.push(`model ${config.models.partner.model}`); wake(); },
    onError: message => { seen.push(message); wake(); },
    settleMs: 20,
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    let event = next();
    writeFileSync(path, '{"model": {"api": "openai", "baseUrl": "http://unused", "model": "b"} // a comment\n}');
    await event;
    event = next();
    writeFileSync(path, JSON.stringify({model: entry('b'), level: 'loud'}));
    await event;
    // An editor that saves by writing a new file and renaming it over the config.
    event = next();
    writeFileSync(join(dir, 'config.json.tmp'), JSON.stringify({model: entry('c')}));
    renameSync(join(dir, 'config.json.tmp'), path);
    await event;
    writeFileSync(path, JSON.stringify({model: entry('c')}));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(seen, ['model b', 'config: level must be one of quiet, normal, chatty', 'model c']);
  } finally {
    watch.close();
  }
});

test('the daemon takes a new model between turns, and keeps the old config when the new one has an error', {timeout: 20_000}, async () => {
  const project = mkdtempSync(join(tmpdir(), 'pair-project-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'pair-data-'));
  const configFile = join(dataDir, 'config', 'config.json');
  mkdirSync(join(dataDir, 'config'));
  const save = raw => writeFileSync(configFile, JSON.stringify({dataDir, socket: join(dataDir, 'pair.sock'), ...raw}));
  save({model: entry('first'), testOnSave: {[project]: 'npm test'}});

  // Each model name the config can give gets its own scripted provider.
  const providers = new Map();
  const modelsFor = config => {
    const name = config.models.partner.model;
    if (!providers.has(name)) providers.set(name, fauxProvider({provider: `faux-${name}`}));
    const faux = providers.get(name);
    const models = createModels();
    models.setProvider(faux.provider);
    return {models, watcher: faux.getModel(), partner: faux.getModel()};
  };
  const daemon = await startDaemon(loadConfig(configFile), {configFile, modelsFor, probe: async () => ({ok: true}), log: () => {}});
  const chat = client(join(dataDir, 'pair.sock'), {type: 'hello', role: 'chat', cwd: project});
  const editor = client(join(dataDir, 'pair.sock'), {type: 'hello', role: 'editor', cwd: project});
  try {
    await chat.next(message => message.type === 'welcome');
    chat.send({type: 'goal', text: 'fix reconnect'});
    providers.get('first').setResponses([fauxAssistantMessage([fauxText('First model.')])]);
    chat.send({type: 'ask', text: 'who answers?'});
    await chat.next(message => message.text === 'First model.');

    // A change saved while the Partner answers takes effect after that answer.
    const slow = () => new Promise(resolve => setTimeout(() => resolve(fauxAssistantMessage([fauxText('First, slowly.')])), 300));
    providers.get('first').setResponses([slow]);
    chat.send({type: 'ask', text: 'take your time'});
    while (providers.get('first').getPendingResponseCount()) await new Promise(resolve => setTimeout(resolve, 10));
    save({model: entry('second'), level: 'quiet'});
    await chat.next(message => message.text === 'First, slowly.');
    await chat.next(message => message.text === 'Config reloaded: models, level, testOnSave. The talk level is for new sessions; /level sets this one\'s.');
    await editor.next(message => message.text?.startsWith('Config reloaded: models'));
    providers.get('second').setResponses([fauxAssistantMessage([fauxText('Second model.')])]);
    chat.send({type: 'ask', text: 'and now?'});
    await chat.next(message => message.text === 'Second model.');

    save({model: entry('third'), level: 'loud'});
    await chat.next(message => message.text === 'The config has an error, so Pair keeps the one it runs: config: level must be one of quiet, normal, chatty');
    providers.get('second').setResponses([fauxAssistantMessage([fauxText('Still the second.')])]);
    chat.send({type: 'ask', text: 'and now?'});
    await chat.next(message => message.text === 'Still the second.');

    save({model: entry('second'), level: 'quiet', socket: join(dataDir, 'elsewhere.sock')});
    await chat.next(message => message.text === 'socket changes only when the daemon restarts.');
  } finally {
    chat.close();
    editor.close();
    await daemon.close();
  }
});
