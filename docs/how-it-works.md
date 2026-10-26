# How it works

```
Neovim plugin ──┐                         ┌── Watcher model: is this worth a remark? (0-10)
chat pane ──────┼── pair daemon (socket) ─┤
shell hook ─────┤   events → session state└── Partner model: the words, and its role's tools
herdr panes ────┘   → triggers → speak gate + budget        │
                                                             ├── Pair's own herdr pane (Scout: search, run)
                                                             └── your buffer and terminal (Driver: edit, type)
```

Pair is a long-lived daemon built on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable). It
collects what happens in your editor and terminal, decides when a remark is worth making, and asks two models: a
small, fast **Watcher** that scores each moment with one number, and a **Partner** that writes the words and uses
its role's tools.

## What it sees

- **Neovim.** The plugin sends edits (about 2 s after you stop typing), the current file, cursor, selection, LSP
  diagnostics, and your Telescope and snacks.picker searches.
- **herdr.** The daemon watches your herdr panes for focus, commands and their output
  ([herdr.md](herdr.md) says how, and what herdr lacks).
- **Where you have been.** Your buffers and jumplist, the herdr work board's task for your branch, and git (branch,
  last commit, changed files, pull request). The [context card](neovim.md#what-it-knows-the-context-card) shows all of
  it, and what you hide there is not sent.
- **The shell hook** (optional) adds exit codes, and catches commands too short for herdr's polling.
- **Builds and runs** are read for a crash and where in your code it happened, and for the compiler's errors and
  warnings with their file and line ([builds.md](builds.md)). A segfault counts as a failure also without an exit code.
- **Test output** is parsed (cargo, go test, jest, vitest, pytest, `node --test`): which tests failed and the first
  error line ([scout.md](scout.md#test-results)). With [tests on save](tests-on-save.md), the runner's JSON report
  also says where each test is.

## When it speaks

A remark can come from one of these moments (its **trigger**):

| Trigger | The moment |
| --- | --- |
| `failed_command` | A command failed in a pane you are not looking at |
| `repeated_error` | The same error a second time (the same failing test twice counts) |
| `new_code_diagnostic` | An error diagnostic in code you just wrote, after you moved on |
| `stall` | No progress for a while after a failure |
| `drift` | You edit a file that looks unrelated to the session goal |
| `edit_while_red` | The wrong turn: while a test is red, you edit a source file the failure does not name (a test and the code it tests, like `worker_test.go` and `worker.go`, count as one) |
| `regression` | The tests Pair ran when you saved fail where its run before did not |
| `crash` | A build or run died of a signal or reported a fault (a sanitizer, a failed assert, a panic), also while you look at it: the terminal says that it crashed, not why ([builds.md](builds.md)) |
| `new_warning` | A build printed a warning in a file you edited that no build before it printed; Pair speaks only for a bug ([builds.md](builds.md)) |
| `search_trail` | Three or more Telescope or snacks.picker searches since your last edit, one of them closed with nothing opened, or repeated. The remark gets what fails now, so it can say where the thing is in the code's own word ([neovim.md](neovim.md#the-search-trail)) |

A failed test run counts as failed even without an exit code, and the remark names the failed tests and the first
error. A direct question in the chat is always answered.

## The speak gate

For anything unasked:

1. Cheap rules drop what is plainly noise: a `grep` that finds nothing, a command you stopped, editing a file whose
   path shares a word with the goal.
2. The Watcher scores the moment from 0 to 10 with a single number. Only scores at or above the talk level's bar reach
   the Partner.
3. The budget limits how often Pair speaks ([talk levels](config.md#talk-levels)).

Pair never speaks while you type in Neovim or the chat pane: a remark that is ready while you type waits for your
next pause. One that can wait (drift, a stall, an error in code you moved on from) waits longer, for your next break:
a save, a run that ended, a stop out of Insert mode, or a quiet stretch. Meanwhile a `•` in Neovim's margin marks it,
and `Alt-j` shows it early. Details in [watcher.md](watcher.md).

## What it can do

Each role has a fixed set of tools:

| Tool | What it does | Navigator | Scout | Driver |
| --- | --- | --- | --- | --- |
| `say` | A chat message | yes | yes | yes |
| `point` | Mark lines in Neovim with a short note and the code it means; `Alt-j` goes there | yes | yes | yes |
| `open` | Show a file in a split, asking first while you type | yes | yes | yes |
| `read` | Read a file as the editor has it, or list a directory; Neovim shows where it reads | yes | yes | yes |
| `suggest` | Show a change in place that you accept with one key or ignore | yes | yes | yes |
| `search` | ripgrep, typed in Pair's own herdr pane | no | yes | yes |
| `run` | One command line in Pair's own pane, under the [command policy](scout.md#the-command-policy) | no | yes | yes |
| `edit` | One change in your buffer, typed while you watch, one undo step | no | no | once per hand-over |
| `type` | One line into your terminal, after your yes, without Enter | no | no | after a yes |

The lists are enforced in code: each conversation is offered only its role's tools, and a `beforeTool` policy
refuses any other name ([driver.md](driver.md#the-policy-in-code)). Nothing in the daemon writes your files or saves
buffers, and nothing is typed into your own panes except the Driver's `type`.

## How it talks

Pair's instructions give it a tone: a colleague in the second chair, not an assistant. The fact and its `file:line`
first, the numbers, no praise, apology, filler, emoji or `!`, and at most 30 words for a remark, 80 for an answer.
Asked why, it gives the one idea worth keeping behind what it said. Both are in [tone.md](tone.md).

## What it remembers

Each project gets one long-lived Partner conversation, stored in SQLite by pi-durable, so a restart of the daemon
keeps the session, its chat and its context. When a session ends, Pair writes a short note (goal, what changed, loose
ends), and the next session in that project starts from it. Every unasked remark can get your verdict, and the
verdicts tune when Pair talks. Both are in [memory.md](memory.md).

Everything Pair does is also booked as it happens, in a ledger: what it read, said, pointed at, suggested, searched,
ran, typed and asked, what its policy refused, and the moments it chose to stay quiet, with why. `:Pair today` lists
the day's; the Driver's edit and an accepted suggestion keep the buffer's text before and after them, so one can be
undone later, merged into the buffer as it is now ([neovim.md](neovim.md#the-ledger)).
