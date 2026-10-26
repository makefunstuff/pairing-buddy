// The config file: JSON with comments, written from the commented example on the first run.
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createConfig, loadConfig, parseConfig, stripComments} from '../src/config.mjs';

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

test('a model that can think gets room for its thinking in the answer', () => {
  assert.equal(parseConfig({models: {watcher: {api: 'anthropic', model: 'w'}, partner: {api: 'anthropic', model: 'p'}}}).models.partner.maxTokens, 2048);
  assert.equal(parseConfig({models: {watcher: {api: 'anthropic', model: 'w'}, partner: {api: 'anthropic', model: 'p', reasoning: true}}}).models.partner.maxTokens, 8192);
  assert.equal(parseConfig({models: {watcher: {api: 'anthropic', model: 'w'}, partner: {api: 'anthropic', model: 'p', reasoning: true, maxTokens: 4000}}}).models.partner.maxTokens, 4000);
});
