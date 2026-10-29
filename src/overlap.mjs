// What the board's working tasks change in your repo, read every 30 s while a Neovim is connected: for each task of
// the repo's space whose agent works (Shepherdr's work and merging), which files its branch changes and which lines
// of them, by git, read only (`git diff -U0` against where the branch left its base, in the task's worktree with what
// its agent has not committed yet). Neovim says so in the winbar of a file a task also changes, and an edit of yours
// on lines a task changes is the overlap moment, which goes through the speak gate like any other (triggers.mjs).
// Pair writes nothing here: not to the board, not to git.
import {isAbsolute, join, relative} from 'node:path';
import {Board} from './board.mjs';
import {gitBaseBranch, gitRoot, gitTaskDiff, gitWorktrees} from './git.mjs';

export const TASK_CHANGES_MS = 30_000;
const WORKING = new Set(['work', 'merging']);
const MAX_FILES = 200; // of one task's branch: a bigger change is cut here
const MAX_RANGES = 40; // per file
const SAMPLE_LINES = 4; // of each change, the lines the branch writes there, for the Partner's remark

/**
 * The files and lines a `git diff -U0` changes: [{file, ranges: [{from, to, added}]}], `file` relative to the repo.
 * The lines are the base's, where your checkout has them: a change that only adds lines is the line it adds under
 * (at least 1). `added` holds the first few lines the branch writes there. A deleted file counts; a new one too.
 */
export function parseTaskDiff(text) {
  const files = [];
  let file = null;
  let range = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = null;
      range = null;
      continue;
    }
    const name = /^(?:\+\+\+|---) (?:[ab]\/(.+)|\/dev\/null)$/.exec(line);
    if (name) {
      if (name[1] && !files.some(each => each.file === name[1])) {
        if (files.length >= MAX_FILES) break;
        file = {file: name[1], ranges: []};
        files.push(file);
      } else if (name[1]) file = files.find(each => each.file === name[1]);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (hunk && file) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      range = file.ranges.length < MAX_RANGES ? {from: Math.max(1, start), to: Math.max(1, count ? start + count - 1 : start), added: []} : null;
      if (range) file.ranges.push(range);
      continue;
    }
    if (range && line.startsWith('+') && range.added.length < SAMPLE_LINES) range.added.push(line.slice(1));
  }
  return files;
}

/** The ranges of `ranges` that lines `from`-`to` touch, or the line next to one. */
export const touched = (ranges, from, to) => ranges.filter(range => from <= range.to + 1 && to >= range.from - 1);

/** What the editors are sent: each file a task changes, as an absolute path, with the tasks that change it. */
export function taskFiles(tasks, root) {
  const files = new Map();
  for (const task of tasks) {
    for (const {file} of task.files) {
      const path = join(root, file);
      if (!files.has(path)) files.set(path, []);
      files.get(path).push({id: task.id, title: task.title, branch: task.branch});
    }
  }
  return [...files].map(([file, by]) => ({file, tasks: by}));
}

export class TaskChanges {
  /** `board` is the board's command (`shepherdr`), or null for none. */
  constructor({board = null, log = () => {}} = {}) {
    Object.assign(this, {board, log});
    this.branches = new Map(); // task id -> its branch, as task show last said it
    this.failing = null; // the last error, logged once
  }

  get shepherdr() {
    if (this.adapter?.command !== this.board) this.adapter = this.board ? new Board(this.board) : null;
    return this.adapter;
  }

  /**
   * The working tasks of `space` other than `own` (the task of the branch you are on), each {id, title, branch, files}
   * where `files` are [{file, ranges}] relative to the session's `root` and inside it. [] without a board, a space or
   * a base branch; null when the board cannot be read now (the last answer stands).
   */
  async read({root, space, own = null}) {
    const board = this.shepherdr;
    if (!board || !space) return [];
    let tasks;
    try {
      tasks = (await board.tasks({space})).filter(task => WORKING.has(task.status) && task.id !== own && !task.machine);
      this.said(null);
    } catch (error) {
      this.said(`task list: ${error.message}`);
      return null;
    }
    if (!tasks.length) return [];
    const top = await gitRoot(root);
    const base = top && (await gitBaseBranch(top));
    if (!base) return [];
    const worktrees = await gitWorktrees(top);
    const read = [];
    for (const task of tasks) {
      if (!this.branches.get(task.id)) this.branches.set(task.id, await board.show(task.id).then(shown => shown.branch, () => null));
      const branch = this.branches.get(task.id);
      if (!branch) continue; // its agent has not made one yet
      const diff = await gitTaskDiff(top, base, branch, {worktree: worktrees.get(branch) ?? null}).catch(error => {
        this.log(`overlap: ${task.id}'s branch ${branch}: ${error.message.split('\n')[0]}`);
        return '';
      });
      // The repo's paths, as the session's: a session rooted in a folder of the repo sees only that folder's files.
      const files = parseTaskDiff(diff).map(each => ({...each, file: relative(root, join(top, each.file))}))
        .filter(each => each.file && !each.file.startsWith('..') && !isAbsolute(each.file));
      read.push({id: task.id, title: task.title, branch, files});
    }
    return read;
  }

  said(error) {
    if (error && error !== this.failing) this.log(`overlap: ${error}`);
    this.failing = error;
  }
}
