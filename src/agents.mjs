// Your other agents, in one place: the tasks of the work board (Shepherdr) and the agents running in herdr's panes,
// polled every few seconds. Pair only reads them: the board through board.mjs, herdr through `agent.list`, and git for
// where each task's worktree is. What it does is focus an agent's pane, and find what a task left behind (its report
// or pull request, its branch's diff, its worktree) when you ask.
import {basename} from 'node:path';
import {Board} from './board.mjs';
import {gitBaseBranch, gitBranchDiff, gitWorktrees} from './git.mjs';
import {herdrRequest} from './herdr.mjs';

const POLL_MS = 5000;
const RECENT_MS = 12 * 3600_000; // a task you saw finish stays in the list this long
const SPACES_MS = 60_000; // the board's spaces are read again this often
const SHOWN_AT_ONCE = 4; // tasks read in full (task show) at the same time

// What an agent's state means for you, most urgent first: the relay shows the first of these.
export const STATUSES = ['needs', 'ready', 'failed', 'done', 'working', 'waiting'];
// The ones worth telling you about when a task or agent reaches them.
const NEWS = new Set(['needs', 'ready', 'failed', 'done']);

/**
 * What a board task's status means for you: it waits for your answer (need) or for a merge (ready), works, waits for a
 * go or for room (to do, queued), or is done; a task that ended without its work done failed.
 */
export function taskStatus(task) {
  if (task.status === 'need') return 'needs';
  if (task.status === 'ready') return 'ready';
  if (task.status === 'done') return task.outcome === 'failed' ? 'failed' : 'done';
  return ['work', 'merging'].includes(task.status) ? 'working' : 'waiting';
}

/** What a herdr agent's lifecycle state means: a question or approval on its screen, at work, or finished. */
export function agentStatus(agent) {
  if (agent.agent_status === 'blocked') return 'needs';
  if (agent.agent_status === 'working') return 'working';
  return 'done'; // idle, done, unknown: it waits for input
}

/**
 * One list of everything, each item {key, kind: 'task'|'agent', id, title, status, note, pane, where, …}: the board's
 * tasks, then the herdr agents that belong to no task. A task comes with what `task show` said of it (space, branch,
 * pr) and `where`, its worktree, in which its agents run; `repo` is its space's folder name.
 */
export function agentItems({tasks = [], agents = []}) {
  const items = [];
  const worktrees = new Set();
  for (const task of tasks) {
    if (task.where) worktrees.add(task.where);
    items.push({
      key: `task:${task.id}`, kind: 'task', id: task.id, title: task.title ?? task.id, status: taskStatus(task),
      note: task.sub ?? '', pane: null, where: task.where ?? null, pr: task.pr ?? null, branch: task.branch ?? null,
      space: task.space ?? null, repo: task.repo ?? null, machine: task.machine ?? null,
    });
  }
  for (const agent of agents) {
    // A task's agent and its reviewer run in the task's worktree: the task already says how they are.
    if (worktrees.has(agent.cwd) || !agent.pane_id) continue;
    items.push({
      key: `agent:${agent.pane_id}`, kind: 'agent', id: agent.name ?? agent.pane_id,
      title: agent.title || agent.name || `${agent.agent} in ${basename(agent.cwd ?? '') || '~'}`,
      status: agentStatus(agent), note: agent.terminal_title_stripped ?? '', pane: agent.pane_id, where: agent.cwd ?? null,
    });
  }
  // A task's pane is its agent's, while herdr has one in its worktree.
  for (const item of items) {
    if (item.kind === 'task' && item.where) item.pane = agents.find(agent => agent.cwd === item.where && agent.pane_id)?.pane_id ?? null;
  }
  return items;
}

/**
 * What changed from `before` to `after` (two lists from agentItems): the items that reached a state worth
 * telling you about, and the keys of those that left one (an answered question, a merged task).
 */
export function agentNews(before, after) {
  const old = new Map(before.map(item => [item.key, item.status]));
  const news = after.filter(item => NEWS.has(item.status) && old.has(item.key) && old.get(item.key) !== item.status);
  const gone = before.filter(item => NEWS.has(item.status)
    && after.find(next => next.key === item.key)?.status !== item.status).map(item => item.key);
  return {news, gone};
}

