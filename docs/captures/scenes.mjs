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

// The budget fix is in, the lease is not: TestNoDoubleDelivery fails.
function budgetFixed(project) {
  change(project, 'internal/delivery/worker.go', 'elapsed+wait >= cfg.Budget', 'elapsed+wait > cfg.Budget');
}

const QUEUE = 'internal/queue/queue.go';
const QUEUE_TEST = 'internal/queue/queue_test.go';
const LEASE_LINE = '\treturn &Queue{ttl: cfg.Budget, leased: map[string]time.Duration{}}';

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
  // The ledger: a morning of 02 and 03, then :Pair today, and u undoes the six cases after your own edit above them.
  'ledger': {
    goal: 'retries reach the budget',
    testOnSave: 'go test -json ./...',
    watcher: score('regression'),
    partner: [
      {when: /TestNoDoubleDelivery/, wait: 300, call: ['read', {file: 'internal/queue/queue_test.go', start_line: 24, end_line: 37}]},
      {wait: 600, call: ['read', {file: 'internal/queue/queue.go'}]},
      {wait: 600, call: ['suggest', {file: 'internal/queue/queue.go', line: 18, new_text: '\treturn &Queue{ttl: cfg.Budget + cfg.AttemptTimeout, leased: map[string]time.Duration{}}', note: 'the lease has to outlive the last attempt'}]},
      {wait: 150, say: 'delivery passes now, queue doesn\'t: attempt 5 starts at 15s, the moment evt_42\'s lease runs out, so a second worker takes the job `queue.go:18`'},
      {when: /edge cases/, wait: 500, call: ['read', {file: TABLE}]},
      {wait: 500, call: ['read', {file: 'internal/retry/backoff.go'}]},
      {wait: 600, call: ['edit', {file: TABLE, line: 15, new_text: CASES}]},
      {wait: 300, say: 'six cases, one undo step, and they pass. `64` shifts past the top bit: `Next` already caps it, so that one is a guard.'},
    ],
  },
  // 04: the delivery test is red; you grep "give up", then "dead letter", and find-file "retry". Pair says where it
  // is, in the code's own word. The Watcher's score and the Partner's words are a live model's, from test/live/trail.test.mjs.
  'search-trail': {
    goal: 'retries reach the budget',
    watcher: prompt => (prompt.includes('(search_trail)') ? '7' : '0'),
    partner: [
      {when: /search_trail/, wait: 400, call: ['read', {file: 'internal/delivery/worker.go'}]},
      {wait: 900, call: ['read', {file: 'internal/delivery/worker_test.go'}]},
      {wait: 1100, call: ['point', {file: 'internal/delivery/worker.go', line: 35, note: 'the code\'s word for giving up: `ErrBudget`', code: '>='}]},
      {wait: 200, say: 'The word you\'re looking for is `ErrBudget` ("retry budget spent"), and it fires here: `if elapsed+wait >= cfg.Budget` treats a wait that lands exactly on 15s as over budget, so it returns after attempt 4 instead of 5 — change `>=` to `>`.'},
    ],
  },
  // The held thought, in C: you write ring_pop and go on; the error in a line you left can wait, so Pair holds
  // its remark (a dot in the margin) until you save. The colorscheme is greys with one warm red.
  'held-thought': {
    project: 'ringbuf',
    goal: 'ring_pop hands back the oldest value',
    watcher: prompt => (prompt.includes('(new_code_diagnostic)') && prompt.includes('capacity') ? '9' : '0'),
    partner: [
      {when: /new_code_diagnostic/, wait: 300, call: ['read', {file: 'ring.h'}]},
      {wait: 900, call: ['point', {file: 'ring.c', line: 26, note: 'the ring keeps its size in `r->cap`', code: 'capacity'}]},
      {wait: 200, say: 'line 26 wraps the head with `capacity`, which nothing declares: the ring keeps its size in `r->cap`'},
    ],
  },
  // Delight, in C: you grow the interning table twice and the average probe holds still, because the hash was the
  // problem. Its fix moves the number, and the editor notices, briefly. Pair runs `make -s run` on each save.
  delight: {
    project: 'intern',
    goal: 'interning stays fast past 4000 names',
    testOnSave: 'make -s run',
    watcher: score(),
    partner: [],
  },
  // 04: you hold Alt-t and ask aloud; whisper.cpp hears it (for real: the stage plays `question` into the recorder
  // with espeak-ng), and Pair answers under your line.
  'push-to-talk': {
    goal: 'retries reach the budget',
    question: 'Why does delivery give up one retry too early?',
    watcher: score(),
    partner: [
      {when: /one retry too early/, wait: 500, call: ['read', {file: 'internal/delivery/worker.go'}]},
      {wait: 1200, call: ['point', {file: 'internal/delivery/worker.go', line: 35, note: '7s + 8s = 15s: still inside the budget', code: '>='}]},
      {wait: 200, say: 'attempt 5 would wait 8s after 7s: exactly the 15s budget, and `>=` gives up on it. `>` lets it run.'},
    ],
  },
  // A build and run on save in a C project (probe/, `make run` with AddressSanitizer): a missing semicolon, then a
  // crash whose frame Alt-j goes to, and Pair says why; then a new warning, which Pair leaves to the margin.
  'crash': {
    project: 'probe',
    goal: 'see how well the table spreads its keys',
    testOnSave: 'make run',
    watcher: score('crash'),
    partner: [
      {when: /crash/, wait: 300, call: ['read', {file: 'probe.c'}]},
      {wait: 1400, call: ['point', {file: 'probe.c', line: 11, note: '64 * 31 = 1984: past the table', code: 'key * 31'}]},
      {wait: 200, say: 'insert writes `keys[1984]`: without the mask, the second key already lands past `CAP`'},
    ],
  },
  // :Pair context: no goal typed (it comes from the board task of the branch), a failing run, two Telescope searches,
  // then the card, and x on a source. No model words: the card is what the daemon reads.
  'context-card': {
    branch: 'work/7-retries-reach-the-budget',
    board: true,
    watcher: score(),
    partner: [],
  },
  // The morning pick-up: yesterday ended with the lease still too short. Neovim opens empty and lands on queue.go:18,
  // Pair's gaze reads it again, one line says what is left, and Alt-j goes to the failing test.
  pickup: {
    goal: 'retries reach the budget',
    setup: budgetFixed,
    clock: 9,
    yesterday: project => ({
      note: '✓ delivery makes all 5 attempts: `>` lets attempt 5 run at exactly 15 s\n○ open: the queue\'s lease ends at 15 s, as attempt 5 starts\nTomorrow, first: make the lease outlive the last attempt, in queue.go:18.',
      first: {step: 'make the lease outlive the last attempt, in queue.go:18.', file: QUEUE, line: 18, text: LEASE_LINE},
      tests: {
        type: 'tests', state: 'fail', label: 'go test -json ./...', text: '1 failing · TestNoDoubleDelivery',
        results: [
          {name: 'TestLeaseOnce', file: join(project, QUEUE_TEST), line: 19, ok: true, failure: null},
          {name: 'TestNoDoubleDelivery', file: join(project, QUEUE_TEST), line: 26, ok: false, failure: {file: join(project, QUEUE_TEST), line: 34, text: 'attempt 5 starts at 15s, when evt_42\'s lease runs out'}},
        ],
      },
    }),
    watcher: score(),
    partner: [
      {when: /^\[pickup\]/, wait: 1400, say: 'Morning. Yesterday\'s `>` in worker.go made delivery green and left this: the lease is `cfg.Budget`, so it ends at 15 s, just as attempt 5 starts.'},
    ],
  },
  // The day's end: the lease fix turns the queue green, and /end in the chat gives the day in a few lines, with
  // tomorrow's first step, which e edits. The session's three hours and two noise remarks about drift are seeded.
  debrief: {
    goal: 'retries reach the budget',
    setup: budgetFixed,
    testOnSave: 'go test -json ./...',
    clock: 17,
    today: {activeMs: (3 * 60 + 5) * 60_000, remarks: [['drift', 'dismissed'], ['drift', 'dismissed'], ['regression', 'useful'], ['edit_while_red', 'useful'], ['regression', 'useful']]},
    watcher: score(),
    partner: [
      {when: /^\[end\]/, wait: 1600, say: '✓ delivery makes all 5 attempts\n✓ leases outlast the last attempt: `TestNoDoubleDelivery` passes\n○ open: `AttemptTimeout` is set, but nothing enforces it yet\nTomorrow, first: give `send()` a context with that timeout, in worker.go:27.'},
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
