// Without systemd or launchd, `pair` runs the daemon under this supervisor (`pair supervise`), which restarts it when
// it fails, as their services do: after a crash or an error exit, not after a clean stop. A daemon that keeps
// failing at once (a broken config, another daemon holding the data) is given up on, as systemd does.
import {spawn} from 'node:child_process';

export const RESTART_MS = 2000;
const BURST = 5; // failures within WINDOW_MS that make it give up
const WINDOW_MS = 60_000;

/**
 * Runs `command` with `args` and starts it again `restartMs` after it fails. Resolves when it stopped cleanly, or
 * after `burst` failures in a minute. `stop()` stops the daemon (with SIGTERM) and the supervisor with it.
 */
export function supervise({command, args, log, restartMs = RESTART_MS, burst = BURST, now = Date.now}) {
  let child = null;
  let stopping = false;
  let timer = null;
  let failures = [];
  let done;
  const finished = new Promise(resolve => { done = resolve; });

  function start() {
    child = spawn(command, args, {stdio: 'inherit'});
    child.on('error', error => {
      log(`the daemon did not start: ${error.message}`);
      stopping = true;
      done();
    });
    child.on('exit', (code, signal) => {
      child = null;
      if (stopping || code === 0) return done();
      failures = [...failures.filter(at => now() - at < WINDOW_MS), now()];
      const how = signal ? `was killed by ${signal}` : `exited with code ${code}`;
      if (failures.length >= burst) {
        log(`the daemon ${how}; it failed ${burst} times within a minute, so it is not restarted`);
        return done();
      }
      log(`the daemon ${how}: restarting it in ${restartMs / 1000} s`);
      timer = setTimeout(start, restartMs);
    });
  }
  start();

  return {
    finished,
    /** The daemon's process id while it runs. */
    get pid() { return child?.pid ?? null; },
    stop() {
      stopping = true;
      clearTimeout(timer);
      if (child) child.kill('SIGTERM');
      else done();
      return finished;
    },
  };
}
