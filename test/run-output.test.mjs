// Reading builds and runs against real output (test/fixtures/runs: gcc, clang, zig, glibc, the sanitizers, bash
// and make, with the paths made neutral). Odin and c3c are not installed where these were captured: their lines
// are written in the formats their compilers and runtimes print.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {exitSignal, readingSummary, readRun, warningKey} from '../src/run-output.mjs';

const ROOT = '/home/dev/probe';
const fixture = name => readFileSync(new URL(`./fixtures/runs/${name}.txt`, import.meta.url), 'utf8');
const read = (name, options = {}) => readRun(fixture(name), {root: ROOT, ...options});

test('gcc and clang errors and warnings: file, line, column and message', () => {
  for (const compiler of ['gcc', 'clang']) {
    const errors = read(`${compiler}-errors`);
    assert.equal(errors.crash, null);
    assert.deepEqual(errors.errors.map(error => [error.file, error.line, error.col]), [['bad.c', 3, 11], ['bad.c', 4, 20]], compiler);
    assert.deepEqual(errors.warnings, [], `${compiler}: a note is no warning`);
    const warnings = read(`${compiler}-warnings`);
    assert.deepEqual(warnings.errors, []);
    assert.deepEqual(warnings.warnings.map(warning => [warning.file, warning.line, warning.col]), [['probe.c', 9, 7], ['probe.c', 13, 27]], compiler);
  }
  assert.equal(read('clang-errors').errors[0].message, 'use of undeclared identifier \'undefined_thing\'');
  assert.equal(read('gcc-warnings').warnings[0].message, 'unused variable ‘unused’ [-Wunused-variable]');
});

test('the linker names what is missing, without a line', () => {
  assert.deepEqual(read('gcc-link').errors, [{file: null, line: null, col: null, severity: 'error', message: 'undefined reference to `foo\''}]);
  assert.equal(readRun('/usr/bin/ld: cannot find -lraylib: No such file or directory').errors[0].message, 'cannot find -lraylib: No such file or directory');
  assert.equal(readingSummary(read('gcc-link')), '1 error: undefined reference to `foo\'');
});

test('zig, odin and c3c compile errors', () => {
  assert.deepEqual(read('zig-errors').errors.map(error => [error.file, error.line, error.col, error.message]),
    [['bad.zig', 3, 20, 'use of undeclared identifier \'undefined_thing\'']]);
  const odin = readRun([
    '/home/dev/probe/main.odin(5:9) Error: Undeclared name: foo',
    '\tx := foo',
    '\t     ^~^',
    '/home/dev/probe/main.odin(12:2) Syntax Error: Expected \'}\', got \'EOF\'',
    '/home/dev/probe/table.odin(3:1) Warning: \'core:fmt\' is imported but not used',
  ].join('\n'), {root: ROOT});
  assert.deepEqual(odin.errors.map(error => [error.file, error.line, error.col, error.message]),
    [['main.odin', 5, 9, 'Undeclared name: foo'], ['main.odin', 12, 2, 'Expected \'}\', got \'EOF\'']]);
  assert.deepEqual(odin.warnings.map(warning => [warning.file, warning.line]), [['table.odin', 3]]);
  assert.equal(odin.crash, null, 'a compile error is no runtime report');
  assert.deepEqual(readRun('main.odin:5:9: Error: Undeclared name: foo').errors[0].line, 5, 'odin -error-pos-style:unix');
  const c3 = readRun([
    ' 6:     int x = foo;',
    '                ^^^',
    '(/home/dev/probe/src/main.c3:6:13) Error: \'foo\' could not be found, did you spell it right?',
    '(/home/dev/probe/src/main.c3:2:1) Warning: The import is never used.',
  ].join('\n'), {root: ROOT});
  assert.deepEqual(c3.errors.map(error => [error.file, error.line, error.col]), [['src/main.c3', 6, 13]]);
  assert.deepEqual(c3.warnings.map(warning => warning.message), ['The import is never used.']);
});

