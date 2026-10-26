# What Pair gets from herdr

Pair uses herdr's socket API (protocol 22, herdr 0.9.5) to see the user's terminal panes, to open its chat pane and to run Scout's commands in a pane of its own. This note lists what the API offers, what Pair does with it, and what is missing.

## What the API offers and how Pair uses it

| Need | herdr API | How Pair uses it |
| --- | --- | --- |
| Which pane the user looks at | `pane.list` (`focused`, `scroll.offset_from_bottom`) | Polled once a second: focus target (editor, terminal or chat, or elsewhere when no pane of the workspace has focus) and whether the pane is scrolled up |
| Which command runs in a pane | `pane.process_info` (`foreground_processes`, `shell_pid`) | Polled once a second per pane: a foreground process other than the shell is a running command; when it is gone, the command ended |
| A command's output | `pane.read` with `source: recent_unwrapped` | Read once when a command ends (the last 400 lines); the lines after the last one that shows the command, without the prompt line |
| Open the chat pane | `pane.split` (with `env`), `pane.send_text` | `pair` splits the current pane and starts `pair chat` in the new one |
| Editors among the panes | `pane.process_info` | A pane whose foreground process is `nvim`, `vim` or `vi` counts as the editor |
| Pair's own pane (Scout) | `pane.split`, `pane.rename`, `pane.close`, `pane.list` (`label`) | Opened below the chat pane and labelled `pair scout`, so a restarted daemon finds it again; closed when the role goes back to Navigator |
| Running a command there | `pane.send_text`, `pane.wait_for_output` (regex), `pane.read` | The command is typed with Enter; Pair waits for the next `scout[N] exit X $ ` prompt, then reads up to 1000 lines (herdr's maximum) and cuts out the output; Ctrl-C (`\x03`) stops a command that runs too long |
| The Driver's `type` | `pane.send_text` | One line of plain text, without `\r`, sent to the user's terminal pane after a yes in the chat; never to the chat, Scout or editor pane |

Each request is its own connection: herdr answers one request per connection and then closes it.

## What is missing

- **Command boundaries and exit codes.** herdr knows nothing about the commands a shell runs: there are no shell-integration (OSC 133) events, no command start or end, and no exit status. `pane.exited` is about the pane's own process. Pair therefore polls the foreground process, which misses commands shorter than the poll interval (about a second), and it cannot tell success from failure; without an exit code it guesses from the output (`error`, `failed`, `panic`, ...).
- **The output of one command.** `pane.read` returns recent screen text, not the output of a command. Pair cuts it out heuristically, which fails when the command line was wrapped, cleared or not shown.
- **Keystrokes.** Nothing says that the user is typing in a pane, so typing at a shell prompt does not hold Pair back (typing in Neovim and the chat pane does).
- **A push stream of pane changes.** `pane_output_changed` carries only a revision number and cannot be subscribed to through `events.subscribe`, so Pair polls instead of reacting.

Each gap is tracked as an issue: [#22](https://github.com/makefunstuff/pairing-buddy/issues/22) (command boundaries), [#23](https://github.com/makefunstuff/pairing-buddy/issues/23) (one command's output), [#24](https://github.com/makefunstuff/pairing-buddy/issues/24) (keystrokes), [#25](https://github.com/makefunstuff/pairing-buddy/issues/25) (a push stream), and [#26](https://github.com/makefunstuff/pairing-buddy/issues/26) (at most 1000 lines per read).

Pair's own pane does not need any of this: its shell's prompt carries the command number and the exit code, and `pane.wait_for_output` reports the prompt as soon as it shows.

## The workaround Pair ships, and what would replace it

The optional shell hook (`pair shell-hook bash|zsh`) reports each finished command and its exit code straight to the Pair daemon, outside herdr. For a pane with the hook, Pair takes commands from the hook, catches short commands too, and uses herdr only for the output and focus.

What would let Pair drop the polling, the hook and its prompt in Scout's pane: herdr parsing shell-integration marks (OSC 133 `A`/`B`/`C`/`D`) and exposing `pane.command_started` / `pane.command_finished` events with the command line, exit code and the output's line range.
