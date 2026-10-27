// The exploration loop against real models: the hash table of docs/captures/loop, built and run for real with
// `make run`, four times. A printf for the hunt, then a multiply that keeps the stride (the same numbers), then a
// shift that breaks it (the numbers move). The Watcher scores each moment, and the Partner says why the numbers
// did not move, and then what is now true.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, test} from 'node:test';
import {MemoryStorage} from '@earendil-works/pi-durable';
import {BUDGETS} from '../../src/budget.mjs';
import {describeState} from '../../src/describe.mjs';
import {numberedLines, readProjectPath} from '../../src/files.mjs';
import {fold, initialState} from '../../src/fold.mjs';
import {openPartner} from '../../src/partner.mjs';
import {watchInput} from '../../src/session.mjs';
import {detectTriggers} from '../../src/triggers.mjs';
import {createWatcher} from '../../src/watcher.mjs';
import {bashWithoutCores} from '../no-core.mjs';
import {liveStacks, SKIP_REASON} from './stacks.mjs';

const PROJECT = new URL('../../docs/captures/loop/', import.meta.url);
const PROBE = readFileSync(new URL('probe.c', PROJECT), 'utf8');
const MASK = 'return key & (CAP - 1);';
const PRINT = '        uint32_t p = insert(id);';
const hasCc = spawnSync('cc', ['--version']).status === 0;
const hasMake = spawnSync('make', ['--version']).status === 0;
const NOW = 1_000_000;

const line = (text, part) => text.split('\n').findIndex(each => each.includes(part)) + 1;

/** Runs `make run` in `root` as the user's terminal would, without core dumps: its output and exit code. */
function makeRun(root) {
  const result = spawnSync(...bashWithoutCores('make -s run'), {cwd: root, encoding: 'utf8'});
  return {output: result.stdout + result.stderr, exit: result.status};
}

/** The four runs of the loop, for real: the session state after each, and the project's folder. */
function loop() {
  const root = mkdtempSync(join(tmpdir(), 'pair-live-loop-'));
  copyFileSync(new URL('Makefile', PROJECT), join(root, 'Makefile'));
  let text = PROBE;
  writeFileSync(join(root, 'probe.c'), text);
  let state = initialState({root, goal: 'see how well the entity table spreads its keys'});
  let at = NOW - 60_000;
  const states = [];
  const run = () => {
    at += 5000;
    state = fold(state, {kind: 'command_end', pane: 'w1:p3', cmd: 'make run', ...makeRun(root), cwd: root, at});
    states.push(state);
  };
  // The editor sends the lines the user typed: `typed`, which replaced `from` with `to` in the file.
  const edit = (from, to, typed = to) => {
    at += 5000;
    text = text.replace(from, to);
    writeFileSync(join(root, 'probe.c'), text);
    const where = line(text, typed.trim());
    state = [{kind: 'edit', file: 'probe.c', from: where, to: where, text: typed, at}, {kind: 'cursor', file: 'probe.c', line: where, at}].reduce(fold, state);
  };
  run();
  const debug = '        if (e < 6) printf("bucket %u\\n", hash(id));';
  edit(PRINT, `${PRINT}\n${debug}`, debug);
  run();
  edit(MASK, 'return (key * 31) & (CAP - 1);');
  run();
  edit('return (key * 31) & (CAP - 1);', 'return (uint32_t)(key * 2654435769u) >> 14;');
  run();
  return {root, states: states.map(each => fold(each, {kind: 'focus', target: 'terminal', pane: 'w1:p3', at: each.runs.at(-1).at}))};
}

/** The Partner's hands, recording each call; `read` reads the project for real. */
function recordingHands(root) {
  const calls = [];
  const record = (name, result) => async (_conversation, args) => { calls.push({name, args}); return result; };
  return {calls, hands: {
    roleOf: () => 'navigator',
    say: record('say', 'shown'),
    point: record('point', 'highlighted'),
    open: record('open', 'opened in a split'),
    suggest: record('suggest', 'Shown in the editor. The user accepts it with one key or ignores it.'),
    read: async (_conversation, {file, from, to}) => {
      calls.push({name: 'read', args: {file}});
      const source = await readProjectPath(root, file);
      return source.error ?? source.listing ?? numberedLines(source.text, from, to);
    },
  }};
}

