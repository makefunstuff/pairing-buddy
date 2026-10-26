# Configuration

Pair reads one file: `~/.config/pairing-buddy/config.json` (or the path in `$PAIR_CONFIG`; `$XDG_CONFIG_HOME` is
respected). It is JSON with `//` and `/* */` comments. The first run of `pair setup`, `pair` or `pair daemon` writes it
from [`config.example.json`](../config.example.json), which explains each field.

The config is read when the daemon starts: after a change, restart it (`systemctl --user restart pairing-buddy`) and
run `pair doctor`. Logins and keys are the exception; they take effect without a restart.

## Models

Pair asks two models, one for each of its two jobs:

- The **Watcher** scores every moment that might deserve a remark with one number from 0 to 10. It must be fast,
  about a second.
- The **Partner** writes what Pair says and uses its role's tools. It thinks before it answers.

One model can do both (`model`), or each has its own (`models`):

```jsonc
{
  "level": "normal",
  // One model for both roles
  "model": {"api": "openai", "baseUrl": "http://localhost:8080/v1", "model": "your-model", "contextWindow": 32768}
}
```

```jsonc
{
  "models": {
    // The Watcher scores every candidate remark with one number: it must be fast
    "watcher": {"api": "openai", "baseUrl": "http://localhost:8080/v1", "model": "your-small-model"},
    // A provider pi-ai knows, logged in to with `pair auth login`: a subscription or an API key
    "partner": {"provider": "anthropic", "model": "your-cloud-model"}
  }
}
```

`"watcher": "same as partner"` is the same as one `model`.

A model entry says where its requests go in one of two ways:

- **A provider:** `"provider"` names one of [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)'s providers
  (`pair auth list` lists them) and `"model"` one of its models (`pair auth models PROVIDER`). The provider brings its
  own API, endpoint and model details. The login or key comes from `pair auth login PROVIDER`, or from the provider's
  usual environment variable (for example `ANTHROPIC_API_KEY`).
- **An endpoint:** `"api"` and `"baseUrl"`, for a local server or any OpenAI- or Anthropic-compatible API. Its key
  comes from `"auth"` (a key stored with `pair auth login NAME`), `apiKey`, `apiKeyFile` or `apiKeyEnv`, or there is
  none.

