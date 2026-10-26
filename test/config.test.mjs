// The config file: JSON with comments, written from the commented example on the first run.
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createConfig, loadConfig, parseConfig, rolesText, sameModel, stripComments} from '../src/config.mjs';

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
  assert.equal(partner({thinking: {driver: 'high'}, contextWindow: 65536}).maxTokens, 2048 + 16384);
  assert.equal(partner({thinking: 'off'}).maxTokens, 2048);
  assert.equal(partner({maxTokens: 4000}).maxTokens, 4000);
});

test('in a small context window the reply takes at most a third, and below the minimum the config says why', () => {
  const partner = entry => parseConfig({models: {watcher: {api: 'anthropic', model: 'w'}, partner: {api: 'anthropic', model: 'p', ...entry}}}).models.partner;
  assert.equal(partner({thinking: 'high'}).maxTokens, 10922, 'a third of the default 32768');
  assert.equal(partner({contextWindow: 16384}).maxTokens, 5461);
  assert.equal(partner({contextWindow: 16384, thinking: 'off'}).maxTokens, 2048);
  assert.throws(() => partner({contextWindow: 8192}), /models\.partner\.contextWindow is 8192: the Partner needs at least 16384 tokens/);
});

test('one model for both roles: "model", or the Watcher "same as partner"; each role asks it its own way', () => {
  const entry = {api: 'openai', baseUrl: 'http://box/v1', model: 'm', contextWindow: 65536, thinking: 'high', samplingParams: {temperature: 0.3}, compat: {thinkingFormat: 'x'}};
  const one = parseConfig({model: entry}).models;
  const same = parseConfig({models: {watcher: 'same as partner', partner: entry}}).models;
  assert.deepEqual(one, same);
  assert.equal(sameModel(one.watcher, one.partner), true);
  assert.deepEqual(one.partner.thinking, {navigator: 'high', scout: 'high', driver: 'high', remark: 'high'});
  assert.equal(one.partner.maxTokens, 2048 + 16384);
  assert.equal(one.watcher.reasoning, true, 'marked as a model that thinks, so its thinking is switched off');
  assert.equal(one.watcher.thinking, undefined);
  assert.equal(one.watcher.samplingParams, undefined, 'the Watcher runs at temperature 0');
  assert.equal(one.watcher.maxTokens, 2048);
  assert.deepEqual(one.watcher.compat, {thinkingFormat: 'x'});
  assert.equal(parseConfig({model: {...entry, reasoning: false}}).models.watcher.reasoning, false, 'a model that cannot think');
  assert.equal(rolesText(one), 'one model for both roles: m at http://box/v1');
  assert.equal(rolesText(parseConfig({models: {watcher: {...entry, model: 'w'}, partner: entry}}).models), 'the Watcher w at http://box/v1, the Partner m at http://box/v1');

  assert.throws(() => parseConfig({model: entry, models: {partner: entry}}), /set "model" \(one model for both roles\) or "models", not both/);
  assert.throws(() => parseConfig({models: {watcher: 'same', partner: entry}}), /models\.watcher is a model entry, or "same as partner"/);
  assert.throws(() => parseConfig({model: {api: 'openai', model: 'm'}}), /config: model\.baseUrl is missing/);
  assert.throws(() => parseConfig({model: {...entry, thinking: 'lots'}}), /config: model\.thinking: "lots" is not one of/);
});
