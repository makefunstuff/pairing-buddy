// Your other agents, in one place: the tasks of a herdr work board (Herdr Projects) and the agents running in
// herdr's panes, polled every few seconds. Pair only reads them: the board through its own `list --json` and
// its task files, herdr through `agent.list`. The one thing it does is focus an agent's pane when you ask.
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename, join} from 'node:path';
import {herdrRequest} from './herdr.mjs';

const POLL_MS = 5000;
const RECENT_MS = 12 * 3600_000; // a task you saw finish stays in the list this long
const BOARD_TIMEOUT_MS = 5000;

// What an agent's state means for you, most urgent first: the relay shows the first of these.
export const STATUSES = ['needs', 'approve', 'failed', 'done', 'working', 'waiting'];
// The ones worth telling you about when a task or agent reaches them.
const NEWS = new Set(['needs', 'approve', 'failed', 'done']);

/**
 * What a board task's state means for you: it waits for your answer, your approval, or nothing. `file` is its task
 * file: finished work whose merge failed or whose sync is blocked needs you, as the board's own notices say.
 */
export function taskStatus(task, file = {}) {
  if (task.stage === 'approval') return file.failure || file.prFailure || file.syncBlocked ? 'needs' : 'approve';
  if (task.state === 'blocked' || ['asks', 'plan', 'reviewneeds'].includes(task.stage)) return 'needs';
  if (task.state === 'error') return 'failed';
  if (task.state === 'done') return 'done';
  if (task.state === 'idle') return 'waiting'; // stopped, or not started
  return ['queued', 'after'].includes(task.stage) ? 'waiting' : 'working';
}

/** What a herdr agent's lifecycle state means: a question or approval on its screen, at work, or finished. */
export function agentStatus(agent) {
  if (agent.agent_status === 'blocked') return 'needs';
  if (agent.agent_status === 'working') return 'working';
  return 'done'; // idle, done, unknown: it waits for input
}

/** Where the board keeps its files: as Herdr Projects finds them. */
export function boardDir(env = process.env) {
  if (env.HERDR_PROJECTS_DATA_DIR) return env.HERDR_PROJECTS_DATA_DIR;
  return join(env.HERDR_PROJECTS_HOME || join(homedir(), '.herdr-projects'), 'data');
}

/**
 * One list of everything, each item {key, kind: 'task'|'agent', id, title, status, note, pane, where}: the board's
 * tasks (not archived), then the herdr agents that belong to no task. `files` maps a task id to its task file's
 * {worktree, link}, which say where its agents run.
 */
export function agentItems({tasks = [], files = {}, agents = []}) {
  const items = [];
  const worktrees = new Set();
  for (const task of tasks) {
    if (task.archivedAt) continue;
    const file = files[task.id] ?? {};
    if (file.worktree) worktrees.add(file.worktree);
    const status = taskStatus(task, file);
    items.push({
      key: `task:${task.id}`, kind: 'task', id: task.id, title: task.title ?? task.id, status,
      note: task.msg ?? '', pane: file.link?.pane ?? null, where: file.worktree ?? null, pr: task.pr ?? null,
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
  // A task's pane is only worth going to while herdr still has it.
  const live = new Set(agents.map(agent => agent.pane_id));
  for (const item of items) if (item.pane && !live.has(item.pane)) item.pane = null;
  return items;
}

/**
 * What changed from `before` to `after` (two lists from agentItems): the items that reached a state worth
 * telling you about, and the keys of those that left one (an answered question, an approved task).
 */
export function agentNews(before, after) {
  const old = new Map(before.map(item => [item.key, item.status]));
  const news = after.filter(item => NEWS.has(item.status) && old.has(item.key) && old.get(item.key) !== item.status);
  const gone = before.filter(item => NEWS.has(item.status)
    && after.find(next => next.key === item.key)?.status !== item.status).map(item => item.key);
  return {news, gone};
}

function run(command, args) {
  return new Promise((resolve, reject) => execFile(command, args, {timeout: BOARD_TIMEOUT_MS, maxBuffer: 64 << 20},
    (error, stdout) => (error ? reject(error) : resolve(stdout))));
}

async function taskFile(dir, id) {
  try {
    const {worktree = null, link = null, failure = null, prFailure = null, syncBlocked = null} = JSON.parse(await readFile(join(dir, 'tasks', ...id.split('/'), 'task.json'), 'utf8'));
    return {worktree, link, failure, prFailure, syncBlocked};
  } catch {
    return {};
  }
}

export class AgentBoard {
  /**
   * `board` is the board's command (`herdr-projects`), or null for none; `dir` its files. `onChange({news, gone})`
   * hears what changed after each poll. herdr's agents are read once `useHerdr(socket)` names herdr's socket.
   * Nothing is polled while `wanted()` says no session listens.
   */
  constructor({board = 'herdr-projects', dir = boardDir(), onChange = () => {}, wanted = () => true, log = () => {}, pollMs = POLL_MS}) {
    Object.assign(this, {board, dir, onChange, wanted, log, pollMs});
    this.socketPath = null;
    this.items = null; // the last poll's list; null before the first, and again while no session listens
    this.read = {board: [], herdr: []}; // what each source last answered
    this.finished = new Map(); // key -> when a task was seen to finish
    this.doneFiles = new Map(); // id -> the task file of a finished task, read once
    this.failing = {}; // per source, the error of its last poll
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
      if (this.failing[name] !== error.message) this.log(`agents: ${name}: ${error.message}`);
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
    const tasks = this.board ? await this.source('board', async () => JSON.parse(await run(this.board, ['list', '--json']))) : [];
    const agents = this.socketPath ? await this.source('herdr', async () => (await herdrRequest(this.socketPath, 'agent.list')).agents) : [];
    const live = tasks.filter(task => !task.archivedAt);
    // A finished task's file no longer changes, but its agent's pane may still be open: it is read once.
    const fileOf = async task => {
      if (task.state !== 'done') return taskFile(this.dir, task.id);
      if (!this.doneFiles.has(task.id)) this.doneFiles.set(task.id, await taskFile(this.dir, task.id));
      return this.doneFiles.get(task.id);
    };
    const files = Object.fromEntries(await Promise.all(live.map(async task => [task.id, await fileOf(task)])));
    const items = agentItems({tasks: live, files, agents});
    if (this.items) {
      const change = agentNews(this.items, items);
      for (const item of change.news) if (item.kind === 'task' && item.status === 'done') this.finished.set(item.key, Date.now());
      if (change.news.length || change.gone.length) this.onChange(change);
    }
    this.items = items;
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
}