test('a diagnostic printed twice (make -j, a header included twice) counts once', () => {
  const text = fixture('clang-warnings');
  assert.equal(readRun(`${text}\n${text}`).warnings.length, 2);
});

test('a segfault through herdr alone: the shell\'s or make\'s words say it, without an exit code', () => {
  for (const name of ['bash-segfault', 'make-segfault']) {
    assert.deepEqual(read(name).crash, {signal: 'SIGSEGV', text: 'Segmentation fault', frames: [], at: null}, name);
  }
  const words = {
    'Segmentation fault (core dumped)': 'SIGSEGV',
    'zsh: segmentation fault (core dumped)  ./probe': 'SIGSEGV',
    'zsh: abort (core dumped)  ./probe': 'SIGABRT',
    'Floating point exception (core dumped)': 'SIGFPE',
    'zsh: illegal hardware instruction  ./probe': 'SIGILL',
    'bash: line 1: 4242 Bus error               (core dumped) ./probe': 'SIGBUS',
    'make: *** [Makefile:4: run] Error 139': 'SIGSEGV',
    'make[1]: *** [Makefile:4: run] Aborted (core dumped)': 'SIGABRT',
  };
  for (const [line, signal] of Object.entries(words)) assert.equal(readRun(`avg probe 23.7\n${line}`).crash?.signal, signal, line);
  for (const line of ['Aborted the import: file is busy', 'segmentation fault handling is described in docs/faults.md', 'make: *** [Makefile:4: run] Error 2']) {
    assert.equal(readRun(line).crash, null, line);
  }
});

test('exit codes: a signal a program crashes of is a crash; Ctrl-C, a kill or a closed pipe are not', () => {
  assert.equal(exitSignal(139), 'SIGSEGV');
  assert.equal(exitSignal(134), 'SIGABRT');
  assert.equal(exitSignal(136), 'SIGFPE');
  for (const exit of [0, 1, 2, 127, 130, 137, 141, 143, null]) assert.equal(exitSignal(exit), null, String(exit));
  // In Pair's pane the shell itself says "Segmentation fault", not the output file: the exit code is all there is.
  assert.deepEqual(readRun('avg probe 23.7\n', {exit: 139}).crash, {signal: 'SIGSEGV', text: 'Segmentation fault', frames: [], at: null});
  assert.equal(readRun('', {exit: 130}).crash, null);
});

test('a sanitizer report: its words, and the innermost frame in the project\'s code, not libc\'s', () => {
  const segv = read('asan-segv');
  assert.equal(segv.crash.text, 'AddressSanitizer: SEGV');
  assert.deepEqual(segv.crash.at, {file: 'probe.c', line: 10, function: 'probe'});
  assert.deepEqual(segv.crash.frames.map(frame => frame.function), ['probe', 'main']);
  assert.equal(readingSummary(segv), 'AddressSanitizer: SEGV at probe.c:10 in probe');
  const overflow = read('asan-overflow');
  assert.equal(overflow.crash.text, 'AddressSanitizer: heap-buffer-overflow');
  assert.deepEqual(overflow.crash.frames, [{file: 'ov.c', line: 2, function: 'main'}], 'only the first stack: where it was allocated is another');
  const ubsan = read('ubsan');
  assert.equal(ubsan.crash.text, 'runtime error: signed integer overflow: 2147483647 + 1 cannot be represented in type \'int\'');
  assert.deepEqual(ubsan.crash.at, {file: 'ub.c', line: 2});
});

