---
description: "When another agent needs you, is ready to merge or is done, Pair says so in one line at your next pause, with keys to go there and open what it left."
---

# Your other agents, in one place

When you work through several agents at once, finding out who finished means looking at their panes, and each look
is an interruption you made yourself. Pair looks for you. When another agent needs you, is ready to merge, failed
or is done, Pair tells you in **one line, at your next breakpoint**, with the key that goes there and the keys that
open what a board task left behind: its report or pull request, its branch's diff, its worktree. It never moves your
cursor, opens a window or speaks while you type.

![You change the hash in probe.c while the other agents move on; nothing shows while you type; you save and one line comes in the statusline; :Pair agents lists them all](images/agents.gif)

*Recorded from [a tape](captures/tapes/agents.tape) with the real plugin and daemon. The board and herdr are
stand-ins: their agents move on once you start typing.*

## What you see

![The statusline after the save: ● pair, then ◇ #21 needs you: Should a segfault also name its signal n… +2 M-a](images/agents-line.png)

*The capture predates the board's keys: a board task's line now ends `M-a · M-o opens`.*

- **The line.** After Pair's own part of the statusline: `◇`, who (`#21` for a task of this project's repository,
  `WEB-3` for another repository's, an agent's name or `pi in notes` for an agent outside the board), what it means
  for you, and its question or title. `+2` says two more came at the same time; they are in the list. Then the keys:
  `M-a` for any line, and `M-o opens` for a board task's (the words go once you have used it).
