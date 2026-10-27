// Runs the shell of Pair's pane for real, as herdr's pane would start it, and reads each command back from the
// files its rc file writes, as ScoutPane does.
import {spawn} from 'node:child_process';
import {PaneRuns} from '../src/pane-runs.mjs';
import {shellLine} from '../src/scout-shell.mjs';

/**
 * Starts the pane's shell for `setup` (scoutPaneConfig) in `cwd`, its files in `dir`, and types `commands` one at a
 * time, each once the one before ended (an empty one is typed without waiting). Resolves with each command's
 * `{exit, output}` and the shell's `runs` (a PaneRuns). With `terminal`, the shell gets one (`script`), else pipes.
 * `line`, a function, builds a shell line of the caller's once `dir` is made: the sandbox binds only what is there.
 */
export async function runInPane({setup, cwd, dir, commands, terminal = false, line: lineFor = null, timeoutMs = 10_000}) {
  const runs = new PaneRuns(dir);
  await runs.prepare();
  const line = lineFor ? lineFor() : shellLine({setup, cwd, runs: dir}).line;
  const shell = terminal
    ? spawn('script', ['-qec', line, '/dev/null'], {cwd, env: {...process.env, TERM: 'xterm'}})
    : spawn('sh', ['-c', `${line} 2>&1`], {cwd});
  shell.stdout.resume();
  const results = [];
  try {
    await runs.ready(timeoutMs);
    for (const command of commands) {
      const number = await runs.next();
      if (command) await runs.clearLog();
      shell.stdin.write(`${command}${terminal ? '\r' : '\n'}`);
      if (!command) continue;
      await runs.ended(number, timeoutMs);
      results.push(await runs.result(number));
    }
    return {results, runs, shell};
  } finally {
    if (!terminal) shell.stdin.end();
  }
}
