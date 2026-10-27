// Where the tests' temp dirs go, and stopping what the tests started before those dirs go: test/temp.mjs stops a
// test file's processes, and test/run.mjs whatever of the run outlived its file. Synchronous, as exit handlers must be.
import {execFileSync} from 'node:child_process';
import {mkdirSync, readdirSync, readFileSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';

/**
 * Where a run's root goes: $TMPDIR (made if it is missing), or /tmp when $TMPDIR is longer than 26 characters, as
 * macOS's own /var/folders/… is. Tests make Unix sockets up to 60 characters below the root (`pair-test-XXXXXX`,
 * 18 more), and a socket's path maxes out near 104 bytes: in a longer one they would fail or hang.
 */
export function tempBase() {
  const asked = tmpdir();
  mkdirSync(asked, {recursive: true});
  return realpathSync(asked).length <= 26 ? asked : '/tmp';
}

/** Every running process as [pid, ppid], zombies left out: they have ended, but nothing reaps them while we block. */
function table() {
  try {
    return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,stat='], {encoding: 'utf8'}).trim().split('\n')
      .map(line => line.trim().split(/\s+/))
      .filter(([, , stat]) => stat && !stat.startsWith('Z')).map(([pid, ppid]) => [Number(pid), Number(ppid)]);
  } catch {
    return [];
  }
}

/** The processes `pid` started, and the ones they started, and so on: a shell's `sleep` too. */
export function descendants(pid) {
  const rows = table();
  const found = [];
  for (let parents = [pid]; parents.length;) {
    const next = rows.filter(([, ppid]) => parents.includes(ppid)).map(([child]) => child);
    found.push(...next);
    parents = next;
  }
  return found;
}

/**
 * The processes whose environment has `name=value`, read from /proc (on Linux; elsewhere none): those a test run
 * started keep its $PAIR_TEST_ROOT even once their parent is gone.
 */
export function withEnv(name, value) {
  let pids = [];
  try { pids = readdirSync('/proc').filter(entry => /^\d+$/.test(entry)).map(Number); } catch { return []; }
  return pids.filter(pid => {
    if (pid === process.pid) return false;
    try { return readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0').includes(`${name}=${value}`); } catch { return false; }
  });
}

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const running = pids => {
  const alive = new Set(table().map(([pid]) => pid));
  return pids.filter(pid => alive.has(pid));
};

/** Stops `pids` with SIGTERM and, those still running after 2 s, SIGKILL. */
export function stop(pids) {
  for (const pid of pids) try { process.kill(pid, 'SIGTERM'); } catch {}
  const end = Date.now() + 2000;
  while ((pids = running(pids)).length && Date.now() < end) pause(20);
  for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch {}
}
