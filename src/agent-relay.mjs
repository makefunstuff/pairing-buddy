// Relays your other agents' news into one pairing session: one line, at your next breakpoint (the session's,
// see held.mjs: a save, a run that ended, a stop to look), never while you type.
// The line stays in Neovim's statusline until you go there, the agent moves on, or newer news replaces it.
import {basename} from 'node:path';
import {STATUSES} from './agents.mjs';

const NAME_WIDTH = 24; // of the name column in the list
// A line that asks nothing of you (done, failed) goes by itself after this long; one that needs you stays.
export const SETTLED_LINE_MS = 2 * 60_000;
const ASKS = new Set(['needs', 'ready']);

const SAID = {needs: 'needs you', ready: 'ready to merge', failed: 'failed', done: 'done', working: 'working', waiting: 'waiting'};

/**
 * How an item is named in one line: `#19` for a task of this project's repo (its space or folder is one of `repos`,
 * the names the repo goes by), `WEB-3` for another's.
 */
export function itemName(item, repos) {
  if (item.kind !== 'task') return item.title;
  const ours = [repos].flat().some(name => name && (name === item.space || name === item.repo));
  const number = item.id.match(/-(\d+)$/)?.[1];
  return ours && number ? `#${number}` : item.id;
}

/** The one line for `item`: who, what it means for you, and its question or title. */
export function newsLine(item, repos) {
  const said = item.kind === 'agent' && item.status === 'done' ? 'finished' : SAID[item.status];
  const about = item.status === 'needs' && item.note ? item.note : item.kind === 'task' ? item.title : '';
  return `${itemName(item, repos)} ${said}${about ? `: ${about}` : ''}`;
}

/** The words for an item's status: a herdr agent that is done is waiting for its next prompt. */
export const statusWords = item => (item.kind === 'agent' && item.status === 'done' ? 'idle' : SAID[item.status]);

/** The answer to `/agents` as lines for the chat: one per task or agent, the ones that need you first. */
export function agentListLines({items, off}) {
  if (off) return ['·· the agent relay is off ("agents": false in the config)'];
  if (!items.length) return ['·· no other agents or board tasks'];
  const width = Math.max(...items.map(item => statusWords(item).length));
  const name = item => (item.name.length > NAME_WIDTH ? `${item.name.slice(0, NAME_WIDTH - 1)}…` : item.name);
  const named = Math.max(...items.map(item => name(item).length));
  return items.map(item => {
    const about = item.kind === 'task' ? item.title : item.note;
    const note = item.kind === 'task' && item.note ? `  · ${item.note}` : '';
    return `  ${statusWords(item).padEnd(width)}  ${name(item).padEnd(named)}  ${about}${note}`;
  });
}

const urgency = item => STATUSES.indexOf(item.status);

export class AgentRelay {
  /**
   * `root` is the session's project; news about the board task whose worktree it is stays out. `send(message)`
   * reaches the session's chat and editors. `breakpoint()` is when the user last came to a natural end, and
   * `wait()` says the news must wait anyway: they type, or Pair is busy (a turn, the wheel). `repos` are the names
   * the project's repo goes by (repoNames), for the `#19` of its own tasks.
   */
  constructor({root, repos = [basename(root)], send, breakpoint, wait = () => false, now = Date.now}) {
    Object.assign(this, {root, repos, send, breakpoint, wait, now});
    this.pending = new Map(); // key -> item, news not shown yet
    this.since = null; // when the oldest of it came: the breakpoint after that shows it
    this.shown = null; // the item on the line now
    this.shownAt = 0;
    this.last = null; // the message that showed it, for an editor that connects later
  }

  /** What the board says changed (see agentNews). */
  hear({news, gone}) {
    for (const key of gone) {
      this.pending.delete(key);
      if (this.shown?.key === key) this.clear();
    }
    if (!this.pending.size) this.since = null;
    for (const item of news) {
      if (item.where === this.root) continue; // this session's own task
      this.pending.set(item.key, item);
      this.since ??= this.now();
    }
  }

  /** Called about once a second: at a breakpoint, the most urgent news becomes the line. */
  tick() {
    if (this.shown && !ASKS.has(this.shown.status) && this.now() - this.shownAt >= SETTLED_LINE_MS) this.clear();
    if (!this.pending.size || this.breakpoint() < this.since || this.wait()) return;
    const [first, ...rest] = [...this.pending.values()].sort((a, b) => urgency(a) - urgency(b));
    this.pending.clear();
    this.since = null;
    this.shown = first;
    this.shownAt = this.now();
    this.last = {type: 'agents', item: first, text: newsLine(first, this.repos), more: rest.length};
    this.send(this.last);
  }

  /** The line is answered (you went there or put it away), no longer true, or old news. */
  clear() {
    this.shown = this.last = null;
    this.send({type: 'agents', item: null});
  }
}
