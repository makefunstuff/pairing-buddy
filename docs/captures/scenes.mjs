// The scenes: where the project starts, the session's goal and settings, and the models' words and timing.
// Everything else in a capture is the real plugin and daemon at work: the triggers, the tools reading and checking
// the files, the tests on save and on the unsaved buffer (go test, for real), and what Neovim draws.
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sliceText} from '../../src/blank-page.mjs';

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

// The blank page's scenes replay a real :Pair new with a cloud model, unedited: its three questions (each asked after the
// answer before it), the slice, and the Makefile and main.c it typed when handed the wheel.
const TICKS = JSON.parse(readFileSync(new URL('./ticks.json', import.meta.url), 'utf8'));

// The board of a day of exploring: four tasks of this project at work and a notes agent, all in their own panes.
const task = (n, title, state, stage, msg) => ({id: `hashtab/${n}`, title, state, stage, msg});
const TASKS = [
  task(21, 'See crashes and compiler errors', 'working', 'working', 'Parsing clang diagnostics'),
  task(22, 'The exploration loop: read every run', 'working', 'reviewing', 'Under review'),
  task(24, 'The search trail from Telescope', 'working', 'working', 'Reading the docs'),
  task(25, 'Context card and no ceremony', 'working', 'after', 'queued after #21'),
];
const AGENTS = {
  tasks: TASKS,
  files: Object.fromEntries([21, 22, 24, 25].map(n => [`hashtab/${n}`, {worktree: `/work/hashtab-${n}`, link: {pane: `w${n}:p1`}}])),
  herdr: [
    ...[21, 22, 24].map(n => ({pane_id: `w${n}:p1`, cwd: `/work/hashtab-${n}`, agent: 'claude', agent_status: 'working'})),
    {pane_id: 'w3:p1', cwd: '/work/notes', agent: 'pi', agent_status: 'working', terminal_title_stripped: 'tidy the design notes'},
  ],
  // While you type: #21 asks you a question, #22 passed its review, and the notes agent finishes.
  later(herdr, show) {
    show(TASKS.map(t => (t.id === 'hashtab/21' ? {...t, state: 'blocked', stage: 'asks', msg: 'Should a segfault also name its signal number?'}
      : t.id === 'hashtab/22' ? {...t, state: 'blocked', stage: 'approval', msg: 'Review: Pass'} : t)));
    herdr[3].agent_status = 'idle';
  },
};

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
  // Your other agents: their news waits while you type, and comes as one line when you save; :Pair agents has them all.
  'agents': {
    project: 'hashtab',
    goal: 'a faster probe',
    watcher: score(),
    partner: [],
    agents: AGENTS,
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
  // The blank page: an empty folder, :Pair new and one sentence; three questions one at a time, then the first slice.
  'blank-page': {
    blank: 'ticks',
    watcher: score(),
    partner: [
      ...TICKS.questions.map(question => ({when: /^\[new\]/, wait: 1600, say: question})),
      {when: /^\[new\]/, wait: 2600, say: JSON.stringify(TICKS.slice)},
    ],
  },
  // The first run: the slice is in the note; handed the wheel twice, Pair types the Makefile and main.c, and it runs.
  'first-run': {
    blank: 'ticks',
    watcher: score(),
    setup: project => writeFileSync(join(project, 'NOTES.md'),
      `# ticks\n\n${TICKS.idea}\n${TICKS.answers.map(answer => `- ${answer}`).join('\n')}\n\n${sliceText(TICKS.slice)}\n`),
    partner: [
      {when: /Makefile/, wait: 700, call: ['read', {file: 'NOTES.md'}]},
      {wait: 900, call: ['edit', {file: 'Makefile', line: 1, new_text: TICKS.makefile}]},
      {wait: 300, say: TICKS.makefileSaid},
      {when: /main\.c/, wait: 800, call: ['read', {file: 'Makefile'}]},
      {wait: 1100, call: ['edit', {file: 'main.c', line: 1, new_text: TICKS.main}]},
      {wait: 300, say: TICKS.mainSaid},
    ],
  },
};
