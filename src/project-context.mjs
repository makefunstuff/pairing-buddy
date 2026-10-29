// Reads what a project's context card shows of git and the board, as a `context` event for the session state.
// The board (Shepherdr) is read through board.mjs: the space of the repo, its tasks, and the branch's own task in full
// (its pull request, its status, and its brief on the board, which is part of the brief /gen runs against).
// A pull request is asked of GitHub's `gh` at most every few minutes per branch, and only when the board does not
// already name one; offline or without `gh`, the card leaves it out.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Board, boardContext, spaceFor} from './board.mjs';
import {DEFAULT_BRANCHES} from './context-card.mjs';
import {gitBranch, gitCheckout, gitLastCommit, gitStatus, repoNames} from './git.mjs';

const run = promisify(execFile);
const PR_EVERY_MS = 5 * 60_000;

/** The open or merged pull request of the checked-out branch: "#12 open · title", '' when there is none, null when unknown. */
async function pullRequest(root) {
  try {
    const {stdout} = await run('gh', ['pr', 'view', '--json', 'number,state,title'], {cwd: root, timeout: 5000});
    const pr = JSON.parse(stdout);
    return `#${pr.number} ${pr.state.toLowerCase()} · ${pr.title}`;
  } catch (error) {
    return /no pull requests found/i.test(error.stderr ?? '') ? '' : null;
  }
}

/** The board names a task's pull request by its URL: #12. */
const prOfUrl = url => {
  const number = url.match(/\/pull\/(\d+)/)?.[1];
  return number ? `#${number}` : url;
};

/**
 * The board as it concerns the project at `root` (see boardContext), with its own task's pull request, status and brief; null without a
 * board, outside git, or when the board does not know the repo or cannot be read.
 */
async function readBoard(board, root, {repos, branch}) {
  if (!board || !repos.length) return null; // a folder outside git has no board task
  try {
    const space = spaceFor(await board.spaces(), {repos, checkout: await gitCheckout(root)});
    if (!space) return null;
    const context = boardContext(await board.tasks({space: space.name}), {space: space.name, branch});
    if (context.task) {
      const shown = await board.show(context.task.id).catch(() => null);
      Object.assign(context.task, {pr: shown?.pr ?? null, brief: shown?.brief ?? null, status: shown?.status ?? null});
    }
    return context;
  } catch {
    return null;
  }
}

/** `board` is the board's command, or null for none. */
export function projectContext({board = null, now = Date.now} = {}) {
  const prs = new Map(); // `${root}\n${branch}` -> {pr, at}
  const shepherdr = board ? new Board(board) : null;

  async function prOf(root, branch) {
    if (!branch || DEFAULT_BRANCHES.has(branch)) return null;
    const key = `${root}\n${branch}`;
    const known = prs.get(key);
    if (known && now() - known.at < PR_EVERY_MS) return known.pr;
    const pr = await pullRequest(root);
    prs.set(key, {pr, at: now()});
    return pr;
  }

  return async function read(root) {
    const branch = await gitBranch(root);
    const [last, status, repos] = await Promise.all([gitLastCommit(root), gitStatus(root), repoNames(root)]);
    const boardNow = await readBoard(shepherdr, root, {repos, branch});
    const pr = boardNow?.task?.pr ? prOfUrl(boardNow.task.pr) : await prOf(root, branch);
    return {
      kind: 'context',
      branch,
      git: {last, changed: status === null ? null : status.split('\n').filter(Boolean).length, pr},
      board: boardNow,
    };
  };
}