test('a failed assert, a Zig panic and a Zig segfault: the place in the project, with the signal from the exit code', () => {
  const assertion = read('assert', {exit: 134});
  assert.deepEqual(assertion.crash, {signal: 'SIGABRT', text: 'Assertion `t.keys != NULL\' failed', frames: [{file: 'probe.c', line: 16, function: 'main'}], at: {file: 'probe.c', line: 16, function: 'main'}});
  assert.equal(readingSummary(assertion), 'Assertion `t.keys != NULL\' failed (SIGABRT) at probe.c:16 in main');
  const panic = read('zig-panic', {exit: 134});
  assert.equal(panic.crash.text, 'panic: index out of bounds: index 4, len 3');
  assert.deepEqual(panic.crash.at, {file: 'z/main.zig', line: 4, function: 'probe'});
  assert.deepEqual(panic.crash.frames.map(frame => frame.file), ['z/main.zig', 'z/main.zig', '/usr/lib/zig/std/start.zig', '/usr/lib/zig/std/start.zig'],
    'files in the project relative to its root, the standard library absolute');
  const segfault = read('zig-segfault');
  assert.equal(readingSummary(segfault), 'Segmentation fault at seg.zig:4 in main');
  assert.deepEqual(segfault.crash.at, {file: 'z/seg.zig', line: 4, function: 'main'});
});

test('odin and c3 runtime reports, and a gdb backtrace', () => {
  const bounds = readRun('/home/dev/probe/main.odin(7:14) Index 4 is out of range 0..<3\nIllegal instruction (core dumped)', {root: ROOT});
  assert.deepEqual(bounds.crash, {signal: 'SIGILL', text: 'Index 4 is out of range 0..<3', frames: [{file: 'main.odin', line: 7}], at: {file: 'main.odin', line: 7}});
  assert.equal(readRun('/home/dev/probe/main.odin(9:2) runtime assertion: count > 0', {root: ROOT}).crash.text, 'runtime assertion: count > 0');
  const c3 = readRun([
    'ERROR: \'Array index out of bounds (array had size 3, index was 4)\'',
    '  in std.core.builtin.panicf (/usr/lib/c3c/lib/std/core/builtin.c3:178) [./main]',
    '  in main (/home/dev/probe/src/main.c3:8) [./main]',
  ].join('\n'), {root: ROOT, exit: 134});
  assert.equal(c3.crash.text, 'Array index out of bounds (array had size 3, index was 4)');
  assert.deepEqual(c3.crash.at, {file: 'src/main.c3', line: 8, function: 'main'});
  const gdb = readRun([
    'Program received signal SIGSEGV, Segmentation fault.',
    '#0  0x00007ffff7e3b2bb in __memmove_avx_unaligned () from /usr/lib/libc.so.6',
    '#1  0x0000555555555189 in probe (t=0x7fffffffe0a0, key=3) at probe.c:10',
    '#2  0x00005555555551d6 in main (argc=1, argv=0x7fffffffe1c8) at probe.c:17',
  ].join('\n'), {root: ROOT, exit: 139});
  assert.deepEqual(gdb.crash.at, {file: 'probe.c', line: 10, function: 'probe'});
});

test('files are relative to the project\'s root, also when the run started in a folder below it', () => {
  const run = readRun(fixture('gcc-warnings'), {root: ROOT, cwd: `${ROOT}/src`});
  assert.deepEqual(run.warnings.map(warning => warning.file), ['src/probe.c', 'src/probe.c']);
  const outside = readRun('../vendor/lib.c:3:1: warning: unused function', {root: ROOT, cwd: ROOT});
  assert.equal(outside.warnings[0].file, '/home/dev/vendor/lib.c');
});

test('a warning\'s key leaves out its line, which moves as the file is edited', () => {
  const [before] = read('gcc-warnings').warnings;
  const after = readRun(fixture('gcc-warnings').replace('probe.c:9:7', 'probe.c:14:7'), {root: ROOT}).warnings[0];
  assert.equal(warningKey(before), warningKey(after));
});

test('the summary: the crash, else the errors, else the warnings, else nothing', () => {
  assert.equal(readingSummary(read('make-segfault')), 'Segmentation fault');
  assert.equal(readingSummary(read('gcc-errors')), '2 errors: bad.c:3: ‘undefined_thing’ undeclared (first use in this function)');
  assert.equal(readingSummary(read('clang-warnings')), '2 warnings: probe.c:9: unused variable \'unused\' [-Wunused-variable]');
  assert.equal(readingSummary(readRun('190000 keys  load 0.72  avg probe 23.7  worst 47  35 ms')), '');
});
