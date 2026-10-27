import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall} from '@earendil-works/pi-ai';
import {MemoryStorage} from '@earendil-works/pi-durable';
import {checkCommand, judge, markOf, numberFor, parseHandOver, targetOf, targetsOf} from '../src/check.mjs';
import {measure} from '../src/run-log.mjs';
import {sandboxWords, sandboxWorks} from '../src/sandbox.mjs';
import {checkInput, driveInput, PairSession} from '../src/session.mjs';
import {withPicture} from '../src/tools.mjs';
import {createPairModels} from '../src/models.mjs';
import {parseConfig} from '../src/config.mjs';
import {openPartner} from '../src/partner.mjs';
import {bashWithoutCores} from './no-core.mjs';
import {scratch} from './temp.mjs';

const has = (command, flag = '--version') => spawnSync(command, [flag]).status === 0;

test('a hand-over splits into what to change, what the user expects to see, and the command in backquotes', () => {
  assert.deepEqual(parseHandOver('you take it: make the table grow when the load passes 0.7, avg probe stays under 2'),
    {intent: 'make the table grow when the load passes 0.7', expect: 'avg probe stays under 2', command: null});
  assert.deepEqual(parseHandOver('add the second counter; the window shows both counters'),
    {intent: 'add the second counter', expect: 'the window shows both counters', command: null});
  assert.deepEqual(parseHandOver('your turn: grow the table at 0.7 load, keep avg probe under 2, run `make -s run`'),
    {intent: 'grow the table at 0.7 load', expect: 'keep avg probe under 2', command: 'make -s run'});
  assert.deepEqual(parseHandOver('use the high bits. expect: worst under 4 check with `odin run .`'),
    {intent: 'use the high bits', expect: 'worst under 4', command: 'odin run .'});
  assert.deepEqual(parseHandOver('set the timeout to 30 s'), {intent: 'set the timeout to 30 s', expect: null, command: null}, 'no observable');
  assert.deepEqual(parseHandOver('your turn'), {intent: null, expect: null, command: null});
  assert.deepEqual(parseHandOver(''), {intent: null, expect: null, command: null});
  assert.equal(parseHandOver('it prints the sum, and the loop stops').expect, null, 'the first clause is always the intent');
  assert.equal(parseHandOver('rename it, keep the old name as an alias').expect, null, 'keep is a change here');
  assert.equal(parseHandOver('use a range loop, iterate over the slice instead').expect, null);
  assert.equal(parseHandOver('use a mask, fps over 59').expect, 'fps over 59', 'a bound on a number is an observable');
  assert.equal(parseHandOver('validate n, it should print an error for n over 100').expect, 'it should print an error for n over 100', 'in words: the Partner judges it');
  assert.equal(parseHandOver('add the check, it should fail fast').expect, null, 'should alone is no observable');
});

test('a bound in the expectation names a number: its label, the comparison and the value', () => {
  assert.deepEqual(targetOf('avg probe stays under 2'), {label: 'avg probe', op: '<', value: 2});
  assert.deepEqual(targetOf('keep avg probe under 2'), {label: 'avg probe', op: '<', value: 2});
  assert.deepEqual(targetOf('and the worst is at most 4'), {label: 'worst', op: '<=', value: 4});
  assert.deepEqual(targetOf('fps above 59.5'), {label: 'fps', op: '>', value: 59.5});
  assert.deepEqual(targetOf('hits >= 12'), {label: 'hits', op: '>=', value: 12});
  assert.deepEqual(targetOf('count equals 3'), {label: 'count', op: '=', value: 3});
  assert.equal(targetOf('the window shows both counters'), null);
  assert.equal(targetOf('under 2'), null, 'a bound without a label names no number');
  assert.equal(targetOf('it prints an error for n over 100'), null, 'a sentence is no number\'s name: the Partner judges');
  assert.equal(targetOf(null), null);
});

test('the number a bound names is found by its label, or by its words', () => {
  const numbers = measure('190000 keys, cap 262144\navg probe 1.30 worst 3\n12 ms\n');
  assert.equal(numberFor(numbers, {label: 'avg probe'}).text, '1.30');
  assert.equal(numberFor(numbers, {label: 'probe'}).text, '1.30', 'all its words');
  assert.equal(numberFor(numbers, {label: 'the worst probe'}).text, '3', 'all the label\'s words');
  assert.equal(numberFor(numbers, {label: 'misses'}), null);
});

