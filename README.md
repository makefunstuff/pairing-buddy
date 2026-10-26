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

Status: **v0.4, Navigator, Scout and Driver, with inline suggestions; installed once, then always running.** Memory across sessions and voice come later.

## How it works

```
Neovim plugin ──┐                         ┌── Watcher model: is this worth a remark? (0-10)
chat pane ──────┼── pair daemon (socket) ─┤
shell hook ─────┤   events → session state└── Partner model: the words, and its role's tools
herdr panes ────┘   → triggers → speak gate + budget        │
                                                             ├── Pair's own herdr pane (Scout: search, run)
                                                             └── your buffer and terminal (Driver: edit, type)
```

- **Senses.** The Neovim plugin sends edits (about 2 s after you stop typing), the current file, cursor, selection and LSP diagnostics. The daemon watches your herdr panes for focus, commands and their output. The optional shell hook adds exit codes. Test output is parsed (cargo, go test, jest, vitest, pytest, `node --test`): which tests failed and the first error line.
- **When it speaks.** A remark can come from: a failed command you are not looking at, the same error a second time, an error diagnostic in code you just wrote after you moved on, a stall after a failure, or work that drifts from the session goal. A failed test run counts as failed even without an exit code, the same failing test twice is the same error, and the remark names the failed tests and the first error. A direct question in the chat is always answered.
- **The gate.** For anything unasked, the Watcher scores the moment from 0 to 10. Only scores above the talk level's bar reach the Partner, and the budget limits how often Pair speaks. Pair never speaks while you type in Neovim or the chat pane: a remark that is ready while you type waits for your next pause.
- **Hands.** As Navigator, the Partner has five tools: `say` (chat message), `point` (highlight lines with a short note in Neovim), `open` (show a file in a split, asking first while you type), `read` (read a file as the editor has it, or list a directory) and `suggest` (show a change as an inline diff that you accept with one key or ignore). As Scout it also has `search` (ripgrep) and `run` (one command line), both typed and run in Pair's own herdr pane, where you see everything; their results go back to the model. As Driver, which Pair is only while you hand it the wheel, it also has `edit` (one change in your buffer, one undo step) and `type` (one line into your terminal, after your yes, without Enter). The lists are enforced in code: each conversation is offered only its role's tools, and a `beforeTool` policy refuses any other name. Nothing in the daemon writes your files or saves buffers, and nothing is typed into your own panes except the Driver's `type`.
- **Memory.** Each project gets one long-lived Partner conversation, stored in SQLite by pi-durable, so a restart of the daemon keeps the session, its chat and its context.

## Roles

Pair has one role at a time. It shows in the chat pane's prompt and in Neovim's statusline.

| Role | What Pair does | Switch with |
| --- | --- | --- |
| Navigator (default) | Watches, comments, answers and points at lines | `/navigate` in the chat, `:Pair navigate` |
| Scout | Also searches and runs commands in its own herdr pane: tests, builds, `git log`, `git diff` | `/scout` in the chat, `:Pair scout` |
| Driver | Makes one change in your buffer while you watch, then hands back by itself | You hand over: `:Pair drive`, `/drive`, or say "you take it" or "your turn" in the chat |

Switching to Scout opens Pair's pane below the chat pane; switching back closes it. The role is kept with the session, also across a daemon restart; the Driver role is not, since it lasts one answer.

In every role Pair can **suggest** a change: the old lines are marked in your buffer and the new ones appear below them as ghost text, with a note. `Alt-y` (`<M-y>`, or `:Pair accept`) applies it as your own change; editing those lines yourself, `:Pair dismiss`, or the next suggestion drops it. Nothing changes until you accept.

**Driving** ([details](docs/driver.md)): hand over with `:Pair drive [what to do]` in Neovim, `/drive [what to do]` in the chat, or a chat line that is "you take it" or "your turn", alone or followed by punctuation and a request (`you take it: set the timeout to 30 s`; "your turn to explain ..." stays a question). Pair becomes the Driver for that one answer:

- It reads the code and makes one `edit`: the lines change in your buffer as one undo step, so `u` takes it back. The buffer is not saved; the disk changes when you `:w`.
- It gets one edit per hand-over, says what it changed, and then is Navigator again by itself, also when it answered without an edit. You save and run the tests.
- Any key you press in Neovim while Pair has the wheel takes it back at once: an edit still on its way is refused. Scrolling or clicking to watch it does not.
- It may `type` one command line into your terminal pane (the one you last used), after you allow it in the chat. It never presses Enter, and never types what Scout's policy refuses (`git commit`, `git push`, ...).
- Ping-pong TDD: write a failing test, say "your turn", and Pair changes the code (not the test) to make it pass, then hands back. Run the tests, write the next one.

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

