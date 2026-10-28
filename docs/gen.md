---
description: "Every change Pair makes in your buffer says it was Pair, so the Watcher never remarks on Pair's code as if you had written it. The first step of /gen."
---

# Who wrote it: edits carry their origin

Pair watches what you write and speaks about it: an error in code you just wrote, a file that drifts from the goal,
an edit while a test is red. For that it has to know which code is yours. Pair also changes your buffer itself: the
Driver types its edits while you watch, a suggestion you take with `Alt-y` replaces your lines, and `u` in
`:Pair today` undoes one of Pair's edits later. Each of those changes now says who made it.

This is the first step of `/gen`, a way to ask Pair for code (a block at the cursor, new files, a scaffold, a sample
to try). `/gen` itself is not in this version: the rest of it builds on this step, and this page grows as it lands.

## The origins

Every edit the Neovim plugin sends to the daemon has an `origin`:

| Origin | Who made the edit |
| --- | --- |
| `user` | You: your typing, your `u`, a formatter or plugin you ran |
| `pair` | Pair, for you: the Driver's typing (also the undo of an edit you stopped halfway), a suggestion you took (`Alt-y`, `:Pair accept`, `a` in the chat pane, the slice of `:Pair new`), and an undo or redo from `:Pair today` |
| `gen:#n` | A `/gen` request, by its number. Nothing sends it yet; the daemon already keeps it |

The plugin never sends your edits and Pair's as one: edits of yours still waiting for the debounce (`debounce_ms`)
are sent before Pair changes the buffer, and Pair's change is sent as soon as it is in. An edit without an origin
(an older plugin) or with one the daemon does not know counts as yours.

## What changes for Pair's edits

The daemon keeps the origin with each edit. An edit Pair made:

- **is no news about your code.** `new_code_diagnostic` is raised only when the newest edit near the error is
  yours. `drift` and `edit_while_red` look at your own last edit, so the Driver working in another file is not you
  drifting from the goal or taking a wrong turn while a test is red. `new_warning` leaves out a warning on lines
  Pair edited last, and a file only Pair edited is no file you edited. In a Markdown note, text Pair put there is no
  question you asked (`note_stall`) and no section you began (`note_drift`).
- **is not you at the keyboard.** It is no keystroke (the speak gate's typing pause, "Last keystroke"), does not
  move the current file, and counts neither as active time nor as you using the session (which ends after you are
  away long enough). The plugin sends no "still typing" signal for it.
- **is still an edit.** The Partner sees it among the recent edits as `a.js:2-2 (3 s ago, by Pair)`, the decision
  model as `"by": "pair"`, and the run log counts it as a change of the code. A `regression` (the tests on save
  fail where they passed) still speaks, whoever made the change.

## Edits outside the project

An edit of a file outside the session's project (a scratch file, another repository, a file in Pair's own data
folder, where `/gen try` will put its samples) is dropped when it reaches the daemon, whoever made it. It raises no
`drift`, is no file you edited, and is not counted as work in this session.

## Making Pair's lines yours

Lines Pair wrote become yours when you edit them: the newest edit of a line decides. An edit of yours elsewhere in
the file leaves Pair's lines Pair's.

## Limits

- The daemon keeps the last 20 edits of the session, with their line ranges as they were sent. An origin is not
  followed as lines move: after many edits, or lines added above, an older edit of Pair's no longer marks its
  lines, and they count as yours again.
- The origin lives in the session's state, not in the ledger or the store: after a daemon restart, earlier edits
  are no longer known.
- Neovim's own undo of an accepted suggestion (`u` in the buffer) is your edit, since you pressed the key.
