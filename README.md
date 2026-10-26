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

Status: **v0.1, Navigator only.** Scout, Driver, inline suggestions and voice come later.

## How it works

```
Neovim plugin ──┐                         ┌── Watcher model: is this worth a remark? (0-10)
chat pane ──────┼── pair daemon (socket) ─┤
shell hook ─────┤   events → session state└── Partner model: the words, and say/point/open/read
herdr panes ────┘   → triggers → speak gate + budget
```

- **Senses.** The Neovim plugin sends edits (about 2 s after you stop typing), the current file, cursor, selection and LSP diagnostics. The daemon watches your herdr panes for focus, commands and their output. The optional shell hook adds exit codes.
- **When it speaks.** A remark can come from: a failed command you are not looking at, the same error a second time, an error diagnostic in code you just wrote after you moved on, a stall after a failure, or work that drifts from the session goal. A direct question in the chat is always answered.
- **The gate.** For anything unasked, the Watcher scores the moment from 0 to 10. Only scores above the talk level's bar reach the Partner, the budget limits how often Pair speaks, and Pair never speaks while you type.
- **Hands.** The Partner has exactly four tools: `say` (chat message), `point` (highlight lines with a short note in Neovim), `open` (show a file in a split, asking first while you type) and `read` (read a file as the editor has it, or list a directory). That list is enforced in code: only these tools are registered, and a `beforeTool` policy refuses any other name. Nothing in the daemon writes your files, runs commands for the model or saves buffers.
- **Memory.** Each project gets one long-lived Partner conversation, stored in SQLite by pi-durable, so a restart of the daemon keeps the session, its chat and its context.

## Requirements

- Node.js 22.19 or newer
- Neovim 0.10 or newer
- [herdr](https://herdr.dev) for the chat pane and terminal watching (Pair also works without it, with the chat in any terminal)
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
| `compat` | OpenAI-compatibility flags passed to pi-ai (see its "OpenAI Compatibility Settings"), for example `thinkingFormat` for a model whose chat template has a thinking switch |

Other settings: `level` (`quiet`, `normal` or `chatty`), `typingPauseMs` (how long after a keystroke you count as typing, default 2000), `socket` and `dataDir`.

Tips for local models:

- The Watcher runs on every candidate remark and should answer in about a second: use a small model, keep `reasoning: true` for models that think by default (so thinking gets switched off), and keep `maxTokens` small.
- The prompts and tools are deliberately simple (four tools, flat arguments, one instruction per message), so mid-sized local models handle them. Thinking is off by default for both roles; turn it on for the Partner with `thinking` if your model needs it.

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
| `:Pair open` | Open the place Pair asked to show while you were typing |
| `:Pair clear` | Remove Pair's highlights |
| `:Pair end` | End the session; Pair writes a short session note in the chat |
| `:Pair stop` | Disconnect this Neovim |

For a statusline, `require('pair').status()` returns `Pair: navigator · normal` while connected.

## Start a session in herdr

1. In the herdr pane next to your Neovim, run `pair`. It starts the daemon if it is not running and opens a narrow chat pane on the right.
2. In Neovim, run `:Pair start`.
3. Pair asks for the session goal in the chat; type it (or use `/goal <text>`).
4. Work as usual. Pair stays quiet unless a remark clears the bar.
5. `/end` in the chat (or `:Pair end`) closes the session with a short note.

Chat commands: `/goal <text>`, `/level quiet|normal|chatty`, `/end`, `/quit` (closes the pane, the session goes on); anything else is a question for Pair.

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

runs the model-free tests: event folding, triggers, the budget and speak gate, the tool policy (including with file-writing tools installed by mistake), the daemon end to end with scripted models, the Neovim plugin in a headless Neovim, and the bash hook.

```sh
PAIR_LIVE_CONFIG=/path/to/stacks.json npm run test:live
```

runs the same decisions against real models: Watcher scores for worth-it and noise moments, the speak gate, and the Partner's tool calls (pointing at the right line, staying silent on noise, reading before answering, changing nothing when asked to). The file lists one or more stacks, each with a `watcher` and a `partner` entry like those in the config:

```json
{"stacks": [{"name": "local", "watcher": {"api": "openai", "baseUrl": "http://localhost:8080/v1", "model": "your-small-model"}, "partner": {"api": "openai", "baseUrl": "http://localhost:8080/v1", "model": "your-larger-model"}}]}
```

Without `PAIR_LIVE_CONFIG` (or a gitignored `test/live/config.json`) the live tests are skipped.

## Known limits of v0.1

- herdr exposes no command boundaries or exit codes; see [docs/herdr.md](docs/herdr.md) for what Pair does instead and what herdr would need.
- A Partner answer that is running when the daemon stops is finished by pi-durable on restart, but is not shown in the chat.
- One session per project (git root); Pair works with one Neovim per session.
