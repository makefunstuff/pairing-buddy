# Tests

## Model-free tests

```sh
npm test
```

Runs every test that needs no model, in under a minute, with scripted models and fakes of herdr and the providers.

- **The core.** Event folding, the triggers, the budget and speak gate, the tool policy per role (also with
  file-writing tools installed by mistake, and an edit after the wheel was taken back), the command policy, and the
  test-output parsers, on real output of each runner.
- **Panes and roles.** Pair's pane and role switching against a fake herdr; hand-over and take-back; `type` (only after
  a yes, only into your terminal pane, never Enter); the bash hook.
- **The daemon end to end** with scripted models; several projects and Neovims at once; Neovim and the chat pane
  reconnecting after a daemon restart.
- **The Neovim plugin** in a headless Neovim:
  - suggestions accepted and ignored, struck from their first character;
  - a Driver edit undone with one `u` and never saved, and a key taking the wheel back;
  - the hand-over end to end: the edit typed as ghost text with only whole lines ever in the buffer, the tests run on
    a copy of the project with the buffer's text, the hand-back line with `✓` and `u undoes it`, and a key halfway
    leaving no change and doing nothing else;
  - the wrong turn end to end: Pair's words under your line, `Alt-j` to the cause, your next edit counting as seen;
  - tests on save end to end: the spinner, the failing test named, signs on the test functions and the failure after
    its line, `Alt-j` to Pair's suggestion and `Alt-y`, and the passing run;
  - a note moving under its line when the window narrows, and a question about selected lines;
  - the ledger: `:Pair today` listing what Pair read, typed, ran and said, `u` undoing its edit after a later edit of
    yours and `u` again making it again, nothing changing when you edited its lines, and `⏎` showing a run's output;
  - a held thought end to end: the `•` where it points and the statusline while you type in Insert mode, nothing in
    the chat, and `Alt-j` showing it at once;
  - push-to-talk: the held key's meter, the words heard and the answer in their place, and a tap;
  - the accent reaching the chat pane, also after a colorscheme change; the accent itself on a grey palette with one
    warm red, in a coloured scheme whose regexp colour is the error's hue, and in Neovim's own scheme.
- **Push-to-talk** without Neovim: the recorder (levels, a pipeline stopped as a whole, a failing recorder said at
  once), whisper.cpp's flags and text, and what is read aloud, only when you are away.
- **The held thought's rules** without Neovim: which triggers wait, each breakpoint, a thought dropped once the error
  is fixed or you left the file, one held at a time. Also the chat pane's true-colour lines and wrapping.
- **Install and daily use.** The config with comments and the first run's example; model entries that name a provider
  or a stored key; the credential store (owner-only, a token renewed once when two processes need it at the same
  time, a lock left by a dead process); `pair auth` with fake providers (subscription or key, a key for your own
  server, logout, the list without secrets, a typed key not echoed); the systemd unit; `pair doctor` against a fake
  model server (fast, slow, dead, a wrong model name, a stored key it needs, a login that no longer renews); model
  health (one notice, no remarks while down, back after a probe).
- **Memory and feedback.** The note the next session starts from (in the chat and the Partner's instructions, per
  project, never a failed note); remarks stored with their verdicts (`+`, `Alt-n`, an accepted suggestion); ignored
  remarks counting as noise and seen ones as neither; the tuning and its bounds; active time; `pair stats`.
- **The Watcher's speed.** The prefilter's rules, the one-number answer, drift checked once per file, keep-warm, and
  the Watcher following the model a one-model server has loaded.
- **The wrong turn's trigger.** Raised once per red run and file, never for the code the failure names, its test,
  notes, or a run that passed since.
- **The search trail.** Three searches with one closed empty make a trail, an edit or the time window ends it; the
  trigger waits for a pause and carries what fails now; the Watcher's question; what the project has for each query;
  a trail remark and `:Pair trail` showing the same searches; a held trail remark dropped once you edit.
