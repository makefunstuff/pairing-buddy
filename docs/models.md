# Models and providers

Pair asks two models, one for each of its two jobs:

- The **Watcher** scores every moment that might deserve a remark with one number from 0 to 10. It must be fast,
  about a second, and it never thinks.
- The **Partner** writes what Pair says and uses its role's tools. It thinks before it answers.

One model can do both. Each model comes from one of three places:

| Where | What you set | Key |
| --- | --- | --- |
| A local server | `"api": "openai"` and its `"baseUrl"`: llama.cpp, Ollama, vLLM, LM Studio or any OpenAI-compatible server | None, unless the server wants one |
| A provider with an API key | `"provider"` and `"model"`: any provider [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) supports (`pair auth list`), or `"api": "anthropic"` for an Anthropic-compatible API | `pair auth login PROVIDER`, or the provider's usual environment variable |
| A subscription login | `"provider"` and `"model"`, for a provider that offers a login in pi-ai | `pair auth login PROVIDER`, then pick the subscription. Read [the terms first](#before-you-use-a-subscription) |

Every field of a model entry is in the [configuration reference](config.md#model-entries).

## Pick a setup

**One local model for both roles.** The simplest setup, and the one for a server that holds one model at a time:

```jsonc
{
  "model": {"api": "openai", "baseUrl": "http://localhost:8080/v1", "model": "your-model"}
}
```

**A small local Watcher and a cloud Partner.** The Watcher runs on every candidate remark, so keep it local or
pay-per-use; the Partner runs only when there is something to say:

```jsonc
{
  "models": {
    "watcher": {"api": "openai", "baseUrl": "http://localhost:8080/v1", "model": "your-small-model"},
    "partner": {"provider": "anthropic", "model": "your-cloud-model"}
  }
}
```

**One cloud model for both.** `"model": {"provider": "openai", "model": "..."}` works too, but the Watcher asks
about every candidate remark, and each of those calls is a paid request or counts against a plan's limits.

`"watcher": "same as partner"` in `models` is the same as one `model`. After a change, run `pair doctor`: it checks
that each model answers, how fast, and that the Partner thinks.

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
- **Keys from environment variables** (`apiKeyEnv`): a service started at login does not get your shell's
  environment, so `pair setup` stores each variable a model entry names, as this shell has it, in `service.env` next to
  the config, readable by you only. The daemon takes the variable from its own environment first, else from that file,
  as it needs the key. After changing the key, run `pair setup` again; `pair doctor` says which variable the service
  would miss.

### Before you use a subscription

- **Terms.** Whether a subscription may be used from a tool like Pair is up to the provider, and terms change. An API
  key is the route every provider supports. `pair auth login` shows the provider's line below before a subscription
  login, and `pair doctor` warns when the Watcher runs on one. What the terms said in October 2026:

  | Login | What the provider's terms say | Read |
  | --- | --- | --- |
  | `anthropic` (Claude Pro/Max) | Not allowed. A Claude subscription login (Free, Pro, Max, Team or Enterprise) is for Claude Code and Anthropic's own apps; other tools must use an API key, and Anthropic may enforce this without notice. pi-ai's login sends requests the way Claude Code does. Use an API key. | [Claude Code: legal and compliance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use), [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) |
  | `openai` (Sign in with ChatGPT) | Allowed in the apps you let use your plan: a Plus or Pro plan, up to a weekly limit you set per app in ChatGPT under Settings > Usage. | [Sign in with ChatGPT](https://learn.chatgpt.com/docs/sign-in-with-chatgpt), [Using your plan in other apps](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) |
  | `openai-codex` (ChatGPT Plus/Pro, legacy) | Unclear. The plan covers Codex itself; this login sends requests as the Codex CLI. Prefer `openai` above. | [Codex and your ChatGPT plan](https://help.openai.com/en/articles/11369540-codex-product-information) |
  | `github-copilot` | Not offered. GitHub has no Copilot API for other tools; this login sends requests as Copilot Chat in an editor. Copilot's terms and the Acceptable Use Policies apply, and scripted or heavy use can get Copilot suspended. | [GitHub Generative AI Services Terms](https://gh.io/terms), [Acceptable Use Policies](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies) |
  | `kimi-coding` (Kimi Code) | Not for this sign-in. The plan may be used in third-party tools, but they must authenticate with an API key made in the Kimi Code Console; this sign-in is the official client's. Choose the API key at `pair auth login kimi-coding`. Changing the client identifier (User-Agent) can suspend the membership. | [Kimi Code membership guide](https://www.kimi.ai/help/kimi-code/membership-guide) |
  | `xai` (SuperGrok, X Premium) | Not stated. xAI publishes no terms on using these plans from other tools, and its servers refuse some plans. | [xAI terms of service](https://x.ai/legal/terms-of-service) |
  | `meta` (Muse) | Not stated. Meta publishes no terms on using a Muse plan from other tools. | [Meta legal](https://www.meta.com/legal/) |

  `openrouter` and `radius` sign in to a pay-per-use account, not a subscription.
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
  otherwise once two of its calls after Partner turns took reload-long, and `pair doctor` measures the reload
  ([watcher.md](watcher.md#two-roles-one-loaded-model)).
- If the server's default temperature is high, give the Partner `"samplingParams": {"temperature": 0.3}`: its
  yes-or-no calls (speak or stay silent) get much steadier. The Watcher always runs at temperature 0.
- The prompts and tools are deliberately simple (six tools as Navigator, eight as Scout, ten as Driver, flat
  arguments, one instruction per message), so mid-sized local models handle them. The command policy, the limit of
  four commands per question and the five edits per hand-over are in code, so a model that loops or asks for too much
  cannot do harm.
- A model that has a thinking switch in its chat template needs it in `compat` on an OpenAI-compatible server, or
  Pair cannot set it. That switch is only on or off, unless the server also takes a level (`reasoning_effort`, or a
  budget field). `pair doctor` says when the Partner answers without thinking, when its levels are only on or off,
  and when the Watcher thinks anyway; `pair doctor --thinking` tries the switches and fields Pair knows on your
  server and prints the `compat` that works.

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
