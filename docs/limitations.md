# Known limitations

What Pair cannot do well yet; where one has a GitHub issue, it is linked. The full list of issues, with the ones
already fixed, is the [tracking issue](https://github.com/makefunstuff/pairing-buddy/issues/51); open ones carry the
[`limitation` label](https://github.com/makefunstuff/pairing-buddy/issues?q=is%3Aissue+is%3Aopen+label%3Alimitation).

## herdr

These need a change in herdr itself. The [shell hook](cli.md#pair-shell-hook) takes away most of them for the
terminals that have it: commands, their start, end and exit code, and in zsh your typing come from the hook.

- **No command boundaries or exit codes without the hook.** In a herdr pane without it, Pair learns that a command
  ran by watching it, so a command shorter than about a second can be missed, and success or failure is guessed from
  the output. [#22](https://github.com/makefunstuff/pairing-buddy/issues/22)
- **A command's output is cut from the screen text**, also with the hook: from the line the command was typed on, at
  most 1000 lines, so a very long output loses its beginning. Pair's own pane is not affected: its shell writes each
  output to a file. [#23](https://github.com/makefunstuff/pairing-buddy/issues/23)
- **Output changes are polled without the hook.** herdr pushes focus and pane events, but a pane's output cannot be
  subscribed to, so Pair looks at the focused pane twice a second and at other panes running a command once a second.
  With the hook, a zsh pane is not polled at its prompt, and a running command is looked at only for an editor
  opening in it. [#25](https://github.com/makefunstuff/pairing-buddy/issues/25)
- **Typing at a bash or fish prompt is guessed** from the focused pane's screen, as those shells have no hook for
  keys and herdr reports none; a prompt that changes by itself looks like typing, and typing in a pane without focus
  is not seen. zsh's hook reports keys from any terminal.
  [#24](https://github.com/makefunstuff/pairing-buddy/issues/24), [herdr.md](herdr.md#what-is-missing)

## Without herdr

Without herdr all of Pair works in Neovim and tmux ([workflows](workflows.md#with-or-without-herdr)). Two things
stay herdr's:

- **A terminal that is neither a Neovim `:terminal` nor a tmux pane** (a plain window of your terminal emulator):
  nothing lets another program read its screen, so Pair sees its commands and exit codes through the
  [shell hook](cli.md#pair-shell-hook), but not their output.
- **herdr's own agents** in [your other agents](agents.md), and `Alt-a` bringing one's pane to the front. The board's
  tasks are read without herdr.

## Neovim

- **Push-to-talk guesses when you let go** of `Alt-t` from the terminal's key repeats, since Neovim drops key-release
  events. A terminal that is slow to repeat turns a hold into a tap; `listen_mode = 'toggle'` (press to start, press
  again to ask) never guesses ([voice.md](voice.md#4-the-key)). Only one recording runs per project: `Alt-t` in
  another Neovim of the same project starts over there.
  [#55](https://github.com/makefunstuff/pairing-buddy/issues/55)

- **/gen**: a try's or a scaffold's runs need bubblewrap for their own sandbox (without it they run in their folder
  after a yes) and have no network unless `gen.network` is on, so a scaffold lists its installs instead of running
  them; `/keep` keeps one file at a time, a scaffold one file at a time too, and a file it deletes is not proposed; a
  `--branch` worktree starts from `HEAD`, without your uncommitted changes. Taken code is owned a part (the lines between blank lines) at a time, its `┊` marks last a week, and a part changed outside Neovim is lost; the brief's checks cost one more answer of the Partner's model
  each, before and after a request; `? guessed` lines are logged as decisions only from `:Pair gen list`; a daemon
  restart stops a running request and loses code it proposed at your cursor that you did not take (new files to
  review are kept); and a buffer to review gets no language server until you take it ([gen.md](gen.md#limits)).

- **Who wrote a line is known only for the session's last 20 edits**, at the line numbers they were sent with, and
  not after a daemon restart: an older edit of Pair's, or one whose lines moved, counts as yours again
  ([gen.md](gen.md#limits)).

## The board

- **Shepherdr only.** The board is read through `shepherdr` (Shepherdr 2); herdr-projects 1.x, the board before it, is
  not read any more.
- **A task's report is found by the words of `shepherdr artifact list` and `artifact show`**, which have no JSON: the
  list names the space an artifact is kept in, not the task, so Pair asks the space's newest 20 who made them (`by
  BDY-7 agent`). A report older than those 20, or a change of those lines' format in Shepherdr, hides it (the pull
  request still opens).
- **The diff is against the branch the repository merges into** (origin's default, else `main`, else `master`), not the commit the
  task started from, and only for a task whose repository is on this machine.
- **Another machine's tasks** (Shepherdr lists them too) are only their line: `o`, `d` and `t` open nothing of
  theirs.
- **In Neovim's statusline only `Alt-o`** opens what a task left behind; `Alt-d` and `Alt-t` are Pair's own keys
  (a decision, listening), so the diff and the terminal are in `:Pair agents` and on the chat pane's line.
- **`/gen board`'s task is edited only in Neovim** (`pair://board/new`); in the chat pane, copy the command (`c`) to
  change it. `/gen board #n` hands on only a request of the running daemon.
- **A task's review reads its verdict from the facts line** its agent wrote (`shepherdr task show --json`): what the
  reviewer found but the agent left out of it is not there. Only a branch in this repository can be reviewed, only
  what is committed on it, and it is kept in Neovim; the chat's `/review` opens it there. Pair keeps no file the
  branch deletes and none that is not text ([gen.md](gen.md#reviewing-a-board-task-pair-review)).
- **Shepherdr has no approve**: a review's merge is a tell, `merge it`, which the task's agent acts on as its brief
  says. Pair never runs `shepherdr merge`.
- **Tasks working on your files are read every 30 seconds**, so the winbar note and the overlap remark can lag a
  task's change by that much. Only tasks at work count (not one that waits for a go, needs you or is ready to merge),
  only tracked files (a new file its agent has not added to git is not seen), and the lines compared are the base
  branch's: lines you added or removed above an edit shift what counts as the same lines. A window with a winbar of
  its own gets no note ([agents.md](agents.md#tasks-working-on-your-files)).
- **`/brief sync` can only tell**: Shepherdr has no way to replace a task's brief, so what changed goes to its agent
  as a message. It compares words, line by line: a line reworded in the task's brief counts as missing. Only the note
  and `decisions.md` next to it are compared, not the goal. Shepherdr gives no time a task was added, so "decided
  since" counts from the day its branch left the base branch, by its decisions' dates: a decision logged that same day
  before the task was added is listed too ([gen.md](gen.md#keeping-the-task-in-step-brief-sync)).

## The chat pane

- **Copying needs OSC 52.** `c` and `/copy` hand the text to the terminal, which puts it on the clipboard only if it
  takes OSC 52; one that does not drops it, and the pane cannot tell ([chat.md](chat.md#limits)).
- **Esc mapped in Neovim's Terminal mode** (to leave it) never reaches the pane in `:Pair chat`: `Ctrl-C` stops an
  answer there instead ([chat.md](chat.md#in-neovim)).

## Models

- **A slow server still makes each new moment wait for one Watcher call.** Pair asks it about fewer kinds of moment
  while it is slow, and remembers scores ([watcher.md](watcher.md#when-the-server-is-slow)), but a moment worth asking
  about waits for the call. Fixed as far as Pair can in
  [#45](https://github.com/makefunstuff/pairing-buddy/issues/45).
- **The Anthropic API path and subscription logins are not tested against the real services** in CI; the token
  renewal is tested against fake providers.
  [#44](https://github.com/makefunstuff/pairing-buddy/issues/44)
