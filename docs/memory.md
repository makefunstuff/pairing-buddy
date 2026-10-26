# Memory and feedback

Pair remembers where the last session in a project stopped, and learns from you when a remark is worth making. Both live in the daemon's data directory (`sessions.sqlite`), never in your repository, and never leave your machine.

## The session note

`/end` in the chat (or `:Pair end`) ends the session. Pair then asks the Partner for a short note of at most six lines: the goal, what changed, and the loose ends. With the request it gets the session goal and `git status --short` (the first 20 lines), so even a small model can say which files changed. The note shows in the chat and is kept with the session.

A heading the model adds itself is dropped. If the Partner cannot answer (the model is down) or answers with nothing, no note is kept (the chat says why when the model failed): the next session then starts from the last good note.

## The next session starts from it

The next session in the same project (the same git root) starts from the last note, in two ways:

- The chat shows it before asking for the new goal:

  ```
  ·· Last time:
  Goal: reconnect drops after the phone sleeps.
  Changed: RECONNECT_TIMEOUT_MS in src/ws.ts is now 30000.
  Loose end: try it on a real phone.
  ·· What are we doing this session? Type the goal here.
  ```

- The Partner's instructions carry it, with the advice to use it when you ask about the last session or its loose ends, and not to bring it up otherwise. "What did we leave open last time?" gets an answer from it; a remark nobody asked for is not made because of it.

Each project has its own memory. Only the last note is carried over, not the whole chat or the old conversation: that keeps the context small for local models. The chat history and every note stay in `sessions.sqlite`.

## Feedback on remarks

Every remark Pair makes unasked can get your verdict: useful, or noise. Answers to your own questions are not remarks and get none.

| Where | Useful | Not useful |
| --- | --- | --- |
| Chat pane | `+` (or `/useful`) | `-` (or `/noise`) |
| Neovim | `Alt-u` (`<M-u>`, or `:Pair useful`) | `Alt-n` (`<M-n>`, or `:Pair noise`) |
| A suggestion in the remark | accepting it (`Alt-y`, `:Pair accept`) | `:Pair dismiss` |

- In the chat, a remark ends with a dim `+ useful  - noise` line. The verdict goes to the last remark.
- In Neovim, `Alt-u` and `Alt-n` are mapped (in Normal mode) only while a remark waits for a verdict, and only if you have no mapping of your own on them; they go away after the verdict. Change them with the plugin's `useful_key` and `noise_key` options, or `false` for none; the commands work either way.
- A later verdict replaces an earlier one: `-`, then accepting the suggestion after all, counts as useful.
- **A remark you ignore counts as not useful.** With no verdict after ten minutes, a remark is counted as ignored. Before that it is "waiting" and counts for nothing.
- A remark that ends in SILENT never reached you, so it is not stored and cannot count as ignored.

## Learning when to talk

With `"autoTune": true` (the default), Pair tunes two things from your verdicts. It looks at the verdicts of the last 30 days, at most the last 20 per trigger, so it follows your recent habits. It tunes the bars and budget of every project together.

**Each trigger's bar** (the Watcher score a remark needs), once a trigger has at least 5 verdicts:

| Kept (useful ÷ judged) | Bar |
| --- | --- |
| under 25% | +2 |
| 25% to under 40% | +1 |
| 40% to 75% | as the level says |
| over 75% | −1 |

**The budget** (remarks per hour, and the gap between them), once there are at least 10 verdicts in all:

| Kept, over all triggers | Remarks per hour | Gap |
| --- | --- | --- |
| under 30% | half | twice as long |
| 30% to under 50% | three quarters | a third longer |
| 50% to 80% | as the level says | as the level says |
| over 80% | one and a half times | two thirds |

The safe bounds hold whatever the numbers say: a bar moves at most 1 down and 2 up from the level's, and stays between 3 and 9, so no trigger is ever silenced completely; the budget scales between half and one and a half times the level's, and always allows at least one remark per hour. The talk level stays yours: `/level` moves all bars and the budget, and the tuning applies on top.

`"autoTune": false` in the config keeps the level's bars and budget. Your verdicts are still recorded, and `pair stats` still shows them.

## `pair stats`

`pair stats` shows the last 7 days (`--days N` for another span), across all projects. It reads the data directory, so it works whether the daemon runs or not.

```
Last 7 days, all projects: 6.5 h of active pairing, 14 unasked remarks (2.2 per hour)
useful 6 · dismissed 3 · ignored 4 · waiting 1 · kept 46%

trigger              remarks  per hour  useful  dismissed  ignored  kept     bar
failed_command             5       0.8       4          0        1   80%  5 (-1)
repeated_error             2       0.3       1          1        0   50%       6
new_code_diagnostic        1       0.2       1          0        0  100%       6
stall                      1       0.2       0          0        0     -       6
drift                      5       0.8       0          2        3    0%  8 (+2)

Budget at level normal: at most 5 remarks per hour, 5 min 20 s apart (the level's default: 6, 4 min)
Tuning follows your verdicts of the last 30 days: a trigger needs 5 of them to move its bar, the budget 10.
```

- **Active pairing** is the time in which you typed, edited or ran a command in the last five minutes, while a session was open. Remarks per hour are counted against it, not against the hours a session stood open, and shown from six minutes of it on.
- **kept** is useful ÷ (useful + dismissed + ignored); remarks still waiting do not count.
- **bar** is the Watcher score each trigger needs now, with the tuning's change from the level's bar in brackets.
- **Budget** is what the tuned budget allows now at your configured level.
