// The held thought: a remark that can wait shows at the user's next breakpoint, with a dot in the margin meanwhile.
import assert from 'node:assert/strict';
import {realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {initialState} from '../src/fold.mjs';
import {BREAK, Breakpoints, placeOf, stillTrue, urgent} from '../src/held.mjs';
import {PairSession} from '../src/session.mjs';
import {openStore} from '../src/store.mjs';
import {scratch} from './temp.mjs';

test('a wrong turn, a regression and a failure speak at the next pause; drift, a stall and a new error can wait', () => {
  for (const kind of ['edit_while_red', 'regression', 'repeated_error', 'failed_command']) assert.equal(urgent(kind), true, kind);
  for (const kind of ['drift', 'stall', 'new_code_diagnostic']) assert.equal(urgent(kind), false, kind);
});

test('a breakpoint: a save, a run that ended, a stop out of Insert mode, or a quiet stretch', () => {
  const now = 100_000;
  const typing = {...initialState(), lastKeyAt: now - 500, lastEditAt: now - 500};
  const breaks = new Breakpoints();
  breaks.see({kind: 'mode', insert: true, at: now - 20_000});
  assert.equal(breaks.last(typing, now), 0, 'typing in Insert mode: none yet');
  breaks.see({kind: 'save', at: now - 300});
  assert.equal(breaks.last(typing, now), now - 300, 'the save');
  breaks.see({kind: 'command_end', at: now - 200});
  assert.equal(breaks.last(typing, now), now - 200, 'a command that ended, such as a commit');
  breaks.see({kind: 'test_run', at: now - 100});
  assert.equal(breaks.last(typing, now), now - 100, 'the tests run on save');

  breaks.see({kind: 'mode', insert: false, at: now - 1000});
  assert.equal(breaks.last(typing, now), now - 100, 'just out of Insert mode is no break yet');
  const later = now - 500 + BREAK.normalMs; // after the last key
  assert.equal(breaks.last(typing, later), later, 'out of it a while is');
  breaks.see({kind: 'mode', insert: true, at: now});
  assert.equal(breaks.last(typing, now + BREAK.quietMs - 1000), now - 100, 'back in Insert mode, still busy');
  assert.equal(breaks.last(typing, now + BREAK.quietMs), now + BREAK.quietMs, 'quiet for a while, in any mode');
});

test('a held thought is dropped once what it saw is gone; its dot goes where it points, else where its trigger is', () => {
  const diagnostic = {kind: 'new_code_diagnostic', file: 'a.c', line: 4, message: 'undeclared n'};
  const state = {...initialState(), diagnostics: {'a.c': [{line: 4, message: 'undeclared n', severity: 'error'}]}};
  assert.equal(stillTrue(diagnostic, state), true);
  assert.equal(stillTrue(diagnostic, {...state, diagnostics: {'a.c': []}}), false, 'the user fixed it meanwhile');
  const drift = {kind: 'drift', file: 'notes.md'};
  assert.equal(stillTrue(drift, {...state, edits: [{file: 'notes.md'}]}), true);
  assert.equal(stillTrue(drift, {...state, edits: [{file: 'notes.md'}, {file: 'main.c'}]}), false, 'back in the goal\'s own file');
  assert.equal(stillTrue({kind: 'stall'}, state), true);

  assert.deepEqual(placeOf({file: '/p/b.c', line: 9, note: 'x'}, diagnostic, '/p'), {file: '/p/b.c', line: 9});
  assert.deepEqual(placeOf(null, diagnostic, '/p'), {file: '/p/a.c', line: 4});
  assert.deepEqual(placeOf(null, drift, '/p'), {file: '/p/notes.md', line: null});
  assert.deepEqual(placeOf(null, {kind: 'stall'}, '/p'), {file: null, line: null});
});

const SOURCE = '#include <stdio.h>\n\nint main(void) {\n\treturn n;\n}\n';

/** A session in a scratch C project, whose Partner points at the error in main.c and says why. */
function pairSession() {
  const root = realpathSync(scratch('pair-held-'));
  writeFileSync(join(root, 'main.c'), SOURCE);
  const store = openStore(':memory:');
  const clock = {now: 1_000_000};
  const sent = [];
  const pair = new PairSession({
    record: store.createSession({root, conversationId: 'c1', goal: 'parse the header', level: 'normal', at: clock.now}),
    store,
    partner: {
      thinkingOf: () => 'off',
      setRole: async () => {},
      ask: async () => {
        await pair.point({file: 'main.c', line: 4, endLine: 4, note: '`n` is never declared', code: 'n'});
        return 'Line 4 returns `n`, which nothing declares.';
      },
    },
    score: async () => ({value: 9, reason: 'test'}),
    typingPauseMs: 2000,
    notify: (to, message) => { sent.push({via: to, ...message}); return 1; },
    requestEditor: async () => null,
    now: () => clock.now,
  });
  const file = join(root, 'main.c');
  /** The user wrote line 4, which has an error now, and went on typing further down. */
  const errorInNewCode = () => {
    pair.receive({kind: 'mode', insert: true});
    pair.receive({kind: 'edit', file, from: 4, to: 4});
    pair.receive({kind: 'diagnostics', file, items: [{line: 4, severity: 'error', message: 'use of undeclared identifier n'}]});
    pair.receive({kind: 'cursor', file, line: 1});
    clock.now += 2500; // a pause in typing: the gate lets the trigger through
  };
  const types = () => { clock.now += 1000; pair.receive({kind: 'typing'}); };
  const shown = type => sent.filter(message => message.type === type && message.via !== 'chat'); // in the editor
  const chat = () => sent.filter(message => message.via === 'chat');
  return {root, file, pair, store, clock, sent, errorInNewCode, types, shown, chat};
}

test('a remark that can wait is ready at once and shows at the next save, with a dot where it points meanwhile', async () => {
  const {file, pair, clock, errorInNewCode, types, shown, chat} = pairSession();
  errorInNewCode();
  await pair.tick();
  assert.deepEqual(shown('held').map(({via, file, line}) => [via, file, line]), [['editor', file, 4]], 'the dot, where it points');
  assert.deepEqual([...shown('point'), ...shown('remark'), ...chat()], [], 'nothing else yet, not even in the chat');

  types();
  await pair.tick();
  clock.now += 2500; // a pause in typing is not a breakpoint
  await pair.tick();
  assert.deepEqual(shown('remark'), []);

  pair.receive({kind: 'save', file});
  await pair.tick();
  assert.deepEqual(shown('point').map(message => message.line), [4], 'at the save: the point');
  const [remark] = shown('remark');
  assert.equal(remark.text, 'Line 4 returns `n`, which nothing declares.', 'and the words');
  assert.ok(chat().some(message => message.text === 'Line 4 returns `n`, which nothing declares.'), 'and the chat');
});

test('the jump key reads a held thought early; one no longer true by its breakpoint is dropped', async () => {
  const early = pairSession();
  early.errorInNewCode();
  await early.pair.tick();
  early.types();
  early.pair.release();
  assert.equal(early.shown('remark').length, 1, 'shown when asked for, typing or not');

  const fixed = pairSession();
  fixed.errorInNewCode();
  await fixed.pair.tick();
  fixed.types();
  fixed.pair.receive({kind: 'diagnostics', file: fixed.file, items: []}); // the user declared it themselves
  fixed.pair.receive({kind: 'save', file: fixed.file});
  await fixed.pair.tick();
  assert.deepEqual(fixed.shown('remark'), []);
  assert.deepEqual(fixed.shown('unheld').map(message => message.via), ['editors'], 'its dot goes');
  assert.deepEqual(fixed.store.remarks(0), [], 'it is no remark the user can rate');
});

test('a remark that can wait shows at once when the user is already at a break; an urgent one never waits for one', async () => {
  const resting = pairSession();
  resting.errorInNewCode();
  resting.pair.receive({kind: 'mode', insert: false});
  resting.clock.now += BREAK.normalMs;
  await resting.pair.tick();
  assert.deepEqual(resting.shown('held'), [], 'no dot');
  assert.equal(resting.shown('remark').length, 1);

  const red = pairSession();
  red.pair.receive({kind: 'command_end', cmd: 'make test', exit: 2, output: 'main.c:4: error: n undeclared', at: red.clock.now - 10_000});
  red.pair.receive({kind: 'command_end', cmd: 'make test', exit: 2, output: 'main.c:4: error: n undeclared', at: red.clock.now - 5000});
  red.pair.receive({kind: 'mode', insert: true});
  await red.pair.tick();
  assert.deepEqual(red.shown('held'), []);
  assert.equal(red.shown('remark').length, 1, 'the same failure again speaks at the pause');
});

test('while a thought is held, nothing else that can wait is judged; urgent news still is', async () => {
  const {pair, clock, errorInNewCode, types, shown} = pairSession();
  const judged = [];
  pair.log = line => judged.push(line.split(':')[0]);
  errorInNewCode();
  await pair.tick();
  assert.equal(shown('held').length, 1);
  types();
  pair.receive({kind: 'edit', file: 'notes.md', from: 1, to: 1}); // drift, which can wait as well
  clock.now += 2500;
  await pair.tick();
  assert.deepEqual(judged, ['new_code_diagnostic', 'new_code_diagnostic'], 'judged and held; drift waits for the held thought');
  pair.receive({kind: 'command_end', cmd: 'make', exit: 2, output: 'error: boom', at: clock.now - 10_000});
  pair.receive({kind: 'command_end', cmd: 'make', exit: 2, output: 'error: boom', at: clock.now});
  pair.receive({kind: 'typing', at: clock.now - 2500});
  await pair.tick();
  assert.ok(judged.includes('repeated_error'), 'the same failure again does not');
});

const RED = '--- FAIL: TestPop (0.00s)\n    ring_test.go:9: got 2, want 1\nFAIL\texample.com/ring\t0.001s';

test('an urgent remark made while a thought is held shows at the next pause, and stays when the held one is dropped', async () => {
  const {file, pair, clock, errorInNewCode, types, shown} = pairSession();
  const logged = [];
  pair.log = line => logged.push(line);
  pair.receive({kind: 'focus', target: 'terminal', pane: 'w1:p3', at: clock.now - 40_000}); // the user watched it fail
  pair.receive({kind: 'command_end', pane: 'w1:p3', cmd: 'go test ./...', exit: 1, output: RED, at: clock.now - 30_000});
  errorInNewCode();
  await pair.tick();
  const [held] = shown('held');
  assert.ok(held, 'the error in new code is held');

  types();
  clock.now += 2500;
  pair.partner.ask = async () => {
    types(); // typing again while Pair writes the wrong turn
    return 'The failure is in ring_test.go, not in main.c.';
  };
  await pair.tick();
  assert.ok(logged.some(line => line.startsWith('edit_while_red: speak')), 'the wrong turn is not held back by the budget of an unseen thought');
  assert.deepEqual(shown('remark'), [], 'not while you type');

  clock.now += 2500; // a pause, still in Insert mode: no breakpoint
  await pair.tick();
  assert.deepEqual(shown('remark').map(message => message.text), ['The failure is in ring_test.go, not in main.c.'], 'the wrong turn, at the pause');
  assert.equal(pair.thought?.id, held.id, 'the held thought still waits');

  pair.receive({kind: 'diagnostics', file, items: []}); // the user fixes the first error
  pair.receive({kind: 'save', file});
  await pair.tick();
  assert.deepEqual(shown('unheld').map(message => message.id), [held.id], 'the held one goes');
  assert.equal(shown('remark').length, 1, 'the wrong turn stays shown');
});

test('a held error whose line moves is still the same error, and shows at the save', async () => {
  const {file, pair, errorInNewCode, types, shown} = pairSession();
  errorInNewCode();
  await pair.tick();
  types();
  // A line added at the top: the same error, now on line 5.
  pair.receive({kind: 'diagnostics', file, items: [{line: 5, severity: 'error', message: 'use of undeclared identifier n'}]});
  pair.receive({kind: 'save', file});
  await pair.tick();
  assert.deepEqual(shown('unheld'), []);
  assert.equal(shown('remark').length, 1);
});
