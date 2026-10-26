// Whether each model answers. A model that fails is marked down once: one log line and one notice for the
// statusline and the chat, however many calls fail after it. While a model is down Pair stays quiet, and a
// small probe every 30 s notices when it answers again.
export const MODEL_ROLES = ['watcher', 'partner'];

export class ModelHealth {
  /** `probe(role)` resolves `{ok, error}`; `onChange(role, reason)` gets every change, `reason` null when up. */
  constructor({probe, onChange = () => {}, intervalMs = 30_000}) {
    Object.assign(this, {probe, onChange, intervalMs});
    this.down = {}; // role -> why it is down
    this.probing = false;
  }

  /** The outcome of a real call to `role`'s model: `error` when it failed. */
  report(role, error = null) {
    const reason = error ? String(error).split('\n')[0].slice(0, 160) : null;
    if (Boolean(this.down[role]) === Boolean(reason)) return; // no news: still up, or still down
    if (reason) this.down[role] = reason;
    else delete this.down[role];
    this.onChange(role, reason);
  }

  ok(role) {
    return role ? !this.down[role] : !Object.keys(this.down).length;
  }

  /** `{watcher, partner}`: why each model is down, or null. */
  snapshot() {
    return Object.fromEntries(MODEL_ROLES.map(role => [role, this.down[role] ?? null]));
  }

  /** Probes every model once now, then the ones that are down every interval. */
  start() {
    this.check(MODEL_ROLES);
    this.timer = setInterval(() => this.check(Object.keys(this.down)), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  async check(roles) {
    if (this.probing || !roles.length) return;
    this.probing = true;
    try {
      for (const role of roles) {
        const result = await this.probe(role);
        this.report(role, result.ok ? null : result.error);
      }
    } finally {
      this.probing = false;
    }
  }
}
