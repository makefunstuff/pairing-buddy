// The thread of the session: the goal as two to four steps, which of them are done, and which is next. Pair proposes
// the steps when the goal is set, the user keeps, edits (/plan, `p` in the chat) or drops them (/plan off), and when a
// step lands (tests go green, code taken, a commit), Pair says at the next break "done: X; next: Y". The plan lives
// in the session only: never in a note, the brief or the project. Pure: the session asks the model and says the lines.

export const STEPS = {min: 2, max: 4, chars: 80};
export const LANDED_KEPT_MS = 30 * 60_000; // a landing not said by then is old news

export const PLAN_PROMPT = 'You turn a programmer\'s goal for a pairing session into its plan: two to four short steps, '
  + 'in the order they would do them, each a few plain words that say what is true once it is done ("the cart tests '
  + 'pass", "the bogo code works"). Answer with the steps only, one per line, no numbers, no other words. A goal too '
  + 'small for two steps: answer exactly NONE.';

export const DONE_PROMPT = 'You keep the plan of a pairing session. From the facts of what happened, say which of its '
  + 'steps are now done: only steps the facts show done, not ones that are likely. Answer with one line, "done: " and '
  + 'their numbers, comma separated ("done: 1, 2"), or exactly NONE.';

const clean = text => text.replace(/^\s*(?:[-*•]|\d+[.)]|step \d+:?)\s*/i, '').replace(/\s+/g, ' ').trim().replace(/[.;]+$/, '');

/** The steps in a model's answer, or in what the user typed (`a; b; c`, or one per line); [] for none. */
export function parseSteps(text) {
  if (!text || /^\s*NONE\b/.test(text)) return [];
  const parts = text.includes('\n') ? text.split('\n') : text.split(/\s*(?:;|·|\s\d+[.)]\s)\s*/);
  return parts.map(clean).filter(Boolean).map(step => (step.length > STEPS.chars ? `${step.slice(0, STEPS.chars - 1)}…` : step));
}

/** The plan as one line: "1 the tests pass · 2 the bogo code works". */
export const stepsLine = steps => steps.map((step, i) => `${i + 1} ${step.text}`).join(' · ');

/** The plan as /plan takes it again, for `p` to put on the chat's line. */
export const planText = steps => steps.map(step => step.text).join('; ');

/** The step numbers a done check's answer names, within `count`. */
export function parseDone(text, count) {
  const found = String(text ?? '').match(/done:\s*([\d,\s]+)/i);
  if (!found) return [];
  return [...new Set(found[1].split(/[,\s]+/).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= count))];
}

export class Thread {
  constructor() {
    this.steps = []; // {text, done}
    this.landed = null; // the latest step that may have landed and is not said yet: {what, at, line once checked}
    this.proposed = null; // Pair's steps, not said yet: {at}, said at the user's next break
    this.version = 0; // each new plan or drop: a model answer about an older one is let go
  }

  get open() { return this.steps.filter(step => !step.done); }
  get next() { return this.open[0] ?? null; }

  /**
   * The plan, from the model or the user's words: a plan of fewer than two steps is none. With `keepDone`, a step whose
   * words are those of one done already stays done (the user edited the others). Returns whether it holds one.
   */
  set(steps, {keepDone = false} = {}) {
    const done = new Set(keepDone ? this.steps.filter(step => step.done).map(step => step.text) : []);
    this.steps = steps.length >= STEPS.min ? steps.slice(0, STEPS.max).map(text => ({text, done: done.has(text)})) : [];
    this.landed = null;
    this.proposed = null;
    this.version += 1;
    return this.steps.length > 0;
  }

  drop() {
    this.steps = [];
    this.landed = null;
    this.proposed = null;
    this.version += 1;
  }

  /** Something that may finish a step happened: tests went green, code was taken, a commit. */
  land(what, at) {
    if (this.next) this.landed = {what, at};
  }

  /** The landing to check or say at a break at `now`, or null: it has a line, or the plan an open step; it is not old. */
  due(now) {
    return this.landed && (this.landed.line || this.next) && now - this.landed.at <= LANDED_KEPT_MS ? this.landed : null;
  }

  /** The landing that got too old to say at `now`, which it lets go; null when none did. */
  expired(now) {
    const old = this.landed && now - this.landed.at > LANDED_KEPT_MS ? this.landed : null;
    if (old) this.landed = null;
    return old;
  }

  /** Marks steps `numbers` done; returns the line to say, or null when none was open. Ends the landing. */
  done(numbers) {
    this.landed = null;
    const newly = numbers.map(n => this.steps[n - 1]).filter(step => step && !step.done);
    if (!newly.length) return null;
    for (const step of newly) step.done = true;
    const said = newly.map(step => step.text).join(', ');
    return this.next ? `done: ${said}; next: ${this.next.text}` : `done: ${said}; that was the last step.`;
  }

  /** What the done check asks the model: the plan, then the debrief's facts of the session so far. */
  doneInput(facts) {
    const plan = this.steps.map((step, i) => `${i + 1}. ${step.text}${step.done ? ' (done already)' : ''}`).join('\n');
    return `Plan:\n${plan}\n\nJust now: ${this.landed?.what ?? 'nothing'}\n\nFacts:\n${facts.filter(Boolean).join('\n')}`;
  }

  /** The plan for the models' "Now" lines and the debrief: ✓ done, → next, ○ open; null without one. */
  summary() {
    if (!this.steps.length) return null;
    const next = this.next;
    return this.steps.map((step, i) => `${step.done ? '✓' : step === next ? '→' : '○'} ${i + 1} ${step.text}${step === next ? ' (next)' : ''}`).join(' · ');
  }
}
