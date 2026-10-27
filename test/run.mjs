#!/usr/bin/env node
// Runs `node --test` with its arguments, every temp dir of the run under one root: `pair-test-XXXXXX` in $TMPDIR
// (or the system's temp dir). test/temp.mjs, loaded into every test file, gives each file a folder there and fails a
// file that leaves anything in it. The root goes when the run ends, also on Ctrl-C; anything still in it then (a
// file killed before it could clean up) is named, and the run fails. A test with no timeout of its own gets 5
// minutes, so a test that hangs fails the run instead of holding it forever.
import {spawn} from 'node:child_process';
import {mkdtempSync, readdirSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const outer = tmpdir();
const ours = name => /^(pair|probe|board)-/.test(name);
const before = new Set(readdirSync(outer).filter(ours));
const root = realpathSync(mkdtempSync(join(outer, 'pair-test-')));
// Tests make Unix sockets up to 60 characters below the root, and a socket's path maxes out near 104 bytes: in a
// longer $TMPDIR they would fail or hang, so the run stops at once.
if (root.length > 44) {
  rmSync(root, {recursive: true, force: true});
  console.error(`TMPDIR is too long for the sockets the tests make in it (${outer}): use one of at most 26 characters`);
  process.exit(2);
}

const child = spawn(process.execPath, [
  '--disable-warning=ExperimentalWarning', '--import', new URL('./temp.mjs', import.meta.url).href, '--test', '--test-timeout=300000',
  ...process.argv.slice(2),
], {stdio: 'inherit', env: {...process.env, TMPDIR: root, PAIR_TEST_ROOT: root}});

// Ctrl-C reaches the tests too; a SIGTERM is passed on. Either way the root goes once they have stopped.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => child.kill('SIGTERM'));

child.on('exit', (code, signal) => {
  let failed = code !== 0 || signal !== null;
  const left = readdirSync(root);
  if (left.length) {
    console.error(`temp dir leak: the run left ${left.join(', ')} in ${root} (each is a test file's folder)`);
    failed = true;
  }
  rmSync(root, {recursive: true, force: true});
  // Outside the root only something that ignores $TMPDIR leaves things, or another run at the same time.
  const strays = readdirSync(outer).filter(name => ours(name) && !before.has(name) && !name.startsWith('pair-test-'));
  if (strays.length) console.error(`note: new in ${outer} during the run (another run, or something that ignores $TMPDIR): ${strays.length} entries, such as ${strays.slice(0, 5).join(', ')}`);
  process.exit(failed ? 1 : 0);
});
