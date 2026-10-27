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
| `sessions.sqlite` | Sessions, goals, chat history, session notes and debriefs (with where the next session picks up), active time (in all and per project), the remarks with your verdicts, what the [decision model](decision.md) answered about each moment it judged (its probabilities, the Watcher's score, what the rules would have done, the remark it led to, and the state it was told), and the [ledger](neovim.md#the-ledger) of what Pair did (what an entry opens to, a command's output or an edit's text before and after, for a week) |
| `runs/` | The output of the latest [tests on save](tests-on-save.md) run of each session |
| `daemon.log` | The daemon's log, when `pair` started it (under systemd it goes to the journal, under launchd to `~/Library/Logs/pairing-buddy.log`) |
| `daemon.lock` | Makes sure one daemon owns the files above |

The [run log](exploration.md) (each build's and run's output and the lines you typed before it) is kept in the
daemon's memory only, for the session.

Nothing is written to your repository or to the work board (Pair only lists its tasks). Nothing leaves your machine
except the requests to the model endpoints you configured, `gh pr view` for the
[context card](neovim.md#what-it-knows-the-context-card) when `gh` is installed and, for a login, to the provider's
sign-in service. Those requests carry your code: the Watcher gets each moment's text (your edits, a command's
output, a test's failure), and the Partner the files and lines it reads, the diffs it suggests and your questions. With
a cloud provider, that code goes to the provider: check that your employer allows it before you use Pair on work code;
a local server keeps it on your machine. A [decision model](decision.md#what-it-is-told), when you set one, gets each moment's kind and
text, your goal, the paths you edited, your last commands and test counts, and your verdicts on earlier remarks; never
the contents of a file.
