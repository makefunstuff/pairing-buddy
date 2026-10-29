---
description: "How Pair is tested: model-free tests with scripted models and fakes of herdr and the providers, and live tests against real models."
---

# Tests

## Model-free tests

```sh
npm test
```

Runs every test that needs no model, in a minute or two, with scripted models and fakes of herdr, the providers and
the work board.

- **The core.** Event folding, the triggers, the budget and speak gate, the tool policy per role (also with
  file-writing tools installed by mistake, and an edit after the wheel was taken back), the command policy, and the
  test-output parsers, on real output of each runner.
- **Panes and roles.** Pair's pane and role switching against a fake herdr, and its shell's rc file in a real bash
  (output and exit codes in files, more than 1000 lines); hand-over and take-back, also by typing at a shell prompt;
  `type` (only after a yes, only into your terminal pane, never Enter); your panes against a fake herdr's event stream
  (focus and scroll pushed, typing, a command seen running and one too short for that, no requests while you are in
  another workspace) and the heuristics on pane text; the shell hooks (bash, and zsh and fish where installed): each
  command's start and end, numbered, a start that arrives after its end, nothing written to the terminal, zsh's keys
  to the socket at most twice a second (and only where zle's hooks are there), no polling of a hooked zsh pane at its
  prompt, and an editor that opens late in a hooked command.
- **Without herdr**, in a headless Neovim: Scout's pane and the tests on save as a `:terminal` there, the Driver's
  `type` into the `:terminal` you used last or another one named in the answer, `:Pair chat`, and a command you run
  in your own `:terminal`, seen running and with its output, and with the bash hook its exit code. In a real tmux
  server with a client attached: focus, typing, a command seen running with its output, the Driver's text, the
  shell's foreground command by `/proc` and by `ps`, and the daemon watching the tmux session of a chat pane.
- **The board** against a fake `shepherdr` ([test/fake-shepherdr.mjs](../test/fake-shepherdr.mjs)), never your
  own Shepherdr: its spaces, tasks, a task in full and its report read through the adapter; the context card's task
  and the chat header's counts; the relay's news, a task's worktree found by its branch in a real git repo, and what
  it left behind (report and pull request, its branch's diff, its worktree); `/gen board`'s brief built from yours
  (the note's lines with `file:line`, the files, the tests, a check's open questions, a note not committed copied
  whole), added only on a pick (add only, delegate, plan first, research only) and nothing else written, and a request
  past `gen.limits` offered to it; in a headless Neovim, the task edited in `pair://board/new` and `:q` dropping it,
  `Alt-o`, and `d` and `t` in `:Pair agents`. A task's review in a scratch git repository: the facts line read into
  the reviewer's verdict and the rest, the files in the brief's order, `≠ brief` on the branch with a stand-in model,
  a hunk and then the rest of a file kept into a buffer as it is now, a new file kept, a deleted one refused, origin
  `board:<id>` and the marks, `/undo` taking it back; tell, merge (a tell) and archive copied or run only on the pick,
  never `shepherdr merge`; in a headless Neovim, `:Pair review`, the list, `Enter`'s diff, `k` on a hunk, `A`, `a`,
  `t` and `Alt-r`.
- **The daemon end to end** with scripted models; several projects and Neovims at once; Neovim and the chat pane
  reconnecting after a daemon restart; a question the restart cut off answered late, a remark dropped; a saved config
  taken without a restart (a new model between turns, one with an error refused).
- **The Neovim plugin** in a headless Neovim:
  - suggestions accepted and ignored, struck from their first character;
  - a Driver edit undone with one `u` and never saved, and a key taking the wheel back;
  - the hand-over end to end: the edit typed as ghost text with only whole lines ever in the buffer, the tests run on
    a copy of the project with the buffer's text, the hand-back line with `✓` and `u undoes it`, and a key halfway
    leaving no change and doing nothing else;
  - the hand-over without a test: your last run from the terminal built and run on the unsaved buffer, and the
    hand-back line starting with the line it printed for your target (`✓ x 100 · …`);
  - the wrong turn end to end: Pair's words under your line, `Alt-j` to the cause, your next edit counting as seen;
  - tests on save end to end: the spinner, the failing test named, signs on the test functions and the failure after
    its line, `Alt-j` to Pair's suggestion and `Alt-y`, and the passing run;
  - a note moving under its line when the window narrows, and a question about selected lines;
  - the ledger: `:Pair today` listing what Pair read, typed, ran and said, `u` undoing its edit after a later edit of
    yours and `u` again making it again, nothing changing when you edited its lines, and `⏎` showing a run's output;
  - a held thought end to end: the `•` where it points and the statusline while you type in Insert mode, nothing in
    the chat, and `Alt-j` showing it at once;
  - the blank page: `:Pair new` opening `NOTES.md` unsaved, each question under the answer it follows (also when
    you type on before it comes), an answer fixed after `Esc` sent as fixed, and `Alt-y` taking the slice in;
  - push-to-talk: the held key's meter, the words heard and the answer in their place, and a tap;
  - teaching on request: `Alt-?` showing the idea under Pair's words and then opening its link, each key's first-use
    hint, and the keys you used remembered;
  - the accent reaching the chat pane, also after a colorscheme change; the accent itself on a grey palette with one
    warm red, in a coloured scheme whose regexp colour is the error's hue, and in Neovim's own scheme.
- **The hand-over without a test** (`test/check.test.mjs`): the hand-over split into intent, observable and command;
  a bound read from the words and checked against the run's numbers; the check command chosen (the one in backquotes,
  the command on save, else your last build and run, with the build before a bare `./probe`, in its folder, never one
  the command policy refuses, nor a bare `./probe` with no build known); a terminal command Scout would ask about
  asking first, a no running nothing and a yes holding for the session; the picture attached only for a model that
  reads images, and `images` in a model entry. Its scratch projects and runs folders are removed when its tests end, and so are the live
  test's. A real C Makefile project (and a Zig one, with `zig` on `PATH`) built and run in the
  scratch copy: a bound met, a bound missed, a deliberate segfault (through `bashWithoutCores`), an expectation in
  words judged by the Partner's `✓`, and a picture the run writes going to the model. The project on disk stays as it
  was.
- **Push-to-talk** without Neovim: the recorder (levels, a pipeline stopped as a whole, a failing recorder said at
  once), whisper.cpp's flags and text, and what is read aloud, only when you are away.
- **The held thought's rules** without Neovim: which triggers wait, each breakpoint, a thought dropped once the error
  is fixed or you left the file, one held at a time. Also the chat pane's true-colour lines and wrapping.
- **The chat pane.** Its editor (words, lines, history, the word Tab completes), the terminal's keys (modifiers,
  Shift-Enter and Alt-Enter, pastes split across reads, the mouse wheel), OSC 52, and the history file; what it draws,
  as text: Markdown, a suggestion's diff, the gutter and the time dividers, code and diffs wrapped between tokens,
  the narrow layout (tool lines, the header, the status said shorter, the `@` menu), the measure of a wide pane and
  the meta in its margin, folding, the header and the status in their rules in each state, the footer's keys, which colour each part is drawn with, the whole frame. The session tells it what Pair does (thinking, a tool, a remark, waiting), streams the
  answer, says how long a turn took, and stops, mutes, follows up and undoes on request. The full-screen pane itself,
  driven by keys against the daemon with a scripted model and a stand-in Neovim: the empty card, a question and its
  answer, the `/` menu, Up, pastes, `?`, Esc stopping a streamed answer, Pair's y/N question (against a stand-in
  daemon) and Esc declining it, a suggestion picked and taken in Neovim, a
  jump, `@here`, a narrow, a wide and a tiny pane; and in a headless Neovim, `a`, `j` and `@here` for real.
