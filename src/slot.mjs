// One server for both roles: many local servers answer one request at a time, so the Watcher's quick score would
// wait behind a long Partner answer that thinks, and a remark nobody asked for would hold up the user's question.
// The slot puts the requests in order: while the Partner is at work the Watcher's checks wait (the trigger is
// looked at again on the next tick), and a turn the user asked for cancels the scores and remarks still running.
// It also counts what it cancelled and times the Watcher's calls, for `pair doctor`.

const SAMPLES = 200; // the latest this many Watcher calls count

const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

export class ModelSlot {
  /** `exclusive`: both roles share one server, so their requests are put in order; without it the slot only measures. */
  constructor({exclusive, now = Date.now}) {
    Object.assign(this, {exclusive, now});
    this.turns = new Set(); // the Partner turns at work: {conversation, asked, cancel, cancelled}
    this.scoring = new Set(); // the AbortControllers of the Watcher calls at work
    this.scores = []; // how long each Watcher call took, in ms
    this.cancelled = {scores: 0, remarks: 0};
  }

  /** Whether a Partner turn is at work. */
  busy() {
    return this.turns.size > 0;
  }

  /**
   * Runs one Watcher call, `call(signal)`, and resolves with its result; null when it has to wait: the Partner is
   * at work, or a turn the user asked for cancelled it.
   */
  async watch(call) {
    if (this.exclusive && this.busy()) return null;
    const controller = new AbortController();
    this.scoring.add(controller);
    const started = this.now();
    try {
      const result = await call(controller.signal);
      if (controller.signal.aborted) return null;
      this.scores = [...this.scores.slice(1 - SAMPLES), this.now() - started];
      return result;
    } finally {
      this.scoring.delete(controller);
    }
  }

  /**
   * Runs one Partner turn of `conversation`, `call()`. On one server a turn the user `asked` for goes first: the
   * Watcher calls and the remarks nobody asked for that are at work are cancelled. `cancel()` stops this turn, if
   * it is a remark.
   */
  async turn({conversation, asked, cancel}, call) {
    if (asked && this.exclusive) this.makeRoom();
    const turn = {conversation, asked, cancel, cancelled: false};
    this.turns.add(turn);
    try {
      return await call();
    } finally {
      this.turns.delete(turn);
    }
  }

  /** Cancels the remark `conversation` is making, if it is; resolves once the cancel is sent. */
  async cancel(conversation) {
    await Promise.all([...this.turns].filter(turn => turn.conversation === conversation).map(turn => this.stop(turn)));
  }

  makeRoom() {
    for (const controller of this.scoring) {
      controller.abort();
      this.cancelled.scores += 1;
    }
    for (const turn of this.turns) this.stop(turn);
  }

  /** Cancels `turn` if it is a remark nobody asked for, once. */
  async stop(turn) {
    if (turn.asked || turn.cancelled) return;
    turn.cancelled = true;
    this.cancelled.remarks += 1;
    await turn.cancel();
  }

  /** What `pair doctor` shows: how long the Watcher's calls take, and what the user's questions cancelled. */
  snapshot() {
    return {exclusive: this.exclusive, scores: this.scores.length, scoreMedianMs: median(this.scores), cancelled: {...this.cancelled}};
  }
}
