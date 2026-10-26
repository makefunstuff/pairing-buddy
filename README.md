# pairing-buddy

An AI pairing partner that works inside your session instead of beside it.

It watches your editor (Neovim) and terminal (herdr), talks with you, and acts
only through the same tools you use: it never writes files on its own. Edits
land unsaved in your buffer as a single undo step; the disk changes only when
you save.

Roles:

- **Navigator** (default): watches, comments, points at code.
- **Scout**: investigates in its own terminal pane (search, tests, logs).
- **Driver**: makes one change in your buffer when you hand over, then hands back.

Runtime: a long-lived daemon on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable),
with a small local model deciding when a remark is worth making and a larger
local or cloud model doing the reasoning.

Status: **v0.2, Navigator and Scout.** Driver, inline suggestions and voice come later.

## How it works

```
Neovim plugin ──┐                         ┌── Watcher model: is this worth a remark? (0-10)
chat pane ──────┼── pair daemon (socket) ─┤
shell hook ─────┤   events → session state└── Partner model: the words, and its role's tools
herdr panes ────┘   → triggers → speak gate + budget        │
                                                             └── Pair's own herdr pane (Scout: search, run)
```

- **Senses.** The Neovim plugin sends edits (about 2 s after you stop typing), the current file, cursor, selection and LSP diagnostics. The daemon watches your herdr panes for focus, commands and their output. The optional shell hook adds exit codes. Test output is parsed (cargo, go test, jest, vitest, pytest, `node --test`): which tests failed and the first error line.
- **When it speaks.** A remark can come from: a failed command you are not looking at, the same error a second time, an error diagnostic in code you just wrote after you moved on, a stall after a failure, or work that drifts from the session goal. A failed test run counts as failed even without an exit code, the same failing test twice is the same error, and the remark names the failed tests and the first error. A direct question in the chat is always answered.
- **The gate.** For anything unasked, the Watcher scores the moment from 0 to 10. Only scores above the talk level's bar reach the Partner, and the budget limits how often Pair speaks. Pair never speaks while you type in Neovim or the chat pane: a remark that is ready while you type waits for your next pause.
- **Hands.** As Navigator, the Partner has four tools: `say` (chat message), `point` (highlight lines with a short note in Neovim), `open` (show a file in a split, asking first while you type) and `read` (read a file as the editor has it, or list a directory). As Scout it also has `search` (ripgrep) and `run` (one command line), both typed and run in Pair's own herdr pane, where you see everything; their results go back to the model. The lists are enforced in code: each conversation is offered only its role's tools, and a `beforeTool` policy refuses any other name. Nothing in the daemon writes your files or saves buffers, and nothing is ever typed into your own panes.
- **Memory.** Each project gets one long-lived Partner conversation, stored in SQLite by pi-durable, so a restart of the daemon keeps the session, its chat and its context.

## Roles

Pair has one role at a time. It shows in the chat pane's prompt and in Neovim's statusline.

| Role | What Pair does | Switch with |
| --- | --- | --- |
| Navigator (default) | Watches, comments, answers and points at lines | `/navigate` in the chat, `:Pair navigate` |
| Scout | Also searches and runs commands in its own herdr pane: tests, builds, `git log`, `git diff` | `/scout` in the chat, `:Pair scout` |

Switching to Scout opens Pair's pane below the chat pane; switching back closes it. The role is kept with the session, also across a daemon restart.

What Scout may run is decided in code, not by the model ([details](docs/scout.md)):

| Kind of command | Examples | What happens |
| --- | --- | --- |
| Read-only | `ls`, `cat`, `rg`, `grep`, `find`, `git status`, `git log`, `git diff`, `git show` | Runs |
| Tests and builds | `npm test`, `npm run build`, `cargo test`, `go test ./...`, `pytest`, `make test` | Runs |
| Writes, deletes or installs | `rm`, `mv`, `npm install`, `cargo fmt`, `git checkout`, `> file`, and flags that make a read write or run a program (`find -exec`, `fd -x`, `sort -o`, `jest -u`) | Asks you in the chat first (`y` to allow, anything else declines; no answer in a minute declines) |
| Anything not on the lists | `./deploy.sh`, `python script.py`, `bash -c ...`, paths outside the project | Asks you first |
| Git history, network, root, interactive | `git commit`, `git push`, `git reset` (whatever git options come first), `curl`, `ssh`, `sudo`, `less`, `vim` | Refused |