- **Install and daily use.** The config with comments and the first run's example; model entries that name a provider
  or a stored key; the credential store (owner-only, a token renewed once when two processes need it at the same
  time, a lock left by a dead process); `pair auth` with fake providers (subscription or key, a key for your own
  server, logout, the list without secrets, a typed key not echoed); the systemd unit, the launchd agent and the
  supervisor that restarts the daemon without either; keys from environment variables stored for the service; `pair doctor` against a fake
  model server (fast, slow, dead, a wrong model name, a stored key it needs, a login that no longer renews); model
  health (one notice, no remarks while down, back after a probe).
- **Memory and feedback.** The note the next session starts from (in the chat and the Partner's instructions, per
  project, never a failed note); earlier sessions searched by `recall`, and a question about the past that comes with
  them; remarks stored with their verdicts (`+`, `Alt-n`, an accepted suggestion, `+2` from `/remarks`, `+` after a
  daemon restart, end to end in the chat pane); ignored remarks counting as noise and seen ones as neither; the tuning
  and its bounds, per project with the fallback to all; active time, reading included (scrolling reported from a
  headless Neovim); `pair stats` and `pair stats --project`.
- **The tone.** The checker the live tests use (praise, apology, filler, emoji, `!` outside code, headings and lists,
  words over the limit), the tone in the Partner's instructions, and teaching: the Partner asked about the words
  shown, the idea and its link apart for the editor, `?` in the chat about Pair's last words.
