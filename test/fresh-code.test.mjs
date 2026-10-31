// Fresh code: a hunk the user just finished writing is read for a likely bug, and a remark waits for their next break.
import assert from 'node:assert/strict';
import {realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {fold, initialState} from '../src/fold.mjs';
import {stillTrue, urgent} from '../src/held.mjs';
import {PairSession} from '../src/session.mjs';
import {openStore} from '../src/store.mjs';
import {detectTriggers} from '../src/triggers.mjs';
import {momentOf} from '../src/watcher.mjs';
import {scratch} from './temp.mjs';

const foldAll = (events, state = initialState()) => events.reduce(fold, state);
const fresh = (state, now, fired) => detectTriggers(state, now, fired).filter(trigger => trigger.kind === 'fresh_code');

const SHARES = [
  'function lineShares(lines, discount) {',
  '  const total = lines.reduce((sum, line) => sum + line.price, 0);',
  '  return lines.map(line => discount * line.price / total);',
  '}',
];
/** The user wrote lineShares at lines 10-13 of cart.js, in two pauses of their typing. */
const written = [
  {kind: 'edit', file: 'cart.js', from: 10, to: 11, text: SHARES.slice(0, 2).join('\n'), at: 1000},
  {kind: 'cursor', file: 'cart.js', line: 11, at: 1000},
  {kind: 'edit', file: 'cart.js', from: 12, to: 13, text: SHARES.slice(2).join('\n'), at: 4000},
  {kind: 'cursor', file: 'cart.js', line: 13, at: 4000},
];

test('a hunk the user finished writing is fresh code: once they leave it, or save', () => {
  const state = foldAll(written);
  assert.deepEqual(fresh(state, 5000), [], 'the cursor is still in it');
  const left = fold(state, {kind: 'cursor', file: 'cart.js', line: 40, at: 5000});
  const [trigger] = fresh(left, 5000);
  assert.equal(trigger.file, 'cart.js');
  assert.deepEqual([trigger.from, trigger.to, trigger.line], [10, 13, 10]);
  assert.equal(trigger.code, SHARES.map((text, i) => `${10 + i}: ${text}`).join('\n'), 'both edits, as one hunk');
  assert.match(trigger.detail, /^The user just finished writing cart\.js:10-13 and moved on:/);
  assert.deepEqual(fresh(left, 5000, new Set([trigger.key])), [], 'once per hunk');

  const saved = fold(state, {kind: 'save', file: 'cart.js', at: 5000});
  assert.equal(fresh(saved, 5000).length, 1, 'a save ends it too, the cursor still in it');
  assert.match(fresh(saved, 5000)[0].detail, /and saved it:/);
  assert.equal(fresh(fold(state, {kind: 'enter', file: 'other.js', at: 5000}), 5000).length, 1, 'another file is leaving it');
});

test('a small fix, a note, old code, Pair\'s code and code with an error of its own are no fresh code', () => {
  const away = {kind: 'cursor', file: 'cart.js', line: 40, at: 5000};
  const small = foldAll([{kind: 'edit', file: 'cart.js', from: 10, to: 11, text: '  return 1;\n', at: 1000}, away]);
  assert.deepEqual(fresh(small, 5000), [], 'fewer than three lines of code');
  const note = foldAll([{...written[0], file: 'NOTES.md'}, {...written[2], file: 'NOTES.md'}, away]);
  assert.deepEqual(fresh(note, 5000), [], 'prose has moments of its own');
  const old = foldAll([...written, away]);
  assert.deepEqual(fresh(old, 4000 + 120_001), [], 'written over two minutes ago');
  const pairs = foldAll([...written.map(event => ({...event, origin: 'pair'})), away]);
  assert.deepEqual(fresh(pairs, 5000), [], 'the Driver wrote it');
  const generated = foldAll([...written, {kind: 'generated', file: 'cart.js', marks: [{from: 12, to: 12, gen: 1}]}, away]);
  assert.deepEqual(fresh(generated, 5000), [], 'taken from a /gen request and not theirs yet');
  const erring = foldAll([...written, {kind: 'diagnostics', file: 'cart.js', items: [{line: 11, severity: 'error', message: 'x'}], at: 4500}, away]);
  assert.deepEqual(fresh(erring, 5000), [], 'an error there is new_code_diagnostic\'s');
});

test('two hunks far apart are read apart; editing a hunk again makes it fresh again', () => {
  const state = foldAll([
    ...written,
    {kind: 'edit', file: 'cart.js', from: 30, to: 33, text: 'a();\nb();\nc();\nd();', at: 6000},
    {kind: 'cursor', file: 'cart.js', line: 60, at: 6000},
  ]);
  const found = fresh(state, 7000);
  assert.deepEqual(found.map(trigger => [trigger.from, trigger.to]), [[10, 13], [30, 33]]);
  const again = fold(state, {kind: 'edit', file: 'cart.js', from: 11, to: 11, text: '  const total = lines.reduce((sum, line) => sum + line.price * line.qty, 0);', at: 8000});
  const [first] = found;
  assert.equal(stillTrue(first, again), false, 'the hunk changed since: the thought about it is stale');
  assert.equal(stillTrue(found[1], again), true, 'the other hunk did not');
  const now = fold(again, {kind: 'cursor', file: 'cart.js', line: 60, at: 8000});
  const [reread] = fresh(now, 9000, new Set(found.map(trigger => trigger.key)));
  assert.match(reread.code, /line\.price \* line\.qty/, 'read again as it is now');
});

test('fresh code can wait for a break, and the Watcher reads the code itself for a bug', () => {
  assert.equal(urgent('fresh_code'), false);
  const [trigger] = fresh(foldAll([...written, {kind: 'save', file: 'cart.js', at: 5000}]), 5000);
  const asked = momentOf(trigger, initialState());
  assert.ok(asked.includes(SHARES[2]), 'the lines themselves');
  assert.match(asked, /likely they hold a real bug/);
  assert.match(asked, /style, naming or a missing check/, 'bugs only');
});

/** A session in a scratch project whose Watcher scores fresh code `scoreOf` and whose Partner points at the bug. */
function pairSession(scoreOf = 9) {
  const root = realpathSync(scratch('pair-fresh-'));
  writeFileSync(join(root, 'cart.js'), `${'\n'.repeat(9)}${SHARES.join('\n')}\n`);
  const store = openStore(':memory:');
  const clock = {now: 1_000_000};
  const sent = [];
  const scored = [];
  const asked = [];
  const pair = new PairSession({
    record: store.createSession({root, conversationId: 'c1', goal: null, level: 'normal', at: clock.now}),
    store,
    partner: {
      thinkingOf: () => 'off',
      setRole: async () => {},
      ask: async (_id, input) => {
        asked.push(input);
        await pair.point({file: 'cart.js', line: 11, endLine: 11, note: 'price, not price × qty', code: 'line.price'});
        return 'cart.js:11 sums `line.price`, not `line.price * line.qty`.';
      },
    },
    score: async trigger => { scored.push(trigger.kind); return {value: scoreOf, reason: 'test'}; },
    typingPauseMs: 2000,
    notify: (to, message) => { sent.push({via: to, ...message}); return 1; },
    requestEditor: async () => null,
    now: () => clock.now,
  });
  const file = join(root, 'cart.js');
  /** The user writes lineShares in Insert mode, in two edits, and moves down to write on. */
  const writes = () => {
    pair.receive({kind: 'mode', insert: true});
    pair.receive({kind: 'edit', file, from: 10, to: 11, text: SHARES.slice(0, 2).join('\n')});
    clock.now += 3000;
    pair.receive({kind: 'edit', file, from: 12, to: 13, text: SHARES.slice(2).join('\n')});
    pair.receive({kind: 'cursor', file, line: 20});
  };
  const types = () => { clock.now += 1000; pair.receive({kind: 'typing'}); };
  const shown = type => sent.filter(message => message.type === type && message.via !== 'chat');
  return {root, file, pair, store, clock, writes, types, shown, scored, asked};
}

test('the session: never asked while typing, held with a dot, said at the save', async () => {
  const {file, pair, clock, writes, types, shown, scored, asked} = pairSession();
  writes();
  types();
  await pair.tick();
  assert.deepEqual(scored, [], 'nothing is asked while the user types');

  clock.now += 2500;
  await pair.tick();
  assert.deepEqual(scored, ['fresh_code']);
  assert.match(asked[0], /^\[watch\] fresh_code: The user just finished writing cart\.js:10-13 and moved on:\n10: function lineShares/);
  assert.match(asked[0], /Style, naming, a missing test or a check they may add later is no bug: answer exactly SILENT\./);
  assert.deepEqual(shown('held').map(({file: at, line}) => [at, line]), [[file, 11]], 'a dot where it points');
  assert.deepEqual(shown('remark'), [], 'still in Insert mode: no break yet');

  pair.receive({kind: 'save', file});
  await pair.tick();
  assert.deepEqual(shown('remark').map(remark => remark.text), ['cart.js:11 sums `line.price`, not `line.price * line.qty`.']);
  assert.equal(pair.store.remarks(0)[0].trigger, 'fresh_code', 'a remark like any other, in the ledger and the stats');
});

test('the session: fresh code under the bar costs a Watcher call and says nothing', async () => {
  const {pair, clock, writes, shown, scored, asked} = pairSession(3);
  writes();
  clock.now += 2500;
  await pair.tick();
  assert.deepEqual(scored, ['fresh_code']);
  assert.deepEqual(asked, [], 'the Partner is not asked');
  assert.deepEqual([...shown('held'), ...shown('remark')], []);
  clock.now += 2500;
  await pair.tick();
  assert.deepEqual(scored, ['fresh_code'], 'the same hunk is not scored again');
});
