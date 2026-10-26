// The scenes: where the project starts, the session's goal and settings, and the models' words and timing.
// Everything else in a capture is the real plugin and daemon at work: the triggers, the tools reading and checking
// the files, the tests on save and on the unsaved buffer (go test, for real), and what Neovim draws.
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const score = (...kinds) => prompt => (kinds.some(kind => prompt.includes(`(${kind})`)) ? '9' : '0');

/** Replaces `from` with `to` in a file of the project; the scene's starting point. */
function change(project, file, from, to) {
  const path = join(project, file);
  const text = readFileSync(path, 'utf8');
  if (!text.includes(from)) throw new Error(`${file} has no ${from}`);
  writeFileSync(path, text.replace(from, to));
}

// Both fixes of the morning are in: the budget check and the lease.
function fixed(project) {
  change(project, 'internal/delivery/worker.go', 'elapsed+wait >= cfg.Budget', 'elapsed+wait > cfg.Budget');
  change(project, 'internal/queue/queue.go', 'ttl: cfg.Budget,', 'ttl: cfg.Budget + cfg.AttemptTimeout,');
}

const TABLE = 'internal/retry/backoff_test.go';
const CASES = [
  '\t\t{"first retry waits the base", 1, time.Second},',
  '\t\t{"second retry doubles", 2, 2 * time.Second},',
  '\t\t{"fifth retry", 5, 16 * time.Second},',
  '\t\t{"capped at Max", 7, time.Minute},',
  '\t\t{"no attempt yet", 0, 0},',
  '\t\t{"negative attempt", -1, 0},',
  '\t\t{"shift past 63 bits", 64, time.Minute},',
].join('\n');

export const scenes = {
  // 01: the delivery test is red; you open backoff.go and change the shift. Pair reads, and says why not.
  'wrong-turn': {
    goal: 'retries reach the budget',
    watcher: score('edit_while_red'),
    partner: [
      {when: /backoff\.go/, wait: 250, call: ['read', {file: 'internal/retry/backoff.go'}]},
      {wait: 1100, call: ['read', {file: 'internal/delivery/worker.go'}]},
      {wait: 1300, call: ['point', {file: 'internal/delivery/worker.go', line: 35, note: '7s + 8s = 15s: still inside the budget', code: '>='}]},
      {wait: 200, say: 'the shift is fine: 1s 2s 4s 8s, as the test wants.\nattempt 5 lands at exactly 15s, and `worker.go:35` gives up on `>=`'},
    ],
  },
  // 02: Pair runs the tests on each save; the fix for the budget breaks the queue's lease, and Pair suggests the fix.
  'tests-on-save': {
    goal: 'delivery retries reach the budget',
    testOnSave: 'go test -json ./...',
    watcher: score('regression'),
    partner: [
      {when: /TestNoDoubleDelivery/, wait: 300, call: ['read', {file: 'internal/queue/queue_test.go', start_line: 24, end_line: 37}]},
      {wait: 1300, call: ['read', {file: 'internal/queue/queue.go'}]},
      {wait: 1100, call: ['suggest', {file: 'internal/queue/queue.go', line: 18, new_text: '\treturn &Queue{ttl: cfg.Budget + cfg.AttemptTimeout, leased: map[string]time.Duration{}}', note: 'the lease has to outlive the last attempt'}]},
      {wait: 150, say: 'delivery passes now, queue doesn\'t: attempt 5 starts at 15s, the moment evt_42\'s lease runs out, so a second worker takes the job `queue.go:18`'},
    ],
  },
  // 03: you hand over with :Pair drive; Pair types six table cases, tests the unsaved buffer and hands back.
  'hand-over': {
    goal: 'retries reach the budget',
    testOnSave: 'go test -json ./...',
    setup: fixed,
    watcher: score(),
    partner: [
      {when: /edge cases/, wait: 700, call: ['read', {file: TABLE}]},
      {wait: 900, call: ['read', {file: 'internal/retry/backoff.go'}]},
      {wait: 1100, call: ['edit', {file: TABLE, line: 15, new_text: CASES}]},
      {wait: 300, say: 'six cases, one undo step, and they pass. `64` shifts past the top bit: `Next` already caps it, so that one is a guard.'},
    ],
  },
  // The same hand-over, taken back with a key while Pair types.
  'take-back': {
    goal: 'retries reach the budget',
    testOnSave: 'go test -json ./...',
    setup: fixed,
    watcher: score(),
    partner: [
      {when: /edge cases/, wait: 600, call: ['edit', {file: TABLE, line: 15, new_text: CASES}]},
      {say: 'Okay, yours.'},
    ],
  },
};
