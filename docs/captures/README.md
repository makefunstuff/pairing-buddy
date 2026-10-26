# The captures

The clips and stills of the three moments and the ledger (the README, [docs/neovim.md](../neovim.md) and the site) are recorded
from the tapes here. They show the plugin and the daemon of this checkout as they ship. Only the models are scripted, so a
recording comes out the same each time.

- **The daemon** is the real one: `pair daemon`, with a config that points both models at a local stand-in server.
- **The models:** [model.mjs](model.mjs) is a small OpenAI-compatible server. The Watcher's score depends on the
  trigger it is asked about. The Partner's turns (tool calls or words, each after its own pause) come in order
  from [scenes.mjs](scenes.mjs). The tools those calls reach are real: they read the files, check the line and the
  code they point at, and type the edit.
- **herdr:** [herdr.mjs](herdr.mjs) stands in for herdr's socket, because the captures show Neovim alone.
  - Pair's own pane runs its commands for real, with bash in the project: the tests on save, and
    `go test -overlay` on the unsaved buffer.
  - The user's shell is Neovim's `:terminal`, with Pair's shell hook.
- **The project** is [hookd/](hookd/), a small Go webhook service with a retry bug. Each scene starts it at its
  own point. The held thought is in C instead: [ringbuf/](ringbuf/), a ring buffer with a Makefile, and `clangd`
  gives its diagnostics.
- **Neovim** is clean: [init.lua](init.lua), the ayu colorscheme (fetched at a pinned commit), and scratch XDG
  directories. The held thought uses mini.base16 (also fetched at a pinned commit) on a grey palette with one
  warm red, and shows the real chat pane (`pair chat`) in a `:terminal` on the right.

| Tape | Shows |
| --- | --- |
| [wrong-turn](tapes/wrong-turn.tape) | 01 · it stops the wrong turn |
| [tests-on-save](tapes/tests-on-save.tape) | 02 · it runs what you'd skip |
| [hand-over](tapes/hand-over.tape) | 03 · the visible hand-over |
| [take-back](tapes/take-back.tape) | a key while Pair drives takes the wheel back |
| [ledger](tapes/ledger.tape) | `:Pair today` after a morning of 02 and 03; `u` undoes the six cases after your own edit |
| [held-thought](tapes/held-thought.tape) | the held thought, and one look on a grey palette |
| [push-to-talk](tapes/push-to-talk.tape) | hold `Alt-t`, ask aloud, and Pair answers under your line |

## Recording

Needs [VHS](https://github.com/charmbracelet/vhs) 0.11 with ttyd, Neovim 0.11+, Go, clangd, Node.js, curl, FFmpeg
and the JetBrainsMono Nerd Font.

```sh
npm ci                                  # in the repo root
docs/captures/record.sh                 # all six scenes into docs/captures/out/, or name some
docs/captures/encode.sh                 # out/ -> site/media/ and docs/images/
```

The push-to-talk scene is not in the default four: it also needs [whisper.cpp](../voice.md#1-build-whispercpp-cpu-only),
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
