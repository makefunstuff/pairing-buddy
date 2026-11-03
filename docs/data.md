---
description: "What Pair keeps and where: logins and keys by the config, the rest in its data folder, an index in your repository if asked, and what leaves the machine."
---

# Data and privacy

- **Logins and keys** live next to the config, readable by you only ([models.md](models.md#logins-and-keys)):
  `auth.json` (logins and stored keys; `$PAIR_AUTH` moves it), `service.env` (the variables your entries name in
  `apiKeyEnv`, stored by `pair setup` for the service) and `device-id` (the id "Sign in with ChatGPT" is given; it
  sits next to `auth.json` and moves with it).
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
| `voice/` | A [push-to-talk](voice.md) recording, only while whisper.cpp reads it (LFM3-Omni's and OpenRouter's are kept in memory only); and once you turn it on (`:Pair voice on`), `voice/lfm3-omni/`: LFM3-Omni's files (4.0 GB, each with its checksum note) and in `cache-<revision>/` their weights packed for your CPU (4.2 GB). `:Pair voice off` deletes them |
| `off` | After `:Pair find off` with an `embedding` model: the note that keeps search by meaning off until `:Pair find on` (semantic-grep's, in Pair's data folder) |
| `index/` | [Search by meaning](meaning.md#the-index)'s index, [semantic-grep](https://github.com/makefunstuff/semantic-grep.nvim)'s, a SQLite file per repository (`<repository>-<hash>.sqlite`), shared by its worktrees: each piece of code's file, lines, hash, kind and name, the FTS5 index of its words (lower case and stemmed, with their places, but not the text itself), and a vector per piece (256 numbers, about 1 KB, for EmbeddingGemma); no copy of the code. `:Pair find off` deletes them, `:Pair index rebuild` makes one again |
| `meaning/` | [Search by meaning](meaning.md)'s EmbeddingGemma 2, once you turn it on: its model (`embeddinggemma-2-text-270m.litertlm`, 165 MB, with its checksum note), and `venv/`, the venv with its runtime LiteRT-LM that `:Pair find on` makes (with a `venv-made-by-pair.json` note next to it) unless you made it there yourself. `:Pair find off` deletes the model and the venv Pair made |
| `daemon.log` | The daemon's log, when `pair` started it (under systemd it goes to the journal, under launchd to `~/Library/Logs/pairing-buddy.log`) |
| `daemon.lock` | Makes sure one daemon owns the files above |

The [run log](exploration.md) (each build's and run's output and the lines you typed before it) is kept in the
daemon's memory only, for the session.

Nothing is written to your repository, unless you put [search by meaning's index](meaning.md#the-index) there
(`"meaning": {"index": "project"}`: `.pair/index.sqlite`, and `.pair/` in `.git/info/exclude`). The work board (Shepherdr) is read, and written to only when you pick it:
[`/gen board`](gen.md#gen-board-a-task-for-the-board) adds one task, with its brief shown to you first, as the pick you
chose says (add only, add and delegate, delegate with a plan first, or delegate for research only), and a task's
[review](gen.md#reviewing-a-board-task-pair-review) tells its agent what you wrote, asks it to merge (a tell), or
archives the task, each on the pick that names it, and [`/brief sync`](gen.md#keeping-the-task-in-step-brief-sync)
tells the branch's task what changed in the brief, on its pick too. What the board's working tasks change is read with
git, never changed. Nothing leaves your machine
except the requests to the model endpoints you configured (OpenRouter's voice too, when you set it), search by meaning's one-time
downloads when you say yes to them (EmbeddingGemma 2 from Hugging Face, LiteRT-LM's wheel from PyPI) ([meaning.md](meaning.md#why-this-model-and-runtime)), `gh pr view` for the
[context card](neovim.md#what-it-knows-the-context-card) when `gh` is installed and, for a login, to the provider's
sign-in service. Those requests carry your code: the Watcher gets each moment's text (your edits, a command's
output, a test's failure), and the Partner the files and lines it reads, the diffs it suggests and your questions; an
[embedding model](meaning.md) of your own gets the text of each piece of code it indexes, and your searches. With
a cloud provider, that code goes to the provider: check that your employer allows it before you use Pair on work code;
a local server keeps it on your machine. A [decision model](decision.md#what-it-is-told), when you set one, gets each moment's kind and
text, your goal, the paths you edited, your last commands and test counts, and your verdicts on earlier remarks; never
the contents of a file. With [voice through OpenRouter](voice.md#openrouter), your spoken question's recording goes to
OpenRouter's transcription model, and the answer's first sentences to its speech model.