- **The Watcher's speed.** The prefilter's rules, the one-number answer, scores remembered, drift checked once per
  file with the file's gist, keep-warm, the Watcher following the model a one-model server has loaded, and, end to
  end against a fake server that swaps and does not say so, the Watcher moving to the Partner's model after two
  reloads. The pace: its levels and their border, verdicts ranking what it gives up, and, end to end against a fake
  server answering in 1.7 s, drift costing no call while a failure is still scored. `node test/pace-bench.mjs` (not
  part of `npm test`, about 2 minutes) measures calls and waits before and after the pace at set latencies.
- **The decision model.** Fake decision models stand in for a real one (`test/decision.test.mjs`): fixed
  probabilities, one that is slow and ignores the abort signal (given up at its timeout), one that is down or throws,
  and malformed answers (the wrong type, a probability outside 0 to 1, a choice that was not offered, none at all).
  The config entry, the catalog and gateway models pi-ai builds, the gate's sort, its speak probability against the
  bar and its fallback to the rules, the pace on the Watcher's path only, the state the model is told, the log and
  the ledger, `pair stats`'s section, and `pair doctor` and pi-ai's System One request against a fake HTTP server.
  End to end (`test/decision-daemon.test.mjs`): a failure let through without the Watcher, then the model down, said
  once in the chat, and the next failure scored by the Watcher. No provider is called.
  `node test/decision-check.mjs` (not part of `npm test`) is the live check. It runs moments through the real gate
  and prefilter with the config's `decision` model, or `--entry '{...}'`. The moments are either the 16 hand-written
  samples in `test/fixtures/decision-moments.json`, each with a Watcher score and a label chosen by hand and a sample
  history of verdicts the model is told, or, with `--store PATH`, the moments the daemon recorded: each logged
  decision keeps the state the model was told, and your verdict on its remark is the label. It reports how often the
  gate was right with the model and with the rules alone, how often the prefilter's sure sorts were right, the
  Watcher calls saved, and latency and cost per call, for each of `--runs N`. It asks a real model with your login or
  key, so it runs by hand; `--fake` checks the script. The results are in [decision.md](decision.md#measured).
- **Context windows and thinking settings.** The window from vLLM's, llama.cpp's and LM Studio's metadata or pi-ai's
  catalog, the config's own winning; `pair doctor --thinking` against fake servers that take a chat-template switch
  with a budget field, or `reasoning_effort` with three levels.
- **The wrong turn's trigger.** Raised once per red run and file, never for the code the failure names, its test,
  notes, or a run that passed since.
- **The search trail.** Three searches with one closed empty make a trail, an edit or the time window ends it; the
  trigger waits for a pause and carries what fails now; the Watcher's question; what the project has for each query;
  a trail remark and `:Pair trail` showing the same searches; a held trail remark dropped once you edit. In a
  headless Neovim, the searches read from a stand-in for Telescope and from the real fzf-lua, at a pinned commit
  fetched once into `node_modules/.cache` (skipped without `fzf` or the network): live_grep and files given up with
  `Esc` in fzf-lua's default setup, which hides the picker, a resumed picker with fewer words, grep words with
  punctuation as you gave them, grep_cWORD and grep_cword, what you opened, and fzf-lua set to end fzf, in fzf's own
  bottom-up layout with a `>` pointer, where a result line starts like the prompt.
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
- **The exploration loop.** The run log on the research's four runs (the same numbers after a print and after a
  change of the code, a number that moved, a time that only moves at half or double, a number that got worse, the
  output compared without numbers, a crash and a broken build); which commands are runs; the numbers of a run (no
  listing, place or address); the triggers once per run, and none from a hidden terminal; each language's debug
  prints and the lines one printed; debug lines added in the session and still in the code. In Neovim, four runs on
  save end to end: the statusline for each, the remark on the same numbers, the debug line counted and `Alt-j` to
  it, `:Pair runs` with `⏎` and `x` removing the print unsaved.
