// Search by meaning's reranker: a small decision model (a classifier that answers a choice with a probability for each
// answer and writes no text, such as LiquidAI's d1-2B behind a System One API) reorders the first pieces of a settled
// list. One question names each of the top pieces as an answer, "which best matches the search?", and the pieces go
// best first by the probability the model gives each; the rest of the list stays as it was.
//
// One rerank at a time: a model on a CPU may serve other work too, and a second question would only wait behind the
// first. A rerank asked while one runs keeps its search's order ("busy").
//
// It is optional and never in the way: off unless the config has a "rerank" entry, asked only where a list is settled
// (the pause after typing in a picker, /find, the search tool), within `timeoutMs`. A model that is down, slow, or
// answers oddly (the wrong shape, or no preference at all) keeps the order the search gave. See docs/meaning.md.
//
// The entry may list several models, best first (a fast one on a GPU that is not always up, then one on a CPU that
// is): a rerank asks the first that has not failed lately, and the next when it fails or is slower than its own
// `timeoutMs`. Each one that fails rests for a minute, so a search pays its wait once, not every time.

// How many of the first pieces the model reorders: ten are what a picker shows without scrolling, and the labelled
// questions of test/fixtures/rerank-queries.json gained as much from ten as from fifteen, in two thirds of the time.
export const RERANK_TOP = 10;
// The longest the model is waited for; past it the order stays. A CPU's 2B model takes 2.5 s for ten pieces.
export const RERANK_TIMEOUT_MS = 3000;
// The default wait for a model that another follows in the list: a GPU's answers in a fifth of a second, and a model
// that is down should cost a search little before the next is asked.
export const FALLBACK_TIMEOUT_MS = 1000;
// Of each piece's text, its first this many characters (its doc comment, or its head and first lines): the model reads
// them all, so they are its time. 160 ranked as well as 600, in half the time.
export const SNIPPET_CHARS = 160;
const FLAT = 0.02; // a model whose probabilities differ by less than this has no preference: the order stays
const DOWN_MS = 60_000; // after a failure, how long a rerank is not tried again

// What `pair doctor` asks the model: the first matches "add two numbers", and the others take its time as a search's would.
const PROBE_PIECES = [
  'math.js:1  /** The sum of a and b. */ export function add(a, b) { return a + b }',
  'log.js:1  /** Prints a warning on stderr. */ export function warn(text) { console.warn(`warning: ${text}`) }',
  'cart.js:4  /** What the basket costs. */ export function total(cart) { return cart.items.reduce((sum, item) => sum + item.cents, 0) }',
  'slug.js:1  export const slug = title => title.toLowerCase().replace(/[^a-z0-9]+/g, "-")',
  'retry.js:3  /** How long to wait before the next try. */ export function nextDelay(attempt) { return 250 * 2 ** attempt }',
  'csv.js:1  export function rows(text) { return text.trim().split("\\n").map(line => line.split(",")) }',
  'user.js:9  /** Signs the user out everywhere. */ export async function logout(id) { await sessions.delete(id) }',
  'date.js:2  export function startOfDay(now) { const day = new Date(now); day.setHours(0, 0, 0, 0); return day }',
  'avatar.js:1  export function initials(name) { return name.split(" ").map(word => word[0]).join("") }',
  'README.md:12  ## Install: npm install, then npm test',
];

const INSTRUCTIONS = 'A developer searched their project with the words in the state. Which piece of code or documentation '
  + 'is the one they are looking for? Judge what each piece does, not whether it shares their words.';

