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
 * results, {texts, wait, prepare, stale})` resolves `{ok: true, results, moved, ms}`, the list reordered, or `{ok: false, why, error,
 * ms, results}` with the list as it was: why is "down" (it failed lately), "busy" (another rerank runs), "timeout",
 * "error", "malformed", "flat" or "aborted" (`stale`).
 * It never rejects. Without `wait` it never waits past the entry's `timeoutMs` for the model; with it, it waits its turn
 * first. A failure (a timeout too: the server may still be on that question) keeps it from being asked for a minute,
 * so a model that is off costs one wait, not one a search, and no second question goes to a server still busy.
 */
export class Reranker {
  constructor({models, model, entry, log = () => {}, now = Date.now}) {
    Object.assign(this, {models, model, entry, log, now});
    this.top = entry.top ?? RERANK_TOP;
    this.timeoutMs = entry.timeoutMs ?? RERANK_TIMEOUT_MS;
    this.down = null; // why it failed last, while it is not asked
    this.downAt = 0;
    this.running = null; // the rerank under way, a promise that settles when it ends
    this.calls = 0;
    this.kept = 0; // how many reranks kept the order
    this.msTotal = 0;
  }

  /** Whether a rerank would ask the model now: not within the minute after a failure. */
  get available() { return !(this.down && this.now() - this.downAt < DOWN_MS); }

  /** The model, for people: "d1-2B at http://…". */
  get name() { return this.entry.provider ? `${this.entry.model} on ${this.entry.provider}` : `${this.entry.model} at ${this.entry.baseUrl}`; }

  /** Asks the model about one question: `{ok, answer, ms}` or `{ok: false, why, error, ms}`. */
  async ask(state, question) {
    const started = this.now();
    const controller = new AbortController();
    let timer;
    const late = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, this.timeoutMs); });
    const options = {signal: controller.signal, maxRetries: 0, timeoutMs: this.timeoutMs};
    const result = await Promise.race([
      this.models.classify(this.model, {state, questions: {best: question}}, options).catch(error => ({stopReason: 'error', errorMessage: String(error?.message ?? error)})),
      late,
    ]);
    clearTimeout(timer);
    const ms = this.now() - started;
    if (!result) return {ok: false, why: 'timeout', error: `no answer within ${this.timeoutMs} ms`, ms};
    if (result.stopReason !== 'stop') {
      const timedOut = /timed out|abort/i.test(result.errorMessage ?? '');
      // pi-ai checks the answer's shape: one of the wrong shape is an odd answer, not a model that is down.
      if (!timedOut && /returned invalid|invalid (probabilit|confidence|choice)/i.test(result.errorMessage ?? '')) return {ok: false, why: 'malformed', error: result.errorMessage, ms};
      return {ok: false, why: timedOut ? 'timeout' : 'error', error: timedOut ? `no answer within ${this.timeoutMs} ms` : result.errorMessage ?? 'the model failed', ms};
    }
    return {ok: true, answer: result.answers?.best, ms};
  }

  /**
   * `results` reranked for `query`; `texts` are what the model reads of the first ones (pieceText each). With `wait`,
   * a rerank under way is waited for, else this one is "busy". `prepare()`, when given, resolves `{results, texts}`
   * once the model is this rerank's (a picker's ranking, read only then); `stale()` says the asker has moved on:
   * checked before the model is asked and after, the answer is then "aborted". A question once sent is never cut off
   * but by the timeout: the server would go on with it, and the model gets one question at a time.
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
      const n = Math.min(this.top, results.length, texts?.length ?? results.length);
      if (n < 2) return {ok: false, why: 'short', error: 'fewer than two pieces', ms: 0, results};
      const asked = await this.ask(`Search: ${query}`, rerankQuestion((texts ?? results.map(result => pieceText(result))).slice(0, n)));
      this.calls += 1;
      this.msTotal += asked.ms;
      if (!asked.ok && asked.why === 'malformed') {
        this.kept += 1;
        this.log(`reranker: ${asked.error}; the search's order stays`);
        return {...asked, results};
      }
      if (!asked.ok) return this.failed(asked, results);
      const found = probabilitiesOf(asked.answer, n);
      if (!found.values) {
        this.kept += 1;
        if (found.why === 'malformed') this.log(`reranker: ${found.error}; the search's order stays`);
        return {ok: false, why: found.why, error: found.error, ms: asked.ms, results};
      }
      this.down = null;
      if (stale()) return {...aborted, ms: asked.ms};
      const reordered = reorder(results, found.values);
      const moved = reordered.slice(0, n).filter((result, i) => result.file !== results[i].file || result.from !== results[i].from).length;
      return {ok: true, results: reordered, moved, ms: asked.ms};
    } finally {
      this.running = null;
      release();
    }
  }

  /**
   * A new reranker of a changed config waits for the question the one before has under way, and keeps its minute of
   * rest after a failure (the server may still be on a question that timed out).
   */
  follow(previous) {
    if (previous?.down) Object.assign(this, {down: previous.down, downAt: previous.downAt});
    if (!previous?.running) return;
    const after = previous.running.then(() => { if (this.running === after) this.running = null; });
    this.running = after;
  }

  failed(asked, results) {
    if (results.length) this.kept += 1;
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
    const resting = () => ({ok: false, ms: 0, error: `not asked: it failed ${Math.round((this.now() - this.downAt) / 1000)} s ago (${this.down}), and is asked again a minute after`});
    if (!this.available) return resting();
    while (this.running) await this.running; // one question at a time, a check's too
    if (!this.available) return resting(); // the one before timed out: the server may still be on it
    let release;
    this.running = new Promise(resolve => { release = resolve; });
    const asked = await this.ask('Search: add two numbers', rerankQuestion(pieces)).finally(() => { this.running = null; release(); });
    if (!asked.ok && asked.why !== 'malformed') this.failed(asked, []);
    if (!asked.ok) return {ok: false, ms: asked.ms, error: asked.error};
    const found = probabilitiesOf(asked.answer, pieces.length);
    if (found.why === 'malformed') return {ok: false, ms: asked.ms, error: `its answer has ${found.error}`};
    return {ok: true, ms: asked.ms, pieces: pieces.length, right: !!found.values && found.values.indexOf(Math.max(...found.values)) === 0};
  }

  snapshot() {
    return {model: this.name, top: this.top, timeoutMs: this.timeoutMs, down: this.down, calls: this.calls, kept: this.kept, msPerCall: this.calls ? Math.round(this.msTotal / this.calls) : null};
  }
}