test('the check: a failed run fails, a bound is checked in code, any other expectation is the Partner\'s to judge', () => {
  const numbers = measure('avg probe 1.30 worst 3\n');
  const target = targetOf('avg probe stays under 2');
  assert.deepEqual(judge({red: false, numbers, targets: [target], expect: 'avg probe stays under 2', text: 'passed'}), {mark: 'pass', text: 'avg probe 1.30'});
  assert.deepEqual(judge({red: false, numbers: measure('avg probe 2.6\n'), targets: [target], expect: 'x', text: 'passed'}), {mark: 'fail', text: 'avg probe 2.6'});
  assert.deepEqual(judge({red: true, failure: 'Segmentation fault', numbers, targets: [target], expect: 'x', text: 'x'}), {mark: 'fail', text: 'Segmentation fault'});
  assert.deepEqual(judge({red: false, numbers: measure('load 0.4\n'), targets: [target], expect: 'avg probe stays under 2', text: 'passed'}), {mark: null, text: null},
    'a bound on a number the run did not print: the Partner reads the output');
  assert.deepEqual(judge({red: false, numbers, expect: 'the window shows both counters', text: 'passed'}), {mark: null, text: null});
  assert.deepEqual(judge({red: false, numbers, expect: null, text: 'passed'}), {mark: 'pass', text: 'passed'}, 'no expectation: it went through');
  // Two bounds: each is checked, and one missed fails it.
  const both = targetsOf('avg probe stays under 2 and worst stays under 5');
  assert.deepEqual(both, [{label: 'avg probe', op: '<', value: 2}, {label: 'worst', op: '<', value: 5}]);
  assert.deepEqual(targetsOf('avg probe under 2, worst under 5'), both);
  assert.deepEqual(targetsOf('the window shows both counters'), []);
  const printed = output => measure(output);
  assert.deepEqual(judge({red: false, numbers: printed('190000 keys  avg probe 1.3  worst 89  12 ms\n'), targets: both, expect: 'x', text: 'passed'}),
    {mark: 'fail', text: 'avg probe 1.3 · worst 89'}, 'the second bound is missed');
  assert.deepEqual(judge({red: false, numbers: printed('190000 keys  avg probe 1.3  worst 3  12 ms\n'), targets: both, expect: 'x', text: 'passed'}),
    {mark: 'pass', text: 'avg probe 1.3 · worst 3'});
  assert.deepEqual(judge({red: false, numbers: printed('avg probe 1.3\n'), targets: both, expect: 'x', text: 'passed'}),
    {mark: null, text: 'avg probe 1.3'}, 'a bound on a number the run did not print: the Partner judges');
  assert.equal(markOf('✓ both counters show.'), 'pass');
  assert.equal(markOf(' ✗ only one counter.'), 'fail');
  assert.equal(markOf('Both counters show.'), null);
});

test('the check command is the user\'s: the one in the hand-over, the command on save, else their last build and run', () => {
  const root = '/p';
  const run = (cmd, cwd = root, by = 'you') => ({cmd, cwd, by});
  assert.deepEqual(checkCommand({given: 'make -s run', testCommand: 'make test', runs: [run('zig build run')], root}), {command: 'make -s run', from: 'the command in the hand-over', ask: null});
  assert.deepEqual(checkCommand({testCommand: 'make test', runs: [run('zig build run')], root}), {command: 'make test', from: 'the project\'s command on save', ask: null});
  assert.equal(checkCommand({testCommand: 'node --test', root}).command, 'node --test', 'a test runner that is no build is still a check');
  assert.equal(checkCommand({runs: [run('make -s run'), run('odin run .'), run('./probe', root, 'pair')], root}).command, 'odin run .', 'the user\'s, not Pair\'s');
  assert.equal(checkCommand({runs: [run('make'), run('ls'), run('./probe')], root}).command, 'make && ./probe', 'the copy has the old program: build it first');
  assert.match(checkCommand({runs: [run('./probe')], root}).none, /^`\.\/probe` runs the program as it was built, so in the copy it would run the old code/, 'no build known: no check');
  assert.match(checkCommand({given: 'build/probe --n 5', root}).none, /would run the old code/);
  assert.equal(checkCommand({runs: [run('./build.sh')], root}).command, './build.sh', 'a script builds what it needs');
  assert.equal(checkCommand({runs: [run('zig build', '/p/tool'), run('./zig-out/bin/tool', '/p/tool')], root}).command, "cd 'tool' && zig build && ./zig-out/bin/tool", 'in its folder');
  assert.equal(checkCommand({runs: [run('make run', '/elsewhere')], root}).none, '`make run` ran in /elsewhere, outside the project, so it checks nothing here');
  assert.match(checkCommand({given: 'sudo make install', root}).none, /^`sudo make install` is not run for a check: /);
  assert.deepEqual(checkCommand({runs: [], root}), {none: 'no command on save, and no build or run in the user\'s terminal yet'});
});

