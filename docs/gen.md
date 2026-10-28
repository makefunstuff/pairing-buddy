---
description: "/gen: ask Pair for code at your cursor, as new files to review, or as a sample to run outside the project. Take it with one key, :w or /keep."
---

# /gen: ask Pair for code

Pair writes code when you ask for it, and only then. `/gen here a list handler with paging` (or `Alt-g` in Neovim)
is a request: it gets a number, `gen #3`, runs in a conversation of its own, and hands you a proposal at the place
you asked. You take it with one key, or not. Taken code lands in your buffer unsaved, as one undo step: as with
everything Pair does, the disk changes only when you save. `/undo` takes back everything a request gave you, as one.

Every request runs against [the brief](#the-brief): your goal, your board task and a note of yours, `NOTES.md` by
default. Pair reads it and never writes it. When your request contradicts it, Pair asks one question first; when its
code does, the debrief says so.

A request never changes your text by itself, so it is not the Driver: the Driver edits while you watch and is held to
five edits, while a request makes proposals you review, and is held by size limits instead
([driver.md](driver.md#the-driver-and-gen)).

This version builds three shapes: `here`, code at your cursor; `file`, [new files](#new-files-gen-file) you
review as buffers and take with `:w`; and `try`, [a sample](#samples-gen-try-and-keep) to read and run in a folder of
its own outside the project, which `/keep` moves in. `scaffold` is named, guessed and confirmed like them, and then
says it is not built yet.

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
- `:Pair gen [here|file|try] <what>` asks without the dialog. `:Pair gen cancel` stops the request that runs or
  waits, and `:Pair gen list` lists the files of `/gen file` requests to review ([below](#the-review-list-pair-gen-list)).
  `:Pair gen run`, `:Pair gen tries` and `:Pair keep [path]` are for tries ([below](#samples-gen-try-and-keep)).
- With a selection, `Alt-g` in Visual mode or `:'<,'>Pair gen`: in code, the code replaces those lines, so the shape
  is `here` and the dialog asks only what to write. In a Markdown note, the selected lines are the request itself: the
  dialog shows their first line to send or change, the rest goes with it, and the shape is guessed.

**In the chat**, `/gen here <what>` asks for code at your cursor in the Neovim you work in, and `@here` in it means
over the lines you selected there last. `/gen file <what>` asks for new files, which open in that Neovim as buffers to
review. `/gen try <what>` asks for a sample, which opens in that Neovim in a split; `/gen run` runs the newest
again, `/gen tries` lists the try folders, and `/keep [path]` moves the newest try's file into the project. `/gen`
alone lists today's requests, and `/gen cancel` stops the one that runs or waits. `/cancel` stops a running request
too, when Pair answers nothing else.

## The shape

| Shape | What it makes | Built |
| --- | --- | --- |
| `here` | Code at the cursor, or over the selection: a query, a handler, a config block | yes |
| `file` | New files to review, as unsaved buffers: a migration, a module, a config file, a test file | yes |
| `scaffold` | Many files and their wiring, in a copy of the project in Pair's data folder | not yet |
| `try` | A sample to read and run, in a folder of its own outside the project: an LRU in 30 lines, how a library's API feels | yes |

When the request does not start with a shape word, a cheap rule guesses one from it, never the model: a selection in
code is `here`; then words like "here", "below this" or "this function" mean `here`; "scaffold", "wired into", "an
app" mean `scaffold`; "sample", "example", "to try" mean `try`; a file name or "migration", "test file", "new file"
mean `file`; anything else is `here`. A guess is always shown first, and goes only once you confirm it, so `scaffold`
is never picked silently. A shape you typed is not asked about.

In Neovim the guess comes as a list with the guess first, so `Enter` takes it. A select plugin shows it as its own
picker; without one (or with `gen_input = 'cmdline'`), Pair's numbered list on the command line asks instead of
Neovim's own, whose empty `Enter` would cancel. There a number picks another shape, and `Esc` cancels:

```
gen #1 · new files: "migration". Shape?
1: file      new files to review  (guessed)
2: here      at the cursor, over a selection
3: scaffold  many files, in Pair's copy  (not built yet)
4: try       a sample outside the project
Number, Enter takes 1 (Esc cancels):
```

In the chat, `y` takes the guess, a shape word another, and `n` cancels.

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
  names of the first 60 of the project's files.
- **Its tools.** `say`, `read`, `recall`, `search` (in Pair's pane, also outside Scout), `propose`, `draft`, `write`,
  `run` and `ask`. Never `edit`, `type`, `suggest` or `point`, and a policy in code refuses them
  ([how-it-works.md](how-it-works.md#what-it-can-do)). `propose(file, line, end_line, insert, text, note)` puts the
  code below `line` (`insert`), or in place of `line`..`end_line`; for `here`, only in the file you asked in.
  `draft(path, text, note)` writes a new file, for `file` only (below). `write(path, text)` and `run(command)` work
  only in a `try`, and only in its own folder ([below](#samples-gen-try-and-keep)); in the other shapes they are
  refused with why.
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
| `lines` | `4000` | The proposal or draft is refused: the model is told to propose less |
| `files` | `40` | A proposal or draft in one more file is refused |
| `commands` | `8` | Searches, and a try's runs, past it are refused |
| `minutes` | `10` | The model is stopped; what it proposed so far still shows. Time a question waits for you does not count |

## The brief

The brief is your idea in your own words. Every request runs against it, and Pair never edits it, as it never
writes your notes. It is made of:

- **the session goal**, as `/goal` set it or as the session took it from the board task or the branch;
- **the board task** of the branch, its number and title, when the [board](herdr.md) has one;
- **one note**: the one you pinned, else `NOTES.md` at the project root when it exists (the config's
  [`gen.brief`](config.md#gen)). The note goes as your buffer has it, unsaved changes and all, its first 300 lines.

The first request that runs against `NOTES.md` without your pinning it says so once in the chat:
`gen #1 runs against the brief: NOTES.md + goal "orders API". /brief <note> pins another note; /brief off leaves it out.`

| You | What it does |
| --- | --- |
| `/brief`, or `:Pair brief` outside a note | Says what the brief is now: `The brief: NOTES.md + goal "orders API" + board task shop/12` |
| `/brief docs/orders.md`, `:Pair brief docs/orders.md`, or `:Pair brief` in a Markdown buffer | Pins that note as the brief's note |
| `/brief off`, `:Pair brief off` | Leaves the note out: the brief is the goal and the board task. `/brief <note>` pins one again |

A pin lasts into the next sessions of the project, until you change it. A request reads the brief when it starts, so
a change to the note counts from the next request on.

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
| `Alt-y`, `:Pair accept`, or `a` on it in the chat | The code goes into your buffer, unsaved, as one undo step. It is the request's code (`gen:#2`, below) until you edit it |
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
In Neovim, :w in one writes it to its path; :Pair gen list lists them.
```

and the statusline `gen #4 · 2 to review · :Pair gen list`.

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

`:Pair gen list` opens the file requests of the last seven days in a split at the bottom, newest first:

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
In Neovim: main.go in a split, outside the project. Your run key runs it again; /keep <path> moves it into the project, as a buffer to review. The folder stays 7 days after it last changed (/gen tries).
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

A try folder stays for [`gen.keepTries`](config.md#gen) days (7) after anything in it last changed, so a try you
keep running stays. Older ones are deleted when the daemon starts and whenever a new try starts, every project's.
`/gen tries` in the chat lists the project's folders still there, newest first:

```
gen #8 · an LRU cache in 30 lines · main.go · kept as internal/cache/lru.go · goes in 6 days
  /home/you/.local/state/pairing-buddy/gen/shop-1a2b3c4d/try/8
```

`:Pair gen tries` in Neovim shows them as a list (`vim.ui.select`), and the one you pick opens in a split.

## One undo per request

The ledger books a request as one line: `generated  gen #3 · here · a list handler with paging`, with a note that
follows it (`3 lines proposed`, `1 of 1 piece taken`, `1 dropped`, `cancelled`). `/undo` in the chat takes back the
last thing Pair changed today, and for a request that is all of it:

- a request that still runs or waits stops;
- what it proposed and you did not take goes;
- what you took is undone, newest first, merged into your buffers as they are now, so your edits since stay. Code
  you have changed since cannot be taken back: the chat says which (`Could not undo gen #1. Not changed: a.js: …`),
  and the request stays taken.
- a file of `/gen file` you took (wrote), or one you kept from a try and wrote, is deleted, with its buffer, but only
  while it is exactly as you wrote it and
  its buffer has no changes you did not save. Otherwise it stays, and the chat says why
  (`Not changed: db/x.sql: it changed since you wrote it`). Files still to review go, with their buffers.

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
folder, where `/gen try` puts its samples) is dropped when it reaches the daemon, whoever made it. It raises no
`drift`, is no file you edited, and is not counted as work in this session.

### Making Pair's lines yours

Lines Pair wrote become yours when you edit them: the newest edit of a line decides. An edit of yours elsewhere in
the file leaves Pair's lines Pair's.

## Limits

- `here`, `file` and `try` are built. `scaffold` is named and guessed, and says it is not built yet.
- `/gen file` makes new files only. A change to a file you have is a suggestion in it, never a buffer to review.
- A buffer to review is no file yet: no language server attaches to it, and Pair's Watcher does not see your edits in
  it. Once taken, it is an ordinary file.
- A file you took is yours from then on: Pair does not mark it as generated, and `:Pair own` does not exist yet.
- Files to review go to one Neovim, the one you work in; a second Neovim on the project gets them when it connects.
- Changes you make in a buffer to review live only in that Neovim: after a Neovim restart the buffer comes back as the
  request drafted it.
- `:Pair gen list` and the files that come back after a restart cover the last seven days.
- A try's sandbox needs bubblewrap, as Pair's pane's does; without it, a try's command runs in its folder without
  one, after a yes for what Scout would ask about. A pane an older Pair opened (before tries) cannot write the try
  folders from its sandbox: close it, and the next run opens a new one.
- A try cannot install anything unless `gen.network` is on: a sample that needs a package says so instead.
- The chat's questions are told of the newest try this daemon made; an older one's files can still be read by their
  full path.
- `/keep` keeps one file at a time, as a new file. To bring a change into a file you have, copy it from the sample.
- A try whose model never ran it has no command for the run key: run it in a terminal of yours.
- The brief's two checks (the question before, the debrief after) are each one more answer of the Partner's model.
  They run in its slot like the note reader, so on a slow local model a request takes that much longer. They are made
  only when the brief says something.
- A brief line you chose to go against is remembered for the session (also across a daemon restart, from the
  ledger); the next session asks again.
- `? guessed` lines are words in the chat and the ledger. Only `:Pair gen list`, for a `file` request, logs one as a
  decision (`Alt-d`).
- Taken code carries no mark of its own in the sign column, and `:Pair own` does not exist yet: it stays the
  request's until you edit its lines, as far as its origin can be followed ([above](#who-wrote-it-edits-carry-their-origin)).
- A request lives in the daemon's memory. A daemon restart stops one that runs, and code it proposed at your cursor
  that you did not take is gone; the ledger line stays, and what you took can still be undone from it. New files
  to review are not gone: the ledger keeps them ([above](#after-a-restart)).
- The code shows in the Neovim you work in; a second Neovim on the same project does not show it.
- A request from the chat asks its questions in the chat only; one from Neovim asks in Neovim, and the chat shows
  them to read.
- The daemon keeps the last 20 edits of the session, with their line ranges as they were sent. An origin is not
  followed as lines move: after many edits, or lines added above, an older edit of Pair's no longer marks its
  lines, and they count as yours again.
- The origin lives in the session's state, not in the store: after a daemon restart, earlier edits are no longer
  known.
- Neovim's own undo of code you took (`u` in the buffer) is your edit, since you pressed the key.
