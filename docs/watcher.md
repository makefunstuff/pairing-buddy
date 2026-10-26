# The Watcher: fast and well-judged

Every candidate remark (a failed command you missed, the same error again, a new diagnostic, a stall, drift) goes through the speak gate before the Partner writes a word. The gate asks the Watcher model for a score from 0 to 10, so the Watcher must answer in well under a second, and must not make the Partner's model slower. This page says how Pair keeps it that way.

## The order of the gate

1. **Typing.** While you type, the trigger waits for your next pause; nothing is asked.
2. **Budget.** When the talk level's budget is spent (too many remarks this hour, or the last one too recent), the trigger is dropped; nothing is asked.
3. **Prefilter.** Cheap rules drop what is plainly noise, without a model (below).
4. **Watcher.** The model scores what is left. Below the trigger's bar the trigger is dropped; at or above it, the Partner gets it.

Each trigger is looked at once: a dropped trigger does not come back. Drift is the exception for the budget: it lasts as long as you stay in that file, so when the budget holds it back it is looked at again on each tick (logged once) until the budget allows, and then judged.

## The prefilter

The rules only ever drop; anything they are unsure of goes to the Watcher.

| Rule | Example |
| --- | --- |
| Exit 1 of a command whose exit 1 is an answer, not a failure | `grep`, `rg`, `ag`, `diff`, `cmp`, `test`, `[`, `which`, `pgrep`, `git diff`, `git grep` finding nothing or a difference |
| A command you stopped yourself | exit 130 (Ctrl-C) or 143 |
| Drift into a file whose path shares a word with the goal | goal "reconnect waits 30 s after the phone sleeps", editing `src/power/sleepWatch.ts` or `src/net/reconnecting.ts` |

Paths are split into words at slashes, dots, underscores and camelCase. A path word must be a goal word, give or take a plural or verb ending ("sleep" matches "sleeps", "cache" matches "caches"), never just share a prefix ("form" does not match "formatted"). Goal words shorter than four letters, and common ones like "test", "code", "file" or "error", do not count. What you typed in the file is not looked at: code is full of ordinary words ("wait", "user", "index") that any goal may share.

## A short question, a short answer

- The Watcher sees a few lines: the goal, the current file and cursor, where you are looking, your last keystroke, and what just happened. The Partner gets the full picture only once the gate lets the remark through.
- It answers with the score alone, a single number, and may write at most 8 tokens. A JSON answer with a reason took about ten times as many tokens, and on a local server every token written adds to the wait.
- Drift gets a question of its own: how clearly the file you now edit is unrelated to the goal, with the goal named in the question. Asked whether you would want a remark, models score how important the work is instead.
- A smaller Watcher model than the Partner's is faster, but small models tend to judge drift badly (scoring it 0 or 1), and on a server that keeps one model loaded every swap costs far more than it saves. One mid-sized model for both roles is the tested setup.
- Drift is checked once for each file you move into (and again on another branch), right when you start editing it, not once every ten minutes.

## Keep-warm

Many local servers unload a model that has not been asked for a few minutes, and loading it again takes from seconds to minutes: the Watcher's call then times out, and Pair stays quiet until the model is back. While you work (a key, an edit or a command in the last five minutes), the daemon makes sure the Watcher's model has been asked something in the last four minutes: if not, it sends the Watcher's own instructions with a one-token answer. When you stop working, the pings stop too, and the server may unload the model as it likes.

`"keepWarm": false` turns this off. With an `anthropic` Watcher it is off unless you set it: a cloud model is never unloaded, and each ping would be a paid request.

## Two roles, one loaded model

Some servers keep only one model in memory and swap on request (a llama.cpp router with one model at a time, or a model switcher in front of a single-model server). With two different models for the Watcher and the Partner on such a server, every remark would swap twice: once for the Watcher's score and once for the Partner's words.

The simple fix is one model for both roles: a mid-sized model answers the Watcher's short question fast enough. If you configure two models on one server anyway, Pair avoids the swaps where the server says which models it has loaded (its `/models` list then marks each one loaded or not): while only the Partner's model is loaded, the Watcher scores with that one. When the Watcher's own model is loaded, or none is, or the server does not say, the Watcher uses its own. The daemon's log says when the Watcher switches. The health probe follows the same choice, so it does not swap models either.

## Measuring it

`pair doctor` times one short answer of each model. The live tests time the Watcher on each scenario, and the scripted session (`test/live/dogfood.test.mjs`) plays a twelve-minute session through a real Pair session on a simulated clock: edits, a failing test watched, a `grep` that finds nothing, the same failure again, a typo in new code, a failure missed while in the editor, a stall, a question, and drift into unrelated code. It prints the whole session like a transcript, with every gate decision and every remark, and checks that Pair spoke two to four times, on the repeated failure and on the drift among them.
