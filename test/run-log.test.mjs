import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {DebugLines, isDebugLine, printedBy} from '../src/debug-lines.mjs';
import {fold, initialState} from '../src/fold.mjs';
import {changeLine, isRun, logRun, measure, runLine, runLines, verdictText} from '../src/run-log.mjs';
import {readRun} from '../src/run-output.mjs';
import {detectTriggers} from '../src/triggers.mjs';

// The hash table of the research's prototype: four runs of ./run, the numbers its last line prints.
const report = (probe, worst, ms) => `190000 keys  load 0.72  avg probe ${probe}  worst ${worst}  ${ms} ms\n`;
const buckets = step => [0, 1, 2, 3, 4, 5].map(i => `bucket ${i * step}\n`).join('');
const edit = (at, line, text, file = 'probe.c') => ({file, from: line, to: line, text, at});
const PRINT = '    if (e < 6) printf("bucket %u\\n", hash(id));';

function loop() {
  const run = (runs, at, output, edits = []) => logRun(runs, {cmd: './run', by: 'you', at, exit: 0, output, reading: readRun(output), edits});
  let runs = run([], 10, report(23.7, 47, 35));
  runs = run(runs, 20, buckets(64) + report(23.7, 47, 52), [edit(15, 36, PRINT)]);
  runs = run(runs, 30, buckets(1984) + report(23.7, 47, 55), [edit(15, 36, PRINT), edit(25, 13, '    return (key * 31) & (CAP - 1);')]);
  return run(runs, 40, buckets(7) + report(1.1, 3, 5), [edit(35, 13, '    return (uint32_t)(key * 2654435769u) >> 14;')]);
}

test('a run is read next to the last run of its command: the same numbers after a change of the code, or the numbers that moved', () => {
  const runs = loop();
  assert.deepEqual(runs.map(runLine), [
    'run 1 · exit 0 · 35 ms · avg probe 23.7',
    'run 2 · exit 0 · 52 ms · avg probe 23.7', // a print is no change of the code: the same numbers are no news
    'run 3 · exit 0 · 55 ms · avg probe 23.7 · same numbers as run 2', // 52 → 55 ms is a time's noise
    'run 4 · exit 0 · 5 ms · avg probe 23.7 → 1.1',
  ]);
  assert.deepEqual(runs.map(run => run.verdict.kind), ['first', 'again', 'same', 'moved']);
  assert.deepEqual(runs[3].verdict.moves.map(move => [move.label, move.from, move.to, move.better]), [
    ['avg probe', '23.7', '1.1', true], ['worst', '47', '3', null], ['keys', '55', '5', true],
  ], 'the numbers that say which way is better first, the time last');
  assert.deepEqual(runs.map(changeLine), ['first run', PRINT.trim(), 'return (key * 31) & (CAP - 1);', 'return (uint32_t)(key * 2654435769u) >> 14;']);
});

test('the numbers of a run: lines it prints once, not a listing, nor a compiler\'s place or an address', () => {
  const numbers = measure(`${buckets(64)}probe.c:21:7: warning: unused variable 'x'\nat 0x7ffd5e2a1b40\n${report(23.7, 47, 35)}`);
  assert.deepEqual(Object.values(numbers).map(number => [number.label, number.text, number.unit, number.time]), [
    ['keys', '190000', '', false], ['keys load', '0.72', '', false], ['avg probe', '23.7', '', false], ['worst', '47', '', false], ['keys', '35', 'ms', true],
  ]);
});

test('a time moves only when it halves or doubles; a number that got worse says so', () => {
  const run = (runs, at, output, edits) => logRun(runs, {cmd: 'make bench', by: 'you', at, output, reading: readRun(output), edits});
  let runs = run([], 1, 'lookup 120 ns/op  misses 4\n');
  runs = run(runs, 2, 'lookup 150 ns/op  misses 4\n', [edit(1.5, 3, 'x = 2;', 'bench.c')]);
  assert.equal(runLine(runs.at(-1)), 'run 2 · 150 ns/op · misses 4 · same numbers as run 1', 'no exit code through herdr; 120 → 150 ns is noise');
  runs = run(runs, 3, 'lookup 400 ns/op  misses 9\n', [edit(2.5, 3, 'x = 3;', 'bench.c')]);
  assert.equal(verdictText(runs.at(-1)), 'misses 4 → 9 (worse)');
  assert.deepEqual(runs.at(-1).verdict.moves.map(move => move.to), ['9', '400']);
});