- **The context card and no ceremony.** The board task matched by repo and number (never another repo's task of the
  same number, nor a version branch), the board's agent launches left out of your commands, each source's rows and
  budget, a hidden source left out of what the Partner gets and raising no remark (no failed command with a hidden
  terminal, no search trail with a hidden editor), the goal from the board task or the branch with nothing asked,
  "later" skipping the question, `:Pair context` in a headless Neovim (buffers and jumps on the card, `x` hiding git
  and bringing it back, and a word when not connected), and sessions ending by themselves: after the idle time, and
  once the last Neovim closed, with a note only for a session that was used.
- **The day's end and the morning pick-up.** The wins (tests and commands green again, numbers that moved, kept
  changes), the debrief's first step and the file its short name resolves to, the lesson line from the verdicts
  (ignored remarks counting as noise), the debrief kept as the note and a place; the next morning landing on that
  place after the code moved, the gaze reading it, the line and the failing run "since yesterday" with signs only for
  files unchanged since; no pick-up right after an end or once you work; the first step without a model; `/first`;
  break hints only at a natural end after 50 minutes of focus. In a headless Neovim: an empty Neovim landing, the
  line under the place, `Alt-j` to the failing test, a Neovim on another file staying there, and the debrief panel.
- **Builds and crashes.** The crash and diagnostic readers on real output of gcc, clang, zig, lld, glibc, the
  sanitizers, bash and make, recursive make included (and Odin's and C3's formats); signals from exit codes, never a
  program's own words in a run that ended with exit 0; the frame in the project; paths from where a command ran; new
  warnings only in files you edited; the crash and new-warning triggers; and in Neovim the `✗` and `△` on their lines,
  `Alt-j` to the crash or first error at its column, and a clean run clearing them.
- **Tests on save.** The JSON reports of go test (subtests, panics, build failures), jest and vitest, each test placed
  at its line; runs in Pair's pane one at a time; the regression trigger raised once per run with new failures.
- **Tests on unsaved text.** A real `go test -overlay` passing on the buffer's fix while the file on disk fails; a copy
  of the project for other runners (git's files and ignored files copied, dependency folders linked at any depth
  without their caches, builds into ignored folders staying in the copy, a file in a dependency folder refused); the
  Driver hearing the result.
- **The ledger.** What a session books (reads in a row as one line, the place a remark pointed at, its verdict,
  commands with their output, what it asked and was refused, the moments it stayed quiet and why), today from local
  midnight, the three-way merge that undoes an edit, details forgotten after a week, and `/today` in the chat.
- **[One model](config.md#one-model).** Each role's request to it (no thinking and 8 tokens for the Watcher, thinking
  for the Partner); the Watcher waiting while the Partner works in another project, and its remark saying how long it
  waited; a question cancelling the remark still being written (dropped, and no failure of the model); the context
  budget: the reply's room, compaction, and the instructions, tools and longest note fitting the smallest window.

