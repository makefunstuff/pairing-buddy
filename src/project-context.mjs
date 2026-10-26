// Reads what a project's context card shows of git and the board, as a `context` event for the session state.
// A pull request is asked of GitHub's `gh` at most every few minutes per branch, and only when the board does not
// already name one; offline or without `gh`, the card leaves it out.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {boardContext, boardTasks} from './board.mjs';
import {DEFAULT_BRANCHES} from './context-card.mjs';
import {gitBranch, gitLastCommit, gitStatus, repoNames} from './git.mjs';

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

/** `board` is the board's command, or null for none. */
export function projectContext({board = null, now = Date.now} = {}) {
  const prs = new Map(); // `${root}\n${branch}` -> {pr, at}

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
    const tasks = board && repos.length ? await boardTasks(board) : null; // a folder outside git has no board task
    const boardNow = boardContext(tasks, {repos, branch});
    const pr = boardNow?.task?.pr ? prOfUrl(boardNow.task.pr) : await prOf(root, branch);
    return {
      kind: 'context',
      branch,
      git: {last, changed: status === null ? null : status.split('\n').filter(Boolean).length, pr},
      board: boardNow,
    };
  };
}