/** What the model reads of one piece: where it is, then its text from its doc comment on, cut short, on one line. */
export function pieceText(result, text = result.head ?? '') {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return `${result.file}:${result.line ?? result.from}  ${flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}…` : flat}`;
}

/** The choice question about `texts` (each piece's pieceText): its answers are "1" to "N", in the list's order. */
export function rerankQuestion(texts) {
  return {type: 'choice', instructions: INSTRUCTIONS, criteria: Object.fromEntries(texts.map((text, i) => [String(i + 1), text]))};
}

/**
 * The model's probabilities for "1" to "n", or why they are no answer to go by: missing or out of range ("malformed"),
 * or all about the same ("flat": the model cannot tell them apart, and a reorder would be noise).
 */
export function probabilitiesOf(answer, n) {
  const probabilities = answer?.probabilities;
  if (!answer || answer.type !== 'choice' || !probabilities || typeof probabilities !== 'object') return {why: 'malformed', error: 'no probabilities in its answer'};
  const values = [];
  for (let i = 1; i <= n; i++) {
    const p = probabilities[String(i)];
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return {why: 'malformed', error: `no probability for piece ${i}`};
    values.push(p);
  }
  if (Math.max(...values) - Math.min(...values) < FLAT) return {why: 'flat', error: 'no piece stood out'};
  return {values};
}

/**
 * `results` with their first `values.length` reordered best first by `values` (the model's probability for each);
 * equal ones keep their order. The rest stay where they were.
 */
export function reorder(results, values) {
  const top = values.map((p, i) => ({p, i})).sort((a, b) => b.p - a.p || a.i - b.i).map(({i, p}) => ({...results[i], rerank: Math.round(p * 1000) / 1000}));
  return [...top, ...results.slice(values.length)];
}

/** One model of the entry: "d1-2B at http://…" for people. */
export const endpointName = entry => (entry.provider ? `${entry.model} on ${entry.provider}` : `${entry.model} at ${entry.baseUrl}`);

/**
 * The daemon's reranker over the config's `rerank` models, best first: `endpoints` are `{models, model, entry}`, pi-ai's
 * models and the model of each entry (see config.mjs, rerankConfig, and models.mjs, createRerankEndpoints); `models`,
 * `model` and `entry` alone make a list of one. `rerank(query, results, {texts, wait, prepare, stale})` resolves
 * `{ok: true, results, moved, ms, model, name, top}`, the list reordered by `model` (the one that answered, its `name`
 * for people, of its `top` first pieces), or `{ok: false, why, error, ms, results}` with the list as it was: why is "down" (each failed lately),
 * "busy" (another rerank runs), "timeout", "error", "malformed", "flat" or "aborted" (`stale`). `skipped` names the
 * models before the one that answered (or last failed) that were not asked or failed, `{model, name, why, error}` each.
 * It never rejects. Without `wait` it never waits past the models' `timeoutMs` together; with it, it waits its turn
 * first. A failure (a timeout too: the server may still be on that question) keeps that model from being asked for a
 * minute, so a model that is off costs one wait, not one a search, and no second question goes to a server still busy.
 */
export class Reranker {
  constructor({endpoints, models, model, entry, log = () => {}, now = Date.now}) {
    Object.assign(this, {log, now});
    this.endpoints = (endpoints ?? [{models, model, entry}]).map(endpoint => ({
      ...endpoint, name: endpointName(endpoint.entry), top: endpoint.entry.top ?? RERANK_TOP, timeoutMs: endpoint.entry.timeoutMs ?? RERANK_TIMEOUT_MS,
      down: null, downAt: 0, answered: 0, msAnswered: 0, // why it failed last, while it is not asked; and the reranks it answered
    }));
    this.top = Math.max(...this.endpoints.map(endpoint => endpoint.top)); // the most pieces any of them reads
    this.timeoutMs = this.endpoints.reduce((sum, endpoint) => sum + endpoint.timeoutMs, 0); // the longest a rerank waits
    this.running = null; // the rerank under way, a promise that settles when it ends
    this.calls = 0;
    this.kept = 0; // how many reranks kept the order
    this.msTotal = 0;
  }

  /** Whether `endpoint` is asked now: not within the minute after it failed. */
  resting(endpoint) { return !!endpoint.down && this.now() - endpoint.downAt < DOWN_MS; }

  /** Whether a rerank would ask a model now: one has not failed within the minute. */
  get available() { return this.endpoints.some(endpoint => !this.resting(endpoint)); }

  /** The models, for people: "d3-flash at http://…, then d1-2B at http://…". */
  get name() { return this.endpoints.map(endpoint => endpoint.name).join(', then '); }

  /** The model a rerank asks first now, by its name in the config: what a picker is told. */
  get model() { return (this.endpoints.find(endpoint => !this.resting(endpoint)) ?? this.endpoints[0]).entry.model; }

  /** Why each model rests, while all do: what a search that is not asked is told. */
  get down() { return this.available ? null : this.endpoints.map(endpoint => (this.endpoints.length > 1 ? `${endpoint.entry.model}: ${endpoint.down}` : endpoint.down)).join('; '); }

  /** Asks `endpoint` one question: `{ok, answer, ms}` or `{ok: false, why, error, ms}`. */
  async ask(endpoint, state, question) {
    const started = this.now();
    const controller = new AbortController();
    const {timeoutMs} = endpoint;
    let timer;
    const late = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs); });
    const options = {signal: controller.signal, maxRetries: 0, timeoutMs};
    const result = await Promise.race([
      endpoint.models.classify(endpoint.model, {state, questions: {best: question}}, options).catch(error => ({stopReason: 'error', errorMessage: String(error?.message ?? error)})),
      late,
    ]);
    clearTimeout(timer);
    const ms = this.now() - started;
    if (!result) return {ok: false, why: 'timeout', error: `no answer within ${timeoutMs} ms`, ms};
    if (result.stopReason !== 'stop') {
      const timedOut = /timed out|abort/i.test(result.errorMessage ?? '');
      // pi-ai checks the answer's shape: one of the wrong shape is an odd answer, not a model that is down.
      if (!timedOut && /returned invalid|invalid (probabilit|confidence|choice)/i.test(result.errorMessage ?? '')) return {ok: false, why: 'malformed', error: result.errorMessage, ms};
      return {ok: false, why: timedOut ? 'timeout' : 'error', error: timedOut ? `no answer within ${timeoutMs} ms` : result.errorMessage ?? 'the model failed', ms};
    }
    return {ok: true, answer: result.answers?.best, ms};
  }

  /**
   * Asks the models in turn, `questionOf(n)` with each one's `n` pieces of `pieces`, until one answers (oddly too):
   * `{asked, endpoint, n, ms, skipped}`, where `asked` is that answer, or the last failure with `endpoint` null when
   * none answered (and `failed`, the model that failed last). A model that fails rests (see failed); `stale()` stops it before the next is asked.
   */
  async askInTurn(state, pieces, questionOf, stale = () => false) {
    const skipped = [];
    let ms = 0;
    let last = null;
    for (const endpoint of this.endpoints) {
      if (this.resting(endpoint)) {
        skipped.push({model: endpoint.entry.model, name: endpoint.name, why: 'down', error: endpoint.down});
        continue;
      }
      if (last && stale()) return {asked: {ok: false, why: 'aborted', error: 'a newer search came', ms}, endpoint: null, ms, skipped};
      const n = Math.min(endpoint.top, pieces);
      const asked = await this.ask(endpoint, state, questionOf(n));
      ms += asked.ms;
      if (asked.ok || asked.why === 'malformed') return {asked, endpoint, n, ms, skipped};
      this.failed(endpoint, asked);
      skipped.push({model: endpoint.entry.model, name: endpoint.name, why: asked.why, error: asked.error});
      last = {asked, endpoint};
    }
    // None answered: the last that failed says why, the ones before it are skipped.
    if (!last) return {asked: {ok: false, why: 'down', error: this.down, ms}, endpoint: null, ms, skipped};
    skipped.splice(skipped.findLastIndex(skip => skip.name === last.endpoint.name), 1);
    return {asked: {...last.asked, ms}, endpoint: null, failed: last.endpoint, ms, skipped};
  }

  /**
   * `results` reranked for `query`; `texts` are what the model reads of the first ones (pieceText each). With `wait`,
   * a rerank under way is waited for, else this one is "busy". `prepare()`, when given, resolves `{results, texts}`
   * once the model is this rerank's (a picker's ranking, read only then); `stale()` says the asker has moved on:
   * checked before a model is asked and after, the answer is then "aborted". A question once sent is never cut off
   * but by the timeout: the server would go on with it, and the models get one question at a time.
   */
  async rerank(query, results, {texts, wait = false, prepare = null, stale = () => false} = {}) {
    if (!prepare && Math.min(results.length, texts?.length ?? results.length) < 2) return {ok: false, why: 'short', error: 'fewer than two pieces', ms: 0, results};
    if (!this.available) return {ok: false, why: 'down', error: this.down, ms: 0, results};
    if (this.running && !wait) return {ok: false, why: 'busy', error: 'another rerank is under way', ms: 0, results};
    while (this.running) await this.running;
    const aborted = {ok: false, why: 'aborted', error: 'a newer search came', ms: 0, results};
    if (stale()) return aborted;
    if (!this.available) return {ok: false, why: 'down', error: this.down, ms: 0, results};
    let release;
    this.running = new Promise(resolve => { release = resolve; }); // taken before anything is awaited: no other rerank slips in
    try {
      if (prepare) {
        try {
          ({results, texts} = await prepare());
        } catch (error) {
          return {ok: false, why: 'short', error: `its pieces could not be read: ${error.message}`, ms: 0, results};
        }
      }
      aborted.results = results;
      if (stale()) return aborted;
      const pieces = Math.min(results.length, texts?.length ?? results.length);
      if (pieces < 2) return {ok: false, why: 'short', error: 'fewer than two pieces', ms: 0, results};
      const all = texts ?? results.map(result => pieceText(result));
      const {asked, endpoint, n, ms, skipped, failed} = await this.askInTurn(`Search: ${query}`, pieces, count => rerankQuestion(all.slice(0, count)), stale);
      this.calls += 1;
      this.msTotal += ms;
      const by = endpoint ?? failed;
      const about = {ms, skipped, model: by?.entry.model, name: by?.name, top: n};
      if (!endpoint) {
        if (asked.why === 'aborted') return {...asked, ...about, results};
        if (results.length) this.kept += 1;
        return {...asked, ...about, results};
      }
      if (!asked.ok) { // malformed
        this.kept += 1;
        this.log(`reranker: ${endpoint.name}: ${asked.error}; the search's order stays`);
        return {...asked, ...about, results};
      }
      const found = probabilitiesOf(asked.answer, n);
      if (!found.values) {
        this.kept += 1;
        if (found.why === 'malformed') this.log(`reranker: ${endpoint.name}: ${found.error}; the search's order stays`);
        return {ok: false, why: found.why, error: found.error, ...about, results};
      }
      endpoint.down = null;
      endpoint.answered += 1;
      endpoint.msAnswered += asked.ms;
      if (stale()) return {...aborted, ...about};
      const reordered = reorder(results, found.values);
      const moved = reordered.slice(0, n).filter((result, i) => result.file !== results[i].file || result.from !== results[i].from).length;
      return {ok: true, results: reordered, moved, ...about};
    } finally {
      this.running = null;
      release();
    }
  }

  /**
   * A new reranker of a changed config waits for the question the one before has under way, and each model it has
   * too keeps its minute of rest after a failure (the server may still be on a question that timed out).
   */
  follow(previous) {
    const rest = () => {
      for (const endpoint of this.endpoints) {
        const before = previous?.endpoints.find(other => other.name === endpoint.name);
        if (before?.down && before.downAt > endpoint.downAt) Object.assign(endpoint, {down: before.down, downAt: before.downAt});
      }
    };
    rest();
    if (!previous?.running) return;
    // A question under way may fail after the change: its model rests here too before anything else is asked.
    const after = previous.running.then(() => { rest(); if (this.running === after) this.running = null; });
    this.running = after;
  }

  /** `endpoint` failed as `asked` says: it is not asked for a minute. */
  failed(endpoint, asked) {
    const why = String(asked.error).split('\n')[0].slice(0, 160);
    const next = this.endpoints[this.endpoints.indexOf(endpoint) + 1];
    if (endpoint.down !== why) this.log(`reranker: ${endpoint.name}: ${why}; ${next ? `${next.entry.model} is asked instead` : 'searches keep their order'} for a minute`);
    endpoint.down = why;
    endpoint.downAt = this.now();
  }

  /**
   * A search's question of small pieces, for `pair doctor`, asked of the models in turn as a search's:
   * `{ok, ms, error, right, model, pieces, skipped}`, how long it took, which model answered, and whether it put the
   * one that matches first.
   */
  async probe() {
    const resting = () => ({ok: false, ms: 0, error: `not asked: ${this.endpoints.map(endpoint => `${this.endpoints.length > 1 ? `${endpoint.entry.model} ` : 'it '}failed ${Math.round((this.now() - endpoint.downAt) / 1000)} s ago (${endpoint.down})`).join('; ')}, and is asked again a minute after`});
    if (!this.available) return resting();
    while (this.running) await this.running; // one question at a time, a check's too
    if (!this.available) return resting(); // the one before timed out: the server may still be on it
    let release;
    this.running = new Promise(resolve => { release = resolve; });
    const pieces = Math.min(PROBE_PIECES.length, this.top);
    const {asked, endpoint, n, skipped, failed} = await this.askInTurn('Search: add two numbers', pieces, count => rerankQuestion(PROBE_PIECES.slice(0, count)))
      .finally(() => { this.running = null; release(); });
    const by = endpoint ?? failed;
    const about = {ms: asked.ms, skipped, model: by?.entry.model, name: by?.name};
    if (!asked.ok) return {ok: false, ...about, error: asked.error};
    const found = probabilitiesOf(asked.answer, n);
    if (found.why === 'malformed') return {ok: false, ...about, error: `its answer has ${found.error}`};
    return {ok: true, ...about, pieces: n, right: !!found.values && found.values.indexOf(Math.max(...found.values)) === 0};
  }

  snapshot() {
    return {
      model: this.name, top: this.top, timeoutMs: this.timeoutMs, down: this.down, calls: this.calls, kept: this.kept, msPerCall: this.calls ? Math.round(this.msTotal / this.calls) : null,
      endpoints: this.endpoints.map(endpoint => ({model: endpoint.entry.model, name: endpoint.name, down: this.resting(endpoint) ? endpoint.down : null, answered: endpoint.answered, msPerAnswer: endpoint.answered ? Math.round(endpoint.msAnswered / endpoint.answered) : null})),
    };
  }
}