test('a command from the terminal that Scout would ask about asks first; the user\'s own words and command on save do not', () => {
  const root = '/p';
  const run = cmd => ({cmd, cwd: root, by: 'you'});
  for (const cmd of ['make install', 'make deploy', './deploy.sh', 'python3 send_mail.py']) {
    assert.ok(checkCommand({runs: [run(cmd)], root}).ask, `${cmd} asks`);
  }
  assert.equal(checkCommand({runs: [run('make test')], root}).ask, null, 'a test target Scout runs at once');
  assert.equal(checkCommand({given: 'make deploy', root}).ask, null, 'named in the hand-over: the user asked for it');
  assert.equal(checkCommand({testCommand: 'make run', root}).ask, null, 'the command on save runs at every save anyway');
});

test('the Driver hears what the user expects and what will run, before it edits', () => {
  const check = {command: 'make -s run', from: 'the build and run the user ran last in their terminal'};
  const said = checkInput('avg probe stays under 2', check);
  assert.equal(said, 'What the user expects to see: "avg probe stays under 2". After your edit, Pair runs `make -s run` (the build and run the user ran last in their terminal) on the unsaved buffer and gives you its output.\n\n');
  assert.equal(checkInput('it prints 3', {none: 'no command on save'}), 'What the user expects to see: "it prints 3". Pair cannot run anything to check it: no command on save.\n\n');
  assert.equal(checkInput(null, {none: 'x'}), '');
  const input = driveInput('you take it: grow it, avg probe stays under 2', 'Goal: probe', '', said);
  assert.match(input, /Without a test, what they said they expect to see is the goal\./);
  assert.ok(input.includes(said));
});

// A C program in a Makefile project, as in the research behind the feature: the hash table's average probe.
const PROBE_C = `#include <stdio.h>
#include <stdlib.h>
#define CAP 1024
static unsigned slot(unsigned key) { return key % 16; }
int main(void) {
  static unsigned table[CAP];
  unsigned probes = 0, worst = 0;
  for (unsigned e = 1; e <= 500; e++) {
    unsigned i = slot(e * 64), p = 1;
    while (table[i]) { i = (i + 1) % CAP; p++; }
    table[i] = e; probes += p; if (p > worst) worst = p;
  }
  printf("avg probe %.2f worst %u\\n", probes / 500.0, worst);
  return 0;
}
`;

/**
 * A git project in a scratch folder with `files`, and a session in it whose pane runs each command for real; with
 * `sandbox`, in bubblewrap as Pair's pane does, the project and the runs folder writable. The chat answers each
 * question with `answer`.
 */