Once, in two parts: the daemon as an npm package, and the Neovim plugin with lazy.nvim. Both come from this GitHub repo.

```sh
npm install -g github:makefunstuff/pairing-buddy   # puts `pair` on your PATH
pair setup
```

`pair setup`:

1. Writes a commented config to `~/.config/pairing-buddy/config.json` if there is none yet. Set your models there (see below).
2. Installs the daemon as a systemd user service, `pairing-buddy.service`: it starts at login and restarts when it fails.
3. Starts it, and prints the next steps.

Run it again after upgrading Node.js or pairing-buddy (`npm install -g github:makefunstuff/pairing-buddy` again): the unit names the Node.js binary it runs, and setup rewrites it and restarts the daemon. `pair uninstall` stops and removes the service and keeps the config and data.

Then add the plugin to your lazy.nvim specs:

```lua
{
  'makefunstuff/pairing-buddy',
  main = 'pair',
  lazy = false,
  opts = {auto_connect = true},
}
```

With `auto_connect`, every Neovim connects to the daemon at startup, so there is nothing to start by hand: open Neovim, run `pair` in a herdr pane next to it, and pair. Finally, check everything with `pair doctor` ([below](#check-it-pair-doctor)).

From a clone instead of the package: `npm ci && npm link` in it, then `pair setup` (the service then runs the clone's code), and `dir = '/path/to/clone'` in place of the GitHub name in the lazy.nvim spec.

Without systemd, skip `pair setup`: `pair` then starts the daemon in the background when it is not running, and `pair daemon` runs it in the foreground.

## Configure the models

Pair reads one file: `~/.config/pairing-buddy/config.json` (or the path in `$PAIR_CONFIG`; `$XDG_CONFIG_HOME` is respected). It is JSON with `//` and `/* */` comments. The first run of `pair setup`, `pair` or `pair daemon` writes it from [`config.example.json`](config.example.json), which explains each field. After a change, restart the daemon (`systemctl --user restart pairing-buddy`) and run `pair doctor`.

```jsonc
{
  "level": "normal",
  "models": {
    // The Watcher scores every candidate remark: small and fast
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
| `apiKey`, `apiKeyFile`, `apiKeyEnv` | Where the key comes from: inline, a file, or an environment variable. A local server without a key needs none. The service does not see your shell's variables: with `apiKeyEnv`, add it with `systemctl --user edit pairing-buddy` (`[Service]` and `Environment=NAME=value`), or use `apiKeyFile` |
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
- The prompts and tools are deliberately simple (five tools as Navigator, seven as Scout, nine as Driver, flat arguments, one instruction per message), so mid-sized local models handle them. The command policy, the limit of four commands per question and the one edit per hand-over are in code, so a model that loops or asks for too much cannot do harm. Thinking is off by default for both roles; turn it on for the Partner with `thinking` if your model needs it.

## The Neovim plugin

The lazy.nvim spec is in [Install](#install). Without a plugin manager: `vim.opt.rtp:append('/path/to/pairing-buddy')` and `require('pair').setup({auto_connect = true})` in your config.

Options for `setup`: `socket` (default: the daemon's default socket), `debounce_ms` (2000), `max_points` (highlights kept at once, 5), `accept_key` (accepts a suggestion; mapped in Normal mode, only in the buffer and only while a suggestion shows; default `'<M-y>'`, `false` for none; avoid `<Tab>`, which terminals send for Ctrl-I, the jumplist's forward jump), `auto_connect` (connect at startup, `false`; the spec above sets it).

Once connected, the plugin stays connected: when the daemon restarts (an upgrade, `systemctl --user restart`, a crash), it reconnects by itself, after 1, 2, 5, 10 and then every 30 seconds, and sends the current file again. `:Pair stop` disconnects for good.

Commands:

| Command | What it does |
| --- | --- |
| `:Pair start [goal]` | Connect to the daemon (not needed with `auto_connect`), optionally setting the session goal |
| `:Pair goal <text>` | Set the session goal |
| `:Pair ask <text>` | Ask Pair something (the answer appears in the chat pane) |
| `:Pair level quiet\|normal\|chatty` | How often Pair speaks unasked |
| `:Pair scout` | Switch to Scout: Pair may search and run commands in its own pane |
| `:Pair navigate` | Switch back to Navigator (the default) |
| `:Pair drive [what]` | Hand Pair the wheel for one change; any key takes it back |
| `:Pair accept` | Accept Pair's suggestion (same as the accept key) |
| `:Pair dismiss` | Drop Pair's suggestion |
| `:Pair open` | Open the place Pair asked to show while you were typing |
| `:Pair clear` | Remove Pair's highlights |
| `:Pair end` | End the session; Pair writes a short session note in the chat |
| `:Pair stop` | Disconnect this Neovim, and stop reconnecting |

For a statusline, `require('pair').status()` returns the role and talk level while connected, for example `Pair: scout · normal`, or `Pair: driver · normal` while Pair has the wheel. It adds a warning while a model is down (`Pair: navigator · normal · partner down`, or `· models down`), says `Pair: reconnecting` while the daemon is away, and is empty when the plugin is not connected.

Highlight groups, all linked by default: `PairPoint` (`Visual`), `PairNote` (`DiagnosticVirtualTextInfo`), `PairSuggestDelete` (`DiffDelete`, the lines a suggestion replaces) and `PairSuggestAdd` (`DiffAdd`, its new lines).

## Start a session in herdr

1. In the herdr pane next to your Neovim, run `pair`. It opens a narrow chat pane on the right (and starts the daemon if it is not running).
2. Neovim is connected already with `auto_connect`; otherwise run `:Pair start` there.
3. Pair asks for the session goal in the chat; type it (or use `/goal <text>`).
4. Work as usual. Pair stays quiet unless a remark clears the bar.
5. `/end` in the chat (or `:Pair end`) closes the session with a short note.

Chat commands: `/goal <text>`, `/level quiet|normal|chatty`, `/scout`, `/navigate`, `/drive [what]`, `/end`, `/quit` (closes the pane, the session goes on). A line that starts with "you take it" or "your turn" hands Pair the wheel too; anything else is a question for Pair. When Pair asks before running or typing a command, your next line is the answer: `y` or `yes` allows it, anything else declines.

Optional, for exit codes and short commands: add the shell hook to your shell's rc file.

```sh
eval "$(pair shell-hook bash)"   # or zsh
```

Without herdr, run `pair chat` in any terminal; Pair then sees your editor and, with the shell hook, your commands' exit codes, but no terminal output.

Several projects at once work: each project (git root) has its own session, chat pane and goal, and the daemon serves them all. Several Neovims in one project share its session; Pair shows points, suggestions and edits in the Neovim you used last, and reads a file from whichever Neovim has it loaded.

If the daemon restarts, the chat pane says so, waits for it and carries on, without printing the history again.

Other commands: `pair daemon` runs the daemon in the foreground. Its log goes to the journal under the service (`journalctl --user -u pairing-buddy`), and to `daemon.log` in the data directory when `pair` started it.

## Check it: `pair doctor`

`pair doctor` checks every part and says what is wrong in plain words, one line each, with the fix:

```
✓ config   ~/.config/pairing-buddy/config.json
✓ service  starts at login, running
✓ daemon   version 0.4.0, up 42 min, 2 sessions
✓ plugin   your Neovim config loads it
✓ neovim   2 connected, in shop, blog
✓ herdr    answers in 3 ms, 4 panes in this workspace
! watcher  your-small-model at http://localhost:8080/v1 answers, but takes 2.4 s: the Watcher scores every candidate remark and should take about 1 s. ...
✓ partner  your-larger-model at http://localhost:8081/v1 answers in 1.1 s
```

| Check | What it looks at |
| --- | --- |
| config | The file parses, and its models are not still the example's |
| service | The unit is installed, enabled, running, and its Node.js still exists |
| daemon | It answers on its socket, with the same version as `pair` |
| plugin | Neovim, started headless with your config, loads the plugin |
| neovim | How many Neovims are connected, in which projects |
| herdr | herdr answers on its socket (only checked when run inside herdr) |
| watcher, partner | The server answers and lists the model, one short completion works, and how long it took (about 1 s is the aim for the Watcher). One line, `models`, when both use the same model |

It exits with 1 when a check fails, so scripts can use it too.

## When a model is down

A model endpoint that stops answering does not turn into a stream of errors:

- The first failed call marks the model down: one line in the daemon's log, one note in the chat, and the statusline warning in Neovim.
- While a model is down, Pair makes no remarks (it does not even ask the Watcher). A question you type is still sent, in case the model is back, and gets one short error if not.
- A tiny request every 30 seconds notices when the model answers again; the warning goes away and the chat says so.
- The daemon also checks both models when it starts, so a dead endpoint shows at once.
- A Partner request that gets no answer for 90 seconds fails, and is retried twice.

## Talk levels

| Level | Watcher score needed | At most | Minimum gap |
| --- | --- | --- | --- |
| quiet | 8 | 2 per hour | 15 min |
| normal | 6 | 6 per hour | 4 min |
| chatty | 4 | 15 per hour | 90 s |

Answers to your own questions do not count against the budget.

## Data

Everything lives in the data directory (default `~/.local/state/pairing-buddy`, or under `$XDG_STATE_HOME`): `partner.sqlite` holds the Partner's conversations (pi-durable), `sessions.sqlite` the sessions, goals, chat history and session notes, and `daemon.lock` makes sure one daemon owns them. Nothing leaves your machine except the requests to the model endpoints you configured.

## Tests

```sh
npm test
```

runs the model-free tests: event folding, triggers, the budget and speak gate, the tool policy per role (including with file-writing tools installed by mistake, and an edit after the wheel was taken back), the command policy, the test-output parsers (on real output of each runner), Pair's pane and role switching against a fake herdr, hand-over and take-back, `type` (only after a yes, only into your terminal pane, never Enter), the daemon end to end with scripted models, the Neovim plugin in a headless Neovim (suggestions accepted and ignored, a Driver edit undone with one `u` and never saved, a key taking the wheel back), and the bash hook. Also the install and daily use: the config with comments and the first run's example, the systemd unit, `pair doctor` against a fake model server (fast, slow, dead, a wrong model name), model health (one notice, no remarks while down, back after a probe), several projects and Neovims at once, and Neovim and the chat pane reconnecting after a daemon restart.

```sh
PAIR_LIVE_CONFIG=/path/to/stacks.json npm run test:live
```

runs the same decisions against real models: Watcher scores for worth-it and noise moments, the speak gate, the Partner's tool calls (pointing at the right line, staying silent on noise, reading before answering, changing nothing when asked to), Scout (searching to answer "where else", running the tests to say what fails, leaving the commit to you, and the Navigator pointing to `/scout`), and the Driver (making a failing test pass after "your turn" without touching the test, making exactly the change asked for, typing the test command without Enter, and the Navigator suggesting instead of editing). It also sends the probe `pair doctor` and the daemon's health check use, and checks that the Watcher answers it within 3 s. The Scout and Driver tests work in a scratch project with a local bash in place of the herdr pane; the Driver's editor is played by buffers in memory, and the files on disk must stay as they were. The file lists one or more stacks, each with a `watcher` and a `partner` entry like those in the config:

```json
{"stacks": [{"name": "local", "watcher": {"api": "openai", "baseUrl": "http://localhost:8080/v1", "model": "your-small-model"}, "partner": {"api": "openai", "baseUrl": "http://localhost:8080/v1", "model": "your-larger-model"}}]}
```

Without `PAIR_LIVE_CONFIG` (or a gitignored `test/live/config.json`) the live tests are skipped.

## Known limits of v0.4

- herdr exposes no command boundaries or exit codes; see [docs/herdr.md](docs/herdr.md) for what Pair does instead and what herdr would need.
- Scout's pane runs `bash` without your rc files (a custom prompt would hide the exit code), so your aliases and shell functions are not there. It reads back at most the last 1000 lines of a command's output.
- Scout's pane is not a sandbox: the command policy decides what runs, and an allowed test or build can still write what tests and builds write.
- A Partner answer that is running when the daemon stops is finished by pi-durable on restart, but is not shown in the chat.
- One session per project (git root). With several Neovims in one project, "the one you used last" is the one that last sent an edit, a cursor move or a file change.
- The service is a systemd user unit; without systemd, `pair` starts the daemon in the background, and nothing restarts it.
- The config is read at start: after changing it, restart the daemon.
- Typing in a shell pane does not count as typing: herdr does not report keystrokes. For the same reason, only a key in Neovim takes the wheel back from the Driver; typing in the chat or a shell pane does not.
- The Driver makes one edit per hand-over, in whole lines. After its answer, Pair is Navigator again, also when you handed over in Scout (Pair's pane then closes).
- One suggestion shows at a time; a new one replaces it.
- `type` needs herdr and goes to the terminal pane you last looked at or ran a command in.
- Pair's pane runs commands against the files on disk, not your unsaved buffer, so the Driver does not run the tests after its edit: you save and run them.
- Test output is parsed from what the pane shows: a user's command's output is read from the last 400 lines of its pane.
