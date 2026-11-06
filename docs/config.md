# Configuration reference

Every setting Pair reads, with its default. Which model to pick and how to log in is in
[Models and providers](models.md).

## The file

Pair reads one file: `~/.config/pairing-buddy/config.json` (or the path in `$PAIR_CONFIG`; `$XDG_CONFIG_HOME` is
respected). It is JSON with `//` and `/* */` comments. The first run of `pair setup`, `pair`, `pair chat` or `pair daemon` writes it
from [`config.example.json`](../config.example.json), which explains each field.

The daemon takes a change as you save the file (also through a symlink), without a restart, and says in the chat pane
and Neovim what it reloaded. It checks the new config as at start: one with an error is not taken, and the chat says
why while the daemon keeps the config it runs. Run `pair doctor` after a change to check the models.

- **At once**: the typing pause, `autoTune`, `plan`, `keepWarm`, `watcherPace`, the `decision` model, `rerank`, `testOnSave`,
  `voice`, `taskCommand`, `gen` and `board`, in open sessions too (a `/gen` request already running keeps the limits it
  started with).
- **Between turns**: new `model` or `models` entries (and their thinking levels). An answer under way finishes on
  the old model; the next one is the new model's, in the same conversation.
- **For new sessions**: `level` and `sessionRoots`. An open session keeps its own level; `/level` changes it.
- **After a restart only**: `socket`, `dataDir`, `meaning`, `embedding`, `herdrPanel`, and turning `agents` on or off.
- **Unsaid**: `scoutPane` is not named in the chat; a change of it alone waits for a restart, but saved with another
  change it is taken at once, for Pair's panes opened from then on and `/gen`'s sandbox in open sessions.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `model` | (one of the two is needed) | One [model entry](#model-entries) for both roles |
| `models` | | `{"watcher": ..., "partner": ...}`, a model entry for each role; `"watcher": "same as partner"` is the same as one `model`. Set `model` or `models`, not both |
| `level` | `"normal"` | How often Pair speaks unasked: `quiet`, `normal` or `chatty` ([talk levels](#talk-levels)) |
| `autoTune` | `true` | Your feedback tunes the bars and budget ([memory.md](memory.md#learning-when-to-talk)) |
| `plan` | `true` | Pair proposes the goal's steps and says what is done and next ([the thread](memory.md#the-thread-done-and-next)); `false` proposes none, and `/plan` still sets your own |
| `keepWarm` | `true` for a Watcher with `"api": "openai"`, else `false` | While you work, ask the Watcher's model for one token every 4 minutes, so a server that unloads idle models keeps it loaded ([watcher.md](watcher.md#keep-warm)) |
| `watcherPace` | `true` | While the Watcher's calls take 1.5 s or more (the median of its last calls), ask about fewer kinds of moment: the ones you can see for yourself go first and, with `autoTune` on, those whose remarks you dismiss before those you keep. Every kind comes back once calls take 1 s or less. `false` asks about every kind however slow the server is ([watcher.md](watcher.md#when-the-server-is-slow)) |
| `decision` | none | A decision (classifier) model the speak gate asks whether a remark is worth it, with probabilities: TypeSafe's Jev, Cloudflare's Clef, OpenAI's Decisions API, or a gateway of your own. Without it the Watcher's score and the bar decide ([decision.md](decision.md#configure)) |
| `typingPauseMs` | `2000` | How long after a keystroke you count as typing |
| `testOnSave` | none | A test command per project folder, run when you save ([below](#testonsave), [tests-on-save.md](tests-on-save.md)) |
| `sessionRoots` | `[]` | Folders that are projects of their own, for a monorepo ([session roots](#session-roots)) |
| `agents` | `true` | The relay of your other agents' news, from herdr and the `board`: `false` turns it off ([agents.md](agents.md#configure)) |
| `herdrPanel` | `"auto"` | The daemon's loopback port for [Pair's panel in the Herdr window](herdr.md#pairs-panel-in-the-herdr-window): `"auto"` opens it where the Herdr window is installed, `true` always, `false` never (`pair` then opens the chat in a terminal there, as before) |
| `voice` | off | Push-to-talk and spoken answers with LFM3-Omni, whisper.cpp or OpenRouter ([below](#voice), [voice.md](voice.md)) |
| `meaning` | `{}` | [Search by meaning](meaning.md): the Python that runs EmbeddingGemma 2, the cores it may use and where the index lives, or `false` to turn it off for good ([below](#meaning)). Its word search works at once; meaning once its model and runtime are fetched (`:Pair find on`) or with an `embedding` model |
| `embedding` | none | An embedding model behind an OpenAI-compatible `/v1/embeddings` for [search by meaning](meaning.md#another-embedding-model), instead of EmbeddingGemma 2 ([below](#embedding)) |
| `rerank` | none | A decision model, or a cross-encoder (`"api": "rerank"`), that reorders the first pieces of a settled search by meaning ([below](#rerank)); off without it |
| `scoutPane` | see [below](#scoutpane) | Pair's own pane: your rc file and the sandbox ([scout.md](scout.md#pairs-pane)) |
| `taskCommand` | none | What `:Pair tasks` runs for each task you say yes to, as a list of words with `{title}` and `{description}`, never through a shell, for example `["gh", "issue", "create", "--title", "{title}", "--body", "{description}"]`. Without it, the tasks are copied as a checklist ([notes.md](notes.md#tasks-only-when-you-ask)) |
| `gen` | see [below](#gen) | What one `/gen` request may do at most, its brief's note, and how long a try's folder stays and whether its runs reach the network ([gen.md](gen.md)) |
| `board` | `"shepherdr"` | The work board's command, [Shepherdr](agents.md#where-it-reads)'s: the goal and the [context card](neovim.md#what-it-knows-the-context-card) read the board task of your branch, the [relay](agents.md) its tasks, the chat's header counts the repository's tasks, [`/gen board`](gen.md#gen-board-a-task-for-the-board) adds one on your pick, [`:Pair review`](gen.md#reviewing-a-board-task-pair-review) reads a task's facts and, on your pick, tells it something or archives it, the repository's [tasks at work](agents.md#tasks-working-on-your-files) are read every 30 s for what their branches change (the winbar note and the overlap remark), and [`/brief sync`](gen.md#keeping-the-task-in-step-brief-sync) tells the branch's task, on your pick, what changed in the brief. One command name or path, run directly, never through a shell. `null` turns it off |
| `socket` | `$PAIR_SOCKET`, else `$XDG_RUNTIME_DIR/pairing-buddy.sock`, else `/tmp/pairing-buddy-<uid>.sock` | The daemon's socket path |
| `dataDir` | `$XDG_STATE_HOME/pairing-buddy` (`~/.local/state/pairing-buddy`) | Where Pair keeps its data ([data.md](data.md)) |

## Model entries

A model entry says where its requests go in one of two ways:

- **A provider:** `"provider"` names one of [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)'s providers
  (`pair auth list` lists them) and `"model"` one of its models (`pair auth models PROVIDER`). The provider brings its
  own API, endpoint and model details. The login or key comes from `pair auth login PROVIDER`, or from the provider's
  usual environment variable (for example `ANTHROPIC_API_KEY`) when the daemon sees it; the systemd or launchd
  service does not get your shell's environment, so there use `pair auth login`.
- **An endpoint:** `"api"` and `"baseUrl"`, for a local server or any OpenAI- or Anthropic-compatible API. Its key
  comes from one of `"auth"` (a key stored with `pair auth login NAME`), `apiKey`, `apiKeyFile` or `apiKeyEnv`, or
  there is none.

| Field | Default | Meaning |
| --- | --- | --- |
| `provider` | | A pi-ai provider id, for example `anthropic`, `openai`, `openai-codex`, `github-copilot`, `openrouter`, `mistral` (`pair auth list` lists all). Takes no `api`, `baseUrl` or key fields |
| `api` | | `"openai"` (OpenAI-compatible chat completions) or `"anthropic"`, for an entry without a `provider` |
| `baseUrl` | `https://api.anthropic.com` for `anthropic` | The server's base URL, usually ending in `/v1`. Required for `openai` |
| `model` | (needed) | The model id the provider or server expects |
| `auth` | | The name of a key stored with `pair auth login NAME`, for an endpoint (a name pi-ai does not know stores a key for your own server; a provider's id uses that provider's stored key) |
| `apiKey`, `apiKeyFile`, `apiKeyEnv` | | Or the key inline, in a file, or in an environment variable; at most one of these and `auth`. A local server without a key needs none. The service does not see your shell's variables: `pair setup` stores those named by `apiKeyEnv` in `service.env` next to the config, readable by you only, and `pair doctor` says when one is missing there |
| `contextWindow` | asked of the server or catalog, else `32768` | Tokens of conversation Pair keeps for this model (at least 16384 for the Partner). Pair compacts the conversation before it crowds out the reply. Without it, Pair asks as the daemon starts: a provider's model has its window from pi-ai's catalog; an OpenAI-compatible server is asked what it serves (vLLM and SGLang list it, llama.cpp's `/props` and LM Studio's model info have it); a found window above 131072 is held to that, since every turn sends the whole conversation. Where nothing says (Ollama, many proxies), it is 32768. `pair doctor` shows where the window came from, and warns when yours is larger than the server serves |
| `maxTokens` | 2048 plus the most thinking (10240 with the default levels), at most a third of `contextWindow` | The Partner's longest answer, its thinking included. The Watcher always answers with one number |
| `images` | `false` | Whether a model at a `baseUrl` reads images. Only then does the Driver get the picture a run writes in [the hand-over's check](driver.md#the-check-on-the-unsaved-buffer); otherwise it is told the picture's name. A provider's model has it from pi-ai's catalog |
| `reasoning` | Partner `true`, Watcher `false` | Whether Pair sets the model's thinking. Set `false` on the Partner for a model that cannot think. On the Watcher, set `true` for a model that thinks by default, so Pair can switch its thinking off (with one `model` for both roles it is on already). A provider's model has it from pi-ai's catalog, whatever the role |
| `thinking` | `{"navigator": "medium", "scout": "medium", "driver": "medium", "remark": "low", "gen": "medium"}` | The Partner only: how much it thinks, `off`, `minimal`, `low`, `medium`, `high` or `xhigh`. One level for every turn, or levels by kind of turn: `navigator` (answers to your questions), `scout`, `driver`, `remark` (what it says unasked) and `gen` (a [/gen request](gen.md)). On an OpenAI-compatible server a level is sent only as its `compat` says (`pair doctor --thinking` finds it); without that it only switches thinking on |
| `samplingParams` | | Extra sampling fields sent with each request to an OpenAI-compatible server, for example `{"temperature": 0.3}` when the server's default is high. The Watcher asks for temperature 0, but a Watcher entry of its own sends its `samplingParams` too, and they win: leave them off there (with one `model` or `"same as partner"` the Watcher sends none) |
| `compat` | | OpenAI-compatibility flags passed to pi-ai (see its "OpenAI Compatibility Settings"): for example `thinkingFormat` and `chatTemplateKwargs` for a model whose chat template has a thinking switch, `supportsReasoningEffort: true` for a server that takes the thinking level as `reasoning_effort`, or `thinkingTokenBudgetField` for one that takes a token budget. `pair doctor --thinking` tries them on your server and prints the block to paste |
| `thinkingLevelMap` | | For an OpenAI-compatible server: the server's own name for a thinking level, or `null` for one it does not have, for example `{"minimal": "low", "xhigh": "high"}` |

The Partner thinks before it answers, and the Watcher never does. The Watcher only scores, on every candidate remark,
so it must stay under a second. The Partner's words are what you act on, and a few seconds of thinking make them right
far more often. `"thinking": {"remark": "medium"}` lets remarks think more, `"thinking": "off"` switches it off
everywhere. `pair doctor` checks that the Partner does think, and that the Watcher does not. Details in
[watcher.md](watcher.md#thinking-the-partner-not-the-watcher).

The optional `decision` entry takes the same `provider`, `model` and key fields, an `api` of its own (`"openai"` for
OpenAI's Decisions API, `"system-one"` or `"llama-cpp"`) at a `baseUrl`, `timeoutMs` (default 1500) and, for a gateway, `contextWindow` (default 32768): see
[decision.md](decision.md#configure).

## `testOnSave`

Maps a project's folder to the command Pair runs in its pane when you save a source file there:

```jsonc
"testOnSave": {
  "~/src/shop": "go test -json ./...",
  "~/src/big": {"command": "make test", "timeoutSeconds": 600, "affected": false}
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `command` | (needed) | The test command, run in the project's folder |
| `timeoutSeconds` | `120` | How long a run may take |
| `affected` | `true` | Run only the tests the save affects, where Pair can tell; `false` runs the whole command on every save |

## `scoutPane`

```jsonc
"scoutPane": {"rc": "~/.bashrc", "sandbox": "auto", "network": false, "writable": ["~/.cache"]}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `rc` | `false` | A bash rc file the pane loads first, for your aliases, functions and `PATH`; `true` is `~/.bashrc` ([your rc file](scout.md#your-rc-file)) |
| `sandbox` | `"auto"` | The bubblewrap sandbox: `"auto"` where `bwrap` works, `true` always (the pane fails to open without it), `false` never ([the sandbox](scout.md#the-sandbox)) |
| `network` | `false` | Whether commands in the sandbox reach the network |
| `writable` | `[]` | Folders that keep what is written in the sandbox, besides the project |

## `gen`

```jsonc
"gen": {"limits": {"files": 40, "lines": 4000, "commands": 8, "minutes": 10}, "brief": "NOTES.md", "keepTries": 7, "network": false, "scaffold": "tree"}
```

`brief` is the note a request's [brief](gen.md#the-brief) has when you pinned none: a path in the project, used when
the project has that file. `null` leaves the note out, so a brief is the goal and the board task only. `/brief` and
`:Pair brief` pin another note, or none, for the project; a pin wins over this setting.

`limits` is what one [/gen request](gen.md) may do at most. They stop a model that loops; they are no review budget.
Each limit is a whole number above 0, and one you leave out keeps its default.

| Limit | Default | Meaning |
| --- | --- | --- |
| `files` | `40` | Files a request may propose code in, draft, or write in a try's folder or a scaffold's copy |
| `lines` | `4000` | Lines of code it may propose, draft or write, in all; of a change a scaffold makes to a file, the lines it adds |
| `commands` | `8` | Searches it may run in Pair's pane, and the runs of a try or a scaffold |
| `minutes` | `10` | How long its model may work; time a question waits for you does not count |

A change takes effect for the next request; one already running keeps the limits it started with. A request that
runs into `files`, `lines` or `minutes` is offered to the board when it ends ([`/gen board #n`](gen.md#a-request-too-big-for-gen)).

`keepTries` is how many days a [/gen try](gen.md#samples-gen-try-and-keep)'s folder (in `dataDir/gen/`) stays after
anything in it last changed or it last ran, and a [/gen scaffold](gen.md#many-files-gen-scaffold)'s copy after it was
last used: a whole number above 0. Older folders are deleted when the daemon starts and whenever a new try or scaffold
starts; a scaffold's git worktree never is. `network` lets the runs of a try or a scaffold reach the network, to
install what they need; off, their sandbox has none, and a scaffold lists its installs for you instead of running
them. Their sandbox follows `scoutPane.sandbox`: without bubblewrap, a command runs in the folder unsandboxed and asks
first, as Scout's would.

`scaffold` is where a `/gen scaffold` is built: `"tree"`, a copy of the project in Pair's data folder (no branch, no
change to your repository, deleted with one key), or `"worktree"`, a git worktree on a new branch `gen/<n>`, which you
can commit as it is. `--branch` and `--copy` in the request choose for one request
([gen.md](gen.md#in-a-git-worktree---branch)).

## `voice`

Off until set. `"voice": {}` (or `true`) hears and reads answers aloud with LFM3-Omni on your CPU, once
`:Pair voice on` has downloaded it. Set up in [voice.md](voice.md#setup).

| Field | Default | Meaning |
| --- | --- | --- |
| `model` | none: LFM3-Omni hears | A whisper.cpp model file, like `ggml-base.en.bin`: whisper.cpp hears instead |
| `whisper` | `"whisper-cli"` | The whisper.cpp program, on `PATH` or a path |
| `threads` | `4` | CPU threads LFM3-Omni or whisper uses |
| `language` | `"en"` | What you speak (`auto` with a multilingual whisper model) |
| `record` | the first recorder found | A shell command that writes raw 16-bit little-endian mono at 16 kHz to stdout |
| `speak` | `"omni"` when LFM3-Omni hears, else none | `"omni"` (LFM3-Omni reads answers aloud), `false` (nothing is read aloud), or a shell command that reads the answer from stdin and says it |
| `talk` | `false` | `true`: every answer to a spoken question is read aloud, at the editor too, not only when you are away |
| `omni` | `{"voice": "female"}` | LFM3-Omni's voice: `"female"` or `"male"` |
| `play` | `mpv`, else `ffplay`, else `pw-play`, else `aplay` | A shell command that plays LFM3-Omni's or OpenRouter's audio from stdin (`pw-play` and `aplay` for LFM3-Omni's WAV only) |
| `maxSeconds` | `60` | The longest recording |
| `openrouter` | none | Hearing and reading aloud through OpenRouter, below |

`voice.openrouter` ([voice.md](voice.md#openrouter)):

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKeyFile`, `apiKeyEnv`, `auth`, `apiKey` | (one needed) | The OpenRouter key, as in a model entry |
| `hear` | none | A transcription model, like `"openai/whisper-large-v3-turbo"`: it hears instead of LFM3-Omni (then `model` is not taken) |
| `speak` | none | `{"model": ..., "voice": ...}`, a speech model and one of its voices, with optional `"format"` (`"mp3"`, the default, or `"wav"`) and `"speed"`: it reads answers aloud instead of a `speak` command (then `speak` is not taken) |
| `timeoutMs` | `30000` | How long Pair waits for OpenRouter before it says so |
| `baseUrl` | `"https://openrouter.ai/api/v1"` | Where the API is |

At least one of `hear` and `speak` is needed.

## `meaning`

[Search by meaning](meaning.md)'s word search works once a project has a session; meaning needs EmbeddingGemma 2,
which `:Pair find on` downloads once with the LiteRT-LM runtime it runs on, or an [`embedding`](#embedding) model. These fields say how it runs.

| Field | Default | Meaning |
| --- | --- | --- |
| `python` | `<dataDir>/meaning/venv/bin/python` if it is there (`:Pair find on` makes it), else `python3` | The Python whose `litert-lm-api` runs EmbeddingGemma 2. Set, it wins: Pair installs nothing into it and never deletes it ([meaning.md](meaning.md#turn-embeddinggemma-on)) |
| `threads` | `2` | The cores EmbeddingGemma may use while it indexes and searches, at low priority |
| `index` | `"data"` | Where the index lives: `"data"`, Pair's data folder (`index/<repository>-<hash>.sqlite`); or `"project"`, `.pair/index.sqlite` in the repository, with `.pair/` added to `.git/info/exclude` ([meaning.md](meaning.md#the-index)) |

`"meaning": false` turns search by meaning off for good: nothing is downloaded or indexed, and `Alt-s` says so.

## `embedding`

An embedding model of your own for [search by meaning](meaning.md#another-embedding-model), next to the models: an
`"api": "openai"` entry at a `baseUrl` that serves `/v1/embeddings` (llama.cpp's `llama-server --embeddings`, Ollama,
LM Studio, vLLM, a cloud API), with its key as a [model entry](#model-entries)'s (but `pair setup` does not store its `apiKeyEnv` in `service.env`:
under the service, use `auth`, `apiKeyFile` or `apiKey`). Without it, EmbeddingGemma 2.

| Field | Default | Meaning |
| --- | --- | --- |
| `api` | | `"openai"` |
| `baseUrl` | | Where its `/v1` is, for example `http://127.0.0.1:8080/v1` |
| `model` | | Its name there, for example `jina-embeddings-v2-base-code` or `nomic-embed-code` |
| `auth`, `apiKey`, `apiKeyFile`, `apiKeyEnv` | none | Its key, if it needs one: one of them |
| `queryPrefix`, `documentPrefix` | the model's own, where semantic-grep knows them | The prompts it was trained with, for a search and for a piece of code |
| `dimensions` | the model's | Asks a model that can for shorter vectors |
| `timeoutMs` | `60000` | How long one request to it may take, in ms (`pair doctor`'s own check waits 15 s) |

## `rerank`

A decision model that [reranks](meaning.md#rerank) search by meaning's first pieces once a
list is settled: `/find`, the `search` tool, `vim.ui.select`, and a live picker after you stop typing. A
[decision entry](decision.md#configure) (a `provider` and one of its classifiers, or an `api` at a `baseUrl`), with
fields of its own (`top`, `timeoutMs` and `chars`), or a cross-encoder (`"api": "rerank"` at a `baseUrl`); or a list
of them, best first. Without it (or with `false`), searches keep the order of
meaning and words. A change is taken without a restart. Its key goes as a decision entry's, but `pair setup` does not
store a `rerank` entry's `apiKeyEnv` in `service.env`: under the service, use `auth`, `apiKeyFile` or `apiKey`.

| Field | Default | Meaning |
| --- | --- | --- |
| `api` | | `"system-one"` (`POST <baseUrl>/systemone`: llama.cpp's decision models, TypeSafe, OpenRouter), `"llama-cpp"` (a chat model on llama.cpp's server, asked for each answer's probability), `"openai"` (OpenAI's Decisions API) or `"rerank"` (a cross-encoder's `POST <baseUrl>/rerank`: llama.cpp's `--rerank`, Cohere, Jina, Voyage; it scores each piece and reorders them all, where a decision model only moves its first choice when it stands out); or a `provider` instead |
| `baseUrl` | | Where its `/v1` is, for example `http://127.0.0.1:8080/v1` |
| `model` | | Its name there, for example `d1-2B` |
| `auth`, `apiKey`, `apiKeyFile`, `apiKeyEnv` | none | Its key, if it needs one: one of them |
| `top` | `10` | How many of the first pieces it reads, 2 to 30. Each costs the model time |
| `timeoutMs` | `3000`; `1000` for one another follows | How long a search waits for it; slower, the next in the list is asked, or the order stays |
| `chars` | `1200` for `"rerank"`, `160` otherwise | How much of each piece it reads, 40 to 4000 |

```jsonc
"rerank": {"api": "system-one", "baseUrl": "http://127.0.0.1:8080/v1", "model": "d1-2B"}
```

A cross-encoder, such as Qwen3-Reranker-0.6B (`llama-server -m qwen3-reranker-0.6b-q8_0.gguf --rerank --port 18121`;
semantic-grep's docs/profiles.md has its numbers), takes about 1 s for 15 pieces on a laptop's small GPU:

```jsonc
"rerank": {"api": "rerank", "baseUrl": "http://127.0.0.1:18121/v1", "model": "qwen3-reranker-0.6b", "top": 15}
```

A list asks its first model that has not failed within the last minute, and the next when that one fails or is slower
than its `timeoutMs`: a fast model on a GPU that is not always up, then one on the CPU that is. Each has its own
`top` and `timeoutMs`:

```jsonc
"rerank": [
  {"api": "system-one", "baseUrl": "http://127.0.0.1:8081/v1", "model": "gpu-decision-model", "top": 15},
  {"api": "system-one", "baseUrl": "http://127.0.0.1:8080/v1", "model": "d1-2B"}
]
```

## Session roots

A project, with its own session, goal, chat and memory, is the git root of the folder Neovim and `pair` start in.
In a monorepo that is too coarse; `sessionRoots` lists folders that are projects of their own. A folder ending in
`/*` makes each folder in it one:

```jsonc
"sessionRoots": ["~/src/shop/packages/*", "~/src/shop/tools"]
```

Neovim started in `~/src/shop/packages/api/src` then pairs in the project `~/src/shop/packages/api`, and so does
`pair` started there; the deepest listed folder wins. Start both in the package, or below it: a Neovim started at
the monorepo's root stays in the root's project. Pair reads, points and suggests only inside the project, and its
`testOnSave` entry is the package's folder.

## Talk levels

| Level | Watcher score needed | At most | Minimum gap |
| --- | --- | --- | --- |
| quiet | 8 | 2 per hour | 15 min |
| normal | 6 | 6 per hour | 3 min |
| chatty | 4 | 15 per hour | 90 s |

With a [decision model](decision.md), the bar is also the share the "speak now" probability needs: 80% at quiet, 60%
at normal, 40% at chatty. Answers to your own questions do not count against the budget. With `autoTune` on, your feedback moves each
trigger's bar and scales the budget within fixed bounds, per project ([memory.md](memory.md#learning-when-to-talk)).
Change the level for a session with `/level` in the chat or `:Pair level` in Neovim.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `PAIR_CONFIG` | The config file, in place of `~/.config/pairing-buddy/config.json` |
| `PAIR_AUTH` | The logins and keys file, in place of `auth.json` next to the config |
| `PAIR_SOCKET` | The daemon's socket, when the config sets none; the Neovim plugin's too, when its `setup` sets no `socket`. The daemon run as the service does not see it: set `socket` in the config for that |
| `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR` | Where the config, the data and the socket go by default |
| `NO_COLOR` | The chat pane prints no colours |