| Field | Meaning |
| --- | --- |
| `provider` | A pi-ai provider id, for example `anthropic`, `openai`, `openai-codex`, `github-copilot`, `openrouter`, `mistral` (`pair auth list` lists all). Takes no `api`, `baseUrl` or key fields |
| `api` | `"openai"` (OpenAI-compatible chat completions) or `"anthropic"`, for an entry without a `provider` |
| `baseUrl` | The server's base URL, usually ending in `/v1`. Required for `openai`; `anthropic` defaults to the Anthropic API |
| `model` | The model id the provider or server expects |
| `auth` | The name of a key stored with `pair auth login NAME`, for an endpoint (a name pi-ai does not know stores a key for your own server; a provider's id uses that provider's stored key) |
| `apiKey`, `apiKeyFile`, `apiKeyEnv` | Or the key inline, in a file, or in an environment variable. A local server without a key needs none. The service does not see your shell's variables: with `apiKeyEnv`, add it with `systemctl --user edit pairing-buddy` (`[Service]` and `Environment=NAME=value`), or use `auth` or `apiKeyFile` |
| `contextWindow` | Tokens of conversation Pair keeps for this model (default 32768, also for a provider's model with a larger window; at least 16384 for the Partner). Pair compacts the conversation before it crowds out the reply |
| `maxTokens` | The Partner's longest answer, its thinking included (default 2048 plus room for its most thinking: 10240 with the default levels, and at most a third of `contextWindow`). The Watcher always answers with one number |
| `reasoning` | Whether Pair sets the model's thinking. The Partner's default is `true`, so it thinks as `thinking` says; set `false` for a model that cannot think. The Watcher's default is `false`: set `true` for a model that thinks by default, so Pair can switch its thinking off. A provider's model has it from pi-ai's catalog, whatever the role |
| `thinking` | The Partner only: how much it thinks, `off`, `minimal`, `low`, `medium`, `high` or `xhigh`. One level for every turn, or levels by kind of turn: `navigator` (answers to your questions), `scout`, `driver` and `remark` (what it says unasked). Default `{"navigator": "medium", "scout": "medium", "driver": "medium", "remark": "low"}`. On an OpenAI-compatible server a level is sent only with `compat.supportsReasoningEffort` or `compat.thinkingTokenBudgetField`; without them it only switches thinking on |
| `samplingParams` | Extra sampling fields sent with each request to an OpenAI-compatible server, for example `{"temperature": 0.3}` when the server's default is high |
| `compat` | OpenAI-compatibility flags passed to pi-ai (see its "OpenAI Compatibility Settings"): for example `thinkingFormat` for a model whose chat template has a thinking switch, `supportsReasoningEffort: true` for a server that takes the thinking level as `reasoning_effort`, or `thinkingTokenBudgetField` for one that takes a token budget |

The Partner thinks before it answers, and the Watcher never does. The Watcher only scores, on every candidate remark,
so it must stay under a second. The Partner's words are what you act on, and a few seconds of thinking make them right
far more often (a remark may come a little later; that is fine). `"thinking": {"remark": "medium"}` lets remarks
think more, `"thinking": "off"` switches it off everywhere. `pair doctor` checks that the Partner does think, and that
the Watcher does not. Details in [watcher.md](watcher.md#thinking-the-partner-not-the-watcher).

## Other settings

| Setting | Meaning |
| --- | --- |
| `level` | How often Pair speaks unasked: `quiet`, `normal` (default) or `chatty` ([talk levels](#talk-levels)) |
| `autoTune` | Your feedback tunes the bars and budget, default `true` ([memory.md](memory.md#learning-when-to-talk)) |
| `keepWarm` | While you work, ask the Watcher's model for one token every 4 minutes, so a server that unloads idle models keeps it loaded. Default `true` for an `openai` Watcher, `false` for an `anthropic` one ([watcher.md](watcher.md#keep-warm)) |
| `typingPauseMs` | How long after a keystroke you count as typing, default 2000 |
| `testOnSave` | A test command per project, run when you save ([tests-on-save.md](tests-on-save.md)) |
| `agents` | The relay of your other agents' news, from herdr and the `board`: `false` turns it off ([agents.md](agents.md#configure)) |
| `voice` | Push-to-talk with whisper.cpp; off until set ([voice.md](voice.md)) |
| `taskCommand` | What `:Pair tasks` runs for each task you say yes to, as a list of words with `{title}` and `{description}`, never through a shell, for example `["gh", "issue", "create", "--title", "{title}", "--body", "{description}"]`. Without it, the tasks are copied as a checklist ([notes.md](notes.md#tasks-only-when-you-ask)) |
| `board` | The herdr work board's command, default `"herdr-projects"`: the goal and the [context card](neovim.md#what-it-knows-the-context-card) read the board task of your branch. `null` turns it off |
| `socket` | The daemon's socket path |
| `dataDir` | Where Pair keeps its data ([data.md](data.md)) |

## Talk levels

| Level | Watcher score needed | At most | Minimum gap |
| --- | --- | --- | --- |
| quiet | 8 | 2 per hour | 15 min |
| normal | 6 | 6 per hour | 3 min |
| chatty | 4 | 15 per hour | 90 s |

Answers to your own questions do not count against the budget. With `autoTune` on, your feedback moves each
trigger's bar and scales the budget within fixed bounds ([memory.md](memory.md#learning-when-to-talk)). Change the
level for a session with `/level` in the chat or `:Pair level` in Neovim.

## Logins and keys

`pair auth` keeps the logins and keys of every provider in one file, `auth.json` next to the config (or `$PAIR_AUTH`),
readable by you only (mode 600). It holds the secrets in plain text, as other command-line tools do, and nothing ever
prints them.

```sh
pair auth login anthropic   # pick a subscription login or an API key; also `pair login anthropic`
pair auth list              # every provider: logged in, key stored, key from its environment variable, or not set
pair auth models anthropic  # the models it offers, for "model"
pair auth logout anthropic  # also `pair logout anthropic`
```

- **Subscriptions** (OAuth): providers that offer one in pi-ai, for example Anthropic (Claude Pro/Max), OpenAI (Sign
  in with ChatGPT), OpenAI Codex (ChatGPT Plus/Pro, which pi-ai marks as legacy), GitHub Copilot, xAI and others;
  `pair auth list` says `subscription` where there is one. The login opens the provider's sign-in page in your browser
  (or prints the link) and finishes on a local callback. On a machine without a browser, choose the copy-code or
  device-code login where the provider offers one. The token renews itself before it expires, under a lock, so the
  daemon, `pair doctor` and `pair auth` never renew it twice.
- **API keys**: every provider takes one. The key is typed at a prompt that does not echo it. A key for your own
  server: `pair auth login my-server` (any name pi-ai does not know), then `"auth": "my-server"` in its model entry.
- The daemon reads the file as it needs a key, so a login takes effect without a restart.

### Before you use a subscription

- **Terms.** Whether a subscription may be used from a tool like Pair is up to the provider's terms, and they change.
  Anthropic's Claude Pro/Max plans are meant for Anthropic's own apps and Claude Code; pi-ai's login sends requests the
  way Claude Code does (its identity line and tool names), which Anthropic may not allow for other tools and may
  block. The OpenAI Codex login does the same for the Codex CLI, while Sign in with ChatGPT is OpenAI's sign-in for
  other agents. Read the current terms first; an API key is the route every provider supports.
- **Limits.** Requests count against your plan's usage limits, shared with the provider's own apps, and the plan's rate
  limits apply. The Watcher asks its model about every candidate remark, which adds up fast on a subscription. Keep
  the Watcher on a small local or pay-per-use model and give the subscription to the Partner.
- **Expiry.** A login can end (a password change, a revoked session, a plan that lapsed). Pair then says the model is
  down, and `pair doctor` names the fix: `pair auth login PROVIDER` again.

## Local models

- The Watcher runs on every candidate remark and should answer in under a second. It gets a few lines (under 200
  tokens) and answers with one number, so a mid-sized model is fast enough on a fast server. A server with a high fixed
  cost per request may still take close to a second; `pair doctor` shows the time. Keep `reasoning: true` for models
  that think by default, so thinking gets switched off.
- A server that keeps only one model loaded at a time (llama.cpp's router mode, for example) reloads on every switch
  between two models. There, use [one model](#one-model) for both roles. With two models on such a server, the
  Watcher uses the Partner's model while only that one is loaded, if the server says which models are loaded;
  otherwise it swaps on every remark.
- If the server's default temperature is high, give the Partner `"samplingParams": {"temperature": 0.3}`: its
  yes-or-no calls (speak or stay silent) get much steadier. The Watcher always runs at temperature 0.
- The prompts and tools are deliberately simple (five tools as Navigator, seven as Scout, nine as Driver, flat
  arguments, one instruction per message), so mid-sized local models handle them. The command policy, the limit of
  four commands per question and the one edit per hand-over are in code, so a model that loops or asks for too much
  cannot do harm.
- A model that has a thinking switch in its chat template needs `compat.thinkingFormat` on an OpenAI-compatible
  server, or Pair cannot set it. That switch is only on or off, unless the server also takes a level
  (`supportsReasoningEffort`, `thinkingTokenBudgetField`). `pair doctor` says when the Partner answers without
  thinking, when its levels are only on or off, and when the Watcher thinks anyway.

## One model

One model can serve both roles, for example the one model a local server has room for. Set `model` in place of
`models` (or `"watcher": "same as partner"`). Pair asks it in two ways:

- **As the Watcher**, without thinking, at temperature 0, for at most 8 tokens: one number. The entry's `thinking`
  and `samplingParams` are the Partner's only.
- **As the Partner**, with thinking at the levels of `thinking`, as with a Partner of its own.

The server never switches models, so it never reloads. Many local servers answer one request at a time, so when both
roles share a server (one model, or two models on one `baseUrl`), Pair puts the requests in order:

- **The Watcher waits while the Partner works.** A score never queues behind a long answer that thinks: the moment is
  looked at again once the answer is done, and then scored at once. A remark nobody asked for can wait.
- **Your question goes first.** A question, a hand-over or `/end` cancels the Watcher's score and the unasked remark
  still being written, in every project. A remark that showed nothing yet is dropped, and a cancel never counts as
  the model failing.
- **No work behind your back.** The conversation is compacted only between turns, never alongside them, and
  keep-warm pings pause while the Partner works (it keeps the model loaded anyway).
- **It fits the context.** The Partner's reply (thinking and answer) takes at most a third of `contextWindow`, and
  compaction keeps that room free; the session note it carries is at most 1200 characters. Below 16384 tokens Pair
  refuses the config. Below 32768, or when the reply has less room than its thinking level wants, `pair doctor`
  warns.

`pair doctor` shows a `roles` line for it, with how many scores the Watcher made, how long they took, and what your
questions cancelled since the daemon started. `pair stats` shows how many remarks waited for the model, and for how
long, next to how they turned out.

## When a model is down

A model endpoint that stops answering does not turn into a stream of errors:

- The first failed call marks the model down: one line in the daemon's log, one note in the chat, and a warning in
  Neovim's statusline.
- While a model is down, Pair makes no remarks (it does not even ask the Watcher). A question you type is still sent,
  in case the model is back, and gets one short error if not.
- A tiny request every 30 seconds notices when the model answers again; the warning goes away and the chat says so.
- The daemon also checks both models when it starts, so a dead endpoint shows at once.
- A Partner request that gets no answer for 90 seconds (four minutes while it thinks) fails, and is retried twice.