- **Tests on save.** The JSON reports of go test (subtests, panics, build failures), jest and vitest, and the real
  output of cargo test, pytest (plain, `-q`, `-v`, `-rA`, JUnit), zig test, zig build test, ctest, and node's TAP and JUnit
  reporters, each test placed at its line in the project that printed it (`test.each` and template titles too); runs
  in Pair's pane one at a time, a later save stopping a stale run, narrowed to the affected Go packages, jest, vitest
  and pytest files after the baseline; the regression trigger raised once per run with new failures.
- **Tests on unsaved text.** A real `go test -overlay` passing on the buffer's fix while the file on disk fails, with
  every unsaved buffer in the overlay; a copy of the project for other runners (git's files and ignored files copied,
  or every file without git, dependency folders linked at any depth without their caches, builds into ignored folders
  staying in the copy, a file in a dependency folder left out), kept between runs and copying only what changed; the
  Driver hearing the result.
- **The blank page.** The stack from your words ("go" and "node" in plain English name none), the question and slice
  rules with one more try, a slice that breaks them not shown, a long line asked about but never refused, remarks
  about the note held while a question waits and every other remark going on, `:Pair clear` ending the questions,
  and the Driver typing a file that does not exist yet.
- **The ledger.** What a session books (reads in a row as one line, the place a remark pointed at, its verdict,
  commands with their output, what it asked and was refused, the moments it stayed quiet and why), today from local
  midnight, the three-way merge that undoes an edit, details forgotten after a week, and `/today` in the chat.
- **Notes in the margin.** The repeat a rule finds, and the near-repeats and parallel paragraphs (two allocators, three
  build targets, option A and B) it leaves alone; decisions and their section; the code a note names found where it is
  defined (C and Go); the model's marks kept only where they hold up (a contradiction needs its other side); marks
  following their lines and going with an edit; the decision log (its entry, the question it quotes, a decision
  superseded, going back to one, never logged twice); tasks added only after the yes, as whole words; the prose
  triggers, the Watcher's questions for them, and a stall remark held to one question; and the plugin end to end:
  five marks, `Alt-l` to the code, `Alt-d` putting the entry in the log's buffer and not on disk, the tasks panel.
- **[One model](models.md#one-model).** Each role's request to it (no thinking and 8 tokens for the Watcher, thinking
  for the Partner); the Watcher waiting while the Partner works in another project, and its remark saying how long it
  waited; a question cancelling the remark still being written (dropped, and no failure of the model); the context
  budget: the reply's room, compaction, and the instructions, tools and longest note fitting the smallest window.
- **The site's link previews** (`test/site-meta.test.mjs`): each docs page's description from its frontmatter or
  first paragraph (own, not thin, at most 155 characters), the tags a page gets, and the check of the built pages
  naming a missing, relative or wrong tag. The Pages workflow runs that check on the real build (`npm run check` in
  `site/`).

**Temp dirs.** `npm test` runs through [test/run.mjs](../test/run.mjs), which puts the whole run under one folder,
`pair-test-XXXXXX` in `$TMPDIR` (`/tmp` when it is not set), and removes it when the run ends, also on Ctrl-C and
SIGTERM, once what the run started has stopped. To run the tests somewhere else, for example when `/tmp` is a small
tmpfs, set `TMPDIR` (the folder is made if it is missing):

```sh
TMPDIR=/var/tmp/pair npm test
```

Keep it to 26 characters or fewer: the tests make Unix sockets a few folders down, and a socket's path maxes out near
104 bytes. With a longer `TMPDIR`, as macOS's own `/var/folders/…/T` is, the run says so and uses `/tmp`.

