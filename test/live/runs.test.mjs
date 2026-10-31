// Builds and runs against real models: a C program that crashes and one whose build prints a new warning, compiled
// and run for real with cc. The Watcher scores the moments, and the Partner points at the cause of the crash, at a
// warning that is a bug, and stays silent on one that is only untidy.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
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
import {scratch} from '../temp.mjs';

// Exploring a hash table: the user just took the mask out of hash() (line 10), so the index runs past the table.
const PROBE = `// probe: how well does the table spread its keys?
#include <stdio.h>

#define CAP 1024

static unsigned keys[CAP];
static unsigned char used[CAP];

static unsigned hash(unsigned key) {
  return key * 31;
}

static int insert(unsigned key) {
  unsigned i = hash(key);
  int probes = 1;
  while (used[i]) { i = (i + 1) & (CAP - 1); probes++; }
  used[i] = 1;
  keys[i] = key;
  return probes;
}

int main(void) {
  long total = 0;
  for (unsigned e = 0; e < 700; e++) total += insert(e * 64);
  printf("avg probe %.1f\\n", (double)total / 700);
  return 0;
}
`;
const BUILD = 'cc -g -O0 -Wall -o probe probe.c';

const hasCc = spawnSync('cc', ['--version']).status === 0;
const NOW = 1_000_000;

/**
 * Runs `command` in `root` with bash, as the user's terminal would, but without core dumps (see ../no-core.mjs):
 * its output, and its exit code as the shell hook reports it.
 */
function sh(root, command) {
  const result = spawnSync(...bashWithoutCores(command), {cwd: root, encoding: 'utf8'});
  const signals = {SIGSEGV: 11, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8};
  return {output: result.stdout + result.stderr, exit: result.signal ? 128 + signals[result.signal] : result.status};
}

/** The project with probe.c as `text`, and the session state after the user's `events` and commands run for real. */
function session(text, steps) {
  const root = scratch('pair-live-runs-');
  writeFileSync(join(root, 'probe.c'), text);
  let state = initialState({root, goal: 'see how well the table spreads its keys'});
  let at = NOW - 60_000;
  for (const step of steps) {
    at += 5000;
    if (step.edit) {
      writeFileSync(join(root, 'probe.c'), step.edit.text);
      state = [{kind: 'edit', file: 'probe.c', from: step.edit.line, to: step.edit.line, at}, {kind: 'cursor', file: 'probe.c', line: step.edit.line, at}].reduce(fold, state);
    } else {
      const {output, exit} = sh(root, step.run);
      state = fold(state, {kind: 'command_end', pane: 'w1:p3', cmd: step.run, exit, output, cwd: root, at});
    }
  }
  return {root, state: fold(state, {kind: 'focus', target: 'terminal', pane: 'w1:p3', at})};
}

function crashed() {
  const masked = PROBE.replace('return key * 31;', 'return (key * 31) & (CAP - 1);');
  return session(masked, [{run: `${BUILD} && ./probe`}, {edit: {line: 10, text: PROBE}}, {run: `${BUILD} && ./probe`}]);
}

// The user changes the printf to print the average as a whole number, or adds a variable for later.
const formatBug = () => session(PROBE.replace('return key * 31;', 'return (key * 31) & (CAP - 1);'), [
  {run: BUILD},
  {edit: {line: 25, text: PROBE.replace('return key * 31;', 'return (key * 31) & (CAP - 1);').replace('%.1f', '%d')}},
  {run: BUILD},
]);
const unusedVariable = () => session(PROBE.replace('return key * 31;', 'return (key * 31) & (CAP - 1);'), [
  {run: BUILD},
  {edit: {line: 24, text: PROBE.replace('return key * 31;', 'return (key * 31) & (CAP - 1);').replace('  long total = 0;', '  long total = 0;\n  int worst;')}},
  {run: BUILD},
]);

function triggerOf(state, kind) {
  const trigger = detectTriggers(state, NOW).find(found => found.kind === kind);
  assert.ok(trigger, `the real run raises ${kind}`);
  return trigger;
}