test('without numbers, the output itself is compared; a crash or a broken build is said first, and the next good run compares with the last good one', () => {
  const run = (runs, at, output, {exit = 0, edits = []} = {}) => logRun(runs, {cmd: './probe', by: 'you', at, exit, output, reading: readRun(output, {exit}), edits});
  let runs = run([], 1, 'hello\n');
  runs = run(runs, 2, 'hello\n', {edits: [edit(1.5, 2, 'greet();', 'main.c')]});
  assert.equal(runLine(runs.at(-1)), 'run 2 · exit 0 · same output as run 1');
  runs = run(runs, 3, 'Segmentation fault (core dumped)\n', {exit: 139, edits: [edit(2.5, 2, 'greet(NULL);', 'main.c')]});
  assert.equal(runLine(runs.at(-1)), 'run 3 · exit 139 · Segmentation fault');
  runs = run(runs, 4, 'main.c:2:7: error: too few arguments to function call\n', {exit: 1});
  assert.equal(runLine(runs.at(-1)), 'run 4 · exit 1 · does not build');
  runs = run(runs, 5, 'hello, you\n', {edits: [edit(4.5, 2, 'greet("you");', 'main.c')]});
  assert.deepEqual(runs.at(-1).verdict, {kind: 'changed', as: 2}, 'next to run 2, the last one that ran through');
});

test('a run\'s new warnings are said with it', () => {
  const runs = logRun([], {cmd: 'make', by: 'pair', at: 1, exit: 0, output: '', reading: readRun(''), newWarnings: [{file: 'a.c', line: 1, message: 'x'}]});
  assert.equal(runLine(runs[0]), 'run 1 · exit 0 · 1 new warning');
});

test('builds and runs are logged, other commands and test runs are not', () => {
  assert.deepEqual(['./probe', 'make run', 'cc -O2 -o probe probe.c && ./probe', 'zig build run', 'odin run .', 'c3c compile-run main.c3', 'CFLAGS=-O2 make',
    'time ./probe', 'bash build.sh', 'build/probe --n 100', 'cd build && make', 'clear; make run', 'sudo make install', 'python3 probe.py',
    'npm run bench', './probe | head'].filter(command => !isRun(command)), []);
  assert.deepEqual(['git status', 'ls -la', 'nvim probe.c', 'cd src', 'rg hash', 'bash', 'cat run.out', 'npm install', 'node --version',
    'cd src && git log'].filter(isRun), []);
  const state = [
    {kind: 'command_end', cmd: 'git status', exit: 0, output: 'clean', at: 1},
    {kind: 'command_end', cmd: 'go test ./...', exit: 0, output: 'ok  \texample.com/a\t0.01s\n', at: 2},
    {kind: 'command_end', cmd: './probe', exit: 0, output: 'avg probe 1.2\n', at: 3},
  ].reduce(fold, initialState({root: '/p'}));
  assert.deepEqual(state.runs.map(run => [run.n, run.cmd, run.by]), [[1, './probe', 'you']]);
});

test('the runs the models read: the change before each, its numbers, what it said, and what the last ones printed', () => {
  assert.deepEqual(runLines(loop(), './run'), [
    'run 1 (first run): keys 190000, keys load 0.72, avg probe 23.7, worst 47, 35 ms',
    'run 2 after probe.c:36 `if (e < 6) printf("bucket %u\\n", hash(id));`, a debug print: keys 190000, keys load 0.72, avg probe 23.7, worst 47, 52 ms',
    'run 3 after probe.c:13 `return (key * 31) & (CAP - 1);`: keys 190000, keys load 0.72, avg probe 23.7, worst 47, 55 ms; same numbers as run 2',
    'run 4 after probe.c:13 `return (uint32_t)(key * 2654435769u) >> 14;`: keys 190000, keys load 0.72, avg probe 1.1, worst 3, 5 ms; avg probe 23.7 → 1.1',
  ]);
});