function realProject(files, {partner, buffer, buffers = () => [], sandbox = false, answer = true}) {
  const root = realpathSync(scratch('pair-check-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), {recursive: true});
    writeFileSync(join(root, path), text);
  }
  execFileSync('git', ['init', '-q'], {cwd: root});
  const runs = scratch('pair-check-runs-');
  const sent = [];
  const ran = [];
  const pane = {
    close: async () => {},
    run: async command => {
      ran.push(command);
      const [bash, words] = bashWithoutCores(command); // the crash tests crash on purpose: no core dumps
      const [file, ...args] = sandbox ? [...sandboxWords({cwd: root, writable: [runs]}), bash, ...words] : [bash, ...words];
      const result = spawnSync(file, args, {encoding: 'utf8', timeout: 60_000});
      return {exit: result.status ?? 128 + 11, output: '', timedOut: false};
    },
  };
  const pair = new PairSession({
    record: {id: 3, root, conversation_id: 7, goal: 'probe', level: 'normal'},
    store: {addMessage() {}, addAction: () => 1, updateAction() {}, lastRemark: () => null, setRole() {}},
    partner,
    score: async () => ({value: 9, reason: 'worth it'}),
    typingPauseMs: 2000,
    checkOutput: join(runs, '3.check.out'),
    notify: (to, message) => {
      sent.push({to, ...message});
      if (message.type === 'confirm') setImmediate(() => pair.answer(message.id, answer));
      return 1;
    },
    requestEditor: async message => (message.type === 'read' ? {text: buffer} : message.type === 'buffers' ? {buffers: buffers(root)} : {ok: true, from: 4, to: 4}),
    now: () => 100_000,
  });
  pair.scout = pane;
  return {pair, root, runs, sent, ran};
}

const driver = (edit, words) => {
  const seen = {};
  const partner = {
    thinkingOf: () => 'off',
    setRole: async () => {},
    ask: async (_id, input) => { seen.input = input; seen.reply = await seen.pair.edit(edit); return seen.words; },
  };
  return {partner, seen};
};

test('without a test: the hand-over builds and runs the unsaved buffer with the user\'s last build and run, and checks the bound', {skip: has('cc') && has('make') ? false : 'needs cc and make', timeout: 60_000}, async () => {
  const fixed = PROBE_C.replace('return key % 16;', 'return (key * 2654435761u) >> 22;');
  const {partner, seen} = driver({file: 'probe.c', line: 4, endLine: 4, text: 'static unsigned slot(unsigned key) { return (key * 2654435761u) >> 22; }'});
  seen.words = 'Took the multiply\'s high bits: avg probe 1.20.';
  const {pair, root, sent, ran} = realProject({'probe.c': PROBE_C, 'Makefile': 'run: probe\n\t./probe\nprobe: probe.c\n\tcc -O1 -o probe probe.c\n'}, {partner, buffer: fixed});
  seen.pair = pair;
  execFileSync('make', ['-s', 'probe'], {cwd: root}); // the user's own build: the copy gets their old program too
  const before = execFileSync('./probe', {cwd: root, encoding: 'utf8'});
  pair.receive({kind: 'command_end', cmd: 'make -s run', exit: 0, output: before, cwd: root});

  await pair.drive('you take it: make the keys spread over the table, avg probe stays under 2');
  assert.match(seen.input, /What the user expects to see: "avg probe stays under 2"\. After your edit, Pair runs `make -s run` \(the build and run the user ran last in their terminal\), once the user allows it,/);
  assert.deepEqual(sent.filter(message => message.type === 'confirm').map(message => message.text),
    ['Pair wants to run `make -s run` on the unsaved buffer, in a scratch copy, to check its edit (make run runs a target that is not a test or build). Allow?']);
  assert.equal(ran.length, 1);
  assert.match(ran[0], /\/trees\/[\da-f]{16}' && \(make -s run\) > /, 'in the scratch copy');
  assert.match(seen.reply, /It printed avg probe 1\.\d+, which meets it\./);
  assert.match(seen.reply, /exit 0\navg probe 1\.\d+ worst \d+/, 'with the output');
  const handback = sent.find(message => message.type === 'handback');
  assert.equal(handback.tests, 'pass');
  assert.match(handback.check, /^avg probe 1\.\d+$/);
  const [start, end] = sent.filter(message => message.type === 'tests');
  assert.deepEqual([start.label, end.state, end.label], ['make -s run (unsaved)', 'pass', 'make -s run (unsaved)']);
  assert.match(end.text, /^avg probe 1\.\d+$/, 'the statusline shows the line the run printed for the target');
  assert.equal(readFileSync(join(root, 'probe.c'), 'utf8'), PROBE_C, 'the project is untouched: the buffer is not saved');
  assert.equal(execFileSync('./probe', {cwd: root, encoding: 'utf8'}), before, 'nor its program');
});

test('the check sees every unsaved buffer, and the copy it builds in stays: the next build builds only what changed', {skip: has('cc') && has('make') ? false : 'needs cc and make', timeout: 60_000}, async () => {
  const main = '#include <stdio.h>\n#include "size.h"\nint main(void) {\n  printf("size %d\\n", SIZE);\n  return 0;\n}\n';
  const edited = main.replace('size %d', 'table size %d');
  const {partner, seen} = driver({file: 'main.c', line: 4, endLine: 4, text: '  printf("table size %d\\n", SIZE);'});
  seen.words = 'Named the size.';
  // size.h has an unsaved change the Driver did not make: the build has to see it too.
  const files = {'main.c': main, 'size.h': '#define SIZE 16\n', 'util.c': 'int util;\n', 'Makefile': 'run: probe\n\t./probe\nprobe: main.o util.o\n\tcc -o probe main.o util.o\nmain.o: main.c size.h\n\tcc -c main.c\nutil.o: util.c\n\tcc -c util.c\n'};
  const {pair, root, runs, sent} = realProject(files, {partner, buffer: edited, buffers: dir => [{file: join(dir, 'size.h'), text: '#define SIZE 64\n'}]});
  seen.pair = pair;
  const check = 'run `make -s run`';
  await pair.drive(`you take it: name the size, ${check}`);
  assert.match(seen.reply, /exit 0\ntable size 64/, 'the edit and the other unsaved buffer');
  assert.equal(readFileSync(join(root, 'size.h'), 'utf8'), '#define SIZE 16\n', 'nothing was saved');
  const [tree] = readdirSync(join(runs, 'trees')).filter(name => !name.endsWith('.json'));
  const built = name => statSync(join(runs, 'trees', tree, name)).mtimeMs;
  const util = built('util.o');

  await pair.setRole('navigator');
  const again = driver({file: 'main.c', line: 4, endLine: 4, text: '  printf("slots %d\\n", SIZE);'});
  again.seen.words = 'Renamed it.';
  again.seen.pair = pair;
  pair.partner = again.partner;
  pair.requestEditor = async message => (message.type === 'read' ? {text: main.replace('size %d', 'slots %d')} : message.type === 'buffers' ? {buffers: []} : {ok: true, from: 4, to: 4});
  await pair.drive(`you take it: rename it, ${check}`);
  assert.match(again.seen.reply, /exit 0\nslots 16/, 'size.h is the saved one again');
  assert.equal(built('util.o'), util, 'util.c did not change: not built again');
  assert.ok(sent.filter(message => message.type === 'handback').length === 2);
});

test('a bound the run misses comes back ✗ with the number; a crash comes back ✗ with the signal, core dumps off', {skip: has('cc') && has('make') ? false : 'needs cc and make', timeout: 60_000}, async () => {
  const files = {'probe.c': PROBE_C, 'Makefile': 'run: probe\n\t./probe\nprobe: probe.c\n\tcc -O1 -o probe probe.c\n'};
  const missed = driver({file: 'probe.c', line: 4, endLine: 4, text: 'static unsigned slot(unsigned key) { return (key * 31) % 64; }'});
  const one = realProject(files, {partner: missed.partner, buffer: PROBE_C.replace('return key % 16;', 'return (key * 31) % 64;')});
  missed.seen.pair = one.pair;
  missed.seen.words = 'Multiplied by 31.';
  one.pair.receive({kind: 'command_end', cmd: 'make -s run', exit: 0, output: 'avg probe 200.50 worst 400\n', cwd: one.root});
  await one.pair.drive('you take it: spread the keys, avg probe stays under 2');
  assert.match(missed.seen.reply, /It printed avg probe \d+\.\d+, which does not meet it: say why from the output in a few words\./);
  const handback = one.sent.find(message => message.type === 'handback');
  assert.equal(handback.tests, 'fail');

  const crash = driver({file: 'probe.c', line: 4, endLine: 4, text: 'static unsigned slot(unsigned key) { return *(volatile unsigned *)0 + key; }'});
  crash.seen.words = 'Read the slot from memory.';
  const two = realProject(files, {partner: crash.partner, buffer: PROBE_C.replace('return key % 16;', 'return *(volatile unsigned *)0 + key;')});
  crash.seen.pair = two.pair;
  two.pair.receive({kind: 'command_end', cmd: 'make -s run', exit: 0, output: 'avg probe 200.50 worst 400\n', cwd: two.root});
  await two.pair.drive('you take it: spread the keys, avg probe stays under 2');
  assert.match(crash.seen.reply, /and that the run failed: /);
  assert.equal(two.sent.find(message => message.type === 'handback').tests, 'fail');
});

test('an expectation in words: the Partner compares the output, and its ✓ or ✗ marks the hand-back', {skip: has('cc') && has('make') ? false : 'needs cc and make', timeout: 60_000}, async () => {
  const counters = '#include <stdio.h>\nint main(void) {\n  int hits = 3, misses = 1;\n  printf("hits %d\\n", hits);\n  return 0;\n}\n';
  const both = counters.replace('printf("hits %d\\n", hits);', 'printf("hits %d misses %d\\n", hits, misses);');
  const {partner, seen} = driver({file: 'show.c', line: 4, endLine: 4, text: '  printf("hits %d misses %d\\n", hits, misses);'});
  seen.words = '✓ The line shows both: hits 3 misses 1.';
  const {pair, root, sent} = realProject({'show.c': counters}, {partner, buffer: both});
  seen.pair = pair;
  pair.receive({kind: 'command_end', cmd: 'cc -o show show.c && ./show', exit: 0, output: 'hits 3\n', cwd: root});
  await pair.drive('you take it: print the misses too, the line shows both counters');
  assert.match(seen.reply, /The user expects: "the line shows both counters"\. Compare the output with it: start your sentence with ✓ if the run shows that, or ✗ if it does not/);
  assert.match(seen.reply, /hits 3 misses 1/);
  const handback = sent.find(message => message.type === 'handback');
  assert.deepEqual([handback.tests, handback.check], ['pass', null], 'the Partner\'s ✓');
});

test('a run that writes a picture: the Partner gets it with the edit\'s answer', {skip: has('cc') && has('make') ? false : 'needs cc and make', timeout: 60_000}, async () => {
  // A program that writes a 1x1 PNG, as a renderer writes its screenshot.
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f3d0000000049454e44ae426082', 'hex');
  const bytes = [...png].join(',');
  const shot = `#include <stdio.h>\nstatic const unsigned char png[] = {${bytes}};\nint main(void) {\n  FILE *f = fopen("shot.png", "wb");\n  fwrite(png, 1, sizeof png, f);\n  fclose(f);\n  puts("wrote shot.png");\n  return 0;\n}\n`;
  const {partner, seen} = driver({file: 'shot.c', line: 7, endLine: 7, text: '  puts("wrote shot.png");'});
  seen.words = 'Done.';
  const {pair, root} = realProject({'shot.c': shot}, {partner, buffer: shot});
  seen.pair = pair;
  pair.receive({kind: 'command_end', cmd: 'cc -o shot shot.c && ./shot', exit: 0, output: 'wrote shot.png\n', cwd: root});
  await pair.drive('you take it: write the shot, the picture shows one pixel');
  assert.deepEqual([seen.reply.picture.file, seen.reply.picture.mimeType, seen.reply.picture.data], ['shot.png', 'image/png', png.toString('base64')]);
});

test('a Zig project: the check builds and runs it in the copy', {skip: has('zig', 'version') ? false : 'needs zig', timeout: 120_000}, async () => {
  const main = 'const std = @import("std");\npub fn main() void {\n    const n: u32 = 7;\n    std.debug.print("count {d}\\n", .{n});\n}\n';
  const edited = main.replace('const n: u32 = 7;', 'const n: u32 = 3;');
  const {partner, seen} = driver({file: 'main.zig', line: 3, endLine: 3, text: '    const n: u32 = 3;'});
  seen.words = 'Set n to 3.';
  const {pair, root, sent} = realProject({'main.zig': main}, {partner, buffer: edited});
  seen.pair = pair;
  pair.receive({kind: 'command_end', cmd: 'zig run main.zig', exit: 0, output: 'count 7\n', cwd: root});
  await pair.drive('you take it: count to three, count equals 3');
  assert.match(seen.reply, /It printed count 3, which meets it\./);
  assert.equal(sent.find(message => message.type === 'handback').tests, 'pass');
});

test('in the sandbox of Pair\'s pane, the check builds and runs in the writable runs folder', {skip: !sandboxWorks() ? 'needs bubblewrap' : has('cc') && has('make') ? false : 'needs cc and make', timeout: 60_000}, async () => {
  const fixed = PROBE_C.replace('return key % 16;', 'return (key * 2654435761u) >> 22;');
  const {partner, seen} = driver({file: 'probe.c', line: 4, endLine: 4, text: 'static unsigned slot(unsigned key) { return (key * 2654435761u) >> 22; }'});
  seen.words = 'High bits.';
  const {pair, root, sent, ran} = realProject({'probe.c': PROBE_C, 'Makefile': 'run: probe\n\t./probe\nprobe: probe.c\n\tcc -O1 -o probe probe.c\n'}, {partner, buffer: fixed, sandbox: true});
  seen.pair = pair;
  pair.receive({kind: 'command_end', cmd: 'make -s run', exit: 0, output: 'avg probe 200.50 worst 400\n', cwd: root});
  await pair.drive('you take it: spread the keys, avg probe stays under 2');
  assert.match(ran[0], /pair-check-runs-[^/]+\/trees\/[\da-f]{16}' && \(make -s run\)/);
  assert.match(seen.reply, /It printed avg probe 1\.\d+, which meets it\./);
  assert.equal(sent.find(message => message.type === 'handback').tests, 'pass');
});

test('the check waits for the user\'s yes: a no runs nothing; a yes holds for that command for the session', {skip: has('cc') && has('make') ? false : 'needs cc and make', timeout: 60_000}, async () => {
  const files = {'probe.c': PROBE_C, 'Makefile': 'run: probe\n\t./probe\nprobe: probe.c\n\tcc -O1 -o probe probe.c\n'};
  const edit = {file: 'probe.c', line: 4, endLine: 4, text: 'static unsigned slot(unsigned key) { return key % 32; }'};
  const declined = driver(edit);
  declined.seen.words = 'Done.';
  const no = realProject(files, {partner: declined.partner, buffer: PROBE_C, answer: false});
  declined.seen.pair = no.pair;
  no.pair.receive({kind: 'command_end', cmd: 'make -s run', exit: 0, output: 'avg probe 200.50 worst 400\n', cwd: no.root});
  await no.pair.drive('you take it: spread the keys, avg probe stays under 2');
  assert.match(declined.seen.reply, /The user did not allow `make -s run` on the unsaved buffer, so nothing ran\./);
  assert.deepEqual(no.ran, []);

  const allowed = driver(edit);
  allowed.seen.words = 'Done.';
  const yes = realProject(files, {partner: allowed.partner, buffer: PROBE_C});
  allowed.seen.pair = yes.pair;
  yes.pair.receive({kind: 'command_end', cmd: 'make -s run', exit: 0, output: 'avg probe 200.50 worst 400\n', cwd: yes.root});
  await yes.pair.drive('you take it: spread the keys, avg probe stays under 2');
  await yes.pair.drive('you take it: spread them more, avg probe stays under 2');
  assert.equal(yes.ran.length, 2, 'both hand-overs ran the check');
  assert.equal(yes.sent.filter(message => message.type === 'confirm').length, 1, 'asked once');
});

test('the run\'s picture is attached only for a model that reads images; the config can say a model at a baseUrl does', async () => {
  const picture = {file: 'shot.png', data: 'iVBO', mimeType: 'image/png'};
  const apiFor = input => ({agent: async () => ({model: {provider: 'pair-partner', modelId: 'm'}}), models: {getModel: () => ({input})}});
  const seeing = await withPicture({text: 'Changed.', picture}, apiFor(['text', 'image']), {});
  assert.deepEqual(seeing.output, [{type: 'text', text: 'Changed.\n\nThe run wrote the picture shot.png, attached.'}, {type: 'image', data: 'iVBO', mimeType: 'image/png'}]);
  const blind = await withPicture({text: 'Changed.', picture}, apiFor(['text']), {});
  assert.deepEqual(blind.output, [{type: 'text', text: 'Changed.\n\nThe run wrote the picture shot.png; your model does not read images, so it is not attached.'}]);
  assert.deepEqual((await withPicture('Changed.', apiFor(['text']), {})).output, [{type: 'text', text: 'Changed.'}]);

  const model = images => ({api: 'openai', baseUrl: 'http://localhost:1/v1', model: 'm', ...(images === undefined ? {} : {images})});
  assert.deepEqual(createPairModels(parseConfig({models: {watcher: model(), partner: model(true)}})).partner.input, ['text', 'image']);
  assert.deepEqual(createPairModels(parseConfig({models: {watcher: model(), partner: model()}})).partner.input, ['text']);
  assert.throws(() => parseConfig({models: {watcher: model(), partner: model('yes')}}), /models\.partner\.images must be true or false/);
});

test('through the Partner: a model that reads images gets the picture; one that does not gets its name, and no picture is promised', async () => {
  const picture = {file: 'shot.png', data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'), mimeType: 'image/png'};
  for (const input of [['text', 'image'], ['text']]) {
    const faux = fauxProvider({provider: 'faux-partner', models: [{id: 'p', input}]});
    const models = createModels();
    models.setProvider(faux.provider);
    let received;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('edit', {file: 'shot.c', line: 1, new_text: 'x'})], {stopReason: 'toolUse'}),
      context => { received = context.messages.filter(message => message.role === 'toolResult').at(-1).content; return fauxAssistantMessage([fauxText('Done.')]); },
    ]);
    const say = async () => 'shown';
    const partner = await openPartner({
      storage: new MemoryStorage(), models, model: faux.getModel(),
      hands: {say, edit: async () => ({text: 'Changed.', picture}), roleOf: () => 'driver'},
    });
    const conversation = await partner.createConversation();
    await partner.setRole(conversation, 'driver');
    await partner.ask(conversation, 'go');
    await partner.close();
    const texts = received.filter(part => part.type === 'text').map(part => part.text).join('\n');
    if (input.includes('image')) {
      assert.deepEqual(received.filter(part => part.type === 'image'), [{type: 'image', data: picture.data, mimeType: 'image/png'}]);
      assert.match(texts, /The run wrote the picture shot\.png, attached\.$/);
    } else {
      assert.equal(received.some(part => part.type === 'image'), false);
      assert.match(texts, /The run wrote the picture shot\.png; your model does not read images, so it is not attached\.$/);
      assert.doesNotMatch(texts, /omitted/);
    }
  }
});

