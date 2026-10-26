// Some tests crash programs on purpose (a segfault, a failed assert, a panic). None of those crashes may reach
// the machine's crash reporter: with a pipe in /proc/sys/kernel/core_pattern (systemd-coredump), `ulimit -c 0`
// is not enough, since the kernel still hands the crash to the pipe, which logs it and shows a notification.
// A core limit of exactly 1 byte makes the kernel give up before the pipe ("RLIMIT_CORE is set to 1, aborting
// core"). bash's `ulimit -c` counts in 1024-byte blocks and cannot say 1 byte, so this uses util-linux's prlimit,
// and falls back to `ulimit -c 0` without it. Children inherit the limit.
import {spawnSync} from 'node:child_process';

const hasPrlimit = spawnSync('prlimit', ['--version']).status === 0;

/** `[file, args]` that run `command` with bash, with core dumps off for everything it starts. */
export function bashWithoutCores(command) {
  return hasPrlimit ? ['prlimit', ['--core=1', 'bash', '-c', command]] : ['bash', ['-c', `ulimit -c 0; ${command}`]];
}