const stacks = liveStacks();
const skip = !stacks.length ? SKIP_REASON : !hasCc || !hasMake ? 'no C compiler or make' : false;

describe('the exploration loop on live models', {skip}, () => {
  const {root, states} = skip ? {} : loop();

  for (const stack of stacks) {
    const score = createWatcher({models: stack.models, model: stack.watcher, now: () => NOW});

    async function remark(t, state, trigger) {
      const {calls, hands} = recordingHands(root);
      const partner = await openPartner({storage: new MemoryStorage(), models: stack.models, model: stack.partner, thinking: stack.config.models.partner.thinking, hands});
      const at = state.runs.at(-1).at + 2000;
      const answer = await partner.ask(await partner.createConversation(), watchInput(trigger, describeState(state, at)), {kind: 'remark'});
      await partner.close();
      t.diagnostic(`tools: ${calls.map(call => `${call.name}(${JSON.stringify(call.args)})`).join(', ')}`);
      // say's hand gets the words themselves, point's its arguments.
      const words = [...calls.map(call => (call.name === 'say' ? call.args : call.name === 'point' ? call.args.note : '')), answer].filter(Boolean).join('\n');
      t.diagnostic(`words: ${words}`);
      t.diagnostic(`points: ${calls.filter(call => call.name === 'point').map(call => `${call.args.file}:${call.args.line}`).join(', ')}`);
      return {words, points: calls.filter(call => call.name === 'point' || call.name === 'suggest')};
    }

    const triggerOf = (state, kind) => {
      const trigger = detectTriggers(state, state.runs.at(-1).at + 2000).find(found => found.kind === kind);
      assert.ok(trigger, `the real runs raise ${kind}`);
      return trigger;
    };

    test(`${stack.name}: the runs read for real: the same numbers after a print and after *31, then the shift moves them`, () => {
      assert.deepEqual(states.map(state => state.runs.at(-1).verdict.kind), ['first', 'again', 'same', 'moved']);
      assert.match(states[2].runs.at(-1).output, /bucket 1984/, 'the printf printed the stride');
      const loopKinds = ['same_result', 'number_moved'];
      assert.deepEqual(detectTriggers(states[1], states[1].runs.at(-1).at + 2000).filter(found => loopKinds.includes(found.kind)), [], 'a print for the hunt raises nothing');
    });

    test(`${stack.name}: the change that did nothing scores above the bar, and the Partner says why at hash()`, {timeout: 240_000}, async t => {
      const trigger = triggerOf(states[2], 'same_result');
      const {value} = await score(trigger, states[2]);
      t.diagnostic(`same numbers scored ${value}`);
      assert.ok(value >= BUDGETS.normal.bar, `score ${value} below the normal bar`);
      const {words, points} = await remark(t, states[2], trigger);
      // After a say or a point, a closing SILENT is no silence: the user saw what came before it (see session.mjs).
      assert.ok(words.trim() && !/^\W*silent\W*$/i.test(words), 'it speaks');
      // The cause is in two places: hash() keeps the stride, and the ids that come 64 apart give it one.
      const code = readFileSync(join(root, 'probe.c'), 'utf8');
      const hash = line(code, 'static uint32_t hash');
      const ids = line(code, 'uint32_t id = e * 64');
      assert.ok(points.some(({args}) => args.file.endsWith('probe.c') && ((args.line >= hash && args.line <= hash + 2) || args.line === ids)), 'it marks hash() or the ids');
      assert.match(words, /64|stride|odd|bijection|multiple/i, 'it names why: the keys stay 64 apart');
    });

    test(`${stack.name}: the numbers that moved at the end of a hunt score above the bar, and get one line on what is now true`, {timeout: 240_000}, async t => {
      const trigger = triggerOf(states[3], 'number_moved');
      const {value} = await score(trigger, states[3]);
      t.diagnostic(`moved numbers scored ${value}`);
      assert.ok(value >= BUDGETS.normal.bar, `score ${value} below the normal bar`);
      const {words} = await remark(t, states[3], trigger);
      // After a say or a point, a closing SILENT is no silence: the user saw what came before it (see session.mjs).
      assert.ok(words.trim() && !/^\W*silent\W*$/i.test(words), 'it speaks');
      assert.match(words, /1\.1/, 'it says the new number');
    });
  }
});