**No core dumps.** Tests that crash a program on purpose (and the captures' crash scene) run it through
[test/no-core.mjs](../test/no-core.mjs), which sets the core limit to 1 byte. With systemd-coredump in
`/proc/sys/kernel/core_pattern`, `ulimit -c 0` is not enough: the kernel still hands the crash to it, and it logs the
crash and shows a notification. At 1 byte the kernel gives up before the pipe. A new test that crashes something on
purpose should run it the same way (`bashWithoutCores(command)`).

## Live tests against real models

```sh
PAIR_LIVE_CONFIG=/path/to/stacks.json npm run test:live
```

Runs the same decisions against real models. The file lists one or more stacks, each with a `watcher` and a `partner`
entry like those in the config:

```json
{"stacks": [{"name": "local", "watcher": {"api": "openai", "baseUrl": "http://localhost:8080/v1", "model": "your-small-model"}, "partner": {"api": "openai", "baseUrl": "http://localhost:8080/v1", "model": "your-larger-model"}}]}
```

Stacks can name a `provider` too, with its login or key from `pair auth`. Without `PAIR_LIVE_CONFIG` (or a gitignored
`test/live/config.json`) the live tests are skipped.

- **The Watcher** scores worth-it and noise moments, and the speak gate decides.
- **The Partner's tool calls:** pointing at the right line, staying silent on noise, reading before answering,
  changing nothing when asked to; on a wrong turn, pointing at the real cause with its code, or staying silent when
  your edit is the fix; on a regression found on save, a real `node --test` run, suggesting the fix where it breaks
  rather than undoing your change.
- **Scout:** searching to answer "where else", running the tests to say what fails, leaving the commit to you, and the
  Navigator pointing to `/scout`.
- **The Driver:** making a failing test pass after "your turn" without touching the test, then hearing the tests on the
  unsaved buffer pass and saying so; making exactly the change asked for; typing the test command without Enter; and
  the Navigator suggesting instead of editing.
- **Memory:** a session note that names the goal, the change and the loose end; the next session answering "what did
  we leave open?" from it; the note not turning a noise moment into a remark.
- **The day's end and the pick-up** (`test/live/day.test.mjs`): the debrief keeping its form (a `✓` line and a
  first step whose place is a file in the project), and the next morning's line being one short line of the model's.
- **Builds and runs** (`test/live/runs.test.mjs`): a C program built and run for real with `cc`. A segfault gets a
  point at its cause, a `-Wformat` warning a point at the `printf`, and an unused variable silence.
- **The probe** `pair doctor` and the daemon's health check use, and the Watcher answering it within 3 s.
- **A scripted session** (`test/live/dogfood.test.mjs`): twelve minutes of edits, failing tests, a stall, a question
  and drift, played through a real Pair session on a simulated clock and printed like a transcript. It checks that
  Pair spoke a few times, on the moments that matter.

The Scout and Driver tests work in a scratch project with a local bash in place of the herdr pane; the Driver's
editor is played by buffers in memory, and the files on disk must stay as they were.

**The search trail.** `test/live/trail.test.mjs` plays the captures' Go project with a red test and three searches;
the cue has to name the real cause in the code's own words. The trail alone, without the failing test, is run too,
for the record.

**The context card.** `test/live/context.test.mjs` gives the Partner a board task, buffers and a search: it has to
name the task, know nothing of the search while the editor source is hidden, and name the file the search opened once
it is back.

**Push-to-talk.** `test/live/voice.test.mjs` runs with real parts when `PAIR_LIVE_WHISPER_MODEL` names a whisper.cpp
model (and `PAIR_LIVE_WHISPER` the program, if it is not `whisper-cli` on `PATH`): espeak-ng and FFmpeg play a
spoken question into the recorder, whisper.cpp hears it on the CPU, and the stack's model answers through the daemon.
It prints what was heard and how long each step took.

**One model.** A stack with `"model"` in place of `watcher` and `partner` runs every test with one model in both
roles, and also `test/live/one-model.test.mjs`: the daemon end to end behind a local proxy that lets one request
through at a time, as many local servers do. It checks that a question cancels the remark still being written and is
answered, and that while the Partner answers in one project the Watcher of another waits instead of queueing behind
it. It prints when each request queued and ran.

**Logins.** Run when `PAIR_LIVE_LOGIN="provider/model"` is set and that provider is logged in with `pair auth login`:
the model answers as both roles, and a subscription's token renews and is kept. No test makes a subscription login:
it needs a browser and your account.

**The Anthropic API.** Run when `ANTHROPIC_API_KEY` and `PAIR_LIVE_ANTHROPIC_MODEL` are set: the cloud model answers
the probe as both roles, scores a repeated failure above the bar, and answers a short question as Partner. It has not
been run against the real API yet ([#44](https://github.com/makefunstuff/pairing-buddy/issues/44)).
