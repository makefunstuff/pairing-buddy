# What Pair gets from herdr

Pair v0.1 uses herdr's socket API (protocol 22, herdr 0.9.5) to see the user's terminal panes and to open its chat pane. This note lists what the API offers, what Pair does with it, and what is missing.

## What the API offers and how Pair uses it

| Need | herdr API | How Pair uses it |
| --- | --- | --- |
| Which pane the user looks at | `pane.list` (`focused`, `scroll.offset_from_bottom`) | Polled once a second: focus target (editor, terminal or chat, or elsewhere when no pane of the workspace has focus) and whether the pane is scrolled up |
| Which command runs in a pane | `pane.process_info` (`foreground_processes`, `shell_pid`) | Polled once a second per pane: a foreground process other than the shell is a running command; when it is gone, the command ended |
| A command's output | `pane.read` with `source: recent_unwrapped` | Read once when a command ends; the lines after the last one that shows the command, without the prompt line |
| Open the chat pane | `pane.split` (with `env`), `pane.send_text` | `pair` splits the current pane and starts `pair chat` in the new one |
| Editors among the panes | `pane.process_info` | A pane whose foreground process is `nvim`, `vim` or `vi` counts as the editor |

Each request is its own connection: herdr answers one request per connection and then closes it.

## What is missing

- **Command boundaries and exit codes.** herdr knows nothing about the commands a shell runs: there are no shell-integration (OSC 133) events, no command start or end, and no exit status. `pane.exited` is about the pane's own process. Pair therefore polls the foreground process, which misses commands shorter than the poll interval (about a second), and it cannot tell success from failure; without an exit code it guesses from the output (`error`, `failed`, `panic`, ...).
- **The output of one command.** `pane.read` returns recent screen text, not the output of a command. Pair cuts it out heuristically, which fails when the command line was wrapped, cleared or not shown.
- **Keystrokes.** Nothing says that the user is typing in a pane, so typing at a shell prompt does not hold Pair back (typing in Neovim and the chat pane does).
- **A push stream of pane changes.** `pane_output_changed` carries only a revision number and cannot be subscribed to through `events.subscribe`, so Pair polls instead of reacting.

## The workaround Pair ships, and what would replace it

The optional shell hook (`pair shell-hook bash|zsh`) reports each finished command and its exit code straight to the Pair daemon, outside herdr. For a pane with the hook, Pair takes commands from the hook, catches short commands too, and uses herdr only for the output and focus.

What would let Pair drop the polling and the hook: herdr parsing shell-integration marks (OSC 133 `A`/`B`/`C`/`D`) and exposing `pane.command_started` / `pane.command_finished` events with the command line, exit code and the output's line range.
