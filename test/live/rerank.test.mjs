// Search by meaning's reranker with real models: EmbeddingGemma 2 indexes Pair's own repository, and a decision model
// reranks the first pieces of each search. It asks the labelled questions of test/fixtures/rerank-queries.json (worded
// unlike the code, and seven about the docs) and prints recall@5 and MRR before and after the rerank, and how long the
// rerank took. Set PAIR_LIVE_RERANK to the "rerank" entry as JSON, for example
// '{"api": "system-one", "baseUrl": "http://127.0.0.1:8080/v1", "model": "d1-2B"}', and PAIR_LIVE_MEANING=1 with
// PAIR_LIVE_MEANING_DATA, a data folder whose EmbeddingGemma (and index of this repository) is kept between runs: the
// first run downloads the model and builds the index, about five minutes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {rerankConfig} from '../../src/config.mjs';
import {Meaning} from '../../src/meaning.mjs';
import {createDecisionModel} from '../../src/models.mjs';
import {Reranker} from '../../src/rerank.mjs';
import {scratch} from '../temp.mjs';

const skip = process.env.PAIR_LIVE_RERANK && process.env.PAIR_LIVE_MEANING ? false : 'set PAIR_LIVE_RERANK (a "rerank" entry as JSON) and PAIR_LIVE_MEANING=1 to measure the reranker';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const {queries} = JSON.parse(readFileSync(new URL('../fixtures/rerank-queries.json', import.meta.url), 'utf8'));

const relevant = (query, result) => result.file === query.file && (result.head ?? '').includes(query.name);
const rankOf = (query, results) => results.findIndex(result => relevant(query, result)) + 1; // 0: not in the list
const recall5 = ranks => ranks.filter(rank => rank >= 1 && rank <= 5).length / ranks.length;
const mrr = ranks => ranks.reduce((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / ranks.length;
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];

test('the reranker on Pair\'s own repository: recall@5 and MRR before and after, and its time', {skip, timeout: 1_800_000}, async () => {
  const entry = rerankConfig(JSON.parse(process.env.PAIR_LIVE_RERANK)); // the shipped budget, unless the entry sets one
  const reranker = new Reranker({...createDecisionModel({rerank: entry}, {field: 'rerank'}), entry, log: line => console.log(line)});
  const dataDir = process.env.PAIR_LIVE_MEANING_DATA ?? scratch('rerank-live-data-');
  const meaning = new Meaning({dataDir, config: process.env.PAIR_LIVE_MEANING_PYTHON ? {python: process.env.PAIR_LIVE_MEANING_PYTHON} : {}, reranker, log: () => {}});
  try {
    meaning.open(ROOT);
    await meaning.turnOn();
    await meaning.indexes.get(ROOT).ready;
    const started = Date.now();
    while ((meaning.working || meaning.indexes.get(ROOT).pending().length) && !meaning.problem && Date.now() - started < 1_500_000) await new Promise(resolve => setTimeout(resolve, 500));
    assert.ok(!meaning.problem, meaning.problem ?? '');
    const rows = [];
    for (const query of queries) {
      const plain = await meaning.search(ROOT, query.query, {rerank: false, book: false});
      const reranked = await meaning.search(ROOT, query.query, {book: false});
      rows.push({query, before: rankOf(query, plain.results), after: rankOf(query, reranked.results), ms: reranked.rerank?.ms ?? 0, why: reranked.rerank ? reranked.rerank.why : 'resting'});
      const last = rows.at(-1);
      console.log(`${String(last.before).padStart(2)} → ${String(last.after).padStart(2)}  ${String(last.ms).padStart(5)} ms${last.why ? ` (kept: ${last.why})` : ''}  ${query.query}`);
    }
    const report = (name, subset) => {
      const before = subset.map(row => row.before);
      const after = subset.map(row => row.after);
      console.log(`${name} (${subset.length}): recall@5 ${recall5(before).toFixed(2)} → ${recall5(after).toFixed(2)}, MRR ${mrr(before).toFixed(2)} → ${mrr(after).toFixed(2)}`);
    };
    report('all', rows);
    report('code', rows.filter(row => !row.query.file.endsWith('.md')));
    report('docs', rows.filter(row => row.query.file.endsWith('.md')));
    const ms = rows.map(row => row.ms);
    console.log(`rerank of ${entry.top} pieces with ${reranker.name}: p50 ${percentile(ms, 0.5)} ms, p95 ${percentile(ms, 0.95)} ms, max ${Math.max(...ms)} ms; applied within its ${entry.timeoutMs} ms: ${rows.filter(row => !row.why).length} of ${rows.length}`);
  } finally {
    await meaning.close();
  }
});