test('the same numbers after a change of the code, and a number that moved, are moments for a remark, once per run', () => {
  const at = 100_000;
  const events = [
    {kind: 'command_end', pane: 'w1:p2', cmd: './run', exit: 0, output: report(23.7, 47, 35), at},
    {kind: 'edit', file: 'probe.c', from: 13, to: 13, text: '    return (key * 31) & (CAP - 1);', at: at + 1000},
    {kind: 'command_end', pane: 'w1:p2', cmd: './run', exit: 0, output: report(23.7, 47, 52), at: at + 2000},
  ];
  const same = events.reduce(fold, initialState({root: '/p'}));
  const [trigger] = detectTriggers(same, at + 3000);
  assert.equal(trigger.kind, 'same_result');
  assert.equal(trigger.key, 'same:2');
  assert.deepEqual([trigger.file, trigger.line], ['probe.c', 13]);
  assert.match(trigger.detail, /^`\.\/run` \(the user ran it\) printed the same numbers as run 1, although the code changed since\.\nRuns of `\.\/run`, oldest first:\nrun 1 \(first run\)/);
  assert.match(trigger.detail, /Run 2 printed:\n190000 keys/);
  assert.deepEqual(detectTriggers(same, at + 3000, new Set(['same:2'])).map(found => found.kind), []);
  assert.deepEqual(detectTriggers(fold(same, {kind: 'hide', source: 'terminal', hidden: true}), at + 3000), [], 'a hidden terminal sends no run of the user');

  const moved = [
    {kind: 'edit', file: 'probe.c', from: 13, to: 13, text: '    return (uint32_t)(key * 2654435769u) >> 14;', at: at + 4000},
    {kind: 'command_end', pane: 'w1:p2', cmd: './run', exit: 0, output: report(1.1, 3, 5), at: at + 5000},
  ].reduce(fold, same);
  const [news] = detectTriggers(moved, at + 6000);
  assert.equal(news.kind, 'number_moved');
  assert.match(news.detail, /^`\.\/run` \(the user ran it\): next to run 2, avg probe 23\.7 → 1\.1, 52 → 5 ms\./);

  const small = [
    {kind: 'edit', file: 'probe.c', from: 13, to: 13, text: '    return key >> 13;', at: at + 7000},
    {kind: 'command_end', pane: 'w1:p2', cmd: './run', exit: 0, output: report(1.0, 3, 5), at: at + 8000},
  ].reduce(fold, moved);
  assert.deepEqual(detectTriggers(small, at + 9000), [], 'a number that moved a little is no moment');
});

test('debug lines: the prints of each language, and how many lines one printed', () => {
  const debug = [
    ['probe.c', '    if (e < 6) printf("bucket %u\\n", hash(id));'], ['probe.c', 'fprintf(stderr, "i=%d\\n", i);'],
    ['main.zig', '    std.debug.print("len {d}\\n", .{len});'], ['main.odin', '\tfmt.println("probe", p)'],
    ['main.c3', '  io::printfn("%d", x);'], ['main.go', 'fmt.Println(x)'], ['src/a.rs', 'dbg!(x);'], ['a.js', 'console.log(x)'], ['a.py', 'print(x)'],
  ];
  assert.deepEqual(debug.filter(([file, text]) => !isDebugLine(file, text)), []);
  assert.deepEqual([['probe.c', 'return printed;'], ['probe.c', '// printf("x")'], ['notes.md', 'printf("x")'], ['probe.c', 'sprintf(buf, "%d", x);']]
    .filter(([file, text]) => isDebugLine(file, text)), []);
  assert.equal(printedBy(debug[0][1], `${buckets(64)}190000 keys\n`), 6);
  assert.equal(printedBy(debug[2][1], 'len 4\nlen 5\nother\n'), 2);
  assert.equal(printedBy('printf("%d\\n", x);', '1\n2\n'), null, 'a format of placeholders alone tells no lines');
  assert.equal(printedBy(debug[3][1], ''), null);
});

