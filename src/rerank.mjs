// Search by meaning's reranker: a small decision model (a classifier that answers a choice with a probability for each
// answer and writes no text, such as LiquidAI's d1-2B behind a System One API) reorders the first pieces of a settled
// list. One question names each of the top pieces as an answer, "which best matches the search?", and the pieces go
// best first by the probability the model gives each; the rest of the list stays as it was.
//
// It is optional and never in the way: off unless the config has a "rerank" entry, asked only where a list is settled
// (the pause after typing in a picker, /find, the search tool), within `timeoutMs`. A model that is down, slow, or
// answers oddly (the wrong shape, or no preference at all) keeps the order the search gave. See docs/meaning.md.

// How many of the first pieces the model reorders: ten are what a picker shows without scrolling, and the labelled
// questions of test/fixtures/rerank-queries.json gained as much from ten as from fifteen, in two thirds of the time.
export const RERANK_TOP = 10;
// The longest the model is waited for; past it the order stays. A CPU's 2B model takes 2.5 s for ten pieces.
export const RERANK_TIMEOUT_MS = 3000;
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

/**
 * The daemon's reranker over pi-ai's `models` and the config's `entry` (see config.mjs, rerankConfig). `rerank(query,
 * results, {texts, signal})` resolves `{ok: true, results, moved, ms}`, the list reordered, or `{ok: false, why, error,
 * ms, results}` with the list as it was: why is "down" (it failed lately), "timeout", "error", "malformed" or "flat".
 * It never rejects and never waits past the entry's `timeoutMs`. A failure keeps it from being asked for a minute,
 * so a model that is off costs one wait, not one a search.
 */
export class Reranker {
  constructor({models, model, entry, log = () => {}, now = Date.now}) {
    Object.assign(this, {models, model, entry, log, now});
    this.top = entry.top ?? RERANK_TOP;
    this.timeoutMs = entry.timeoutMs ?? RERANK_TIMEOUT_MS;
    this.down = null; // why it failed last, while it is not asked
    this.downAt = 0;
    this.calls = 0;
    this.kept = 0; // how many reranks kept the order
    this.msTotal = 0;
  }

  /** The model, for people: "d1-2B at http://…". */
  get name() { return this.entry.provider ? `${this.entry.model} on ${this.entry.provider}` : `${this.entry.model} at ${this.entry.baseUrl}`; }

  /** Asks the model about one question: `{ok, answer, ms}` or `{ok: false, why, error, ms}`. */
  async ask(state, question, {signal} = {}) {
    const started = this.now();
    const controller = new AbortController();
    let timer;
    const late = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, this.timeoutMs); });
    const options = {signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, maxRetries: 0, timeoutMs: this.timeoutMs};
    const result = await Promise.race([
      this.models.classify(this.model, {state, questions: {best: question}}, options).catch(error => ({stopReason: 'error', errorMessage: String(error?.message ?? error)})),
      late,
    ]);
    clearTimeout(timer);
    const ms = this.now() - started;
    if (signal?.aborted) return {ok: false, why: 'aborted', error: 'a newer search came', ms};
    if (!result) return {ok: false, why: 'timeout', error: `no answer within ${this.timeoutMs} ms`, ms};
    if (result.stopReason !== 'stop') {
      const timedOut = /timed out|abort/i.test(result.errorMessage ?? '');
      return {ok: false, why: timedOut ? 'timeout' : 'error', error: timedOut ? `no answer within ${this.timeoutMs} ms` : result.errorMessage ?? 'the model failed', ms};
    }
    return {ok: true, answer: result.answers?.best, ms};
  }

  /** `results` reranked for `query`; `texts` are what the model reads of the first ones (pieceText each). */
  async rerank(query, results, {texts, signal} = {}) {
    const n = Math.min(this.top, results.length, texts?.length ?? results.length);
    if (n < 2) return {ok: false, why: 'short', error: 'fewer than two pieces', ms: 0, results};
    if (this.down && this.now() - this.downAt < DOWN_MS) return {ok: false, why: 'down', error: this.down, ms: 0, results};
    this.calls += 1;
    const asked = await this.ask(`Search: ${query}`, rerankQuestion((texts ?? results.map(result => pieceText(result))).slice(0, n)), {signal});
    this.msTotal += asked.ms;
    if (asked.why === 'aborted') return {...asked, results};
    if (!asked.ok) return this.failed(asked, results);
    const found = probabilitiesOf(asked.answer, n);
    if (!found.values) {
      this.kept += 1;
      if (found.why === 'malformed') this.log(`reranker: ${found.error}; the search's order stays`);
      return {ok: false, why: found.why, error: found.error, ms: asked.ms, results};
    }
    this.down = null;
    const reordered = reorder(results, found.values);
    const moved = reordered.slice(0, n).filter((result, i) => result !== results[i] && (result.file !== results[i].file || result.from !== results[i].from)).length;
    return {ok: true, results: reordered, moved, ms: asked.ms};
  }

  failed(asked, results) {
    this.kept += 1;
    const why = String(asked.error).split('\n')[0].slice(0, 160);
    if (this.down !== why) this.log(`reranker: ${why}; searches keep their order for a minute`);
    this.down = why;
    this.downAt = this.now();
    return {...asked, results};
  }

  /**
   * A search's question of `top` small pieces, for `pair doctor`: `{ok, ms, error, right}`, how long it took and
   * whether the model put the one that matches first.
   */
  async probe() {
    const pieces = PROBE_PIECES.slice(0, Math.max(2, Math.min(this.top, PROBE_PIECES.length)));
    const asked = await this.ask('Search: add two numbers', rerankQuestion(pieces));
    if (!asked.ok) return {ok: false, ms: asked.ms, error: asked.error};
    const found = probabilitiesOf(asked.answer, pieces.length);
    if (found.why === 'malformed') return {ok: false, ms: asked.ms, error: `its answer has ${found.error}`};
    return {ok: true, ms: asked.ms, right: !!found.values && found.values.indexOf(Math.max(...found.values)) === 0};
  }

  snapshot() {
    return {model: this.name, top: this.top, timeoutMs: this.timeoutMs, down: this.down, calls: this.calls, kept: this.kept, msPerCall: this.calls ? Math.round(this.msTotal / this.calls) : null};
  }
}
