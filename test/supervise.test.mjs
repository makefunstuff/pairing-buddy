// The supervisor that restarts the daemon without systemd or launchd.
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {supervise} from '../src/supervise.mjs';

/** A daemon stand-in: counts its starts in `file`, and fails (or crashes) until its `failures`-th start. */
const standIn = (file, failures, how = 'process.exit(3)') => [
  '-e',
  `const fs = require('node:fs'); const n = (fs.existsSync(${JSON.stringify(file)}) ? Number(fs.readFileSync(${JSON.stringify(file)}, 'utf8')) : 0) + 1;
   fs.writeFileSync(${JSON.stringify(file)}, String(n));
   if (n <= ${failures}) { ${how}; } else process.exit(0);`,
];

test('a daemon that fails is started again, and one that stops cleanly is not', {timeout: 10_000}, async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'pair-supervise-')), 'starts');
  const lines = [];
  const supervisor = supervise({command: process.execPath, args: standIn(file, 2), log: line => lines.push(line), restartMs: 10});
  await supervisor.finished;
  assert.equal(readFileSync(file, 'utf8'), '3');
  assert.deepEqual(lines, ['the daemon exited with code 3: restarting it in 0.01 s', 'the daemon exited with code 3: restarting it in 0.01 s']);
});

test('a daemon killed by a signal is started again', {timeout: 10_000}, async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'pair-supervise-')), 'starts');
  const lines = [];
  const supervisor = supervise({command: process.execPath, args: standIn(file, 1, "process.kill(process.pid, 'SIGKILL')"), log: line => lines.push(line), restartMs: 10});
  await supervisor.finished;
  assert.equal(readFileSync(file, 'utf8'), '2');
  assert.deepEqual(lines, ['the daemon was killed by SIGKILL: restarting it in 0.01 s']);
});

test('a daemon that keeps failing is given up on', {timeout: 10_000}, async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'pair-supervise-')), 'starts');
  const lines = [];
  const supervisor = supervise({command: process.execPath, args: standIn(file, 100), log: line => lines.push(line), restartMs: 10, burst: 3});
  await supervisor.finished;
  assert.equal(readFileSync(file, 'utf8'), '3');
  assert.equal(lines.at(-1), 'the daemon exited with code 3; it failed 3 times within a minute, so it is not restarted');
});

test('stopping the supervisor stops the daemon, which is not started again', {timeout: 10_000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pair-supervise-'));
  const ready = join(dir, 'ready');
  const lines = [];
  const supervisor = supervise({
    command: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)}, ''); setInterval(() => {}, 1000)`],
    log: line => lines.push(line),
    restartMs: 10,
  });
  while (!existsSync(ready)) await new Promise(resolve => setTimeout(resolve, 10));
  const {pid} = supervisor;
  await supervisor.stop();
  assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
  assert.deepEqual(lines, []);
});
