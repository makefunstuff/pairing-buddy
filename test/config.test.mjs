// The config file: JSON with comments, written from the commented example on the first run.
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {apiKeyOf, authPath, createConfig, loadConfig, parseConfig, stripComments} from '../src/config.mjs';

test('comments are stripped, strings with slashes are kept', () => {
  const text = '{\n  // a comment\n  "url": "http://host/v1", /* another */ "say": "a \\" // not a comment"\n}';
  assert.deepEqual(JSON.parse(stripComments(text)), {url: 'http://host/v1', say: 'a " // not a comment'});
});

test('the first run writes the commented example, which loads; later runs keep the file', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pair-config-')), 'pairing-buddy', 'config.json');
  assert.equal(createConfig(path), true);
  assert.match(readFileSync(path, 'utf8'), /^\/\/ pairing-buddy config/);
  const config = loadConfig(path);
  assert.equal(config.level, 'normal');
  assert.equal(config.models.watcher.api, 'openai');

  writeFileSync(path, '{"level": "quiet", "models": {"watcher": {"api": "openai", "baseUrl": "http://x/v1", "model": "w"}, "partner": {"api": "anthropic", "model": "p"}}}');
  assert.equal(createConfig(path), false);
  assert.equal(loadConfig(path).level, 'quiet');
  assert.equal(loadConfig(path).keepWarm, true, 'on for a local Watcher unless turned off');
  writeFileSync(path, '{"models": {"watcher": {"api": "anthropic", "model": "w"}, "partner": {"api": "anthropic", "model": "p"}}}');
  assert.equal(loadConfig(path).keepWarm, false, 'off for a cloud Watcher: nothing to keep loaded, and each ping is paid');
});

test('a broken config says which file and why', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pair-config-')), 'config.json');
  writeFileSync(path, '{"level": "normal",, }');
  assert.throws(() => loadConfig(path), new RegExp(`config: ${path} is not valid JSON`));
  assert.throws(() => loadConfig(join(path, 'missing')), /run `pair setup`/);
});

test('testOnSave maps project folders, ~ included, to the command run on save', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pair-config-'));
  const config = (testOnSave) => parseConfig({testOnSave, models: {watcher: {api: 'anthropic', model: 'w'}, partner: {api: 'anthropic', model: 'p'}}});
  assert.deepEqual(config({[dir]: ' go test -json ./... '}).testOnSave, {[dir]: 'go test -json ./...'});
  assert.deepEqual(Object.keys(config({'~/src/shop': 'npm test'}).testOnSave), [join(homedir(), 'src/shop')]);
  assert.deepEqual(config(undefined).testOnSave, {});
  assert.throws(() => config({[dir]: ''}), /testOnSave\[".*"\] must be a command/);
  assert.throws(() => config(['npm test']), /testOnSave must map project folders to commands/);
});

test('the Partner thinks by default, remarks a little less; the Watcher never does', () => {
  const models = parseConfig({models: {watcher: {api: 'anthropic', model: 'w'}, partner: {api: 'anthropic', model: 'p'}}}).models;
  assert.deepEqual(models.partner.thinking, {navigator: 'medium', scout: 'medium', driver: 'medium', remark: 'low'});
  assert.equal(models.partner.reasoning, true);
  assert.equal(models.watcher.reasoning, false);
  assert.equal(models.watcher.thinking, undefined);
});

test('thinking is one level for every turn, or levels for some kinds; off is a choice', () => {
  const partner = thinking => parseConfig({models: {watcher: {api: 'anthropic', model: 'w'}, partner: {api: 'anthropic', model: 'p', thinking}}}).models.partner;
  assert.deepEqual(partner('off').thinking, {navigator: 'off', scout: 'off', driver: 'off', remark: 'off'});
  assert.deepEqual(partner({driver: 'high', remark: 'medium'}).thinking, {navigator: 'medium', scout: 'medium', driver: 'high', remark: 'medium'});
  assert.throws(() => partner({answer: 'low'}), /thinking\.answer: the kinds are navigator, scout, driver, remark/);
  assert.throws(() => partner('lots'), /"lots" is not one of off, minimal, low/);
  assert.throws(() => partner(['low']), /must be a level or map kinds to levels/);
});

test('maxTokens has room for the most thinking a turn does, and the answer after it', () => {
  const partner = entry => parseConfig({models: {watcher: {api: 'anthropic', model: 'w'}, partner: {api: 'anthropic', model: 'p', ...entry}}}).models.partner;
  assert.equal(partner({}).maxTokens, 2048 + 8192, 'medium');
  assert.equal(partner({thinking: {driver: 'high'}}).maxTokens, 2048 + 16384);
  assert.equal(partner({thinking: 'off'}).maxTokens, 2048);
  assert.equal(partner({maxTokens: 4000}).maxTokens, 4000);
});

test('a model entry names a provider, or an api with one source of its key; mixed ones say what to do', () => {
  const config = watcher => parseConfig({models: {watcher, partner: {api: 'anthropic', model: 'p'}}}).models.watcher;
  assert.equal(config({provider: 'anthropic', model: 'w'}).provider, 'anthropic');
  assert.equal(config({api: 'openai', baseUrl: 'http://x/v1', model: 'w', auth: 'my-server'}).auth, 'my-server');
  assert.throws(() => config({model: 'w'}), /needs a "provider", or an "api": "openai" or "anthropic"/);
  assert.throws(() => config({provider: 'anthropic', api: 'anthropic', model: 'w'}), /names a provider, which brings its own api and baseUrl/);
  assert.throws(() => config({provider: 'anthropic', model: 'w', apiKeyEnv: 'KEY'}), /log in with `pair auth login anthropic` instead of apiKeyEnv/);
  assert.throws(() => config({api: 'openai', baseUrl: 'http://x/v1', model: 'w', auth: 'mine', apiKey: 'k'}), /takes one of auth, apiKey/);
  assert.throws(() => config({provider: '', model: 'w'}), /must be a provider id/);
});

/** Runs `fn` with the environment variables `vars` set (undefined unsets one), then restores them. */
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(name => [name, process.env[name]]));
  const set = values => Object.entries(values).forEach(([name, value]) => (value === undefined ? delete process.env[name] : (process.env[name] = value)));
  set(vars);
  try { fn(); } finally { set(saved); }
}

test('`auth` takes the key `pair auth login` stored under that name, kept next to the config', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pair-config-')), 'auth.json');
  writeFileSync(path, JSON.stringify({'my-server': {type: 'api_key', key: 'sk-stored'}}));
  withEnv({PAIR_AUTH: path}, () => {
    assert.equal(apiKeyOf({auth: 'my-server'}), 'sk-stored');
    assert.equal(apiKeyOf({auth: 'other'}), undefined);
  });
  withEnv({PAIR_AUTH: undefined, PAIR_CONFIG: '/somewhere/pairing-buddy/config.json'}, () => {
    assert.equal(authPath(), '/somewhere/pairing-buddy/auth.json');
  });
});
