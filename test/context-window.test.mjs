// Each model's context window, where the config does not set it: from pi-ai's catalog or from the server.
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {DEFAULT_CONTEXT, parseConfig} from '../src/config.mjs';
import {catalogWindow, loadSizedConfig, MAX_FOUND_CONTEXT, servedWindow} from '../src/context-window.mjs';
import {contextCheck} from '../src/doctor.mjs';

/** A server that answers `routes` (path with its query -> JSON) and 404 for the rest; `asked` lists every path. */
async function server(routes) {
  const asked = [];
  const http = createServer((request, response) => {
    asked.push(request.url);
    const body = routes[request.url];
    if (body === undefined) { response.writeHead(404); return response.end(); }
    response.end(JSON.stringify(body));
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  return {url: `http://127.0.0.1:${http.address().port}/v1`, asked, close: () => http.close()};
}

const at = (url, model = 'm') => ({api: 'openai', baseUrl: url, model});

test('what servers say they serve: vLLM in /models, llama.cpp in /props, LM Studio in its model info', async () => {
  const vllm = await server({'/v1/models': {data: [{id: 'm', max_model_len: 65536}]}});
  const llama = await server({'/v1/models': {data: [{id: 'm'}]}, '/props?model=m': {default_generation_settings: {n_ctx: 49152}}});
  const studio = await server({'/v1/models': {data: [{id: 'm'}]}, '/api/v0/models/m': {loaded_context_length: 40960, max_context_length: 262144}});
  const silent = await server({'/v1/models': {data: [{id: 'm'}]}});
  const router = await server({'/v1/models': {data: [{id: 'm', status: {value: 'unloaded'}}]}, '/props?model=m': {default_generation_settings: {n_ctx: 8192}}});
  try {
    assert.equal(await servedWindow(at(vllm.url)), 65536);
    assert.equal(await servedWindow(at(llama.url)), 49152);
    assert.equal(await servedWindow(at(studio.url)), 40960, 'the context it was loaded with, not the most it could take');
    assert.equal(await servedWindow(at(silent.url)), null);
    assert.equal(await servedWindow(at(router.url)), null);
    assert.ok(!router.asked.some(path => path.startsWith('/props')), 'a model a router has not loaded is not asked for: that would load it');
  } finally {
    for (const each of [vllm, llama, studio, silent, router]) each.close();
  }
});

test('the daemon\'s config takes the window from the server or the catalog; the config\'s own wins', async () => {
  const vllm = await server({'/v1/models': {data: [{id: 'm', max_model_len: 65536}, {id: 'huge', max_model_len: 1_000_000}, {id: 'tiny', max_model_len: 8192}]}});
  const dir = mkdtempSync(join(tmpdir(), 'pair-window-'));
  const sized = async raw => {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify(raw));
    return (await loadSizedConfig(path)).models;
  };
  try {
    const one = await sized({model: at(vllm.url)});
    assert.deepEqual([one.partner.contextWindow, one.partner.windowFrom, one.watcher.contextWindow], [65536, 'the server', 65536]);
    assert.equal(one.partner.maxTokens, 10240, 'the reply\'s room follows the window');
    const huge = (await sized({model: at(vllm.url, 'huge')})).partner;
    assert.deepEqual([huge.contextWindow, huge.windowFrom], [MAX_FOUND_CONTEXT, 'the server, which serves 1000000']);
    const own = (await sized({model: {...at(vllm.url), contextWindow: 131072}})).partner;
    assert.deepEqual([own.contextWindow, own.windowFrom, own.servedWindow], [131072, 'config', 65536]);
    assert.equal(contextCheck(own).level, 'warn');
    assert.match(contextCheck(own).text, /^"contextWindow" is 131072, but the server serves 65536/);
    await assert.rejects(sized({model: at(vllm.url, 'tiny')}), /contextWindow is 8192 \(the server; set "contextWindow" to say otherwise\): the Partner needs at least 16384/);
    const provider = (await sized({model: {provider: 'deepseek', model: 'deepseek-flash'}})).partner;
    assert.equal(provider.contextWindow, Math.min(catalogWindow(provider), MAX_FOUND_CONTEXT));
    assert.match(provider.windowFrom, /^pi-ai's catalog/);
    assert.match(contextCheck(provider).text, /tokens \(from pi-ai's catalog/);
  } finally {
    vllm.close();
  }
});

test('without the server or catalog saying, the window is the default', () => {
  const {partner} = parseConfig({model: at('http://box/v1')}).models;
  assert.deepEqual([partner.contextWindow, partner.windowFrom], [DEFAULT_CONTEXT, 'default']);
  assert.equal(catalogWindow({provider: 'deepseek', model: 'no-such-model'}), null);
});

test('a reload keeps a window the server found before when the server cannot be asked now', async () => {
  const vllm = await server({'/v1/models': {data: [{id: 'm', max_model_len: 65536}]}});
  const dir = mkdtempSync(join(tmpdir(), 'pair-window-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({model: at(vllm.url)}));
  const running = await loadSizedConfig(path);
  vllm.close();
  await new Promise(resolve => setTimeout(resolve, 50));
  writeFileSync(path, JSON.stringify({level: 'quiet', model: at(vllm.url)}));
  const reloaded = await loadSizedConfig(path, {before: running});
  assert.deepEqual([reloaded.models.partner.contextWindow, reloaded.models.partner.windowFrom], [65536, 'the server']);
  assert.equal(JSON.stringify(reloaded.models), JSON.stringify(running.models), 'so the models are no change');
  const other = (await loadSizedConfig(path, {before: {...running, models: {...running.models, partner: {...running.models.partner, model: 'x'}}}})).models.partner;
  assert.equal(other.windowFrom, 'default', 'a window found for another model is not kept');
});
