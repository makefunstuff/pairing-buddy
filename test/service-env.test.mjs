// The variables named by "apiKeyEnv", stored for a service that does not get the shell's environment.
import assert from 'node:assert/strict';
import {chmodSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {apiKeyOf, parseConfig} from '../src/config.mjs';
import {keysCheck} from '../src/doctor.mjs';
import {keyVariables, readServiceEnv, storeServiceEnv} from '../src/service-env.mjs';
import {scratch as tempDir} from './temp.mjs';

const scratch = () => tempDir('pair-env-');
const entry = name => ({api: 'openai', baseUrl: 'http://unused', model: 'm', apiKeyEnv: name});

test('the variables the config takes keys from, each once', () => {
  const config = parseConfig({models: {watcher: entry('WATCH_KEY'), partner: entry('PARTNER_KEY')}});
  assert.deepEqual(keyVariables(config), ['WATCH_KEY', 'PARTNER_KEY']);
  assert.deepEqual(keyVariables(parseConfig({model: entry('ONE_KEY')})), ['ONE_KEY']);
  assert.deepEqual(keyVariables(parseConfig({model: {api: 'openai', baseUrl: 'http://unused', model: 'm'}})), []);
});

test('setup stores the variables this shell has, readable by its owner only, and keeps the others stored', () => {
  const path = join(scratch(), 'pairing-buddy', 'service.env');
  assert.deepEqual(storeServiceEnv(path, ['A_KEY'], {A_KEY: 'first'}), {stored: ['A_KEY'], missing: []});
  assert.deepEqual(storeServiceEnv(path, ['B_KEY', 'C_KEY'], {B_KEY: 'sk-b=c'}), {stored: ['B_KEY'], missing: ['C_KEY']});
  assert.deepEqual(readServiceEnv(path), {A_KEY: 'first', B_KEY: 'sk-b=c'});
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('nothing to store writes no file', () => {
  const path = join(scratch(), 'service.env');
  assert.deepEqual(storeServiceEnv(path, ['A_KEY'], {}), {stored: [], missing: ['A_KEY']});
  assert.deepEqual(readServiceEnv(path), {});
});

test('without the variable in its environment, the daemon reads the key from the stored file', () => {
  const dir = scratch();
  const previous = process.env.PAIR_CONFIG;
  process.env.PAIR_CONFIG = join(dir, 'config.json');
  try {
    writeFileSync(join(dir, 'service.env'), 'PAIR_TEST_STORED_KEY=sk-stored\n', {mode: 0o600});
    assert.equal(apiKeyOf(entry('PAIR_TEST_STORED_KEY')), 'sk-stored');
    process.env.PAIR_TEST_STORED_KEY = 'sk-shell';
    assert.equal(apiKeyOf(entry('PAIR_TEST_STORED_KEY')), 'sk-shell'); // the environment wins
  } finally {
    delete process.env.PAIR_TEST_STORED_KEY;
    if (previous === undefined) delete process.env.PAIR_CONFIG; else process.env.PAIR_CONFIG = previous;
  }
});

test('doctor names a variable only the shell has, one set nowhere, and a file others can read', () => {
  const path = join(scratch(), 'service.env');
  assert.match(keysCheck(['A_KEY'], {A_KEY: 'x'}, path).text, /^A_KEY is set in this shell only, which the service does not see: run `pair setup`/);
  assert.equal(keysCheck(['A_KEY'], {A_KEY: 'x'}, path).level, 'warn');
  assert.equal(keysCheck(['A_KEY'], {}, path).level, 'fail');
  assert.match(keysCheck(['A_KEY'], {}, path).text, /^A_KEY is not set/);
  storeServiceEnv(path, ['A_KEY'], {A_KEY: 'x'});
  assert.equal(keysCheck(['A_KEY'], {}, path).level, 'ok');
  chmodSync(path, 0o644);
  assert.match(keysCheck(['A_KEY'], {}, path).text, /others can read it: chmod 600/);
});
