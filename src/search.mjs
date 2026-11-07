// Search by meaning, as Pair runs it: semantic-grep's Meaning (its index, word search, meaning search and rerank; see
// docs/meaning.md) with what is Pair's own. EmbeddingGemma 2 on LiteRT-LM (embedder.mjs) is the model when the config
// has no "embedding" one: Pair installs LiteRT-LM in a venv of its own (runtime.mjs, shared with voice's LFM3-Omni) and
// downloads the model once, as `:Pair find on`, through Meaning's `provider` hook. A "meaning": {"profile": ...} names
// the "embedding" and "rerank" models instead (config.mjs), and "meaning": {"notes": ...} a model that writes notes on
// the pieces while nothing is searched. The index lives in Pair's data folder, or in .pair/ of the repository with
// "meaning": {"index": "project"}; builds, searches, reranks and notes go to the ledger (the daemon's `book`).
import {existsSync, renameSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {HttpEmbedder, Meaning, Reranker} from 'semantic-grep';
import {apiKeyOf, primeKeyCommands, withPairKey} from './config.mjs';
import {downloadModel, Embedder, meaningDir, MODEL, modelPath, modelReady, pythonOf, removeModel} from './embedder.mjs';
import {voicePythonsOn} from './omni.mjs';
import {Runtime, RUNTIME_VERSION} from './runtime.mjs';

/** Where the index goes with "meaning": {"index": "project"}: .pair/ in the repository, as before semantic-grep. */
export const PROJECT_DIR = '.pair';

/**
 * EmbeddingGemma 2 on LiteRT-LM, as Meaning's `provider`: `state()` is "off" until the model is downloaded and checked,
 * "installing" or "downloading" while `turnOn` fetches, then "on". `turnOn` installs LiteRT-LM (unless the config has
 * its own meaning.python) and downloads the model, each once and only if missing; either failing, what it half did is
 * deleted and the word search goes on. `turnOff` stops a fetch under way and deletes the model and the venv Pair made
 * (never meaning.python, nor while `keepVenv()`: voice's LFM3-Omni needs it).
 */
export class GemmaProvider {
  constructor({dataDir, meaning = {}, embedder, runtime = null, fetch = globalThis.fetch, log = () => {}}) {
    Object.assign(this, {dataDir, meaning, embedder, runtime, fetch, log});
    this.name = MODEL.name;
    this.downloading = null; // {phase: 'runtime' or 'model', bytes, total, abort, done} while turnOn fetches
    this.keepVenv = () => false; // the daemon's: true while voice's LFM3-Omni needs the venv
  }

  state() {
    if (this.downloading?.phase) return this.downloading.phase === 'runtime' ? 'installing' : 'downloading';
    return modelReady(this.dataDir) ? 'on' : 'off';
  }

  /**
   * What `turnOn` would fetch: `{runtime}` when LiteRT-LM is to be installed (with its wheel's size, or null without
   * one for this machine) and `model` when EmbeddingGemma is to be downloaded.
   */
  async needs() {
    const model = !modelReady(this.dataDir);
    if (!this.runtime || this.meaning?.python) return {runtime: null, model}; // the config's Python is the user's to fill
    const found = await this.runtime.check();
    return {runtime: found.version === RUNTIME_VERSION ? null : {bytes: this.runtime.bytes}, model}; // an older one is installed again
  }

  /**
   * Installs LiteRT-LM and downloads the model, each once and only if missing. `progress({phase, bytes, total})` hears
   * how far. Resolves `{runtime, model}`: what pip installed (`{python, version, pythonVersion, made}`) or null, and
   * whether the model was downloaded.
   */
  async turnOn({progress = () => {}} = {}) {
    if (this.downloading) return this.downloading.done.then(() => ({runtime: null, model: false}));
    const abort = new AbortController();
    const turning = this.downloading = {phase: null, bytes: 0, total: null, abort};
    const told = (phase, bytes, total) => {
      Object.assign(turning, {phase, bytes, total});
      progress({phase, bytes, total});
    };
    turning.done = (async () => {
      const needs = await this.needs();
      if (abort.signal.aborted) throw abort.signal.reason;
      let runtime = null;
      if (needs.runtime) {
        told('runtime', 0, needs.runtime.bytes);
        // A Python voice's packages fit, when there is one: voice shares this venv (omni.mjs).
        runtime = await this.runtime.install({signal: abort.signal, progress: (bytes, total) => told('runtime', bytes, total), prefer: voicePythonsOn()});
        this.log(`meaning: installed ${runtime.version} of LiteRT-LM in ${runtime.python}`);
      }
      if (needs.model) {
        told('model', 0, MODEL.bytes);
        await downloadModel(this.dataDir, {fetch: this.fetch, signal: abort.signal, progress: bytes => told('model', bytes, MODEL.bytes)});
      }
      return {runtime, model: needs.model};
    })().finally(() => { this.downloading = null; });
    return turning.done;
  }

  /** Stops a fetch under way, then deletes the model and the venv Pair made. Resolves `{venv}`: whether it went. */
  async turnOff() {
    if (this.downloading) {
      this.downloading.abort.abort(new Error('search by meaning was turned off'));
      await this.downloading.done.catch(() => {});
    }
    await removeModel(this.dataDir);
    return {venv: await this.removeVenv()};
  }

  /** The venv Pair made, deleted (never meaning.python; not while voice uses it): whether it went. */
  async removeVenv() {
    return !!await this.runtime?.remove({keep: this.keepVenv()});
  }

  /** For `pair doctor` and the daemon's status, next to Meaning's. */
  snapshot() {
    const phase = this.downloading?.phase;
    return {
      revision: MODEL.revision,
      downloading: phase === 'model' ? this.downloading.bytes : null,
      installing: phase === 'runtime' ? this.downloading.bytes : null,
      python: typeof this.embedder?.python === 'function' ? this.embedder.python() : this.embedder?.python ?? null,
      runtime: this.embedder?.runtime?.runtime ?? null,
    };
  }
}

/**
 * semantic-grep's Reranker over Pair's rerank endpoints (models.mjs, createRerankEndpoints: pi-ai's models for each
 * "rerank" entry), each named as Pair names a model: "d1-2B on liquid" for a provider's, "d1-2B at <baseUrl>" else.
 */
export function pairReranker(endpoints, options = {}) {
  const reranker = new Reranker({endpoints, ...options});
  for (const endpoint of reranker.endpoints) if (endpoint.entry.provider) endpoint.name = `${endpoint.entry.model} on ${endpoint.entry.provider}`;
  return reranker;
}

/** Where `:Pair find off` with an "embedding" model leaves its note: semantic-grep's, in Pair's data folder. */
export const offNote = dataDir => join(dataDir, 'off');

/**
 * The daemon's search by meaning: semantic-grep's Meaning over Pair's data folder, with the config's "embedding" model
 * (its key read as a model's is), else EmbeddingGemma through a GemmaProvider. `with` are the tests': an `embedder`
 * (then nothing is installed, unless they give a `runtime` too), `fetch`, `treeSitter`, `now`. `keepVenv()` is true
 * while voice's LFM3-Omni needs the venv. Returns `{meaning, gemma, runtime, turnOff}`: gemma is null with an
 * "embedding" model; runtime is LiteRT-LM's installer, which voice shares; turnOff is `:Pair find off`, Meaning's, and
 * with an "embedding" model the venv Pair made for EmbeddingGemma before goes too. It resolves `{venv}`.
 */
export function pairSearch({config, log = () => {}, book = () => {}, progress = () => {}, reranker = null, keepVenv = () => false, with: given = {}}) {
  const {embedder: fake = null, runtime: fakeRuntime = null, fetch = globalThis.fetch, ...rest} = given;
  const {dataDir} = config;
  const {profile, notes = null, ...own} = config.meaning || {}; // the profile is in config.embedding and config.rerank already
  const meaningConfig = config.meaning === false ? false : {...own, projectDir: PROJECT_DIR};
  const python = () => pythonOf(config.meaning, dataDir);
  const runtime = fakeRuntime ?? (fake ? null : new Runtime({dataDir, python, fetch, log}));
  migrate(dataDir);
  let embedder;
  let gemma = null;
  if (config.embedding) {
    embedder = fake ?? new HttpEmbedder({entry: config.embedding, apiKey: () => apiKeyOf(config.embedding), fetch, log});
  } else {
    // EmbeddingGemma's Python is looked for each time its helper starts: a venv made while the daemon runs is found.
    embedder = fake ?? new Embedder({python, model: modelPath(dataDir), threads: config.meaning?.threads, log});
    gemma = new GemmaProvider({dataDir, meaning: config.meaning, embedder, runtime, fetch, log});
    gemma.keepVenv = keepVenv;
  }
  // A key a command prints is read in the background (config.mjs, commandKey): asked now, the first requests have it.
  primeKeyCommands([config.embedding, ...(config.rerank ?? []), notes]).catch(() => {});
  const meaning = new Meaning({
    dataDir, config: meaningConfig, embedding: config.embedding ?? null, reranker, notes: withPairKey(notes), log, book, progress, fetch, embedder, provider: gemma, ...rest,
  });
  const turnOff = async () => {
    const {venv} = await meaning.turnOff();
    return {venv: gemma ? venv : !!await runtime?.remove({keep: keepVenv()})};
  };
  return {meaning, gemma, runtime, turnOff};
}

/**
 * Before semantic-grep: `:Pair find off`'s note was in <dataDir>/meaning/, and PAIR-5's index (before SQLite) in
 * <dataDir>/meaning/index/. The note moves; the old index goes.
 */
function migrate(dataDir) {
  const old = join(meaningDir(dataDir), 'off');
  try {
    if (existsSync(old) && !existsSync(offNote(dataDir))) renameSync(old, offNote(dataDir));
  } catch {}
  rm(join(meaningDir(dataDir), 'index'), {recursive: true, force: true}).catch(() => {});
}