[test/temp.mjs](../test/temp.mjs), loaded into every test file, gives each file its own folder in the run's one and
points `$TMPDIR` there, so the daemons, Neovims and programs a test starts put their temp files there too. When the
file ends, the processes it left running are stopped (and the ones they started), the dirs it made with `scratch()` (or `socketDir()`, for a
socket's short path) are removed, and anything else left in its folder fails the file with a line naming the file
and what it left. A test makes its temp dirs with those two, never `mkdtemp` or `tmpdir()` itself
([test/temp.test.mjs](../test/temp.test.mjs) checks the sources). A single file run with `node --test` gets the
same, with a root of its own. The live tests run the same way. A test without a timeout of its own gets five
minutes, so one that hangs fails the run instead of holding it.

**No core dumps.** Tests that crash a program on purpose (and the captures' crash scene) run it through
[test/no-core.mjs](../test/no-core.mjs), which sets the core limit to 1 byte. With systemd-coredump in
`/proc/sys/kernel/core_pattern`, `ulimit -c 0` is not enough: the kernel still hands the crash to it, and it logs the
crash and shows a notification. At 1 byte the kernel gives up before the pipe. A new test that crashes something on
purpose should run it the same way (`bashWithoutCores(command)`); so do the live tests' builds and runs, which crash
only when a change goes wrong.

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
- **The hand-over without a test** (`test/live/hand-over.test.mjs`): the captures' hash table, run once with
  `make -s run` as the user did, then handed over with "avg probe stays under 2". One edit, one run of the user's
  command on the unsaved buffer in the scratch copy, and a hand-back with the line the run printed and a `✓` or `✗`
  that agrees with it (under 2 at that load takes more than a good hash, and the model does not always get there; the
  test prints whether it did); the file on disk stays as it was.
- **The exploration loop** (`test/live/loop.test.mjs`): the captures' hash table built and run for real with
  `make run`, four times. The same numbers after `* 31` score above the bar and get a point at the cause with the
  reason, and the shift that ends the hunt scores above the bar and gets a line with the new number. Its runs go
  through `bashWithoutCores` too, like every program a test runs.
- **Notes in the margin:** at most five specific marks on a design note, with its contradiction and a mark on what
  the code does; tasks with its open question as one; after a stalled question, one question back about it, through
  a real session; one question about a section that left the note, and silence for one that did not.
- **The probe** `pair doctor` and the daemon's health check use, and the Watcher answering it within 3 s.
- **A scripted session** (`test/live/dogfood.test.mjs`): twelve minutes of edits, failing tests, a stall, a question
  and drift, played through a real Pair session on a simulated clock and printed like a transcript. It checks that
  Pair spoke a few times, on the moments that matter.

The Scout and Driver tests work in a scratch project with a local bash in place of the herdr pane; the Driver's
editor is played by buffers in memory, and the files on disk must stay as they were.

**The blank page.** `test/live/blank-page.test.mjs` runs `:Pair new` in an empty folder for C, Odin, Zig, Go and
JavaScript, and a node idea where files "go" somewhere: three questions of at most 18 words, then a slice of two files
with the build file the stack wants, and nothing on disk. For C and Zig, handed the wheel twice, the Driver types the
Makefile and the source into new buffers; once saved, make takes the Makefile and its `run` target builds the
source. Whether the program the model typed then compiles and runs cleanly is reported, not failed: in live runs it
mostly did, and twice it did not (a C file that needed `_POSIX_C_SOURCE` for `clock_gettime`, a Zig arena read after
`deinit`).

**The search trail.** `test/live/trail.test.mjs` plays the captures' Go project with a red test and three searches;
the cue has to name the real cause in the code's own words. The trail alone, without the failing test, is run too,
for the record.

**The context card.** `test/live/context.test.mjs` gives the Partner a board task, buffers and a search: it has to
name the task, know nothing of the search while the editor source is hidden, and name the file the search opened once
it is back.

**The tone.** `test/live/tone.test.mjs` runs a real Pair session on a small C program with a Makefile
([test/live/probe](../test/live/probe/)), built and run for real: a remark on a failed `make run` names `file:line` in
at most 30 words, the idea behind it stays within 45 and its link opens, a question gets at most 80 words, and a green
run after a long red is named, not praised; none of them with praise, apology, filler, emoji, `!`, headings or lists.
Details in [tone.md](tone.md).

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
the model answers as both roles, and a subscription's token renews and is kept. No automatic test makes a
subscription login, since it needs a browser and your account. To check one by hand:

```sh
test/live/check-login.sh PROVIDER MODEL
```

It runs `pair auth login PROVIDER` into a credential file of its own (your logins stay as they are), you sign in in
the browser, and then it runs the login test against it and removes the file. Read the provider's terms first
([models.md](models.md#before-you-use-a-subscription)).

**The Anthropic API.** Run when `ANTHROPIC_API_KEY` and `PAIR_LIVE_ANTHROPIC_MODEL` are set: the cloud model answers
the probe as both roles, scores a repeated failure above the bar, and answers a short question as Partner.

Neither has been run against the real services yet: the Anthropic test has reached the real API, but only with a key
the API refused, and no subscription has been signed in to with `check-login.sh`. The script itself has been run end
to end with an API-key login ([#44](https://github.com/makefunstuff/pairing-buddy/issues/44)).
