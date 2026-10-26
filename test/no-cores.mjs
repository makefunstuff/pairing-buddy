// Tests may crash a program on purpose (an assert that aborts, a segfault). Every command line a test or capture
// runs goes through here, so such a crash writes no core. Where core_pattern pipes to systemd-coredump, the kernel
// still hands the crash over, and systemd-coredump logs it (without a core) and the desktop may say so: a test
// that needs no crash fails with an exit code instead, as test/live/probe does.

/** `command` as a bash command line with core dumps off for it and everything it starts. */
export const withoutCores = command => `ulimit -c 0; ${command}`;
