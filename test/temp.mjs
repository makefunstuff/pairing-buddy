// Temp dirs for the tests: every one under one root per run, removed when a test file ends or is interrupted.
//
// test/run.mjs (what `npm test` runs) makes the run's root, `pair-test-XXXXXX` in $TMPDIR (or /tmp, when $TMPDIR
// is too long for sockets: test/teardown.mjs), and loads this module
// into every test file's process with --import. Run a file by itself and this module makes the root. Each test
// file gets a folder of its own in the root, and $TMPDIR points into it, so whatever the file, the code under test,
// its daemons and its Neovims put in the temp dir lands there too.
//
// When the file's tests end (or on SIGINT and SIGTERM): the processes it started and left running are stopped
// (and theirs),
// the dirs `scratch` made are removed, and anything else still in the file's folder is a leak. It is named on
// stderr with the test file, the file fails, and the folder goes anyway.
import {mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {basename, join} from 'node:path';
import {descendants, stop, tempBase} from './teardown.mjs';

const testFile = process.argv[1] ?? 'test';
const runRoot = process.env.PAIR_TEST_ROOT || mkdtempSync(join(tempBase(), 'pair-test-'));
const ownRoot = !process.env.PAIR_TEST_ROOT;
/** This test file's own folder in the run's root, and $TMPDIR from here on. */
export const fileRoot = mkdtempSync(join(runRoot, `${basename(testFile).replace(/\.test\.mjs$|\.mjs$/, '')}-`));
process.env.TMPDIR = fileRoot;

const dirs = [];

/**
 * A new empty directory named `prefix` and six random characters, in this file's folder (or in `parent`, for the
 * few tests that need one in /tmp itself); removed when the file ends.
 */
export function scratch(prefix = 'pair-', parent = fileRoot) {
  const dir = mkdtempSync(join(parent, prefix));
  dirs.push(dir);
  return dir;
}

/**
 * A directory for Unix sockets, whose paths max out near 104 bytes: in this file's folder while that is short
 * enough (it is on Linux), else in /tmp. Removed when the file ends, like `scratch`'s.
 */
export function socketDir(prefix = 'pair-') {
  const dir = scratch(prefix);
  return join(dir, 'nvim.sock.0').length <= 90 ? dir : scratch(prefix, '/tmp');
}

let done = false;

/** Stops the file's processes, removes its dirs and reports what else it left in the temp dir (unless `quiet`). */
function cleanup({quiet = false} = {}) {
  if (done) return;
  done = true;
  stop(descendants(process.pid));
  for (const dir of dirs) rmSync(dir, {recursive: true, force: true});
  let left = [];
  try { left = readdirSync(fileRoot); } catch {}
  if (left.length && !quiet) {
    process.stderr.write(`temp dir leak: ${testFile} left ${left.join(', ')} in ${fileRoot}; make them with scratch() from test/temp.mjs, or remove them\n`);
    process.exitCode = 1;
  }
  rmSync(ownRoot ? runRoot : fileRoot, {recursive: true, force: true});
}

process.on('exit', () => cleanup());
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    cleanup({quiet: true});
    if (!process.listenerCount(signal)) process.kill(process.pid, signal);
  });
}
