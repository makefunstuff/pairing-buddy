// The herdr work board (herdr-projects): the task a project's branch belongs to, and how the repo's other tasks are
// doing. Read with its own command, `list --json`; Pair never changes the board.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run = promisify(execFile);

/** The board's tasks: [{id: "repo/12", state, title, msg, pr?}], or null when the board cannot be read. */
export async function boardTasks(command) {
  try {
    const {stdout} = await run(command, ['list', '--json'], {timeout: 3000});
    const tasks = JSON.parse(stdout);
    return Array.isArray(tasks) ? tasks : null;
  } catch {
    return null;
  }
}

/** The task number a branch is named for: 25 in `work/25-context-card` or `25-fix`; null for `main`. */
export function branchNumber(branch) {
  const number = branch?.match(/(?:^|\/)(\d+)(?:[-_.]|$)/)?.[1];
  return number ? Number(number) : null;
}

/**
 * The board as it concerns a project: `task`, the one whose number its branch has, in a repo of one of `repos`
 * (a number alone would match another repo's task of the same number), and the repo's other tasks that are working
 * and that wait for the user. Null without a board.
 */
export function boardContext(tasks, {repos, branch}) {
  if (!tasks) return null;
  const number = branchNumber(branch);
  const repoOf = task => task.id.slice(0, task.id.lastIndexOf('/'));
  const task = number === null ? null : tasks.find(each => repos.some(repo => each.id === `${repo}/${number}`)) ?? null;
  const others = tasks.filter(each => each !== task && repos.includes(repoOf(each)));
  const brief = each => ({id: each.id, title: each.title});
  return {
    task: task && {id: task.id, title: task.title, state: task.state, msg: task.msg ?? '', pr: task.pr ?? null},
    working: others.filter(each => each.state === 'working').length,
    waiting: others.filter(each => each.state === 'blocked').map(brief),
  };
}

/** Whether a command line is the board launching one of its agents: the board typed it, not the user. */
export const boardLaunch = cmd => /herdr-projects/.test(cmd);