/** `items` mapped by `each`, SHOWN_AT_ONCE at a time. */
async function inTurns(items, each) {
  const out = [];
  for (let i = 0; i < items.length; i += SHOWN_AT_ONCE) out.push(...await Promise.all(items.slice(i, i + SHOWN_AT_ONCE).map(each)));
  return out;
}

export class AgentBoard {
  /**
   * `board` is the board's command (`shepherdr`), or null for none. `onChange({news, gone})` hears what changed after
   * each poll. herdr's agents are read once `useHerdr(socket)` names herdr's socket. Nothing is polled while
   * `wanted()` says no session listens.
   */
  constructor({board = 'shepherdr', onChange = () => {}, wanted = () => true, log = () => {}, pollMs = POLL_MS}) {
    Object.assign(this, {board, onChange, wanted, log, pollMs});
    this.socketPath = null;
    this.items = null; // the last poll's list; null before the first, and again while no session listens
    this.read = {board: [], herdr: [], spaces: []}; // what each source last answered
    this.spacesAt = 0;
    this.shown = new Map(); // task id -> {status, sub, task}: what task show said, read again when its status changes
    this.finished = new Map(); // key -> when a task was seen to finish
    this.failing = {}; // per source, the error of its last poll
  }

  get shepherdr() {
    if (this.adapter?.command !== this.board) this.adapter = this.board ? new Board(this.board) : null;
    return this.adapter;
  }

  useHerdr(socketPath) {
    this.socketPath ??= socketPath;
  }

  start() {
    this.timer = setInterval(() => this.poll().catch(error => this.log(`agents: ${error.message}`)), this.pollMs);
    return this.poll().catch(error => this.log(`agents: ${error.message}`));
  }

  stop() {
    clearInterval(this.timer);
  }

  /**
   * Runs `read`, logging once when it starts failing and once when it works again. A source that fails keeps what it
   * last answered (nothing, for a board that is not installed), so one source down neither empties the list nor
   * holds back the other.
   */
  async source(name, read) {
    try {
      this.read[name] = await read();
      if (this.failing[name]) this.log(`agents: ${name} answers again`);
      this.failing[name] = null;
    } catch (error) {
      // A board command not on PATH is a board that is not installed, as on most machines: nothing to read, nothing
      // to log. A path of the user's own that is missing is logged.
      const notInstalled = name !== 'herdr' && error.code === 'ENOENT' && !this.board?.includes('/');
      if (this.failing[name] !== error.message && !notInstalled) this.log(`agents: ${name}: ${error.message}`);
      this.failing[name] = error.message;
    }
    return this.read[name];
  }

  /** One look at the board and herdr; a look still running when the next is due makes that one skip. */
  async poll() {
    // With nobody to tell, there is no baseline: what changes meanwhile is no news for the next session.
    if (!this.wanted()) this.items = null;
    if (this.polling || !this.wanted()) return;
    this.polling = true;
    try {
      await this.look();
    } finally {
      this.polling = false;
    }
  }

  async look() {
    const board = this.shepherdr;
    const listed = board ? await this.source('board', () => board.tasks()) : [];
    if (board && (!this.spacesAt || Date.now() - this.spacesAt >= SPACES_MS)) {
      await this.source('spaces', () => board.spaces());
      this.spacesAt = Date.now();
    }
    const agents = this.socketPath ? await this.source('herdr', async () => (await herdrRequest(this.socketPath, 'agent.list')).agents) : [];
    const tasks = await this.inFull(listed);
    const items = agentItems({tasks, agents});
    if (this.items) {
      const change = agentNews(this.items, items);
      for (const item of change.news) if (item.kind === 'task' && item.status === 'done') this.finished.set(item.key, Date.now());
      if (change.news.length || change.gone.length) this.onChange(change);
    }
    this.items = items;
  }

