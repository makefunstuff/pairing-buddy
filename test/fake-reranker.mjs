// A fake decision model for search by meaning's reranker: a System One server (`POST <baseUrl>/systemone`) that
// answers a choice question with a probability for each answer, as LiquidAI's d1-2B on llama.cpp does, and writes no
// text. It favours the answers whose text has `favourite`; `mode` makes it slow, fail, or answer oddly.
import {createServer} from 'node:http';
import {rerankConfig} from '../src/config.mjs';
import {createRerankEndpoints} from '../src/models.mjs';
import {Reranker} from '../src/rerank.mjs';

/**
 * Starts the server: `{baseUrl, requests, flight, set({favourite, mode, delayMs}), close()}`. `mode` is "ok", "down" (500),
 * "malformed" (no probabilities), "flat" (all the same) or "slow" (waits `delayMs` first). `requests` lists each body.
 */
export async function fakeRerankServer({favourite = '', mode = 'ok', delayMs = 0} = {}) {
  const state = {favourite, mode, delayMs};
  const requests = [];
  const flight = {now: 0, most: 0}; // questions the server works on at once, and the most at any time
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', async () => {
      const send = (status, value) => {
        if (response.destroyed) return;
        response.writeHead(status, {'content-type': 'application/json'});
        response.end(JSON.stringify(value));
      };
      if (request.method !== 'POST' || !request.url.endsWith('/systemone')) return send(404, {error: {message: 'File Not Found'}});
      const parsed = JSON.parse(body);
      requests.push(parsed);
      flight.most = Math.max(flight.most, ++flight.now);
      // It works on a question to its end, as a server that does not stop when the client goes.
      if (state.mode === 'slow') await new Promise(resolve => setTimeout(resolve, state.delayMs));
      flight.now -= 1;
      if (state.mode === 'down') return send(500, {error: {message: 'the model is loading'}});
      const answers = {};
      for (const [name, question] of Object.entries(parsed.questions ?? {})) {
        const labels = Object.keys(question.criteria);
        const weight = label => (state.mode === 'flat' ? 1 : state.favourite && question.criteria[label].includes(state.favourite) ? 20 : 1 / (Number(label) || 1));
        const sum = labels.reduce((total, label) => total + weight(label), 0);
        const probabilities = Object.fromEntries(labels.map(label => [label, weight(label) / sum]));
        const choice = labels.reduce((best, label) => (probabilities[label] > probabilities[best] ? label : best), labels[0]);
        answers[name] = state.mode === 'malformed' ? {type: 'choice', choice} : {type: 'choice', choice, probabilities, confidence: probabilities[choice]};
      }
      send(200, {model: 'fake-d1', answers, usage: {input_tokens: 10, output_tokens: 0}});
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  return {
    baseUrl, requests, flight,
    set(changes) { Object.assign(state, changes); },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}

/** The config's `rerank` entry for the fake at `baseUrl`, parsed as the daemon parses it. */
export const fakeRerankEntry = (baseUrl, extra = {}) => rerankConfig({api: 'system-one', baseUrl, model: 'fake-d1', ...extra})[0];

/** A Reranker on the fake at `baseUrl`, built as the daemon builds one. */
export function fakeReranker(baseUrl, extra = {}, options = {}) {
  return fakeRerankChain([{baseUrl, ...extra}], options);
}

/** A Reranker on a list of fakes, best first: each `{baseUrl, model, ...}` a "rerank" entry of the list. */
export function fakeRerankChain(entries, options = {}) {
  const rerank = rerankConfig(entries.length > 1 ? entries.map(entry => ({api: 'system-one', model: 'fake-d1', ...entry})) : {api: 'system-one', model: 'fake-d1', ...entries[0]});
  return new Reranker({endpoints: createRerankEndpoints({rerank}, {credentials: {read: async () => null}}), ...options});
}
