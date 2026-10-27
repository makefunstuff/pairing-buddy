---
description: "When another coding agent needs you, is ready to approve, failed or is done, Pair says so in one line at your next pause, with the key that goes there."
---

# Your other agents, in one place

When you work through several agents at once, finding out who finished means looking at their panes, and each look
is an interruption you made yourself. Pair looks for you. When another agent needs you, is ready to approve, failed
or is done, Pair tells you in **one line, at your next breakpoint**, with the key that goes there. It never moves
your cursor, opens a window or speaks while you type.

![You change the hash in probe.c while the other agents move on; nothing shows while you type; you save and one line comes in the statusline; :Pair agents lists them all](images/agents.gif)

*Recorded from [a tape](captures/tapes/agents.tape) with the real plugin and daemon. The board and herdr are
stand-ins: their agents move on once you start typing.*

## What you see

![The statusline after the save: ● pair, then ◇ #21 needs you: Should a segfault also name its signal n… +2 M-a](images/agents-line.png)

- **The line.** After Pair's own part of the statusline: `◇`, who (`#21` for a task of this project's repository,
  `website/3` for another's, an agent's name or `pi in notes` for an agent outside the board), what it means for you,
  and its question or title. `+2` says two more came at the same time; they are in the list. `M-a` is the key.
  In the chat pane the same line appears once, in grey.
- **`Alt-a`** (`<M-a>`, the `agents_key` option) brings that agent's herdr pane to the front: herdr switches to
  its workspace and tab. The line goes once you have been there, or when it is no longer true (someone answered the
  question, the task was approved). When the agent has no pane any more (a finished task's agent is gone), `Alt-a`
  puts the line away. A line that asks nothing of you (done, failed) also goes by itself after two minutes; one that
  needs you or waits for your approval stays.
- **`:Pair agents`** (or `/agents` in the chat) lists every task and agent, the ones that need you first: needs
  you, ready to approve, failed, done (tasks you saw finish in the last 12 hours), idle agents, working, waiting.
  `Enter` on a line goes to that agent, `q` closes the list.

![:Pair agents: needs you #21, ready to approve #22, idle pi in notes, working #24, waiting #25](images/agents-list.png)

| State | From the board | From herdr |
| --- | --- | --- |
| needs you | the task is blocked: a question, a permission or a login; a plan to approve; the reviewer shows a dialog | the agent shows a question or an approval (`blocked`) |
| ready to approve | finished work waits for your yes (`approval`); if its merge failed or its sync is blocked, it needs you instead | |
| failed | the task stopped with an error | |
| done / finished | the work was merged or finished | the agent went from working to idle |

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
At a breakpoint the most urgent news becomes the line: needs you first, then ready to approve, failed and done.
There is only ever one line; what came with it is counted (`+2`) and listed in `:Pair agents`.

## Where it reads

Pair only reads; it changes nothing on the board and sends nothing to an agent.

- **herdr's agents**: `agent.list` over herdr's socket, which Pair knows from the chat pane, or from Neovim when it
  runs in herdr. Every agent herdr recognises, in any workspace.
- **The board**, if [Herdr Projects](https://github.com/eliasstravik/herdr-projects) is installed: its
  `herdr-projects list --json` for each task's state and words, and each open task's `task.json` (in its data
  folder, `$HERDR_PROJECTS_DATA_DIR` or `~/.herdr-projects/data`) for the task's worktree and the pane its agent
  runs in. A task's own agents (the agent and its reviewer, in the task's worktree) show as the task, not twice.
- A session opened in a task's own worktree leaves that task out: it does not tell an agent about itself.

Both are read every 5 seconds while a Neovim or chat pane is connected, and not at all otherwise. A source that fails
(no board installed, herdr closed) is logged once and keeps what it last answered (nothing, for a board that is not
installed), so the other source is still read and relayed.

## Configure

On by default. In `~/.config/pairing-buddy/config.json`:

```jsonc
"agents": false                       // no relay
"board": null                         // no board: herdr's agents only (the context card reads no board either)
"board": "/path/to/herdr-projects"    // the board's command, when it is not on the daemon's PATH
```

The board is the one the context card and the goal are read from (`board`, default `herdr-projects`).

In Neovim, `agents_key = '<M-a>'` in `setup()` changes the key (it is mapped only while a line shows, and only where
you have no mapping of your own). The statusline part comes with `require('pair').statusline()`.
