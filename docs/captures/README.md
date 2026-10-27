# The captures

The clips and stills of the three moments and the ledger ([docs/neovim.md](../neovim.md) and the site) are recorded
from the tapes here. They show the plugin and the daemon of this checkout as they ship. Only the models are scripted, so a
recording comes out the same each time.

- **The daemon** is the real one: `pair daemon`, with a config that points both models at a local stand-in server.
- **The models:** [model.mjs](model.mjs) is a small OpenAI-compatible server. The Watcher's score depends on the
  trigger it is asked about. The Partner's turns (tool calls or words, each after its own pause) come in order
  from [scenes.mjs](scenes.mjs), and so do its readings of a note: the marks, and the tasks. The tools those calls reach are real: they read the files, check the line and the
  code they point at, and type the edit.
- **The board:** [board.mjs](board.mjs) stands in for herdr's work board in the context-card scene, which also
  fetches Telescope and plenary at pinned commits for its searches.
- **The day so far:** the pick-up scene starts from yesterday's session (its debrief and where to pick up), and the
  debrief scene from three hours of active time and five verdicts, which [stage.mjs](stage.mjs) writes into the
  daemon's scratch store; the daemon's clock shows the scene's hour.
- **herdr:** [herdr.mjs](herdr.mjs) stands in for herdr's socket, because the captures show Neovim alone.
  - Pair's own pane runs its commands for real, with bash in the project: the tests on save, and
    `go test -overlay` on the unsaved buffer.
  - The user's shell is Neovim's `:terminal`, with Pair's shell hook.
- **The project** is [hookd/](hookd/), a small Go webhook service with a retry bug. Each scene starts it at its
  own point. The held thought is in C instead: [ringbuf/](ringbuf/), a ring buffer with a Makefile, and `clangd`
  gives its diagnostics; so is the crash scene: [probe/](probe/), a small C hash table built and run with `make run`
  and AddressSanitizer. Delight is in C too: [intern/](intern/), a string-interning table and its benchmark; and the
  agents scene: [hashtab/](hashtab/), another C hash table, timed with `make`. Teach on request is in the C
  program the live tone tests use ([test/live/probe](../../test/live/probe/)), whose `make run` fails its check with exit 1. The notes scene adds its
  design note, [notes/dead-letters.md](notes/dead-letters.md), which the tests read too. The exploration loop:
  [loop/](loop/), the research's entity table, built and run with `make -s run` in the `:terminal` on the right. The hand-over without a
  test uses it too: Pair's own pane builds and runs the unsaved buffer there, in a scratch copy, after a question in
  the chat that the stage answers yes (`allow` in the scene). The blank page's scenes start in an empty folder,
  `ticks`, with no git yet.
- **The blank page's words** are not written for the capture: [ticks.json](ticks.json) holds a real `:Pair new`
  with a cloud model, unedited. It has the three questions (each asked after the answer before it), the slice and the
  two files the Driver typed. Its first slice broke the 90-character rule, so the daemon asked again; the slice
  here is the second answer, the one the note showed.
- **No core dumps.** The crash scene crashes a program on purpose. `record.sh` sets the core limit to 1 byte for
  everything it starts, so nothing reaches the machine's crash reporter (see [test/no-core.mjs](../../test/no-core.mjs)).
- **Your other agents** (the agents scene only): a stand-in board, a script that prints the board's list, with its
  task files in the scratch directory, and the herdr stand-in's `agent.list`. They move on once you start typing.
  The other scenes read no board.
- **Neovim** is clean: [init.lua](init.lua), the ayu colorscheme (fetched at a pinned commit), and scratch XDG
  directories. The search-trail scene also fetches Telescope and plenary at pinned commits; Telescope's history goes
  to the scratch directories too.
  directories. The held thought uses mini.base16 (also fetched at a pinned commit) on a grey palette with one
  warm red, and shows the real chat pane (`pair chat`) in a `:terminal` on the right.

| Tape | Shows |
| --- | --- |
| [wrong-turn](tapes/wrong-turn.tape) | 01 · it stops the wrong turn |
| [tests-on-save](tapes/tests-on-save.tape) | 02 · it runs what you'd skip |
| [hand-over](tapes/hand-over.tape) | 03 · the visible hand-over |
| [take-back](tapes/take-back.tape) | a key while Pair drives takes the wheel back |
| [blank-page](tapes/blank-page.tape) | 04 · the blank page: `:Pair new`, three questions, the first slice |
| [first-run](tapes/first-run.tape) | 05 · the first run: the Driver types the slice's two files, and `make run` runs them |
| [ledger](tapes/ledger.tape) | `:Pair today` after a morning of 02 and 03; `u` undoes the six cases after your own edit |
| [search-trail](tapes/search-trail.tape) | the search trail: three Telescope searches, the cue, `:Pair trail` |
| [held-thought](tapes/held-thought.tape) | the held thought, and one look on a grey palette |
| [delight](tapes/delight.tape) | a number finally moves: the statusline lights up and one line says what moved |
| [push-to-talk](tapes/push-to-talk.tape) | hold `Alt-t`, ask aloud, and Pair answers under your line |
| [context-card](tapes/context-card.tape) | `:Pair context`, with the goal from the board task, and `x` on a source |
| [pickup](tapes/pickup.tape) | the morning pick-up: an empty Neovim lands where yesterday's debrief said, one line, `Alt-j` to the failing test |
| [debrief](tapes/debrief.tape) | the day's end: the lease fix goes green, `/end` in the chat pane, and `e` on tomorrow's first step |
| [crash](tapes/crash.tape) | a compiler error, a crash and its frame, and a new warning, from `make run` on save |
| [loop](tapes/loop.tape) | the exploration loop: four runs of `make` in your terminal, the same numbers and why, `:Pair runs` |
| [hand-over-run](tapes/hand-over-run.tape) | the hand-over without a test: an intent and a number to reach; the unsaved buffer built and run with your `make -s run`; `✓ avg probe 1.1` |
| [agents](tapes/agents.tape) | your other agents' news, one line at your next breakpoint, and `:Pair agents` |
| [notes](tapes/notes.tape) | notes in the margin: the marks, a fixed line, a decision logged, the tasks panel |
| [teach](tapes/teach.tape) | Alt-? on a remark: the idea worth keeping behind it, and its link |

## Recording

Needs [VHS](https://github.com/charmbracelet/vhs) 0.11 with ttyd, Neovim 0.11+, Go, clangd, a C compiler with
AddressSanitizer, make, Node.js, curl, FFmpeg, util-linux's `prlimit` and the JetBrainsMono Nerd Font.

```sh
npm ci                                  # in the repo root
docs/captures/record.sh                 # all the scenes into docs/captures/out/, or name some
docs/captures/encode.sh                 # out/ -> site/media/ and docs/images/
```

The push-to-talk scene is not among the default scenes: it also needs [whisper.cpp](../voice.md#1-build-whispercpp-cpu-only),
espeak-ng and FFmpeg. espeak-ng says the scene's question into the recorder, and whisper.cpp hears it for real:

```sh
CAP_WHISPER_MODEL=/path/to/ggml-base.en.bin CAP_WHISPER=/path/to/whisper-cli docs/captures/record.sh push-to-talk
```

Each scene runs in its own scratch directory under `/tmp/paircap.*`, which holds:

- the project;
- the daemon's socket, config, data and log (`daemon.log`);
- the stage's log (`stage.log`, which has each model request and the chat);
- Neovim's state.

Your own daemon, config, Neovim and shell history are not used. Before committing new captures, check every frame
for personal details, for example with `tesseract` on frames that `ffmpeg -vf fps=4` extracts.