test('debug lines are the prints the user added in the session that are still in the code, with the run they came before', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pair-debug-'));
  const path = join(root, 'probe.c');
  writeFileSync(path, 'int main(void) {\n  printf("%d keys\\n", n);\n}\n');
  const lines = new DebugLines({root, read: file => readFile(file, 'utf8')});
  await lines.edited('probe.c', '  printf("%d keys\\n", n);\n  printf("bucket %u\\n", b);', 2);
  writeFileSync(path, 'int main(void) {\n  printf("%d keys\\n", n);\n  printf("bucket %u\\n", b);\n}\n');
  assert.deepEqual(await lines.left(), [{file: 'probe.c', text: 'printf("bucket %u\\n", b);', run: 2, line: 3}], 'the program\'s own print is no debug line');
  writeFileSync(path, 'int main(void) {\n  printf("%d keys\\n", n);\n}\n');
  assert.deepEqual(await lines.left(), [], 'deleted');
  writeFileSync(path, 'int main(void) {\n  printf("%d keys\\n", n);\n  printf("bucket %u\\n", b);\n}\n');
  assert.deepEqual(await lines.left(), [], 'deleted is gone for good: typed again, it is an edit of a later run');
});

test('a change of the code in each language counts, and its comments do not: Odin, C3, a #define, *slot and --n', () => {
  const kind = (file, text) => {
    const run = (runs, at, edits) => logRun(runs, {cmd: 'make run', by: 'you', at, exit: 0, output: report(23.7, 47, 35), reading: readRun(''), edits});
    return run(run([], 1), 3, [edit(2, 3, text, file)]).at(-1).verdict.kind;
  };
  const code = [
    ['main.odin', '\treturn key * 31'], ['main.c3', '  return key * 31;'], ['probe.c', '#define CAP 128'], ['probe.h', '#define CAP 128'],
    ['probe.c', '    *slot = key;'], ['probe.c', '    --n;'], ['main.zig', '    return key *% 31;'], ['Makefile', 'CFLAGS = -O3'],
    ['probe.lua', 'local cap = 128'], ['probe.py', 'cap = 128'],
  ];
  assert.deepEqual(code.filter(([file, text]) => kind(file, text) !== 'same'), [], 'each is a change: the same numbers are news');
  const comments = [
    ['main.odin', '\t// try a bigger table'], ['main.c3', '/* later */'], ['probe.c', ' * the stride is 64'], ['probe.c', '// #define CAP 128'],
    ['probe.lua', '-- later'], ['probe.py', '# later'], ['notes.md', 'cap = 128'], ['main.odin', '\tfmt.println("probe", p)'],
  ];
  assert.deepEqual(comments.filter(([file, text]) => kind(file, text) !== 'again'), [], 'comments, notes and prints are no change');
});

test('in Odin and C3 the loop raises its remarks like in C', () => {
  for (const file of ['main.odin', 'main.c3']) {
    const at = 100_000;
    const same = [
      {kind: 'command_end', pane: 'w1:p2', cmd: 'odin run .', exit: 0, output: report(23.7, 47, 35), at},
      {kind: 'edit', file, from: 4, to: 4, text: '\treturn key * 31', at: at + 1000},
      {kind: 'command_end', pane: 'w1:p2', cmd: 'odin run .', exit: 0, output: report(23.7, 47, 36), at: at + 2000},
    ].reduce(fold, initialState({root: '/p'}));
    assert.deepEqual(detectTriggers(same, at + 3000).map(trigger => trigger.kind), ['same_result'], file);
    const moved = [
      {kind: 'edit', file, from: 4, to: 4, text: '\treturn (key * 2654435769) >> 14', at: at + 4000},
      {kind: 'command_end', pane: 'w1:p2', cmd: 'odin run .', exit: 0, output: report(1.1, 3, 5), at: at + 5000},
    ].reduce(fold, same);
    assert.deepEqual(detectTriggers(moved, at + 6000).map(trigger => trigger.kind), ['number_moved'], file);
  }
});
