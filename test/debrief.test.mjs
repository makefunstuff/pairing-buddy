// The day's end debrief's parts: the wins, the request, its first step and the place it resolves to, the lesson
// line from the verdicts, and the break hints at natural ends.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Breaks} from '../src/breaks.mjs';
import {debriefInput, duration, firstPlace, heading, keptChanges, lessonLine, parseDebrief, resolveFile, Wins} from '../src/debrief.mjs';

const MIN = 60_000;
const readLines = path => readFile(path, 'utf8').then(text => text.split('\n'));

test('the wins: tests that failed and pass now, commands green again, numbers that moved', () => {
  const wins = new Wins();
  wins.tests(['TestA', 'TestB']);
  wins.tests(['TestB']);
  wins.command('make run', true);
  wins.command('make run', false);
  wins.command('make', false); // never red: no win
  wins.moment('avg probe 23.7 → 4.1, after 3 runs at 23.7.');
  assert.deepEqual(wins.green, {tests: ['TestA'], commands: ['make run']});
  assert.deepEqual(wins.moved, ['avg probe 23.7 → 4.1, after 3 runs at 23.7.']);
});

test('the request carries the facts that exist, and asks for the debrief\'s form', () => {
  const wins = new Wins();
  wins.tests(['TestDeliver']);
  wins.tests([]);
  const input = debriefInput({
    goal: 'retries reach the budget', wins, kept: ['queue.go:18, the lease has to outlive the last attempt'],
    commits: ['abc1234 delivery: give up after the budget'], changes: ' M worker.go', failing: [],
    stopped: {file: 'internal/delivery/worker.go', line: 27, text: '\t\terr := send()'},
  });
  assert.match(input, /^\[end\]/);
  assert.match(input, /Tomorrow, first: <the one concrete step to start with>, in <file>:<line>\./);
  assert.match(input, /Goal: retries reach the budget/);
  assert.match(input, /fail(ed)? during the session and pass now: TestDeliver/);
  assert.match(input, /kept:\n- queue\.go:18/);
  assert.match(input, /Commits made in the session:\n- abc1234/);
  assert.match(input, /Where the user stopped: internal\/delivery\/worker\.go:27: err := send\(\)/);
  assert.doesNotMatch(input, /Still failing|Numbers/);
});

test('Pair\'s changes the user kept: accepted suggestions and edits not undone', () => {
  const actions = [
    {kind: 'suggested', state: 'applied', text: 'queue.go:18, the lease', data: {}},
    {kind: 'suggested', state: null, text: 'a.go:1, ignored', data: {}},
    {kind: 'typed', state: null, text: 'six cases', data: {undo: true}},
    {kind: 'typed', state: 'undone', text: 'undone cases', data: {undo: true}},
    {kind: 'typed', state: null, text: 'go test', data: {note: 'in your terminal'}},
  ];
  assert.deepEqual(keptChanges(actions), ['queue.go:18, the lease', 'six cases']);
});

test('the first step and the file:line it names last', () => {
  const {lines, first} = parseDebrief('✓ delivery makes all 5 attempts\n○ open: AttemptTimeout is not enforced\n**Tomorrow, first:** give `send()` a context, in `worker.go:27`.\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(first, {step: 'give `send()` a context, in `worker.go:27`.', files: ['worker.go'], line: 27});
  assert.deepEqual(parseDebrief('Tomorrow first: try it on a phone').first, {step: 'try it on a phone'});
  assert.equal(parseDebrief('✓ done').first, null);
  const place = step => { const {files, line} = parseDebrief(`Tomorrow, first: ${step}`).first; return {files, line}; };
  assert.deepEqual(place('fix the run target, in Makefile:14.'), {files: ['run target, in Makefile', 'target, in Makefile', 'in Makefile', 'Makefile'], line: 14}, 'a file without an extension');
  assert.deepEqual(place('the rule in (GNUmakefile:7)'), {files: ['GNUmakefile'], line: 7});
  assert.deepEqual(place('wrap the head, in `src/ring buffer.c:9`'), {files: ['src/ring buffer.c'], line: 9}, 'in backticks, as written');
  assert.deepEqual(place('wrap the head, in src/ring buffer.c:9'), {files: ['head, in src/ring buffer.c', 'in src/ring buffer.c', 'src/ring buffer.c', 'buffer.c'], line: 9}, 'a path with a space: the project tells which');
  assert.deepEqual(place('check ring.odin:12, then arena.zig:40').files.at(-1), 'arena.zig');
  assert.equal(parseDebrief('Tomorrow, first: start at 09:12 with the queue').first.files, undefined, 'a time of day is no place');
});

test('a file named by its end resolves to the one file git tracks, or the user had open, with that end', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pair-debrief-'));
  mkdirSync(join(root, 'internal/delivery'), {recursive: true});
  mkdirSync(join(root, 'internal/queue'), {recursive: true});
  writeFileSync(join(root, 'internal/delivery/worker.go'), 'package delivery\n\nfunc Deliver() {\n\terr := send()\n}\n');
  writeFileSync(join(root, 'internal/queue/queue.go'), 'package queue\n');
  writeFileSync(join(root, 'internal/delivery/queue.go'), 'package delivery\n');
  execFileSync('git', ['init', '-q'], {cwd: root});
  execFileSync('git', ['add', '-A'], {cwd: root});
  assert.equal(await resolveFile(root, 'worker.go'), 'internal/delivery/worker.go');
  assert.equal(await resolveFile(root, 'internal/queue/queue.go'), 'internal/queue/queue.go');
  assert.equal(await resolveFile(root, 'queue.go'), null, 'two files end in it');
  assert.equal(await resolveFile(root, 'queue.go', ['internal/queue/queue.go']), 'internal/queue/queue.go', 'one of them was open');
  assert.equal(await resolveFile(root, 'nowhere.go'), null);
  writeFileSync(join(root, 'Makefile'), 'run:\n\t./probe\n');
  writeFileSync(join(root, 'ring buffer.c'), 'int a;\nint b;\n');
  execFileSync('git', ['add', '-A'], {cwd: root});
  for (const [step, file, line] of [['fix the run target, in Makefile:2.', 'Makefile', 2], ['wrap the head, in ring buffer.c:2', 'ring buffer.c', 2]]) {
    const place = await firstPlace(root, parseDebrief(`Tomorrow, first: ${step}`).first, null, [], readLines);
    assert.deepEqual([place.file, place.line], [file, line], step);
  }

  const stopped = {file: 'internal/queue/queue.go', line: 1, text: 'package queue'};
  assert.deepEqual(await firstPlace(root, {step: 'give send a context, in worker.go:4', files: ['worker.go'], line: 4}, stopped, [], readLines),
    {step: 'give send a context, in worker.go:4', file: 'internal/delivery/worker.go', line: 4, text: '\terr := send()'});
  assert.deepEqual(await firstPlace(root, {step: 'try it on a phone'}, stopped, [], readLines), {step: 'try it on a phone', ...stopped}, 'no place: where the user stopped');
  assert.deepEqual(await firstPlace(root, null, null, [], readLines), null);
});