test('two bounds through a real run: the first met and the second missed comes back ✗ with both numbers', {skip: has('cc') && has('make') ? false : 'needs cc and make', timeout: 60_000}, async () => {
  const fixed = PROBE_C.replace('return key % 16;', 'return (key * 2654435761u) >> 22;');
  const {partner, seen} = driver({file: 'probe.c', line: 4, endLine: 4, text: 'static unsigned slot(unsigned key) { return (key * 2654435761u) >> 22; }'});
  seen.words = 'High bits.';
  const {pair, root, sent} = realProject({'probe.c': PROBE_C, 'Makefile': 'run: probe\n\t./probe\nprobe: probe.c\n\tcc -O1 -o probe probe.c\n'}, {partner, buffer: fixed});
  seen.pair = pair;
  pair.receive({kind: 'command_end', cmd: 'make -s run', exit: 0, output: 'avg probe 200.50 worst 400\n', cwd: root});
  await pair.drive('you take it: speed up the hash, avg probe stays under 2 and worst stays under 1');
  assert.match(seen.reply, /It printed avg probe 1\.\d+ · worst \d+, which does not meet it: say why/);
  const handback = sent.find(message => message.type === 'handback');
  assert.equal(handback.tests, 'fail');
  assert.match(handback.check, /^avg probe 1\.\d+ · worst \d+$/);
  assert.equal(sent.filter(message => message.type === 'tests').at(-1).state, 'fail', 'the statusline too');
});