/** The Partner's hands, recording each call; `read` reads the project for real. */
function recordingHands(root) {
  const calls = [];
  const record = (name, result) => async (_conversation, args) => { calls.push({name, args}); return result; };
  return {calls, hands: {
    roleOf: () => 'navigator',
    say: record('say', 'shown'),
    point: record('point', 'Highlighted, with your note: the user sees it, so do not say it again.'),
    open: record('open', 'opened in a split'),
    suggest: record('suggest', 'Shown in the editor, with your note, and not made: the user accepts it with one key or ignores it. Do not say it again, and do not say you added or changed it.'),
    read: async (_conversation, {file, from, to}) => {
      calls.push({name: 'read', args: {file}});
      const source = await readProjectPath(root, file);
      return source.error ?? source.listing ?? numberedLines(source.text, from, to);
    },
  }};
}

const stacks = liveStacks();
const skip = !stacks.length ? SKIP_REASON : !hasCc ? 'no C compiler' : false;

describe('builds and runs on live models', {skip}, () => {
  for (const stack of stacks) {
    const score = createWatcher({models: stack.models, model: stack.watcher, now: () => NOW});

    async function remark(t, root, state, trigger) {
      const {calls, hands} = recordingHands(root);
      const partner = await openPartner({storage: new MemoryStorage(), models: stack.models, model: stack.partner, thinking: stack.config.models.partner.thinking, hands});
      const answer = await partner.ask(await partner.createConversation(), watchInput(trigger, describeState(state, NOW)), {kind: 'remark'});
      await partner.close();
      t.diagnostic(`detail: ${trigger.detail}`);
      t.diagnostic(`tools: ${calls.map(call => `${call.name}(${JSON.stringify(call.args)})`).join(', ')}`);
      t.diagnostic(`answer: ${answer}`);
      return {answer, points: calls.filter(call => call.name === 'point' || call.name === 'suggest')};
    }

    test(`${stack.name}: a segfault without a stack scores above the bar, and the Partner points at its cause`, {timeout: 240_000}, async t => {
      const {root, state} = crashed();
      const trigger = triggerOf(state, 'crash');
      assert.match(trigger.detail, /Segmentation fault/);
      const {value} = await score(trigger, state);
      t.diagnostic(`crash scored ${value}`);
      assert.ok(value >= BUDGETS.normal.bar, `score ${value} below the normal bar`);
      const {answer, points} = await remark(t, root, state, trigger);
      assert.ok(points.some(({args}) => args.file.endsWith('probe.c') && args.line >= 10 && args.line <= 17), 'it marks hash() or the index it gives');
      assert.doesNotMatch(answer, /^\W*silent\W*$/i);
    });

    test(`${stack.name}: a new warning that is a bug scores above the bar, and the Partner points at it`, {timeout: 240_000}, async t => {
      const {root, state} = formatBug();
      const trigger = triggerOf(state, 'new_warning');
      assert.match(trigger.detail, /-Wformat/);
      const {value} = await score(trigger, state);
      t.diagnostic(`format warning scored ${value}`);
      assert.ok(value >= BUDGETS.normal.bar, `score ${value} below the normal bar`);
      const {answer, points} = await remark(t, root, state, trigger);
      assert.ok(points.some(({args}) => args.file.endsWith('probe.c') && args.line === 25), 'it marks the printf');
      assert.doesNotMatch(answer, /^\W*silent\W*$/i);
    });

    test(`${stack.name}: an unused variable while exploring scores below the bar, and the Partner stays silent`, {timeout: 240_000}, async t => {
      const {root, state} = unusedVariable();
      const trigger = triggerOf(state, 'new_warning');
      assert.match(trigger.detail, /unused variable/);
      const {value} = await score(trigger, state);
      t.diagnostic(`unused variable scored ${value}`);
      assert.ok(value < BUDGETS.normal.bar, `score ${value} reaches the normal bar`);
      const {answer, points} = await remark(t, root, state, trigger);
      assert.match(answer, /^\W*silent\W*$/i);
      assert.deepEqual(points, []);
    });
  }
});