test('the lesson: the share of noise and what it was about; nothing without noise', () => {
  const now = 100 * MIN;
  const remark = (trigger, verdict, at = now - MIN) => ({trigger, verdict, at});
  const five = [remark('drift', 'dismissed'), remark('drift', null, now - 20 * MIN), remark('regression', 'useful'), remark('crash', 'seen'), remark('edit_while_red', 'useful')];
  assert.equal(lessonLine(five, now, {tuned: true}), '2 of my 5 remarks were noise, both about drift: I\'ll keep quieter there.');
  assert.equal(lessonLine(five, now), '2 of my 5 remarks were noise, both about drift.', 'without autoTune Pair promises nothing');
  assert.equal(lessonLine([remark('drift', 'dismissed'), remark('crash', 'dismissed'), remark('crash', 'dismissed')], now, {tuned: true}), '3 of my 3 remarks were noise, 2 about crashes: I\'ll keep quieter there.');
  assert.equal(lessonLine([remark('stall', 'dismissed')], now), '1 of my 1 remark was noise, about being stuck.');
  assert.equal(lessonLine([remark('drift', null)], now), null, 'too young to count as ignored');
  assert.equal(lessonLine([], now), null);
});

test('the heading: the session\'s active time and the project, a day\'s end after three', () => {
  const at = hour => new Date(2026, 9, 27, hour, 40).getTime();
  assert.equal(heading(at(17), 185 * MIN, 'hookd'), 'Day\'s end: 3 h 05 min in hookd.');
  assert.equal(heading(at(11), 25 * MIN, 'hookd'), 'Session\'s end: 25 min in hookd.');
  assert.equal(duration(10_000), 'under a minute');
});

test('a break hint comes at a natural end after 50 minutes of focus, at most once per 50, never in a red or at quiet', () => {
  const breaks = new Breaks();
  const work = (from, to) => { for (let t = from; t <= to; t += MIN) breaks.saw(t); };
  work(MIN, 30 * MIN); // focus from the first minute
  assert.equal(breaks.natural('green', 30 * MIN), null, 'too soon');
  work(30 * MIN, 52 * MIN);
  assert.equal(breaks.natural('green', 52 * MIN, {red: true}), null, 'never in the middle of a red');
  assert.equal(breaks.natural('green', 52 * MIN, {level: 'quiet'}), null);
  assert.equal(breaks.natural('green', 52 * MIN), '51 min of focus, and green: a good moment for a short break.');
  work(52 * MIN, 80 * MIN);
  assert.equal(breaks.natural('committed', 80 * MIN), null, 'one per 50 minutes');
  work(80 * MIN, 105 * MIN);
  assert.equal(breaks.natural('committed', 105 * MIN), '1 h 44 min of focus, and committed: a good moment for a longer break.');
  breaks.saw(115 * MIN); // ten minutes away: a break
  work(115 * MIN, 140 * MIN);
  assert.equal(breaks.natural('green', 140 * MIN), null, 'the count started again');
});