Scout runs commands only when you ask: for a remark nobody asked for, it may read and search but not run. It runs at most four searches or commands per question, one at a time; a command still running after two minutes is stopped with Ctrl-C.

## Requirements

- Node.js 22.19 or newer
- Neovim 0.10 or newer
- [herdr](https://herdr.dev) for the chat pane, terminal watching and Scout's pane (Pair also works without it, with the chat in any terminal, as Navigator only)
- For Scout: `bash` and [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`)
- Two models with an OpenAI-compatible or Anthropic API: any OpenAI-compatible local server (for example llama.cpp or Ollama), or a cloud provider. One model can serve both roles.

## Install

```sh
git clone <this repo> pairing-buddy
cd pairing-buddy
npm install
npm link            # puts `pair` on your PATH
```

## Configure the models

Pair reads one file: `~/.config/pairing-buddy/config.json` (or the path in `$PAIR_CONFIG`). Start from [`config.example.json`](config.example.json).

```json
{
  "level": "normal",
  "models": {
    "watcher": {"api": "openai", "baseUrl": "http://localhost:8080/v1", "model": "your-small-model"},
    "partner": {"api": "anthropic", "model": "your-cloud-model", "apiKeyEnv": "ANTHROPIC_API_KEY"}
  }
}
```

Each model entry:

| Field | Meaning |
| --- | --- |
| `api` | `"openai"` (OpenAI-compatible chat completions) or `"anthropic"` |
| `baseUrl` | The server's base URL, usually ending in `/v1`. Required for `openai`; `anthropic` defaults to the Anthropic API |
| `model` | The model id the server expects |
| `apiKey`, `apiKeyFile`, `apiKeyEnv` | Where the key comes from: inline, a file, or an environment variable. A local server without a key needs none |
| `contextWindow` | Tokens the server serves for this model (default 32768); Pair compacts the conversation before it fills up |
| `maxTokens` | Longest answer (default 200 for the Watcher, 2048 for the Partner) |
| `reasoning` | `true` for a model that thinks by default, so Pair can switch its thinking off (default `false`) |
| `thinking` | The Partner's thinking level when `reasoning` is on: `off` (default), `low`, `medium`, `high` |
| `samplingParams` | Extra sampling fields sent with each request to an OpenAI-compatible server, for example `{"temperature": 0.3}` when the server's default is high |
| `compat` | OpenAI-compatibility flags passed to pi-ai (see its "OpenAI Compatibility Settings"), for example `thinkingFormat` for a model whose chat template has a thinking switch |

Other settings: `level` (`quiet`, `normal` or `chatty`), `typingPauseMs` (how long after a keystroke you count as typing, default 2000), `socket` and `dataDir`.

Tips for local models:

- The Watcher runs on every candidate remark and should answer in about a second: use a small model, keep `reasoning: true` for models that think by default (so thinking gets switched off), and keep `maxTokens` small.
- A server that keeps only one model loaded at a time (llama.cpp's router mode, for example) reloads on every switch between two models. There, give both roles the same model; a mid-sized one answers the Watcher's short prompt in well under a second.
- If the server's default temperature is high, give the Partner `"samplingParams": {"temperature": 0.3}`: its yes-or-no calls (speak or stay SILENT) get much steadier. The Watcher always runs at temperature 0.
- The prompts and tools are deliberately simple (four tools as Navigator, six as Scout, flat arguments, one instruction per message), so mid-sized local models handle them. The command policy and the limit of four commands per question are in code, so a model that loops or asks for too much cannot do harm. Thinking is off by default for both roles; turn it on for the Partner with `thinking` if your model needs it.

## Install the Neovim plugin

With lazy.nvim:

```lua
{
  dir = '/path/to/pairing-buddy',
  config = function()
    require('pair').setup({})
  end,
}
```

Or without a plugin manager: `vim.opt.rtp:append('/path/to/pairing-buddy')` and `require('pair').setup({})` in your config.

Options for `setup`: `socket` (default: the daemon's default socket), `debounce_ms` (2000), `max_points` (highlights kept at once, 5), `auto_connect` (connect at startup, `false`).

Commands:

| Command | What it does |
| --- | --- |
| `:Pair start [goal]` | Connect to the daemon, optionally setting the session goal |
| `:Pair goal <text>` | Set the session goal |
| `:Pair ask <text>` | Ask Pair something (the answer appears in the chat pane) |
| `:Pair level quiet\|normal\|chatty` | How often Pair speaks unasked |
| `:Pair scout` | Switch to Scout: Pair may search and run commands in its own pane |
| `:Pair navigate` | Switch back to Navigator (the default) |
| `:Pair open` | Open the place Pair asked to show while you were typing |
| `:Pair clear` | Remove Pair's highlights |
| `:Pair end` | End the session; Pair writes a short session note in the chat |
| `:Pair stop` | Disconnect this Neovim |

For a statusline, `require('pair').status()` returns the role and talk level while connected, for example `Pair: scout · normal`.

## Start a session in herdr

1. In the herdr pane next to your Neovim, run `pair`. It starts the daemon if it is not running and opens a narrow chat pane on the right.
2. In Neovim, run `:Pair start`.
3. Pair asks for the session goal in the chat; type it (or use `/goal <text>`).
4. Work as usual. Pair stays quiet unless a remark clears the bar.
5. `/end` in the chat (or `:Pair end`) closes the session with a short note.

Chat commands: `/goal <text>`, `/level quiet|normal|chatty`, `/scout`, `/navigate`, `/end`, `/quit` (closes the pane, the session goes on); anything else is a question for Pair. When Scout asks before running a command, your next line is the answer: `y` or `yes` allows it, anything else declines.

Optional, for exit codes and short commands: add the shell hook to your shell's rc file.

```sh
eval "$(pair shell-hook bash)"   # or zsh
```

Without herdr, run `pair chat` in any terminal; Pair then sees your editor and, with the shell hook, your commands' exit codes, but no terminal output.

Other commands: `pair daemon` runs the daemon in the foreground (its log otherwise goes to `daemon.log` in the data directory).

## Talk levels

| Level | Watcher score needed | At most | Minimum gap |
| --- | --- | --- | --- |
| quiet | 8 | 2 per hour | 15 min |
| normal | 6 | 6 per hour | 4 min |
| chatty | 4 | 15 per hour | 90 s |

Answers to your own questions do not count against the budget.

## Data

Everything lives in the data directory (default `~/.local/state/pairing-buddy`): `partner.sqlite` holds the Partner's conversations (pi-durable), `sessions.sqlite` the sessions, goals, chat history and session notes, and `daemon.lock` makes sure one daemon owns them. Nothing leaves your machine except the requests to the model endpoints you configured.

## Tests

```sh
npm test
```

runs the model-free tests: event folding, triggers, the budget and speak gate, the tool policy per role (including with file-writing tools installed by mistake), the command policy, the test-output parsers (on real output of each runner), Pair's pane and role switching against a fake herdr, the daemon end to end with scripted models, the Neovim plugin in a headless Neovim, and the bash hook.

```sh
PAIR_LIVE_CONFIG=/path/to/stacks.json npm run test:live
```

runs the same decisions against real models: Watcher scores for worth-it and noise moments, the speak gate, the Partner's tool calls (pointing at the right line, staying silent on noise, reading before answering, changing nothing when asked to), and Scout (searching to answer "where else", running the tests to say what fails, leaving the commit to you, and the Navigator pointing to `/scout`). The Scout tests run commands in a scratch project with a local bash in place of the herdr pane. The file lists one or more stacks, each with a `watcher` and a `partner` entry like those in the config:

```json
{"stacks": [{"name": "local", "watcher": {"api": "openai", "baseUrl": "http://localhost:8080/v1", "model": "your-small-model"}, "partner": {"api": "openai", "baseUrl": "http://localhost:8080/v1", "model": "your-larger-model"}}]}
```

Without `PAIR_LIVE_CONFIG` (or a gitignored `test/live/config.json`) the live tests are skipped.

## Known limits of v0.2

- herdr exposes no command boundaries or exit codes; see [docs/herdr.md](docs/herdr.md) for what Pair does instead and what herdr would need.
- Scout's pane runs `bash` without your rc files (a custom prompt would hide the exit code), so your aliases and shell functions are not there. It reads back at most the last 1000 lines of a command's output.
- Scout's pane is not a sandbox: the command policy decides what runs, and an allowed test or build can still write what tests and builds write.
- A Partner answer that is running when the daemon stops is finished by pi-durable on restart, but is not shown in the chat.
- One session per project (git root); Pair works with one Neovim per session.
- Typing in a shell pane does not count as typing: herdr does not report keystrokes.
- Test output is parsed from what the pane shows: a user's command's output is read from the last 400 lines of its pane.