  /**
   * The listed tasks with what `task show` says of them (space, branch, pull request) and where their worktree is. A
   * task is shown again only when its status line changed, and one that was done before Pair saw it not at all: it is
   * not listed. Another machine's task is not read further.
   */
  async inFull(listed) {
    const board = this.shepherdr;
    const stale = listed.filter(task => {
      if (task.machine || !board) return false;
      const known = this.shown.get(task.id);
      return known ? known.status !== task.status || known.sub !== task.sub : task.status !== 'done';
    });
    await inTurns(stale, async task => {
      try {
        this.shown.set(task.id, {status: task.status, sub: task.sub, task: await board.show(task.id)});
        this.failing[`show ${task.id}`] = null;
      } catch (error) {
        if (this.failing[`show ${task.id}`] !== error.message) this.log(`agents: task show ${task.id}: ${error.message}`);
        this.failing[`show ${task.id}`] = error.message; // logged once, read again at the next poll
      }
    });
    const spaces = new Map(this.read.spaces.map(space => [space.name, space]));
    const full = listed.map(task => ({...this.shown.get(task.id)?.task, ...task}));
    const folders = [...new Set(full.filter(task => task.branch && task.status !== 'done').map(task => spaces.get(task.space)?.path).filter(Boolean))];
    const worktrees = new Map(await Promise.all(folders.map(async path => [path, await gitWorktrees(path)])));
    return full.map(task => {
      const path = spaces.get(task.space)?.path;
      return {...task, repo: path ? basename(path) : task.space ?? null, where: (path && task.branch && worktrees.get(path)?.get(task.branch)) ?? null};
    });
  }

  /** Everything there is now, without the board's old finished tasks: only those seen finishing lately. */
  list(now = Date.now()) {
    return (this.items ?? []).filter(item => item.kind !== 'task' || item.status !== 'done' || now - (this.finished.get(item.key) ?? 0) < RECENT_MS);
  }

  /** Brings the agent's pane to the front in herdr; false when it has no pane open now. */
  async focus(key) {
    const item = this.items?.find(other => other.key === key);
    if (!item?.pane || !this.socketPath) return false;
    await herdrRequest(this.socketPath, 'agent.focus', {target: item.pane});
    return true;
  }

  /**
   * What a task or agent left behind, for `what`: 'open', its report and pull request as [{label, url}] (`links`);
   * 'diff', its branch against the branch it merges into (`diff`, `title`); 'term', its worktree or folder (`where`).
   * `error` says why there is none. Read when you ask, never polled.
   */
  async leftBehind(key, what) {
    const item = this.items?.find(other => other.key === key);
    if (!item) return {error: 'it is not on the list any more'};
    const name = item.kind === 'task' ? item.id : item.title;
    const far = item.machine ? ` (on ${item.machine})` : '';
    if (what === 'open') {
      if (item.kind !== 'task') return {error: `${name} is an agent of your own, with no report or pull request`};
      const report = item.machine ? null : await this.shepherdr?.report(item.id).catch(() => null);
      const number = item.pr?.match(/\/pull\/(\d+)/)?.[1];
      const links = [...(report ? [{label: 'its report', url: report}] : []), ...(item.pr ? [{label: `its pull request${number ? ` #${number}` : ''}`, url: item.pr}] : [])];
      return links.length ? {links} : {error: `${name} has no report or pull request yet`};
    }
    if (what === 'diff') {
      if (!item.branch) return {error: item.kind === 'task' ? `${name} has no branch yet${far}` : `${name} is an agent of your own, with no branch of a task`};
      const folder = item.where ?? this.read.spaces.find(space => space.name === item.space)?.path;
      if (!folder || far) return {error: `${name}'s repository is not on this machine${far}`};
      const base = await gitBaseBranch(folder);
      if (!base) return {error: `${name}'s repository has no main branch to compare with`};
      try {
        const diff = await gitBranchDiff(folder, base, item.branch);
        return diff.trim() ? {diff, title: `${name} · ${item.branch} against ${base}`} : {error: `${item.branch} changes nothing against ${base}`};
      } catch (error) {
        return {error: `no diff of ${item.branch}: ${error.message.split('\n')[0]}`};
      }
    }
    if (what === 'term') {
      if (item.where) return {where: item.where, title: name};
      return {error: item.kind === 'task' ? `${name} has no worktree on this machine${item.status === 'done' ? ': it is done, and it went with the merge' : far}` : `${name} runs in no folder Pair knows`};
    }
    return {error: `no ${what}`};
  }
}
