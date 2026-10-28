---
description: "/gen: ask Pair for code. It lands where you asked, you take it with one key, and /undo takes the whole request back. Every edit says who made it."
---

# /gen: ask Pair for code

Pair writes code when you ask for it, and only then. `/gen here a list handler with paging` (or `Alt-g` in Neovim)
is a request: it gets a number, `gen #3`, runs in a conversation of its own, and hands you a proposal at the place
you asked. You take it with one key, or not. Taken code lands in your buffer unsaved, as one undo step: as with
everything Pair does, the disk changes only when you save. `/undo` takes back everything a request gave you, as one.

A request never changes your text by itself, so it is not the Driver: the Driver edits while you watch and is held to
five edits, while a request makes proposals you review, and is held by size limits instead
([driver.md](driver.md#the-driver-and-gen)).

This version builds one shape, `here`. The others are named, guessed and confirmed like it, and then say they are
not built yet.

## Asking

**In Neovim**, `Alt-g` (the `gen_key`) or `:Pair gen` asks what Pair should write, in a dialog:

- The dialog is Neovim's own `vim.ui.input`, and the shape and Pair's questions are `vim.ui.select` and
  `vim.ui.input`. Pair draws no dialog of its own: a plugin that replaces those hooks, such as
  [snacks.nvim](https://github.com/folke/snacks.nvim)'s input, dressing.nvim or noice.nvim, shows them as floating
  dialogs. Without one, Neovim's own prompt on the command line asks, sent on Enter, and the shape is a numbered
  list. `gen_input = 'cmdline'` always uses Neovim's own ([neovim-plugin.md](neovim-plugin.md#setup)).
- `Tab` completes the shape word, the first word: `here`, `file`, `scaffold`, `try`.
- `Esc` asks nothing. An empty `Enter` opens the compose window, for a request longer than one line: a small
  Markdown window where `:w` or `Ctrl-S` sends it, and `:q` drops it. `:Pair gen +` opens it at once.
- `:Pair gen [here] <what>` asks without the dialog. `:Pair gen cancel` stops the request that runs or waits.
- With a selection, `Alt-g` in Visual mode or `:'<,'>Pair gen`: in code, the code replaces those lines, so the shape
  is `here` and the dialog asks only what to write. In a Markdown note, the selected lines are the request itself: the
  dialog shows their first line to send or change, the rest goes with it, and the shape is guessed.

**In the chat**, `/gen here <what>` asks for code at your cursor in the Neovim you work in, and `@here` in it means
over the lines you selected there last. `/gen` alone lists today's requests, and `/gen cancel` stops the one that
runs or waits. `/cancel` stops a running request too, when Pair answers nothing else.

## The shape

| Shape | What it makes | Built |
| --- | --- | --- |
| `here` | Code at the cursor, or over the selection: a query, a handler, a config block | yes |
| `file` | New files to review, as unsaved buffers | not yet |
| `scaffold` | Many files and their wiring, in a copy of the project in Pair's data folder | not yet |
| `try` | A sample to read and run, outside the project | not yet |

When the request does not start with a shape word, a cheap rule guesses one from it, never the model: a selection in
code is `here`; then words like "here", "below this" or "this function" mean `here`; "scaffold", "wired into", "an
app" mean `scaffold`; "sample", "example", "to try" mean `try`; a file name or "migration", "test file", "new file"
mean `file`; anything else is `here`. A guess is always shown first, and goes only once you confirm it, so `scaffold`
is never picked silently. A shape you typed is not asked about.

In Neovim the guess comes as a list with the guess first, so `Enter` takes it:

```
gen #1 · new files: "migration". Shape?
1: file      new files to review  (guessed)
2: here      at the cursor, over a selection
3: scaffold  many files, in Pair's copy  (not built yet)
4: try       a sample outside the project  (not built yet)
```

In the chat, `y` takes the guess, a shape word another, and `n` cancels.

## How a request runs

- **Its own number and conversation.** Requests are numbered per project, `gen #1`, `gen #2`, and each runs in a
  conversation of its own on the Partner's model, at the thinking level of `gen` (`medium` unless the config says,
  [config.md](config.md#model-entries)). Your questions in the chat still get answers meanwhile, in the
  session's own conversation, and Pair keeps its role: a request is no role you switch to.
- **One at a time.** A second request waits for the first, and the statusline and the chat say so.
- **No unasked remarks.** While a request runs, no remark nobody asked for starts: what comes up waits, as it waits
  while Pair answers you. What a request says in the chat is no remark, and costs no talk budget.
- **What it is told.** Your words, where the code goes (the cursor's line, or the lines you selected), the lines
  around that place as your buffer has them, and the session goal.
- **Its tools.** `say`, `read`, `recall`, `search` (in Pair's pane, also outside Scout), `propose` and `ask`. Never
  `edit`, `type`, `run`, `suggest` or `point`, and a policy in code refuses them
  ([how-it-works.md](how-it-works.md#what-it-can-do)). `propose(file, line, end_line, insert, text, note)` puts the
  code below `line` (`insert`), or in place of `line`..`end_line`; for `here`, only in the file you asked in.
- **Its questions.** When a wrong guess would cost you, the model may ask: at most two questions per request, each
  with the answer it would take. They are asked where you asked. In Neovim it is a dialog with that answer filled in,
  never while you type: in Insert mode or right after a change it waits for your pause, and meanwhile the statusline
  says `gen #4 asks · M-g`. `Esc` leaves it waiting, and `Alt-g` shows it again. In the chat, `y` keeps the answer
  given, `n` leaves it to Pair, and anything else is your answer; a question asked in Neovim also shows in the chat,
  to read.
- **Its limits** (`gen.limits` in the [config](config.md#gen)). They stop a model that loops; they are no review
  budget. A request already running keeps the limits it started with.

| Limit | Default | What happens past it |
| --- | --- | --- |
| `lines` | `4000` | The proposal is refused: the model is told to propose less |
| `files` | `40` | A proposal in one more file is refused |
| `commands` | `8` | Searches past it are refused |
| `minutes` | `10` | The model is stopped; what it proposed so far still shows. Time a question waits for you does not count |

## The code lands where you asked

When you ask in Neovim, the place you asked at (the cursor's line, or the selection) is marked, so you can keep
typing. The code shows at your next pause in typing, as ghost lines under the mark, which moved with what you typed
meanwhile: `gen #2 · a list handler · M-y takes it`. Over a selection, the lines it replaces are struck through, as for
any suggestion. A proposal does not count toward the five suggestions that show at once, and neither pushes the
other out.

A block taller than `gen_preview_lines` (30 lines), or than the window it lands in, is one line in place, `gen #6 · 84 lines: the routes table · M-y
takes · M-j preview`, and the block shows in a preview window under it, with the file's syntax, when that line is in
view. `Alt-j` goes into the preview, to scroll; `q` closes it, and `Alt-y` there or in your buffer takes all of it.
Neovim shows ghost lines at most a window less one at a time: in a 22-row window, 40 of them show as their first 21,
and one `Ctrl-E` jumps to their last 21, so a taller block cannot be read in place.

| You | What happens |
| --- | --- |
| `Alt-y`, `:Pair accept`, or `a` on it in the chat | The code goes into your buffer, unsaved, as one undo step. It is the request's code (`gen:#2`, below) until you edit it |
| `:Pair dismiss`, or over a selection, edit the lines it replaces | It is dropped: the ledger says so, and there is nothing of it to undo |
| `/undo`, or `u` on the request in `:Pair today` | The whole request goes (below) |

Once you take it, the code is checked on your unsaved buffer as after a [hand-over](driver.md#the-check-on-the-unsaved-buffer):
with the project's command on save, else your last build and run (a command from your terminal that Scout would ask
about asks you first). The result shows once, with `✓` or `✗` under the lines taken and in the chat, and the
Watcher adds no remark of its own about it. No command, no check.

## One undo per request

The ledger books a request as one line: `generated  gen #3 · here · a list handler with paging`, with a note that
follows it (`3 lines proposed`, `1 of 1 piece taken`, `1 dropped`, `cancelled`). `/undo` in the chat takes back the
last thing Pair changed today, and for a request that is all of it:

- a request that still runs or waits stops;
- what it proposed and you did not take goes;
- what you took is undone, newest first, merged into your buffers as they are now, so your edits since stay. Code
  you have changed since cannot be taken back, and the chat says which.

`u` on the request in [`:Pair today`](neovim.md#the-ledger) does the same for any request of the day, and `u` again
makes what you took again. Neovim's own `u` right after taking undoes that one step, as your own edit.

## Who wrote it: edits carry their origin

Pair watches what you write and speaks about it: an error in code you just wrote, a file that drifts from the goal,
an edit while a test is red. For that it has to know which code is yours. Pair also changes your buffer itself: the
Driver types its edits while you watch, a suggestion you take with `Alt-y` replaces your lines, `u` in `:Pair today`
undoes one of Pair's edits later, and code you take from a request lands. Each of those changes says who made it.

Every edit the Neovim plugin sends to the daemon has an `origin`:

| Origin | Who made the edit |
| --- | --- |
| `user` | You: your typing, your `u`, a formatter or plugin you ran |
| `pair` | Pair, for you: the Driver's typing (also the undo of an edit you stopped halfway), a suggestion you took (`Alt-y`, `:Pair accept`, `a` in the chat pane, the slice of `:Pair new`), and an undo or redo from `:Pair today` |
| `gen:#n` | A `/gen` request, by its number: the code you took from it, and its undo or redo from `/undo` or `:Pair today` |

The plugin never sends your edits and Pair's as one: edits of yours still waiting for the debounce (`debounce_ms`)
are sent before Pair changes the buffer, and Pair's change is sent as soon as it is in. An edit without an origin
(an older plugin) or with one the daemon does not know counts as yours.

### What changes for Pair's edits

The daemon keeps the origin with each edit. An edit Pair made:

- **is no news about your code.** `new_code_diagnostic` is raised only when the newest edit near the error is
  yours. `drift` and `edit_while_red` look at your own last edit, so the Driver working in another file is not you
  drifting from the goal or taking a wrong turn while a test is red. `new_warning` leaves out a warning on lines
  Pair edited last, and a file only Pair edited is no file you edited. In a Markdown note, text Pair put there is no
  question you asked (`note_stall`) and no section you began (`note_drift`).
- **is not you at the keyboard.** It is no keystroke (the speak gate's typing pause, "Last keystroke"), does not
  move the current file, and counts neither as active time nor as you using the session (which ends after you are
  away long enough). The plugin sends no "still typing" signal for it.
- **is still an edit.** The Partner sees it among the recent edits as `a.js:2-2 (3 s ago, by Pair)`, or `by Pair
  (gen #3)`, the decision model as `"by": "pair"`, and the run log counts it as a change of the code. A `regression`
  (the tests on save fail where they passed) still speaks, whoever made the change.

### Edits outside the project

An edit of a file outside the session's project (a scratch file, another repository, a file in Pair's own data
folder, where `/gen try` will put its samples) is dropped when it reaches the daemon, whoever made it. It raises no
`drift`, is no file you edited, and is not counted as work in this session.

### Making Pair's lines yours

Lines Pair wrote become yours when you edit them: the newest edit of a line decides. An edit of yours elsewhere in
the file leaves Pair's lines Pair's.

## Limits

- Only `here` is built. `file`, `scaffold` and `try` are named and guessed, and say they are not built yet.
- A request knows your words, the place and the session goal. A pinned note as the request's brief, and a check of
  the code against it, are not in this version.
- Taken code carries no mark of its own in the sign column, and `:Pair own` does not exist yet: it stays the
  request's until you edit its lines, as far as its origin can be followed ([above](#who-wrote-it-edits-carry-their-origin)).
- A request lives in the daemon's memory. A daemon restart stops one that runs, and code it proposed that you did not
  take is gone; the ledger line stays, and what you took can still be undone from it.
- The code shows in the Neovim you work in; a second Neovim on the same project does not show it.
- A request from the chat asks its questions in the chat only; one from Neovim asks in Neovim, and the chat shows
  them to read.
- The daemon keeps the last 20 edits of the session, with their line ranges as they were sent. An origin is not
  followed as lines move: after many edits, or lines added above, an older edit of Pair's no longer marks its
  lines, and they count as yours again.
- The origin lives in the session's state, not in the store: after a daemon restart, earlier edits are no longer
  known.
- Neovim's own undo of code you took (`u` in the buffer) is your edit, since you pressed the key.