- **`Alt-a`** (`<M-a>`, the `agents_key` option) brings that agent's herdr pane to the front: herdr switches to
  its workspace and tab. The line goes once you have been there, or when it is no longer true (someone answered the
  question, the task was merged). When the agent has no pane any more (a finished task's agent is gone), `Alt-a`
  puts the line away. A line that asks nothing of you (done, failed) also goes by itself after two minutes; one that
  needs you or is ready to merge stays.
- **`Alt-r`** (`<M-r>`, the `agents_review_key` option), on the line of a task ready to merge, opens its branch as a
  [review](gen.md#reviewing-a-board-task-pair-review) in `:Pair gen list`: what its reviewer said, `≠ brief` on the
  branch, and its files, to keep the pieces you want in yours. The line then says `M-r reviews`.
- **`Alt-o`** (`<M-o>`, the `agents_open_key` option) opens the task's report or pull request (see
  [what a task left behind](#what-a-task-left-behind)). Pair's own keys `Alt-d` and `Alt-t` (a decision, listening)
  stay theirs, so the diff and the terminal are one key away in `:Pair agents`, where the relayed task is under the
  cursor, and in the chat pane.
- **In the chat pane** the same line appears once, in grey, with an action line while it is the newest: `o open   d
  diff   t terminal   · Alt-↑ picks`. `Alt-↑` picks the line, and then `o`, `d` and `t` act on its task (a letter
  on an empty line is the start of a question until then). Neovim opens what they ask for; once the line is answered,
  its keys go.
- **`:Pair agents`** (or `/agents` in the chat) lists every task and agent, the ones that need you first: needs
  you, ready to merge, failed, done (tasks you saw finish in the last 12 hours), idle agents, working, waiting.
  `Enter` on a line goes to that agent; `o`, `d` and `t` open what its task left behind; `r` opens its branch as a
  [review](gen.md#reviewing-a-board-task-pair-review); `q` closes the list.

![:Pair agents: needs you #21, ready to approve #22, idle pi in notes, working #24, waiting #25](images/agents-list.png)

*The capture predates Shepherdr: `ready to approve` is `ready to merge` now, and the list has the keys in its top
line: `Enter goes · o report or PR · d diff · t terminal · r review · q closes`.*

| State | From the board (Shepherdr) | From herdr |
| --- | --- | --- |
| needs you | the task needs you (Shepherdr's Needs you): a question, a permission, a login, a plan to approve | the agent shows a question or an approval (`blocked`) |
| ready to merge | its work is done and waits to be merged (Ready) | |
| failed | the task ended without its work done | |
| done / finished | merged, or closed with nothing to merge | the agent went from working to idle |
| working | at work, or merging | the agent works |
| waiting | To do (it waits for a go) or Queued (it waits for room, or for other tasks) | |

Only a change into one of these states is news. What is already true when the daemon first looks, or what changed
while no Neovim or chat pane was connected, is not relayed (`:Pair agents` shows it), and a task working away never
is.

## When it speaks: breakpoints

The news waits for your next breakpoint, the same one [a held thought](watcher.md#the-held-thought) waits for:

- you saved a file, or a command or test run ended;
- you left Insert mode and have not edited for 3 seconds: you stopped to look; or
- you have not typed or edited for 15 seconds.

Even then, never while you type (in Neovim or the chat pane), while Pair answers or makes a remark, or while it
has the wheel.
At a breakpoint the most urgent news becomes the line: needs you first, then ready to merge, failed and done.
There is only ever one line; what came with it is counted (`+2`) and listed in `:Pair agents`.

## What a task left behind

`o`, `d` and `t` (in `:Pair agents`, on the chat pane's relayed line) and `Alt-o` (on the statusline's) open what a
board task made. Each is read when you press it, read only, and opens in Neovim:

| Key | Opens | How |
| --- | --- | --- |
| `o` | its report or its pull request | the report is the newest artifact the task's agent or reviewer made. A task's artifacts are kept in its space, so Pair lists the space's (`shepherdr artifact list --space=<space>`) and asks the newest 20, newest first, who made them (`shepherdr artifact show <id>`: `by BDY-7 agent`); the first that is the task's opens, as its HTML file. The pull request is the one `task show` names. One of them opens with `vim.ui.open`; with both, you pick |
| `d` | its branch's diff, read only | `git diff <base>...<branch>` in its worktree (or the space's folder), against the branch the repository merges into (origin's default, else `main`), in a split named `pair://agents/<id>/diff` (`q` closes it) |
| `t` | a terminal in its worktree | a split with your `shell`, started in the task's worktree; for an agent of your own, in its folder |

When there is nothing to open, Pair says why: no report or pull request yet, no branch yet, no worktree on this
machine (a task that is done went with its merge), or a task of another machine, of which Pair reads only its line.
From the chat pane, the Neovim of the session opens it; with none connected, the chat gives the links or the folder
instead.

## Where it reads

Pair reads by itself and writes nothing to the board: it never adds, tells, stops, merges or sets a task on its own.
The writes there are go through [`/gen board`](gen.md#gen-board-a-task-for-the-board), a task added on a pick that
names what it does (add only, or add and delegate), and a task's [review](gen.md#reviewing-a-board-task-pair-review),
where a tell, "merge it" told to its agent or archive run on the pick that names them. Pair never runs `shepherdr
merge`.

- **herdr's agents**: `agent.list` over herdr's socket, which Pair knows from the chat pane, or from Neovim when it
  runs in herdr. Every agent herdr recognises, in any workspace.
- **The board**, if [Shepherdr](https://github.com/eliasstravik/shepherdr) (its command `shepherdr`) is
  installed, through its command with a list of words, never a shell: `shepherdr task list --json` for each task's
  status and status line, `shepherdr task show <id> --json` for its space, branch and pull request (read again only
  when its status line changes), and `shepherdr space list` (every minute) for each space's folder. The task's
  worktree is the one git lists for its branch (`git worktree list`), and its pane is that of the herdr agent working
  there. A task's own agents (the agent and its reviewer, in the task's worktree) show as the task, not twice.
- A session opened in a task's own worktree leaves that task out: it does not tell an agent about itself.

Both are read every 5 seconds while a Neovim or chat pane is connected, and not at all otherwise. A source that fails
(no board installed, Shepherdr not running, herdr closed) is logged once and keeps what it last answered (nothing,
for a board that is not installed), so the other source is still read and relayed.

## Configure

On by default. In `~/.config/pairing-buddy/config.json`:

```jsonc
"agents": false                       // no relay
"board": null                         // no board: herdr's agents only (the context card reads no board either)
"board": "/path/to/shepherdr"         // the board's command, when it is not on the daemon's PATH
```

The board is the one the context card, the goal, the chat's header, `/gen board` and `:Pair review` use (`board`,
default `shepherdr`). herdr-projects 1.x (the board before Shepherdr) is not read any more.

In Neovim, `agents_key = '<M-a>'`, `agents_open_key = '<M-o>'` and `agents_review_key = '<M-r>'` in `setup()` change
the keys (`false` for none; each is mapped only while a line shows, `Alt-r` only on a task ready to merge, and only
where you have no mapping of your own). The statusline part comes with
`require('pair').statusline()`.
