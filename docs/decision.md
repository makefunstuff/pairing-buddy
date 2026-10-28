# The decision model

A **decision model** (also called a classifier) answers a typed question, such as "which of these three?", "yes or
no?" or "how much, on this scale?", with probabilities instead of words. TypeSafe's Jev, Cloudflare's Clef and
OpenAI's Decisions API are models of this kind. Pair can ask one at the [speak gate](how-it-works.md#the-speak-gate)
to decide whether an unasked remark is worth it. It is optional. Without a `decision` entry Pair works as it always
has: the [Watcher](watcher.md) scores the moment and the score has to reach the bar.

Pair asks the model through [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)'s `classify`. It works with
any classifier model pi-ai knows, and with a gateway of your own that serves one of the classifier APIs.

## What it decides

The model is asked about each candidate moment that gets past typing, the budget and the
[prefilter's rules](watcher.md#the-prefilter). Two questions go to it in one request:

- **Sort the moment.** Is it *noise*, plainly *worth* a remark, or does it need a *closer look*?
- **Speak now?** How likely is a remark about this moment to be worth interrupting you for right now?

Then the gate goes on as follows:

1. **Noise**, with at least 80% probability: the moment is dropped, and the Watcher is not asked.
2. **Worth it**, with at least 80% probability: the Watcher is not asked. Pair speaks when the "speak now"
   probability reaches the bar as a share: 60% at `normal` (a bar of 6), 80% at `quiet`, 40% at `chatty`. Your
   tuning moves each trigger's bar ([memory.md](memory.md#learning-when-to-talk)), and with it the share needed.
3. **Anything else** goes to the Watcher, as without a decision model. The [pace](watcher.md#when-the-server-is-slow)
   still holds back the kinds a slow server gives up, and [remembered scores](watcher.md#scores-remembered) still
   count. The "speak now" question is then asked again, with the Watcher's score in it. Its probability against the
   bar decides, in place of the score against the bar.

So every moment the model sorts as noise or worth it is one Watcher call fewer. On a slow server or a one-model
server, where each Watcher call costs the most, this saves the most.

The sort is kept for 30 s. While a moment waits for the Watcher (on one server it waits while the Partner works), the
gate looks at it again each second and does not ask the model again.

## What it is told

Each question goes with a small JSON state, the same for every model:

| Field | What it holds |
| --- | --- |
| `moment` | The trigger's kind, what happened (the same text the Watcher reads), and the Watcher's score and the bar once there is a score |
| `user` | The goal, the file you are in, seconds since your last keystroke, how many seconds of the last minute you typed, seconds since Pair last spoke unasked, the talk level |
| `recent` | Your last 5 edits (file and age), your last 3 commands (command, exit code and age), and the last test run (passed, failed, by whom, age) |
| `past_verdicts` | How your remarks of this kind ended in this project in the last 30 days (useful, dismissed, ignored), and your latest 6 judged remarks of any kind with their Watcher score and verdict, as examples |

Your verdicts are the ones you already give ([feedback on remarks](memory.md#feedback-on-remarks)). Nothing new is
asked of you.

This state goes to the decision model's provider: no file contents, only paths, command lines and the moment's text
([data.md](data.md)).

## Configure

Add a `decision` entry next to `model` or `models`. It takes the same keys as a [model entry](config.md#model-entries):
a pi-ai `provider` and one of its classifier models, or an `api` at a `baseUrl` with a key from `auth`, `apiKey`,
`apiKeyFile` or `apiKeyEnv`.

```jsonc
{
  "model": {"api": "openai", "baseUrl": "http://localhost:8080/v1", "model": "your-model"},

  // TypeSafe's Jev through OpenRouter: `pair auth login openrouter`
  "decision": {"provider": "openrouter", "model": "typesafe/jev-1.14"}
}
```

| Key | Default | What it does |
| --- | --- | --- |
| `provider` | none | A pi-ai provider with classifier models (below). Log in with `pair auth login PROVIDER` |
| `model` | required | The classifier model's id, as the provider lists it |
| `api` | none | For a gateway at a `baseUrl` instead of a provider: `"openai"` (OpenAI's Decisions API, `POST /decisions`), `"system-one"` (the System One API TypeSafe, OpenRouter and llama.cpp serve, `POST /systemone`) or `"llama-cpp"` (a chat model on llama.cpp's server, asked for the probability of each answer) |
| `baseUrl` | none | The gateway's URL, up to and including `/v1` where it has one |
| `timeoutMs` | `1500` | How long the gate waits for an answer. Past it, Pair goes by its own rules at once |
| `contextWindow` | `32768` | The model's window, for a gateway (a provider's catalog says it) |

A self-hosted gateway that serves OpenAI's Decisions API, or the System One API, under your own address:

```jsonc
"decision": {"api": "system-one", "baseUrl": "https://decisions.internal.example/v1", "model": "jev", "apiKeyEnv": "DECISIONS_KEY"}
```

The daemon takes a change to the entry as you save the config, in open sessions too.

## Pick a model

The decision model is asked about every candidate moment, so it has to be fast first. It needs to answer well within
`timeoutMs`; an answer in a few hundred milliseconds is the aim. It is a classifier, so it never writes text, and a
small one is enough. pi-ai's catalog has these (`pair auth models PROVIDER` lists them all, after the chat models):

| Provider | Models | Key |
| --- | --- | --- |
| `openrouter` | `typesafe/jev-1.14`, `typesafe/jev-1.13`, `~typesafe/jev-latest`, `cloudflare/clef`, `cloudflare/clef-flash`, and others | `OPENROUTER_API_KEY`, or `pair auth login openrouter` |
| `typesafe` | `jev-latest` | `TYPESAFE_API_KEY` |
| `cloudflare-workers-ai` | `typesafe/jev`, `@cf/cloudflare/clef`, `@cf/cloudflare/clef-flash`, and others | `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` |
| `vercel-ai-gateway` | `typesafe-ai/jev`, and others | `AI_GATEWAY_API_KEY` |
| `opencode` | `jev-1.13` | `OPENCODE_API_KEY` |
| `openai` | `gpt-6-luna` (OpenAI's Decisions API; an API key, not a ChatGPT login) | `OPENAI_API_KEY` |

- **Start with a flash or small model** (`cloudflare/clef-flash`, Jev). The two questions are short and the state is
  a few hundred tokens.
- **Pay per use, not a subscription.** The model is asked about every candidate moment, as the Watcher is.
- **Try it before you rely on it.** `node test/decision-check.mjs --entry '{"provider": "openrouter", "model": "typesafe/jev-1.14"}'`
  runs 16 hand-written sample moments through the gate with it. Once the daemon has logged decisions you judged,
  `--store ~/.local/state/pairing-buddy/sessions.sqlite` replays your own recorded moments instead. It reports how
  often the gate was right with the model and with the rules alone, latency and cost per call
  ([testing.md](testing.md)).
- **Check it with `pair doctor`.** It asks the model one small question and says how long the answer took
  (below). Then let `pair stats` show, after a few days, whether its remarks are kept more often than the rules'.

## Measured

`node test/decision-check.mjs --runs 3` with `typesafe/jev-1.14` on OpenRouter, at `normal`: three runs of the 16
hand-written sample moments, 84 calls. The moments are written by hand, not recorded from a session. Each has a
Watcher score and a label (a remark wanted or not), both chosen by hand. The model is also told a hand-written history
of 10 earlier verdicts, as it would be told yours.

| | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Gate right, with the model | 12 of 16 | 13 of 16 | 12 of 16 |
| Gate right, by the rules alone | 16 of 16 | 16 of 16 | 16 of 16 |
| Sure sorts (80% or more), right | 2 of 2 | 2 of 2 | 2 of 2 |
| Watcher calls saved | 2 | 2 | 2 |
| Latency per call: median, p90, slowest | 241, 300, 629 ms | 231, 274, 330 ms | 240, 291, 453 ms |
| Cost per call | $0.000038 | $0.000038 | $0.000038 |

What these runs show, and what they do not:

- **The rules cannot miss here.** Each sample's Watcher score was chosen to agree with its label. On your own
  moments the Watcher's score is no oracle, so this table does not say the rules beat the model there.
  `--store` on your recorded moments answers that.
- **The model is fast and cheap.** About a quarter of a second and $0.00004 a call, well inside the 1.5 s timeout;
  none of the 84 calls timed out.
- **Its sure sorts were right.** Each run, it was sure two moments were noise (a failure you are already fixing, an
  unused variable while exploring, at 85% to 96%). Both were dropped without a Watcher call.
- **It misses wanted remarks.** All its misses were remarks the labels wanted, put under the 60% bar: a stall after a
  failure (36% to 40%), a likely-bug warning (55% to 57%), drift into billing code (56% to 59%), a diagnostic in code
  you left (56% to 57%). Most of them sit just under the bar.
- **Runs differ.** The same moments got different sorts and probabilities from run to run, by a few points: 12 or 13
  right. An earlier single run, without the verdict history, got 13 of 16 with no sure sort, and one call of 22 over
  the timeout. Judge a model by several runs, or by `pair stats` over days.

With this model, Pair at `normal` says a little less than with the rules alone, and asks the Watcher a little less
often. `chatty` (40%) would have let most of those misses through. Or leave the model out until `pair stats` shows
its remarks are kept more often than the rules' remarks.

## When it is down or slow

A decision model that fails, or does not answer within `timeoutMs`, is down at once:

- One line in the daemon's log and one note in the chat: "The decision model is not answering (…). Pair decides by
  its own rules until it answers again". It is not repeated for each moment.
- While it is down the gate does not wait for it at all: the Watcher's score and the bar decide, as without a
  decision model. Pair keeps talking. Only a Watcher or Partner that is down keeps it quiet
  ([models.md](models.md#when-a-model-is-down)).
- One small question every 30 s notices when it answers again, and the chat says so.
- An answer of the wrong shape (a choice that was not offered, a probability outside 0 to 1, a missing answer) costs
  only that moment's decision. The rules decide that moment, and the daemon's log says so once.

## `pair doctor` and `pair stats`

`pair doctor` has a `decision` line. With no entry it says none is set. With one it gives the model's answer time
and, while the daemon runs, how often the model was asked and how often the gate fell back to its rules. It fails
when the model does not answer, or not within `timeoutMs`.

Pair logs each decision it made with the model (in `sessions.sqlite`, [data.md](data.md)): the sort and its
probability, the "speak now" probability, the Watcher's score and the bar when there was one, what the old rules
would have done, why the rules decided when the model gave no answer, the remark it led to, and the state the model
was told, so `node test/decision-check.mjs --store` can judge the moment again. `pair stats` adds a
section that compares the model with the old rules:

```
Decision model: 48 moments judged; it answered 46, the rules decided the rest (timeout 2)
  sorted as noise 21 · worth it 6 · for the Watcher 19; 27 Watcher calls saved
  its remarks: 9: useful 6 · dismissed 1 · ignored 2 · kept 67%
  the rules' remarks (the Watcher's score against the bar): 11: useful 4 · dismissed 3 · ignored 4 · kept 36%
  where the Watcher scored too, the model and the bar agreed on 14 of 19: it spoke 2 times the bar would not, and stayed quiet 3 times the bar would have spoken
```

"Watcher calls saved" counts the moments the model was sure of (noise, or worth it), where the Watcher was not asked.
A moment the [pace](watcher.md#when-the-server-is-slow) held back after an unsure sort cost no call either, but that
saving is the pace's. "The rules' remarks" are the remarks of the same days the model did not decide: those from before you added it,
and those it fell back on.

## Next steps

The decision API is one way in: a question in `QUESTIONS` (`src/decision.mjs`), a state to judge, and
`DecisionModel.decide(names, state)`, with the same timeout, health and fallback. These places are meant to use it
next. None of them is built yet:

- **When to interrupt.** The [held thought](watcher.md#the-held-thought) waits for a breakpoint by fixed rules. The
  model could judge whether now is a breakpoint.
- **Drift.** Whether a file is part of the goal is a yes or no the Watcher answers with a score today.
- **Is the user stuck?** On the [search trail](neovim.md#the-search-trail): whether the searches go in circles,
  with a probability instead of a fixed count.
- **Routing.** Which role, or which model, a question or a remark should go to.
