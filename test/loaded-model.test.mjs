import assert from 'node:assert/strict';
import {test} from 'node:test';
import {followLoaded, loadedIds, shareServer} from '../src/loaded-model.mjs';

const entries = {
  watcher: {api: 'openai', baseUrl: 'http://models/v1', model: 'small'},
  partner: {api: 'openai', baseUrl: 'http://models/v1', model: 'large'},
};

test('loadedIds reads both ways servers say what is loaded, and null from servers that do not say', () => {
  assert.deepEqual(loadedIds([{id: 'small', status: {value: 'unloaded'}}, {id: 'large', status: {value: 'loaded'}}]), new Set(['large']));
  assert.deepEqual(loadedIds([{id: 'small', loaded: false}, {id: 'large', loaded: true}]), new Set(['large']));
  assert.deepEqual(loadedIds([{id: 'small', loaded: false}]), new Set());
  assert.equal(loadedIds([{id: 'small'}, {id: 'large'}]), null);
  assert.equal(loadedIds(null), null);
});

test('only two different models on one OpenAI-compatible server share it', () => {
  assert.equal(shareServer(entries.watcher, entries.partner), true);
  assert.equal(shareServer(entries.watcher, {...entries.partner, model: 'small'}), false, 'one model for both roles');
  assert.equal(shareServer(entries.watcher, {...entries.partner, baseUrl: 'http://other/v1'}), false);
  assert.equal(shareServer(entries.watcher, {api: 'anthropic', model: 'large'}), false);
});

test('the Watcher uses the Partner\'s model while only that one is loaded, and its own otherwise', async () => {
  let listed;
  const logged = [];
  const choose = followLoaded({entries, watcher: 'W', partner: 'P', list: async () => listed, log: line => logged.push(line)});
  listed = [{id: 'small', loaded: false}, {id: 'large', loaded: true}];
  assert.equal(await choose(), 'P');
  assert.equal(await choose(), 'P');
  assert.equal(logged.length, 1, 'a switch is logged once');
  listed = [{id: 'small', loaded: true}, {id: 'large', loaded: true}];
  assert.equal(await choose(), 'W', 'both loaded: each role its own');
  listed = [{id: 'small', loaded: false}, {id: 'large', loaded: false}];
  assert.equal(await choose(), 'W', 'nothing loaded: the Watcher loads its own');
  listed = [{id: 'small'}, {id: 'large'}];
  assert.equal(await choose(), 'W', 'a server that does not say');
  const down = followLoaded({entries, watcher: 'W', partner: 'P', list: async () => { throw new Error('ECONNREFUSED'); }});
  assert.equal(await down(), 'W', 'a server that does not answer: the call itself reports it');
});
