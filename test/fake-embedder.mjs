// A fake embedder for search by meaning's tests: words that mean the same land on the same numbers, so a search worded
// unlike the code still finds it, as EmbeddingGemma does, without its model or runtime. And a model "downloaded" into a
// data folder, which modelReady takes for the checked one.
import {statSync, writeFileSync, mkdirSync} from 'node:fs';
import {DIMENSIONS, MODEL, meaningDir, modelPath} from '../src/embedder.mjs';
import {words} from '../src/meaning.mjs';

// Each group is one meaning: any of its words counts as the first.
const MEANINGS = [
  ['retry', 'again', 'attempt', 'attempts', 'backoff', 'retries', 'redo'],
  ['fail', 'fails', 'failure', 'error', 'errors', 'broken', 'crash', 'throw'],
  ['money', 'price', 'prices', 'cost', 'invoice', 'total', 'cents', 'pay'],
  ['speak', 'say', 'talk', 'remark', 'quiet', 'voice'],
];
const meaningOf = new Map(MEANINGS.flatMap(group => group.map(word => [word, group[0]])));

const slot = word => {
  let hash = 0;
  for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % DIMENSIONS;
};

/** The fake's vector of `text`: its words' meanings, and a little of the words themselves, normalized. */
export function fakeVector(text) {
  const body = text.replace(/^title: (.*?) \| text: /, '').replace(/^task: search result \| query: /, '');
  const vector = new Float32Array(DIMENSIONS);
  for (const word of words(body)) {
    const meaning = meaningOf.get(word);
    vector[slot(meaning ?? word)] += meaning ? 1 : 0.2; // a word of its own counts a little: real models see words too
  }
  vector[DIMENSIONS - 1] += 0.1; // nothing in common is still a little similar, as with a real model
  const norm = Math.hypot(...vector);
  return vector.map(value => value / norm);
}

/** An embedder as Meaning uses one; `calls` lists every batch it got, `failWith` makes the next calls fail. */
export function fakeEmbedder() {
  const embedder = {
    python: 'fake-python', runtime: {runtime: 'fake'}, msPerText: 1, calls: [], failWith: null, busy: false,
    async embed(texts, {urgent = false} = {}) {
      embedder.calls.push({texts, urgent});
      if (embedder.failWith) throw new Error(embedder.failWith);
      return texts.map(fakeVector);
    },
    stopHelper() {},
    fail() {},
    close() {},
  };
  return embedder;
}

/** Puts a model file in `dataDir` with the checksum note a real download leaves: search by meaning is on. */
export function fakeModel(dataDir) {
  mkdirSync(meaningDir(dataDir), {recursive: true});
  writeFileSync(modelPath(dataDir), 'not a model');
  const stat = statSync(modelPath(dataDir));
  writeFileSync(`${modelPath(dataDir)}.sha256`, JSON.stringify({sha256: MODEL.sha256, size: stat.size, mtimeMs: stat.mtimeMs}));
}
