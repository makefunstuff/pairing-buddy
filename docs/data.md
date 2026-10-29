---
description: "What Pair keeps and where: logins in auth.json, the rest in its data directory. Nothing goes into your repository or leaves your machine but model calls."
---

# Data and privacy

- **Logins and keys** live in `auth.json` next to the config, readable by you only
  ([models.md](models.md#logins-and-keys)).
- **Everything else** lives in the data directory: `~/.local/state/pairing-buddy` by default, or under
  `$XDG_STATE_HOME`, or `dataDir` in the config.

| File | What it holds |
| --- | --- |
| `partner.sqlite` | The Partner's conversations, one per project (pi-durable) |
| `sessions.sqlite` | Sessions, goals, chat history (with the remark, place or suggestion each message is about), session notes and debriefs (with where the next session picks up), active time (in all and per project), the remarks with your verdicts, what the [decision model](decision.md) answered about each moment it judged (its probabilities, the Watcher's score, what the rules would have done, the remark it led to, and the state it was told), and the [ledger](neovim.md#the-ledger) of what Pair did (what an entry opens to, a command's output or an edit's text before and after, for a week) |
| `chat-history.json` | What you sent in the [chat pane](chat.md), the last 200 lines of each project, for Up to bring back |
| `runs/` | The output of the latest [tests on save](tests-on-save.md) run of each session and of the hand-over's [check](driver.md#the-check-on-the-unsaved-buffer), and in `runs/trees/` the scratch copy of each project that check runs in (safe to delete) |
| `gen/` | The folders of [/gen try](gen.md#samples-gen-try-and-keep) samples, `gen/<project>-<hash>/try/<n>/`: what the model wrote and what its runs left there; and the copies of the project [/gen scaffold](gen.md#many-files-gen-scaffold) builds in, `gen/<project>-<hash>/<n>/` (with its manifest `<n>.json`), or with `--branch` a git worktree there. Each try or copy goes once it has not changed, run or been used for `gen.keepTries` days (7), or when you delete it (`x`); a worktree only when you delete it (`git worktree remove` works too). Safe to delete, apart from a worktree with commits of yours |
| `panes/` | Pair's own pane: its shell's output log and each command's exit code, one folder per pane, removed when the pane closes ([herdr.md](herdr.md#pairs-own-pane-exact)) |
| `voice/` | A [push-to-talk](voice.md) recording, only while whisper.cpp reads it (OpenRouter's is kept in memory only) |
| `daemon.log` | The daemon's log, when `pair` started it (under systemd it goes to the journal, under launchd to `~/Library/Logs/pairing-buddy.log`) |
| `daemon.lock` | Makes sure one daemon owns the files above |

The [run log](exploration.md) (each build's and run's output and the lines you typed before it) is kept in the
daemon's memory only, for the session.

Nothing is written to your repository. The work board (Shepherdr) is read, and written to only when you pick it:
[`/gen board`](gen.md#gen-board-a-task-for-the-board) adds one task, with its brief shown to you first, as the pick you
chose says (add only, or add and delegate). Nothing leaves your machine
except the requests to the model endpoints you configured (OpenRouter's voice too, when you set it), `gh pr view` for the
[context card](neovim.md#what-it-knows-the-context-card) when `gh` is installed and, for a login, to the provider's
sign-in service. Those requests carry your code: the Watcher gets each moment's text (your edits, a command's
output, a test's failure), and the Partner the files and lines it reads, the diffs it suggests and your questions. With
a cloud provider, that code goes to the provider: check that your employer allows it before you use Pair on work code;
a local server keeps it on your machine. A [decision model](decision.md#what-it-is-told), when you set one, gets each moment's kind and
text, your goal, the paths you edited, your last commands and test counts, and your verdicts on earlier remarks; never
the contents of a file. With [voice through OpenRouter](voice.md#openrouter), your spoken question's recording goes to
OpenRouter's transcription model, and the answer's first sentences to its speech model.
