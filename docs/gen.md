---
description: "/gen: ask Pair for code at your cursor, as new files, a sample or a scaffold, or hand it to the board. Take it with one key; ┊ marks it until it is yours."
---

# /gen: ask Pair for code

Pair writes code when you ask for it, and only then. `/gen here a list handler with paging` (or `Alt-g` in Neovim)
is a request: it gets a number, `gen #3`, runs in a conversation of its own, and hands you a proposal at the place
you asked. You take it with one key, or not. Taken code lands in your buffer unsaved, as one undo step: as with
everything Pair does, the disk changes only when you save. `/undo` takes back everything a request gave you, as one.
Code you took is [marked `┊`](#owning-generated-code) in the sign column until you edit it or say `:Pair own`: it is
not yours yet, and `:Pair today` and `pair stats` say how much of it there is.

Every request runs against [the brief](#the-brief): your goal, your board task and a note of yours, `NOTES.md` by
default. Pair reads it and never writes it. When your request contradicts it, Pair asks one question first; when its
code does, the debrief says so.

A request never changes your text by itself, so it is not the Driver: the Driver edits while you watch and is held to
five edits, while a request makes proposals you review, and is held by size limits instead
([driver.md](driver.md#the-driver-and-gen)).

There are four shapes of code: `here`, code at your cursor; `file`, [new files](#new-files-gen-file) you review as
buffers and take with `:w`; `try`, [a sample](#samples-gen-try-and-keep) to read and run in a folder of its own
outside the project, which `/keep` moves in; and `scaffold`, [many files and their wiring](#many-files-gen-scaffold),
built and run in a copy of the project in Pair's data folder, which you keep a file at a time. A fifth, `board`, writes
no code: it [hands the request to the board](#gen-board-a-task-for-the-board) as a task, on your pick.

## Asking

**In Neovim**, `Alt-g` (the `gen_key`) or `:Pair gen` asks what Pair should write, in a dialog. In a file of the
project the key (and `:Pair gen +`) means here, at the cursor: the dialog says so (`gen here · what should Pair write at line 12?`), and no shape is asked.
A shape word first (`file a migration for …`) still asks for another.

- The dialog is Neovim's own `vim.ui.input`, and the shape and Pair's questions are `vim.ui.select` and
  `vim.ui.input`. Pair draws no dialog of its own: a plugin that replaces those hooks, such as
  [snacks.nvim](https://github.com/folke/snacks.nvim)'s input, dressing.nvim or noice.nvim, shows them as floating
  dialogs. Without one, Neovim's own prompt on the command line asks, sent on Enter, and the shape is a numbered
  list. `gen_input = 'cmdline'` always uses Neovim's own ([neovim-plugin.md](neovim-plugin.md#setup)).
- `Tab` completes the shape word, the first word: `here`, `file`, `scaffold`, `try`, `board`.
- `Esc` asks nothing. An empty `Enter` opens the compose window, for a request longer than one line: a small
  Markdown window where `:w` or `Ctrl-S` sends it, and `:q` drops it. `:Pair gen +` opens it at once.
- `:Pair gen [here|file|try|scaffold|board] <what>` asks without the dialog. `:Pair gen cancel` stops the request that
  runs or waits, and `:Pair gen list` lists the files of `/gen file` requests to review and of scaffolds to keep
  ([below](#the-review-list-pair-gen-list)). `:Pair gen run`, `:Pair gen tries` and `:Pair keep [path]` are for tries
  ([below](#samples-gen-try-and-keep)); `:Pair keep` and `:Pair gen drop` for scaffolds too
  ([below](#many-files-gen-scaffold)).
- With a selection, `Alt-g` in Visual mode or `:'<,'>Pair gen`: in code, the code replaces those lines, so the shape
  is `here` and the dialog asks only what to write. In a Markdown note, the selected lines are the request itself: the
  dialog shows their first line to send or change, the rest goes with it, and the shape is guessed.

**In the chat**, `/gen here <what>` asks for code at your cursor in the Neovim you work in, and `@here` in it means
over the lines you selected there last. `/gen file <what>` asks for new files, which open in that Neovim as buffers to
review. `/gen try <what>` asks for a sample, which opens in that Neovim in a split; `/gen run` runs the newest
again, `/gen tries` lists the try folders, and `/keep [path]` moves the newest try's file into the project.
`/gen scaffold <what>` (`/gen scaffold --branch <what>` for a git worktree) asks for a scaffold; `/keep <path>` keeps
a file of it, and `/gen drop` deletes its copy. `/gen board <what>` hands a task to the board, and
`/gen board #n` a request too big for `/gen` ([below](#gen-board-a-task-for-the-board)). `/gen` alone lists today's requests (and how much code you took is
[not yours yet](#owning-generated-code)), and `/gen cancel` stops the one
that runs or waits. `/cancel`, and `Esc` or `Ctrl-C` in the full-screen pane, stop a request too, when Pair answers nothing else. Typing `/gen` and a space
lists the shapes first, then what else `/gen` does; `Tab` completes one. What a request makes comes back as a
[gen card](#in-the-chat-pane-the-gen-card), with keys to keep, open, drop and undo it.

## The shape

| Shape | What it makes | How you take it |
| --- | --- | --- |
| `here` | Code at the cursor, or over the selection: a query, a handler, a config block | `Alt-y` |
| `file` | New files to review, as unsaved buffers: a migration, a module, a config file, a test file | `:w` in one |
| `scaffold` | Many files and their wiring, built and run in a copy of the project in Pair's data folder: an admin page wired into the router, a service with its tests | `k` per file in `:Pair gen list`, or `/keep <path>` |
| `try` | A sample to read and run, in a folder of its own outside the project: an LRU in 30 lines, how a library's API feels | `/keep [path]`, if you want it |
| `board` | No code: a task for the board (Shepherdr), its brief written from yours for you to read and edit | `y` add only, `d` add and delegate, `p` plan first, `r` research only, `c` copy ([below](#gen-board-a-task-for-the-board)) |

When the request does not start with a shape word, a cheap rule guesses one from it, never the model: a selection in
code is `here`; then words like "here", "below this" or "this function" mean `here`; "scaffold", "wired into", "an
app" mean `scaffold`; "sample", "example", "to try" mean `try`; a file name or "migration", "test file", "new file"
mean `file`; anything else is `here`. `board` is never guessed: it is in the list for you to pick. A guess is always shown first, and goes only once you confirm it, so `scaffold`
is never picked silently. A shape you typed is not asked about, and neither is `--branch` or `--copy` at the start of
the request: they say where a scaffold goes, so they make one. Nor is a request from Neovim's gen key or the
`:Pair gen` dialog in code, which mean here; `:Pair gen <words>` with no shape word, a request from a note, and
`/gen <words>` in the chat are guessed and asked.

In Neovim the guess comes as a list with the guess first, so `Enter` takes it. A select plugin shows it as its own
picker; without one (or with `gen_input = 'cmdline'`), Pair's numbered list on the command line asks instead of
Neovim's own, whose empty `Enter` would cancel. There a number picks another shape, and `Esc` cancels:

```
gen #1 · new files: "migration". Shape?
1: file      new files to review  (guessed)
2: here      at the cursor, over a selection
3: scaffold  many files, in Pair's copy
4: try       a sample outside the project
5: board     a task for the board, for later
Number, Enter takes 1 (Esc cancels):
```

In the chat, `y` takes the guess, a shape word another, and `n` cancels. The question is the gen speaker's
([below](#in-the-chat-pane-the-gen-card)), and the status says `? gen #1 waits for your answer`.

## How a request runs

- **Its own number and conversation.** Requests are numbered per project, `gen #1`, `gen #2`, and each runs in a
  conversation of its own on the Partner's model, at the thinking level of `gen` (`medium` unless the config says,
  [config.md](config.md#model-entries)). Your questions in the chat still get answers meanwhile, in the
  session's own conversation, and Pair keeps its role: a request is no role you switch to.
- **One at a time.** A second request waits for the first, and the statusline and the chat say so. When a request
  starts, it reads where its mark is now, so lines you typed above the place while it waited do not throw it off.
- **No unasked remarks.** While a request runs, no remark nobody asked for starts: what comes up waits, as it waits
  while Pair answers you. What a request says in the chat is no remark, and costs no talk budget.
- **What it is told.** Your words and [the brief](#the-brief), read again when the request starts. For `here`, where
  the code goes (the cursor's line, or the lines you selected) and the lines around that place as your buffer has
  them; for `file`, the names of the project's files (`git ls-files`, the first 200); for `try`, its folder and the
  names of the first 60 of the project's files; for `scaffold`, where its copy is, its limits, and the names of the
  first 300.
- **Its tools.** `say`, `read`, `recall`, `search` (in Pair's pane, also outside Scout), `propose`, `draft`, `write`,
  `run` and `ask`. Never `edit`, `type`, `suggest` or `point`, and a policy in code refuses them
  ([how-it-works.md](how-it-works.md#what-it-can-do)). `propose(file, line, end_line, insert, text, note)` puts the
  code below `line` (`insert`), or in place of `line`..`end_line`; for `here`, only in the file you asked in.
  `draft(path, text, note)` writes a new file, for `file` only (below). `write(path, text)` and `run(command)` work
  only in a `try` and a `scaffold`, and only in the request's own folder ([try](#samples-gen-try-and-keep),
  [scaffold](#many-files-gen-scaffold)), where `propose` changes the copy at once and `read` and `search` see it; in
  the other shapes they are refused with why.
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
| `lines` | `4000` | The proposal, draft or write is refused: the model is told to propose less. In a scaffold, a change to a file counts the lines it adds |
| `files` | `40` | A proposal, draft or write in one more file is refused. Files a scaffold's runs made past it are counted in its debrief, not listed |
| `commands` | `8` | Searches, and the runs of a try or a scaffold, past it are refused |
| `minutes` | `10` | The model is stopped; what it proposed so far still shows. Time a question waits for you does not count |

## In the chat pane: the gen card

In the [chat pane](chat.md), what a request makes is the **gen** speaker's, in magenta: the colour /gen has next to
the roles' (Navigator blue, Scout green, Driver red, the Watcher yellow). Its message is one unit, a **gen card**:
what it made and how its check went, the debrief, and last its **action line**, the keys that still do something on
it.

```
 you   /gen scaffold an admin page for orders: list, detail, status change
 gen   #7 · scaffold · 9 files, 3 of yours changed · 2m 41s: An admin page under /admin …
       in Pair's copy …/gen/shop-1a2b3c4d/7 · ran ✓ `go build ./...` · ✓ `go test ./...`
       check ✓ `go test ./...`: 47 tests, 6 packages
       │ + internal/admin/orders.go       +118
       │ + internal/admin/orders_test.go  +76
       │ + internal/admin/status.go       +41
       │ + internal/admin/status_test.go  +38
       │ + web/admin/orders.html          +64
       │ + web/admin/order.html           +52
       │ ~ cmd/shop/main.go               +3 -1
       │ ~ internal/orders/repo.go        +12 -0
       │ … 1 more
       ≠ brief "Admin is read-only for now." NOTES.md:17 · internal/admin/orders.go:64 …
       ? guessed html/template, no JS

       k keep one   Enter open the list   d drop all   u undo   · Alt-↑ picks
── ◉ watching · gen #7: 0 of 9 kept ─────────────────────────── qwen3-coder ──
```

As on a remark, the keys work once the card is picked: the first `Alt-↑` picks it while its action line shows (the
aside says so), and a letter typed on an empty line stays a letter. The line shows while the card is the last thing
said (a note after it, such as `gen #7: … taken`, does not count), and only the keys that still apply:

| Key | `here` | `file` | `try` | `scaffold` |
| --- | --- | --- | --- | --- |
| `k` | Takes the code into your buffer, unsaved, as `Alt-y` does | Opens the next file to review in Neovim; `:w` there takes it | Keeps its main file in the project at its own name, as `/keep` alone does (`/keep <path>` for another) | Puts `/keep ` on the line, with the files of this scaffold left to keep in its menu: pick one, `Enter` keeps it from this scaffold, even when a newer one exists. Only on an empty line: what you typed stays |
| `Enter` | Neovim goes to where the code goes | Opens `:Pair gen list` | Opens its file | Opens `:Pair gen list` |
| `d` | Drops the code still showing | Drops the files still to review, and its changes still showing as suggestions | | Deletes the copy, and what you did not keep of it |
| `u` | Undoes the request ([below](#one-undo-per-request)), as `u` in `:Pair today`; once undone, `u again` makes it again | The same | The same, once a file of it is kept | The same |

`d` asks first: the first `d` says what a second one drops (`d again drops gen #7's copy, …`), and only a second `d`
within a moment does it. `u` shows once the request is done, even before you took anything (an undo then drops what
it proposed); for a try, only once a file of it is kept. None of the keys show while the request is at work: `Esc` (or `Ctrl-C`), `/cancel` or `/gen cancel` stop it then, unless Pair answers you meanwhile, when `Esc` stops that answer first. A card for code
at the cursor shows the code as a diff under its words, and `✓ taken` once you took it; `a` and `j` work on it as on
any suggestion. A card does not fold: `Enter` on it opens it. A try's card keeps its words on how to take it (where
its folder is, how long it stays) under its keys. A card that comes while Pair's answer streams waits under the
answer, with its keys as they are then.

**The status** says what /gen does, in the rule over what you type:

| Status | Means |
| --- | --- |
| `▖ gen #4 generating 41s` | A request at work, its spinner in magenta, while Pair does nothing else |
| `▖ gen #4 generating · gen #5 waits` | Another request waits its turn: one runs at a time (`2 more wait` for more) |
| `▖ thinking · gen #4 generating` | Pair answers your question meanwhile, in its own conversation |
| `▖ gen #4 starting` | Asked for, not at work yet: it finds where its code goes and reads the brief (one more answer of the model when the brief says something) |
| `? gen #4 waits for your answer` | The request asks you here: its shape, the brief, or a question of its model |
| `? gen #4 asks in Neovim` | It asks in a dialog there, because you asked in Neovim; answer it there (`Alt-g`) |
| `◉ watching · gen #7: 0 of 9 kept` | Done, with something left: the files of a scaffold kept, `gen #4: 2 to review` for files, `gen #2: ready in Neovim` for code at the cursor (and for a file request's changes, once its files are taken). It goes once nothing is left (every file of a scaffold kept or dropped), and gives way first in a narrow pane |

A chat pane that opens later, or reconnects, gets the cards of today's requests with their keys, and of a request
that waits its turn or asks its shape; what the daemon no longer knows (after a restart) loses its keys. The
[plain pane](chat.md#the-plain-pane) has no keys: it says `gen` before the card, and under it how to take what it
made (`In Neovim, :w in one writes it to its path; :Pair gen list lists them.`).

## The brief

The brief is your idea in your own words. Every request runs against it, and Pair never edits it, as it never
writes your notes. It is made of:

- **the session goal**, as `/goal` set it or as the session took it from the board task or the branch;
- **the board task** of the branch, its number and title, and the brief it has on the board (its first 80 lines), when
  the [board](agents.md#where-it-reads) has one;
- **one note**: the one you pinned, else `NOTES.md` at the project root when it exists (the config's
  [`gen.brief`](config.md#gen)). The note goes as your buffer has it, unsaved changes and all, its first 300 lines.

The first request that runs against `NOTES.md` without your pinning it says so once in the chat:
`gen #1 runs against the brief: NOTES.md + goal "orders API". /brief <note> pins another note; /brief off leaves it out.`

| You | What it does |
| --- | --- |
| `/brief`, or `:Pair brief` outside a note | Says what the brief is now: `The brief: NOTES.md + goal "orders API" + board task SHO-12` |
| `/brief docs/orders.md`, `:Pair brief docs/orders.md`, or `:Pair brief` in a Markdown buffer | Pins that note as the brief's note |
| `/brief off`, `:Pair brief off` | Leaves the note out: the brief is the goal and the board task. `/brief <note>` pins one again |
| `/brief sync`, `:Pair brief sync` | On a board task's branch: how the brief differs from the task's brief on the board, and one offer ([below](#keeping-the-task-in-step-brief-sync)) |

A pin lasts into the next sessions of the project, until you change it. A request reads the brief when it starts, so
a change to the note counts from the next request on.

### Keeping the task in step: /brief sync

On a board task's branch, the task's brief on the board is part of the brief, read by itself. The other way, from
your brief to the task, goes only when you ask: `/brief sync` (or `:Pair brief sync`) reads the task's brief again
(`shepherdr task show <id> --json`) and says what it lacks:

```text
/brief sync: NOTES.md + goal "orders API" + board task SHO-74 with its brief. SHO-74's brief on the board lacks:
+ Statuses: new, paid, shipped. (NOTES.md:11)
- Statuses: new, paid. (no longer in NOTES.md)
+ decided 2026-10-28: Admin is read-only for now
SHO-74's agent is at work: this goes as a message, not a new brief.
  y tell SHO-74 · c copy the command · n leave it
```

- **`+` a line of the note** the task's brief does not have, with its `file:line`. Headings, fenced code blocks (their
  fences too), a table's rule row and lines with fewer than three letters or digits are left out; a line counts as
  there when the task's brief has its words, whatever the case and the quotes.
- **`-` a line the task's brief quotes from the note** (as [`/gen board`](#gen-board-a-task-for-the-board) quotes
  them, `> words (NOTES.md:4)`) that the note no longer has.
- **`+ decided`**: a decision of the [decision log](notes.md#the-decision-log) next to the note (`decisions.md`) that is decided, not
  superseded, and not in the task's brief, logged on or after the day the task's branch left the base branch (the
  date of the commit it shares with your local `main` or origin's, whichever is further on): its brief was written no
  earlier, so these are the decisions logged since. Without git to tell that day, every decision the brief lacks is
  listed, as `+ decided 2026-10-28, not in its brief`, and the message says `Decided, and not in your brief`.

Shepherdr has no way to replace a task's brief, and changing the instructions under a running agent would be unsafe
anyway, so the one offer is a message to its agent, `shepherdr task tell <id> "…"`, with what changed: what the note
says now, what it no longer says, and what was decided since. Its words depend on the task:

| The task | `y` sends |
| --- | --- |
| at work or merging | the message: its agent takes it in as it goes |
| needing you, ready to merge or idle | the message: its agent waits for you, and takes it in as a message, not a new brief |
| waiting for a go (To do, Queued) | the message, which ends `This is no go: keep waiting for mine.`: it does not start the agent |
| stopped | the message, and the pick says so: a message to a stopped task starts its agent again |
| done | nothing is offered: there is no agent to tell |

`c` copies the command and sends nothing; `n` (or `Esc`) leaves the task's brief as it is. From Neovim the lines show
as a message and the offer is a `vim.ui.select` of the same three. The tell is booked in `:Pair today` as `told
SHO-74: …`. Off a board task's branch, or with nothing missing, `/brief sync` says so and offers nothing.

### When the request contradicts the brief

Before a request generates, the Partner's model compares it with the brief, outside the request's conversation. A
clear contradiction (the brief says SQLite, you ask for Postgres) is one question, asked where you asked. A request
for something the brief does not mention is no contradiction. In the chat:

```
gen #5 · the brief says SQLite:
│ "The store: SQLite, one file next to the binary. No server." NOTES.md:4
Postgres anyway?
  y as asked · n follow the brief (SQLite) · e open NOTES.md:4
```

In Neovim it is a dialog, `vim.ui.select` as for the shape, with the brief's choice first so that `Enter` takes it:

```
gen #5 · the brief says SQLite: "The store: SQLite, one file next to the binary. No server." NOTES.md:4
1: follow the brief: SQLite
2: as asked: Postgres
3: open NOTES.md:4
```

| Answer | What happens |
| --- | --- |
| `y`, as asked | The request goes as you asked, and the model is told you chose it over that line. The ledger books the exception with the request, and Pair does not ask about that line again this session |
| `n` (or `Esc` in the chat), follow the brief | The request goes, and the model is told to follow the brief there |
| `e`, open the note | The note opens at that line in Neovim, and the request ends: change the brief or the request, then ask again |

In Neovim, `Esc` leaves the question waiting, and `Alt-g` shows it again. The question counts only when it holds up
in code, not on the model's word: its quote must be words of the brief (of a line of the note, the goal or the board
task), and both sides must be named. Otherwise the request goes without asking.

### The debrief: ≠ brief and ? guessed

When the model is done, it is asked about its own code against the brief, again outside its conversation, and the
chat's line about the request gets up to three lines of each kind:

```
gen #4 · here · 12 lines at internal/orders/handler.go:42: A list handler with cursor paging.
≠ brief "Statuses: new, paid, shipped." NOTES.md:11 · internal/orders/handler.go:47 filters on cancelled too
? guessed the page size is 50 when the request has no limit
```

- **`≠ brief`** says where the code goes against the brief: the brief's line, quoted, and the line of the code that
  does. It is kept only when the quote is words of the brief and the place is a line of the code proposed, at most
  three. A line you chose to go against (`y`, above) is no news, and is left out.
- **`? guessed`** says what the code decides that neither the brief nor your request settles: a library, a name, a
  default, an error behaviour. At most three. These are the decisions to read before you take the code, and the ones
  worth writing into the note, in your words, when you agree.

A request asked in Neovim shows the same lines there too, as a message. The ledger's line counts the `≠` items
(`12 lines proposed · ≠1`), and the entry keeps them all. Without a model for the checks, or with an empty brief (no
goal, no board task, no note), a request asks nothing and checks nothing.

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
| `Alt-y`, `:Pair accept`, or `a` on it in the chat | The code goes into your buffer, unsaved, as one undo step, marked `┊` ([below](#owning-generated-code)). It is the request's code (`gen:#2`, below) until you edit it |
| `:Pair dismiss`, or over a selection, edit the lines it replaces | It is dropped: the ledger says so, and there is nothing of it to undo |
| `/undo`, or `u` on the request in `:Pair today` | The whole request goes (below) |

Once you take it, the code is checked on your unsaved buffer as after a [hand-over](driver.md#the-check-on-the-unsaved-buffer):
with the project's command on save, else your last build and run (a command from your terminal that Scout would ask
about asks you first). The result shows once, with `✓` or `✗` under the lines taken and in the chat, and the
Watcher adds no remark of its own about it. No command, no check.

## New files: /gen file

`/gen file a migration adding status to orders, and its test` (or `:Pair gen file …`, or `file` as the shape in the
dialog) asks for new files. The model writes each with `draft(path, text)`, and Pair checks the path: inside the
project, not in `.git`, and **new**. A draft of a file that exists is refused, and the model is told to `propose` its
change there instead: that change shows in your file as a suggestion, as for `here`, and the chat lists it apart.
Drafting a path again replaces its draft. Folders that do not exist yet are fine.

When the request is done, its files go to the Neovim you work in as buffers named `pair://gen/<n>/<path>`, loaded but
not opened: nothing jumps at you while you type. The chat says what it made:

```
gen #4 · file · 2 new files to review: db/migrations/0007_orders_status.sql +14, db/orders_test.go +38: …
✓ `go test ./...` on the unsaved buffers: 41 pass
≠ brief "Statuses: new, paid, shipped." NOTES.md:11 · db/migrations/0007_orders_status.sql:6 also adds cancelled
? guessed existing rows get the status new
```

Its [card](#in-the-chat-pane-the-gen-card) ends with `k keep one   Enter open the list   d drop all   u undo`; the
plain pane says `In Neovim, :w in one writes it to its path; :Pair gen list lists them.` instead. The statusline
says `gen #4 · 2 to review · :Pair gen list`, and the chat's status `gen #4: 2 to review`.

- **The check** runs once, on all the new files at their real paths with every other unsaved buffer of yours, with
  the command a [hand-over's check](driver.md#the-check-on-the-unsaved-buffer) uses (the project's command on save,
  else your last build and run). A test file it drafted is in the run. No command, no check. Later checks on unsaved
  buffers (a hand-over's, code you take from `here`) count the files still to review too, at their real paths.
- **In a buffer to review** the winbar says ` generated · gen #4 · :w takes it to db/migrations/0007_orders_status.sql `,
  the file's type gives its syntax, and a `≠ brief` line of the debrief that is about this file shows under its line,
  with `≠` in the sign column. You may change it before you take it: what you take is what the buffer has.
- **`:w` in it takes it.** The file is written to its path (its folders made), and the window shows that file as an
  ordinary buffer from then on: the proposal buffer goes. A file that appeared at that path since is not written
  over: `:w!` does. This is the one place Pair's code reaches your disk, and it is your `:w`.
- **`:wa` elsewhere skips them**, and says `Pair: gen #4: 2 buffers not taken. :w in one takes it; :Pair gen list lists them`.
  A habitual `:wa` never takes a whole request at once. `:wa` in one of them takes that one, as `:w` would.
- **Quitting warns.** A buffer to review stays modified until it is taken or dropped, so `:q` in the last window and
  `:qa` stop with Neovim's own `E37`/`E162`, as for any change not written. `:qa!` quits; the files are not lost (below).
- **`:bd!` or `:bw!`** on one drops it, as `d` in the list does. `:e!` in it brings back the draft as the request
  made it, still to review.
- **`:w other.txt`** in one writes a copy there and takes nothing: the proposal stays to review.

### The review list: :Pair gen list

`:Pair gen list` opens the file requests of the last seven days in a split at the bottom, newest first, and the
[reviews of board tasks](#reviewing-a-board-task-pair-review) among them:

```
gen #4 · file · a migration adding status to orders, and its test · 14:02
  brief NOTES.md + goal   ✓ go test ./... (unsaved) · 41 pass
  ◌ db/migrations/0007_orders_status.sql   +14   ⏎ open  w take  d drop
  ✓ db/orders_test.go                      taken · ⏎ open
  ≠ brief "Statuses: new, paid, shipped." NOTES.md:11 · db/migrations/0007_orders_status.sql:6 also adds cancelled
  ? guessed existing rows get the status new   M-d logs it as a decision

⏎ open · w take · d drop · W take all · D drop all · u undo the request · q close
```

| Key | What it does |
| --- | --- |
| `Enter` | Opens the file in the window you came from: the buffer to review, or the file once taken |
| `w` | Takes it, as `:w` in its buffer does |
| `d` | Drops it: its buffer goes, and the ledger says so |
| `W`, `D` | Takes, or drops, every file of the request still to review, after a yes (`Take all 2 files of gen #4? Read them first.`) |
| `u` | Undoes the whole request ([below](#one-undo-per-request)), and `u` again makes it again |
| `Alt-d` (the `decide_key`) | On a `? guessed` line: logs it as a decision in `decisions.md` next to the brief's note (else at the project root), in that buffer, unsaved, as `Alt-d` on a note's decision does ([notes.md](notes.md)) |
| `q` | Closes the list |

After `w` or `d` the cursor goes to the next file to review.

### After a restart

The daemon keeps each file's text in the ledger until you take or drop it. A Neovim that connects gets the buffers of
every file still to review from the last seven days: after a Neovim restart (or `:qa!`) they come back, as the
request left them. A Neovim that still has them (the daemon restarted) keeps its own, with your changes in them.
`Enter` in the list makes one again too, if it went missing.

## Samples: /gen try and /keep

`/gen try an LRU cache in 30 lines` (or `:Pair gen try …`, or `try` as the shape) asks for code to read and run, not
to put in your project: how a library's API feels, an algorithm, a pattern you want to see work first. It goes in a
folder of its own in Pair's data folder, outside the project:

```
~/.local/state/pairing-buddy/gen/shop-1a2b3c4d/try/8/main.go
```

The folder is named after the project and a short hash of its path, so two projects called `shop` do not share one,
and after the request's number. A folder left from an earlier request of that number is emptied first.

- **The model writes and runs there.** `write(path, text)` writes a file of the sample, with its path relative to the
  folder (its folders may be new; writing a path again replaces it). A path that leaves the folder, or goes through a
  link out of it, is refused. `run(command)` runs a command in the folder, in [Pair's pane](scout.md), where you see
  it typed and run, and the model reads its exit code and output and fixes what it shows. Its last command is how you
  run the sample again. A file a run made in the folder (`go mod init`, a heredoc) is part of the sample too. A try
  never changes the project: `propose` and `draft` are refused in one. The daemon makes, lists and deletes try
  folders only through real folders, never through a link someone put in its way.
- **The sandbox is narrower than Scout's.** A try's command runs in a sandbox of its own, inside the pane's: only
  its folder is writable, the project and the rest of the disk are read-only, `/tmp` is empty and private, and there
  is no network unless [`gen.network`](config.md#gen) is on, so nothing can be installed. Your sockets are hidden as
  in the pane's ([scout.md](scout.md#the-sandbox)). The [command policy](scout.md) still decides: what it refuses
  (`git push`, `curl`, `sudo`) is refused, and what it would ask about (`node main.js`, `go run .`) runs at once,
  since it can write nothing but the folder. Without bubblewrap (or with `scoutPane.sandbox` false) the command runs
  in the folder without a sandbox, and asks first as Scout's would.
- **It opens in a split.** When the model is done, the sample's main file (its longest, the code rather than its
  `go.mod`) opens in Neovim in a split below your window, as the real file it is; your cursor stays where it was. Its
  winbar says what it is: ` try · gen #8 · outside the project · \r runs it · :Pair keep moves it in `. The chat says
  what it made and how its run went:

```
gen #8 · try · main.go +34 · ✓ `go run .`: evicts b, the least recently used. I guessed string keys.
In Neovim: main.go in a split, outside the project. Your run key runs it again; /keep <path> moves it into the project, as a buffer to review. The folder stays 7 days after it last changed or ran (/gen tries).
```

- **You change it and run it again.** It is a real file: edit it, save it or not. The run key (`try_run_key`,
  `<LocalLeader>r`, which is `\r` unless you set `maplocalleader`) in a try's buffer, `:Pair gen run` in Neovim or
  `/gen run` in the chat writes the sample's changed buffers to its folder (the folder is Pair's, not your project)
  and runs the model's last command again in Pair's pane, in the same sandbox. Neovim and the chat show its end:
  `gen #8 · ✓ \`go run .\`` and the last three lines of its output. A try whose model never ran it has no command to
  run again; the chat says so.
- **The Watcher does not see it.** Your edits in a try's buffer are dropped when they reach the daemon, as for any
  file [outside the project](#edits-outside-the-project): no `drift`, no remark, no work counted.
- **Ask about it in the chat.** Your questions are told where the newest try of this daemon is, and `read` reads its
  files by their full path, so `why MoveToFront on get and not on put?` gets an answer about the sample, with its
  lines.

### /keep: moving it into the project

`/keep internal/cache/lru.go` in the chat, or `:Pair keep internal/cache/lru.go` in Neovim, moves the sample into the
project as a [buffer to review](#new-files-gen-file), `pair://gen/8/internal/cache/lru.go`, opened at once: in the
try's window when you are in it, else in a split below yours. It is unsaved and generated, exactly like a file of
`/gen file`: `:w` in it takes it, `:wa` elsewhere skips it, quitting warns, `:Pair gen list` lists it under the try
(`gen #8 · try · …`), and it comes back after a restart. Its text is the try's file as you have it now, your changes
included.

- **Which file.** A link is not kept, whatever it points to. `:Pair keep` in a try's buffer keeps that file; otherwise (and `/keep` in the chat) it keeps the
  newest try's main file.
- **Where.** At the path you give, inside the project and not in `.git`. Without one, at the file's path in the
  try's folder (`main.go` at the project root).
- **Only a new file.** A path that exists is refused: `gen #8: internal/cache/lru.go exists already, and /keep makes
  a new file. /keep <another path>; or copy what you need from main.go.` `/keep` to the same path again, before you
  take it, keeps the try's file as it is now in place of the earlier text.
- **Undo.** `u` on the request in `:Pair today` (or `/undo`, when it is the newest thing to undo) takes it back as for a `file` request: a kept file you wrote is deleted while it is as
  you wrote it, and one still to review goes. The try's folder stays. Until a file of it is kept, a try has nothing to
  undo, and `/undo` takes back what came before it.

### /gen tries and how long they stay

A try folder stays for [`gen.keepTries`](config.md#gen) days (7) after anything in it last changed or it last ran
(the model's runs and yours count), so a try you keep running stays. Older ones are deleted when the daemon starts and whenever a new try starts, every project's.
`/gen tries` in the chat lists the project's folders still there, newest first:

```
gen #8 · an LRU cache in 30 lines · main.go · kept as internal/cache/lru.go · goes in 6 days
  /home/you/.local/state/pairing-buddy/gen/shop-1a2b3c4d/try/8
```

`:Pair gen tries` in Neovim shows them as a list (`vim.ui.select`), and the one you pick opens in a split.

## Many files: /gen scaffold

`/gen scaffold an admin page for orders: list, detail, status change, wired into the router` (or `:Pair gen scaffold
…`, or `scaffold` as the shape) asks for many files and the wiring that joins them to your code. It is the costly
shape, so Pair never guesses it silently: a guess is always asked first. The request is built away from your project,
in a copy of it in Pair's data folder, where the model writes, runs and checks what it makes. You then keep what you
want of it, a file at a time; nothing else reaches your project.

### The copy

```
~/.local/state/pairing-buddy/gen/shop-1a2b3c4d/7/
```

The copy is made the way the [check on unsaved buffers](driver.md#the-check-on-the-unsaved-buffer) makes its own: the
files git knows and the files it ignores (such as `.env`), copied as reflinks where the file system has them, so a
big project costs little room; folders git ignores (`dist`, `target`) are left out, and dependency folders
(`node_modules`, `.venv`) are linked. It has your unsaved buffers in it, so it is the project as you see it. It leaves
git alone: no branch, no change to `.git`. A project of more than 50,000 files is not copied, and the request says so.

- **The model works there.** Its paths are the project's: `write(path, text)` writes a whole file in the copy, new or
  not; `propose(file, line, end_line, insert, text)` changes lines of a file there at once (a route, an import);
  `read` and `search` see the copy with its changes. `draft` is refused: there is nothing to draft, the copy is Pair's.
  A path out of the copy, through a link out of it, or in `.git` is refused.
- **It runs there.** `run(command)` runs in [Pair's pane](scout.md), in the same narrow sandbox as a try's: only the
  copy is writable, the project and the rest of the disk are read-only, and there is no network unless
  [`gen.network`](config.md#gen) is on. The command policy still decides, and without bubblewrap a command Scout
  would ask about asks first. The model builds and tests what it made, and fixes what fails.
- **Installs are listed, not run.** Without the network an install cannot work, so a command that installs a package
  (`npm install zod`, `pip install`, `go get`, `cargo add` and the like) is not run at all: the model is told so, and
  the debrief lists it for you to run once you keep the files. With `gen.network` on, it runs.
- **Within its limits.** [`gen.limits`](#how-a-request-runs) holds it: the files it writes, the lines it adds, its
  commands and its minutes.

### The debrief

When the model is done, Pair adds the files its runs made or changed (a lock file, `go.sum`, generated code), except
those git would ignore, and checks the copy with the command a [hand-over's check](driver.md#the-check-on-the-unsaved-buffer)
uses: the project's command on save, else your last build and run (one from your terminal that Scout would ask about
asks you first). The chat gets the debrief:

```
gen #7 · scaffold · 9 files, 3 of yours changed · 2m 41s: An admin page under /admin, with the same auth; …
in Pair's copy /home/you/.local/state/pairing-buddy/gen/shop-1a2b3c4d/7 · ran ✓ `go build ./...` · ✓ `go test ./...`
check ✓ `go test ./...`: 47 tests, 6 packages
│ + internal/admin/orders.go       +118
│ + internal/admin/orders_test.go  +76
│ + internal/admin/status.go       +41
│ + internal/admin/status_test.go  +38
│ + web/admin/orders.html          +64
│ + web/admin/order.html           +52
│ ~ cmd/shop/main.go               +3 -1
│ ~ internal/orders/repo.go        +12 -0
│ … 1 more
≠ brief "Admin is read-only for now." NOTES.md:17 · internal/admin/orders.go:64 the page changes the status
? guessed html/template, no JS
not run: `npm install htmx.org`: the copy has no network (gen.network), so install it yourself once you keep the files
```

In the chat pane the card ends with its keys, `k keep one   Enter open the list   d drop all   u undo`
([above](#in-the-chat-pane-the-gen-card)); the plain pane says `In Neovim, :Pair gen list keeps them one at a time
(k), shows each (Enter) and deletes the copy (x). Here, /keep <path> keeps one; /gen drop deletes the copy.` instead.

`+` is a new file, `~` a change to a file you have, with the lines it adds and removes. The `≠ brief` and `? guessed`
lines are [the brief's check](#the-debrief--brief-and--guessed), on the first 300 lines of each file. Neovim says
`Pair · gen #7 · scaffold: 9 files in Pair's copy · :Pair gen list keeps them`, and the statusline
`gen #7 · scaffold · :Pair gen list keeps it`. The request opens nothing by itself: nothing jumps at you while you type.

### Keeping it a file at a time

`:Pair gen list` lists the scaffold with its files, under the [file requests](#the-review-list-pair-gen-list):

```
gen #7 · scaffold · an admin page for orders · 14:31
  copy ~/.local/state/pairing-buddy/gen/shop-1a2b3c4d/7 · 2 of 9 kept   brief NOTES.md + goal   ✓ go test ./... (in the copy) · 47 tests
  ✓ ~ internal/orders/repo.go        kept · 1 of 1 change taken
  ✓ + internal/admin/orders.go       kept · unsaved · ⏎ open  w take
  ◌ + internal/admin/orders_test.go  +76      ⏎ open  k keep  d drop
  ◌ ~ cmd/shop/main.go               +3 -1    ⏎ diff  k as suggestions  d drop
  · + web/admin/orders.css           +12      dropped · k keeps it after all
  t terminal in the copy · r run the check again · x delete the copy
```

| Key | What it does |
| --- | --- |
| `k` | Keeps the file. A **new file** opens as a [buffer to review](#new-files-gen-file), `pair://gen/7/<path>`, exactly like a `/gen file` one: `:w` in it takes it, `:wa` elsewhere skips it, quitting warns. A **change to a file you have** shows in it as suggestions, one per hunk, at the lines it changes; `Alt-y` takes each, as for `here` (below) |
| `Enter` | Opens it in the window you came from: a new file as the copy's file; a change as your file with the copy's beside it, in a diff (`:diffoff!` ends it). The copy's file has the winbar ` scaffold · gen #7 · Pair's copy, not your file · \r checks it · :Pair keep keeps it ` |
| `w` | On a kept file still to review: takes it, as `:w` in its buffer |
| `d` | Drops the file: it is not kept, and stays in the copy until the copy goes. `k` keeps it after all |
| `r` | Runs the check again in the copy, and says how it went. The run key (`try_run_key`, `\r`) in a file of the copy does it too, after writing that file: you may change the copy's files, and what `k` keeps is the file as you have it then |
| `t` | Opens a terminal of yours in the copy, in a split. It is yours, not Pair's pane: no sandbox |
| `x` | Deletes the copy, after a yes (`Delete gen #7's copy? The 6 files not kept go with it.`). What you did not keep is dropped; what you kept stays |
| `u` | Undoes the whole request ([below](#one-undo-per-request)) |

In the chat, `/keep internal/admin/orders.go` keeps that file of the newest scaffold whose copy is still there (when
the newest of your tries and such scaffolds is one; the chat's answer names it, `gen #7: …`); `/keep` alone keeps the only one left, or lists them. `:Pair keep` in a file of the copy keeps
that file. `/gen drop` and `:Pair gen drop` delete the newest scaffold's copy. Keeping one file at a time is the
point: there is no key that keeps them all, so you read each before it is yours.

### Changes to your files, as suggestions

A change to a file you have is never written over it. Pair takes the copy's file as it is when you press `k`, and the
text that file had when the copy was made, and shows each hunk between them as a suggestion in your buffer as it is
**now**: lines you typed since move it, and it lands where those lines are now. A hunk over lines you changed since the
copy was made is not shown, and the chat says so: `gen #7: cmd/shop/main.go: 1 change, shown there as suggestions;
Alt-y (:Pair accept) takes each. 1 change not shown: you changed those lines since; copy it from …/7/cmd/shop/main.go.`
A hunk that only deletes lines shows as the line next to it, kept, in place of the lines it deletes, since a suggestion
has at least one line.

### In a git worktree: --branch

`/gen scaffold --branch <what>` (or `:Pair gen scaffold --branch …`) builds it in a git worktree on a new branch
`gen/<n>`, at the same place in Pair's data folder, instead of in the copy. Choose it when you want to commit the
scaffold as it is, or open it in herdr as a worktree of its own (it gets its own session there, as any worktree
does). [`gen.scaffold`](config.md#gen) `"worktree"` makes it the default, and `--copy` then asks for the copy. It needs
a git repository whose root is the session's, and a commit to start from:

- The worktree starts from `HEAD`: your uncommitted changes and unsaved buffers are not in it, and a change is shown
  against the file as `HEAD` has it, placed on your buffer as it is now.
- Keeping, the list and the debrief work as for the copy; the debrief and the list name the worktree and its branch.
- `x` removes the worktree (`git worktree remove --force`) and deletes the branch while it has no commit of yours; a
  branch you committed on stays: `gen #7: its worktree is deleted; the branch gen/7 has commits of yours, so it stays.`
- A branch `gen/<n>` that exists already stops the request: `gen #7: no worktree for the scaffold: the branch gen/7
  exists already.`

### How long a copy stays

A copy stays until you delete it (`x`, `/gen drop`), or until it has not been used for
[`gen.keepTries`](config.md#gen) days (7), as a try: a write, a run, a check or a keep in it counts as a use. Older
copies are deleted when the daemon starts and whenever a try or a scaffold starts. A worktree never expires: it is a
branch of your repository, and only `x` (or git) removes it. `/gen cancel` on a running scaffold deletes its copy, and
a scaffold that made nothing leaves none.

## /gen board: a task for the board

Some requests are too big for `/gen`, or are long work you would rather review later than watch: many packages, an
install and the network, something to run while you are away. `/gen board <what>` (or `board` in the shape question,
or `:Pair gen board <what>`) hands such a request to the board, [Shepherdr](agents.md#where-it-reads), as a task. No
model runs: Pair writes the task from your brief, shows it to you before anything is added, and adds it only as you
pick.

### A request too big for /gen

A request that runs into [`gen.limits`](config.md#gen) (its files, its lines, or its minutes) ends as usual, with what
it made so far, and then the chat offers the board:

```
··    gen #9 is bigger than gen's limits (it went past gen.limits.files). /gen board #9 hands it to the board, with
      its brief and what it found.
```

In Neovim, the same offer is a notification (`:Pair gen board #9`). It is only an offer: nothing is added until you
ask. `/gen board #9` hands on request #9 of this daemon with its own words, the files it proposed, and what its check
found.

### The task's brief

The task's title is your request cut to 32 characters at a word, the most the board takes. Its brief is built from
the [brief](#the-brief) the request would run against:

- **The request** in your words.
- **The brief's lines**, quoted with `file:line`: the goal, the branch's board task, and the note's lines, as
  `> Money in integer cents, never floats. (NOTES.md:9)`. A committed note is quoted up to 40 lines, since the task's
  agent can read the rest in its worktree.
- **The files it names**: the project's files your request names (`src/billing.go`), and those the request it hands
  on proposed.
- **The tests**: your [`testOnSave`](tests-on-save.md) command, ``Tests: `go test ./...` ``.
- **What the check found**, when it hands on a request that ran: its `≠ brief` lines, and its `? guessed` items as
  **open questions** for the agent to settle or ask about.

**A note that is not committed.** The task's agent works in a git worktree, which has only what is committed. When the
brief's note has changes that are not committed (unsaved in Neovim, changed on disk, or not in git at all), Pair warns
you, and copies the note whole into the brief, as it is now: every line as it is, blank lines and indentation too,
in a fenced block (its first 300 lines, and the brief says when there are more), in place of the quoted lines:

```
··    gen #9: NOTES.md has changes that are not committed: the task's agent works in a git worktree and would not see
      them, so they are copied into its brief.
```

### Edit it, then pick

In Neovim the task opens in a compose window, `pair://board/new`: its title on the first line, its brief under it.
Edit what you like. `:w` (or `Ctrl-S`) takes it as written and asks how to add it, in a `vim.ui.select` dialog; `:q`
drops it and adds nothing. `Esc` in the dialog leaves it waiting, edits and all: the gen key (`Alt-g`) opens it again.
The gen key while the window is open goes back to it; there is only ever one. A title or a brief you emptied is not
filled in again: `:w` says it is empty, and nothing is added.

```
╭─ board task · edit, then :w · :q drops ─────────────╮
│ the whole billing module:…                           │
│                                                      │
│ the whole billing module: invoices, PDF export, …    │
│                                                      │
│ From the brief (NOTES.md, committed + the goal):     │
│ Goal: billing                                        │
│ > Money in integer cents, never floats. (NOTES.md:9) │
│ Tests: `go test ./...` (Pair runs it on save: …)     │
╰──────────────────────────────────────────────────────╯
```

In the chat the task cannot be edited: the question shows the command whole, brief and all, and each pick is one
key. Ask from Neovim (`:Pair gen board …`) to edit it first, or copy the command (`c`) and change it yourself.

```
gen   #9 · a task for the board: "the whole billing module:…". How should Pair add it?
      │ shepherdr task add 'the whole billing module:…' --brief='the whole billing module: invoices, PDF export, …
      │ From the brief (NOTES.md, committed + the goal):
      │ …' --space=shop --later
      y add only (its agent waits for your go) · d add and delegate · p delegate, plan first · r delegate, research
      only · c copy the command · n nothing
```

| Pick | What Pair runs | What the board does |
| --- | --- | --- |
| `y` add only | `shepherdr task add '<title>' --brief='…' --space=<space> --later` | Adds it; its agent reads the brief and waits for your go (`shepherdr task tell <id> go`, which the chat gives you) |
| `d` add and delegate | the same, without `--later` | Adds it, and its agent starts on the brief now |
| `p` add, delegate, plan first | `d`'s, with `Plan first: before you change any code, write your plan and wait for my go.` at the end of the brief | Its agent starts, writes its plan, and waits for your go |
| `r` add, delegate, research only | `d`'s, with `Research only: find out, and write it up as a report (an artifact). Change no code and open no pull request.` at the end of the brief | Its agent starts, and makes a report, not code |
| `c` copy the command | nothing | The add-only command goes to the clipboard (OSC 52) in the full-screen pane, or to the `"` and `+` registers in Neovim, with your edits. The chat gives it again, to run yourself |
| `n`, `Esc`, `:q` | nothing | Nothing is added |

Shepherdr has no flag for a plan first or research only: the brief says it in its own words, which the board's agent
follows. Pair runs the command once, as a list of words (never a shell), each option one word (`--brief='…'`), so a
brief that starts with `--` stays the brief. `--space` is the repository's space on the board, and the command runs in
the project. The chat says what the board made, `gen #9 → board SHO-80 · added and delegated: its agent starts on the
brief now.`, and the ledger books it (`board`).

Pair adds a task only on a pick that names what it does, and adds it only (for later) unless the pick names delegate.
`/gen board` never tells, merges, stops or sets anything on the board; once the task is done, its
[review](#reviewing-a-board-task-pair-review) can tell its agent something, on your pick. Without a board
(`"board": null`), `/gen board` says so; when the board refuses (Shepherdr not running, a space it does not know), the
chat says what the board said.

## Reviewing a board task: :Pair review

A board task that is done is a big proposal: a branch of commits its agent made and its reviewer checked. `:Pair
review SHO-80` (or `/review SHO-80` in the chat, `Alt-r` on a relayed line of a task ready to merge, `r` on a task in
[`:Pair agents`](agents.md)) opens its branch in the [review list](#the-review-list-pair-gen-list), where you read it a
file at a time and keep the pieces you want, in your own checkout. `:Pair review` alone reviews the task of the
relayed line.

```
SHO-80 · Billing module · work/80-billing · 4 files · 14:20
  reviewer  review: 1 round, 2 minor left (retries without a cap in billing/webhook.js:3; …) · checks passed (npm test) · PR #104
  agent     Invoices and webhooks, with tests.
  · not proven: real Stripe
  ≠ brief "Money in integer cents, never floats." NOTES.md:3 · billing/invoice.js:2 sums in a float
  ◌ ~ billing/invoice.js ≠1     +3 -3    ⏎ diff  k keep  t tell
  ◌ + billing/webhook.js !      +3       ⏎ diff  k keep  t tell
  ◌ ~ cmd/main.js               +1 -1    ⏎ diff  k keep  t tell
  ◌ - old.txt                   +0 -1    deleted on the branch · ⏎ diff
  o PR · t tell its agent · a merge (asks) · A archive (asks)
```

**On top, what the board says of it.** Shepherdr keeps a task's review in its *facts*, the line its agent writes when
it reports ready (`PR #104 · commit 1a2b3c4 · checks passed (…) · review: 1 round, 2 minor left (…) · not proven: …`,
read with `shepherdr task show <id> --json`). The `reviewer` line is its review and checks parts, with the pull
request's number; `agent` is what the agent said when it was ready; each other part (what it decided, follow-ups,
what is not proven, a failure it put first) is a `·` line. A task without facts shows `no review in its facts`.

**≠ brief on the branch.** The [brief's check](#the-debrief--brief-and--guessed) runs on the branch, after the list
opens (`≠ brief: checking…` until it is done): the goal, the reviewed task and your note against what the branch
changed, each change with three lines around it and its own line numbers in the file, so a change at line 380 of a long
file is read as `big.js:380`. It reads the changes of the first 20 files in the list's order, at most 80 lines of
one change and 600 in all. What holds up is listed on top, under the reviewer's lines, as for a request; `≠1` marks its
file, and the chat gets it too. Without a brief, or without the Partner's model, there is no check.

**The files in the order the brief makes them matter**: those `≠ brief` found against it first, then those the task's
brief (Shepherdr's) or your note names, in the order they are named, then those the reviewer's facts name (`!`), then
the rest, the bigger changes first. `+` is a file the branch adds, `~` one it changes, `-` one it deletes.

| Key | What it does |
| --- | --- |
| `Enter` | The file's diff, read only, in a split (`pair://board/SHO-80/billing/invoice.js`): each change with three lines around it, and whether it is kept |
| `k` | Keeps the whole file in yours (see below). In the diff, `k` keeps the change under the cursor, `K` the whole file, `t` tells about that line, `q` goes back to the list |
| `t` | Tells the task's agent something: you write it (`billing/webhook.js: ` is there already, from the file you are on), then pick |
| `a` | Merge: asks the task's agent to merge it, on a pick |
| `A` | Archive the task, on a pick |
| `o` | Opens its pull request |
| `u` | Takes back all you kept of it ([one undo](#one-undo-per-request)) |

**Keeping a piece.** What the branch changes goes into your buffer as it is now, unsaved: a hunk at a time, placed by
its text, so your edits since stay. A file the branch adds becomes a buffer at its path, not written until you `:w`.
Kept code is Pair's edit of origin [`board:SHO-80`](#who-wrote-it-edits-carry-their-origin), marked `┊` as [not
yours yet](#owning-generated-code) until you edit it or `:Pair own` it, and the ledger books the review as one line
(`review SHO-80 · Billing module`) that `/undo` and `u` in `:Pair today` take back as one. For `/undo` it counts as
changed when you last kept from it, so a review opened days ago and kept from now is the change it takes back. A change on lines you
changed since is not kept, and the chat says so (`git show work/80-billing:billing/invoice.js` has it). Pair keeps no
file the branch deletes, and deletes none of yours; a file that is not text is not kept either (`git checkout <branch>
-- <file>` takes it).

Keeps of one review run one after the other, so a key pressed twice keeps a change once. Each diff window's keys act
on its own file.

**Then the branch.** Once you kept pieces of it, merging the whole branch would bring them in twice. Pair says so
when you keep the first one, in the list too, and offers `archive SHO-80` with `A`. The review stays as you left it:
opened again while the branch has no new commit, it is the same review; after a new commit it is a new one.

**Each board command on a pick that names it.** `t`, `a` and `A` ask first, in a `vim.ui.select` dialog, and each
offers to copy the command (to the `"` and `+` registers) instead:

| Pick | What Pair runs |
| --- | --- |
| `t`: tell SHO-80 | `shepherdr task tell SHO-80 '<what you wrote>'` |
| `a`: tell SHO-80 "merge it" | `shepherdr task tell SHO-80 'merge it'`: Shepherdr has no approve, a task merges when its brief or you say so, so its agent is told, and merges it |
| `A`: archive SHO-80 | `shepherdr task archive SHO-80`: out of every list, its record kept; a running agent is stopped first |

Pair never runs `shepherdr merge`, and never tells, archives, stops or sets anything without your pick. The branch is
read from git in this repository (`git diff <merge base>...<branch>`, `git show`) and never changed. The chat books
each command (`board`: `told SHO-80 to merge it`). A task whose branch is not in this repository, one with no branch
yet, or no board (`"board": null`) has no review, and Pair says why.

## One undo per request

The ledger books a request as one line: `generated  gen #3 · here · a list handler with paging`, with a note that
follows it (`3 lines proposed`, `1 of 1 piece taken`, `1 dropped`, `cancelled`). `/undo` in the chat takes back the
last thing Pair changed today, and for a request that is all of it:

- a request that still runs or waits stops;
- what it proposed and you did not take goes;
- what you took is undone, newest first, merged into your buffers as they are now, so your edits since stay. Code
  you have changed since cannot be taken back: the chat says which (`Could not undo gen #1. Not changed: a.js: …`),
  and the request stays taken.
- a file of `/gen file` you took (wrote), or one you kept from a try or a scaffold and wrote, is deleted, with its
  buffer, but only while it is exactly as you wrote it and its buffer has no changes you did not save. Otherwise it
  stays, and the chat says why (`Not changed: db/x.sql: it changed since you wrote it`). Files still to review go,
  with their buffers.
- of a scaffold, the hunks you took from it are undone like code taken from `here`, and the files of its copy you did
  not keep are dropped. The copy itself stays until you delete it or it expires.
- of a [board task's review](#reviewing-a-board-task-pair-review), what you kept is taken back out of your buffers
  (`Undid SHO-80: took back 3 pieces`), and its files are there to keep again. A file the branch added stays as a
  buffer at its path, emptied.

`u` on the request in [`:Pair today`](neovim.md#the-ledger) does the same for any request of the day, and `u` again
makes what you took again: code goes back into your buffers, and a file deleted by the undo comes back as a buffer
to review, not written. Neovim's own `u` right after taking undoes that one step, as your own edit.

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
| `board:<id>` | A board task, by its id (`board:SHO-80`): the code you kept from its [review](#reviewing-a-board-task-pair-review), and its undo or redo |

The plugin never sends your edits and Pair's as one: edits of yours still waiting for the debounce (`debounce_ms`)
are sent before Pair changes the buffer, and Pair's change is sent as soon as it is in. An edit without an origin
(an older plugin) or with one the daemon does not know counts as yours.

### What changes for Pair's edits

The daemon keeps the origin with each edit. An edit Pair made:

- **is no news about your code.** `new_code_diagnostic` is raised only when the newest edit near the error is
  yours. `drift` and `edit_while_red` look at your own last edit, so the Driver working in another file is not you
  drifting from the goal or taking a wrong turn while a test is red. `new_warning` leaves out a warning on lines
  Pair edited last, and a file only Pair edited is no file you edited, and Pair's lines are no `fresh_code` of yours. In a Markdown note, text Pair put there is no
  question you asked (`note_stall`) and no section you began (`note_drift`).
- **is not you at the keyboard.** It is no keystroke (the speak gate's typing pause, "Last keystroke"), does not
  move the current file, and counts neither as active time nor as you using the session (which ends after you are
  away long enough). The plugin sends no "still typing" signal for it.
- **is still an edit.** The Partner sees it among the recent edits as `a.js:2-2 (3 s ago, by Pair)`, or `by Pair
  (gen #3)`, the decision model as `"by": "pair"`, and the run log counts it as a change of the code. A `regression`
  (the tests on save fail where they passed) still speaks, whoever made the change.

### Edits outside the project

An edit of a file outside the session's project (a scratch file, another repository, a file in Pair's own data
folder, where `/gen try` puts its samples and `/gen scaffold` its copies) is dropped when it reaches the daemon,
whoever made it. It raises no
`drift`, is no file you edited, and is not counted as work in this session.

### Making Pair's lines yours

Lines Pair wrote become yours when you edit them: the newest edit of a line decides. An edit of yours elsewhere in
the file leaves Pair's lines Pair's. Code you took from a request goes further: it stays marked until you own it
(below).

## Owning generated code

Code you took from a request is not yours yet. Taking it is one key, and reading it is the part that makes it yours,
so Pair keeps track of what you took and have not touched since, and says how much of it there is.

```
 41
┊42 func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
┊43     limit := queryInt(r, "limit", 50)
┊44     after := queryInt(r, "after", 0)
┊45     rows, err := h.repo.ListAfter(r.Context(), after, limit)
┊..
┊53 }
 54 func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
────────────────────────────────────────────────────────────
● pair · ┊ 12 generated
```

| State | Where | How it looks | Ends when |
| --- | --- | --- | --- |
| Proposed | ghost lines, a `pair://gen` buffer, a try's folder, a scaffold's copy | as each shape shows it | taken, dropped, undone |
| Taken | your buffer, saved or not | a thin `┊` in the sign column on each line (`PairGenerated`, a dim accent), and `┊ 12 generated` in the statusline for the buffer you are in | you edit a part of it, or `:Pair own` |
| Owned | your code | nothing | for good; the ledger still knows where it came from |

- **Part by part.** Taken code is marked in parts: its runs of lines between blank lines, a function or a block of
  statements. Changing a line of a part yourself (typing, a formatter you run, your `u`) makes that part yours, and
  only that one. Lines you add above, below or between parts move the marks and own nothing. Pair's own changes (the
  Driver, another request) leave a part Pair's.
- **`:Pair own`.** `:Pair own` makes all the generated code of the buffer's file yours, `:'<,'>Pair own` the parts on
  those lines, `:Pair own <path>` that file's, and `:Pair own!` all of it in the project. Pair says how many lines are
  yours now.
- **Which code.** Code taken with `Alt-y` from `here`, the hunks of a scaffold's changes to your files, and the files
  of `/gen file` (and those kept from a try or a scaffold) once `:w` writes them. A part you changed in its buffer
  before `:w` is yours already.
- **Gone.** A part whose lines you delete, or that is no longer there when the file is read again, is gone: neither
  yours nor Pair's. `/undo` of the request takes its marks with its code, and again brings them back as they were: a part you had
  made yours stays yours.
- **Found again.** Marks are extmarks, so a buffer read again (`:e`, Neovim restarted) loses them. The daemon keeps
  each part's text and the line it was last seen on (Neovim tells it when you save), and finds the part again by its
  text within 20 lines, as the [marks in a note's margin](notes.md) are found. A Neovim that connects gets the marks
  of every file, and shows them as it opens the file.

While a part is not yours, the Watcher says nothing about it: an error the language server finds in it is no
`new_code_diagnostic`, and a new compiler warning on its lines is no `new_warning`. The request's own check said its
result once, when you took it. Your first edit of the part ends that: an error in it after is an ordinary moment. A
`regression` still speaks, and says that a file it names has code from `gen #3` you have not made your own yet.

### What is not yours yet

- **`:Pair today`** ends with one line, `┊ not yours yet: 4 files · 211 lines`: `⏎` there goes to it (after
  picking a file, when there are several), `o` owns the code of one file, `O` all of it. `/today` in the chat ends
  with the same line.
- **`/gen`** in the chat lists today's requests, and then the same line.
- **`pair stats`** counts the requests per shape, the pieces taken and dropped, and the lines taken by what became of
  them: yours (and what share), not yours yet, gone ([cli.md](cli.md#pair-stats)).

Pair does not commit, and nothing of this reaches git: owning is about your reading of the code, not its history.

## Limits

- `/gen board`'s task is edited only in Neovim (`pair://board/new`); in the chat, copy the command (`c`) to change it.
  `/gen board #n` hands on only a request of the running daemon: one from before a restart is gone. A task's brief
  quotes the note, not the decisions logged since.
- A board task's review is read and kept in Neovim; the chat's `/review` opens it there, and with no Neovim says what
  the reviewer said. Its verdict is the words of the task's facts line, as its agent wrote them: Pair reads no
  findings of the reviewer that are not in it. The diff is against the commit the branch left the base at, and only
  of what is committed on the branch. Files it renames show as one deleted and one added. Pair keeps no deleted file
  and no file that is not text, and lists at most 300 files of a branch.
- `scaffold` keeps one file at a time; there is no key that keeps them all. Files a scaffold deletes are not
  proposed: only new and changed files are.
- A scaffold's copy has your unsaved buffers, but a `--branch` worktree starts from `HEAD`, without your uncommitted
  changes. A worktree needs the session at the repository's root.
- A change kept from a scaffold is placed by the text the file had when the copy was made. After a daemon restart,
  a change its runs made (not its model) is placed against the file as it is on disk then.
- A scaffold's runs cannot install anything unless `gen.network` is on; installs are listed instead. Without
  bubblewrap, a run that may write asks first, and could write through the copy's links to your dependency folders.
- A project of more than 50,000 files cannot be copied for a scaffold; `--branch` still works.
- `/gen file` makes new files only. A change to a file you have is a suggestion in it, never a buffer to review.
- A buffer to review is no file yet: no language server attaches to it, and Pair's Watcher does not see your edits in
  it. Once taken, it is an ordinary file.
- A part of generated code is owned whole: a one-character fix of a 40-line function makes all 40 lines yours. A
  block with no blank lines is one part.
- Marks stay for seven days after the request (the ledger keeps a request's detail that long); code taken earlier
  and still not yours is no longer marked, nor counted in `:Pair today`, `/today` or `/gen`. `pair stats` still counts
  it as not yours yet over a window longer than that.
- A part not found by its text within 20 lines of where it was last seen, when a file is read again, is gone: a
  file changed outside Neovim (a `git checkout`, another editor) can lose its marks. So can a second Neovim that
  opens the file while the first has the code taken but not saved.
- Positions reach the daemon with your edits (`debounce_ms`), and are kept with the ledger when you save; after a
  crash of Neovim, marks are found from where you last saved.
- Neovim's own `u` right after taking deletes the lines, so their parts are gone; `Ctrl-R` brings the code back
  without its marks (`/undo` and `u` in `:Pair today` keep them).
- `:Pair own` and the marks are Neovim's; the chat shows what is not yours yet, and `:Pair own` is the way to own it.
- Files to review go to one Neovim, the one you work in; a second Neovim on the project gets them when it connects.
- Changes you make in a buffer to review live only in that Neovim: after a Neovim restart the buffer comes back as the
  request drafted it.
- `:Pair gen list` and the files that come back after a restart cover the last seven days.
- A try's sandbox needs bubblewrap, as Pair's pane's does; without it, a try's command runs in its folder without
  one, after a yes for what Scout would ask about. A pane an older Pair opened (before tries) cannot write the try
  folders from its sandbox: close it, and the next run opens a new one.
- A try cannot install anything unless `gen.network` is on: a sample that needs a package says so instead.
- The chat's questions are told of the newest try and the newest scaffold this daemon made; an older one's files can
  still be read by their full path.
- `/keep` keeps one file at a time, as a new file. To bring a change into a file you have, copy it from the sample.
- A try whose model never ran it has no command for the run key: run it in a terminal of yours.
- The brief's two checks (the question before, the debrief after) are each one more answer of the Partner's model.
  They run in its slot like the note reader, so on a slow local model a request takes that much longer. They are made
  only when the brief says something.
- A brief line you chose to go against is remembered for the session (also across a daemon restart, from the
  ledger); the next session asks again.
- `? guessed` lines are words in the chat and the ledger. Only `:Pair gen list` logs one as a decision (`Alt-d`),
  for a `file` request, a scaffold, or a try with a kept file.
- A request lives in the daemon's memory. A daemon restart stops one that runs, and code it proposed at your cursor
  that you did not take is gone; the ledger line stays, and what you took can still be undone from it. New files
  to review are not gone: the ledger keeps them ([above](#after-a-restart)).
- The code shows in the Neovim you work in; a second Neovim on the same project does not show it.
- A request from the chat asks its questions in the chat only; one from Neovim asks in Neovim, and the chat shows
  them to read.
- A gen card's keys are the chat pane's own; the [plain pane](chat.md#the-plain-pane) has none, and says how to take
  what a request made in words instead. A card of a request from before a daemon restart keeps the keys that still
  work: its files to review and its undo, not its code at the cursor, which is gone.
- `k` on a scaffold's card lists at most 200 files to keep in `/keep`'s menu (a scaffold has at most `gen.limits.files`, 40 by default).
- The daemon keeps the last 20 edits of the session, with their line ranges as they were sent. An origin is not
  followed as lines move: after many edits, or lines added above, an older edit of Pair's no longer marks its
  lines, and they count as yours again.
- The origin lives in the session's state, not in the store: after a daemon restart, earlier edits are no longer
  known.
- Neovim's own undo of code you took (`u` in the buffer) is your edit, since you pressed the key.
