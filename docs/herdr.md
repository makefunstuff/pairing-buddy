# What Pair gets from herdr

Pair uses herdr's socket API (protocol 22, herdr 0.9.5) to see the user's terminal panes, to open its chat pane and to run Scout's commands in a pane of its own. This note lists what the API offers, what Pair does with it, what Pair does where it falls short, and what herdr would need to add.

## What the API offers and how Pair uses it

| Need | herdr API | How Pair uses it |
| --- | --- | --- |
| Which pane the user looks at | `events.subscribe` (`pane.focused`, `tab.focused`, `workspace.focused`, `pane.created`, `pane.closed`, `pane.updated`), then `pane.list` (`focused`) | Pushed: each event makes Pair look at the workspace's panes once. The focus target is editor, terminal or chat, or elsewhere when no pane of the workspace has focus |
| Whether that pane is scrolled up | `events.subscribe` (`pane.scroll_changed` for the focused pane) | Pushed; the subscription follows the focus |
| Which command runs in a pane | none; `pane.process_info` (`foreground_processes`, `shell_pid`) | With the shell hook, the hook says when each command starts and ends; while one runs, Pair looks at the pane's processes only for an editor (below). Without it, polled where it can change: the focused pane twice a second, a pane with a command running once a second. A foreground process other than the shell is a running command; when it is gone, the command ended |
| Typing at a shell prompt, and commands too short to be seen running | none; `pane.read` (the last 50 lines) | zsh with the hook says when keys change the line. Elsewhere, in the focused pane, at each look while its shell waits at the prompt (see below) |
| A command's output | `pane.read` with `source: recent_unwrapped` | Read once when a command ends (the last 1000 lines, herdr's maximum); the lines after the one the command was typed on, without the prompt line. With the hook, that line is found once more when the command starts (see below) |
| An editor in a pane | `pane.process_info` | A pane whose foreground process is `nvim`, `vim` or `vi`; looked at when a pane appears, and with the hook while a command runs, once a second (twice with focus): an editor can open late, as `git commit` does after its hooks |
| Open the chat pane | `pane.split` (with `env`), `pane.send_text` | `pair` splits the current pane and starts `pair chat` in the new one |
| Pair's own pane (Scout) | `pane.split`, `pane.rename`, `pane.close`, `pane.list` (`label`) | Opened below the chat pane and labelled `pair scout`, so a restarted daemon finds it again; closed when the role goes back to Navigator |
| Running a command there | `pane.send_text` | The command is typed with Enter; its shell writes its output and exit code to files (see below); Ctrl-C (`\x03`) stops a command that runs too long |
| The Driver's `type` | `pane.send_text` | One line of plain text, without `\r`, sent to the user's terminal pane after a yes in the chat; never to the chat, Scout or editor pane |

Each request is its own connection: herdr answers one request per connection and then closes it. The event stream is one more connection, which stays open; when herdr goes away, Pair tries again every 2 seconds and looks at the panes once it is back. While the user is in another workspace and no command runs in this one, Pair sends herdr nothing; nor while the focused pane is a zsh with the shell hook waiting at its prompt.

## Pair's own pane: exact

Pair starts the shell of its pane itself, so it does not need herdr for commands there. The shell is `bash --noprofile` with an rc file Pair writes ([src/pane-runs.mjs](../src/pane-runs.mjs)). At its start, before any command, it sends all it shows through one `tee` to the screen and to `pane.log` in the data directory (`panes/<pane>/`); for each command line, bash's `PS0` writes the mark `OSC 133;C;aid=pairN` there before the output, and the prompt writes `OSC 133;D;<exit>;aid=pairN` after it, and the exit code to `N.exit`. A file `next` holds the number of the next command, or `running N`. Pair waits for `N.exit` and cuts the output out of the log between the two marks, whole, however long (beyond 4 MB, the middle is cut). Pipes (`git log | grep x`), subshells, jobs left in the background (`npm run dev &`, whose later output stays out of the command's) and Ctrl-C need nothing special: no command holds the `tee` open or waits for it. The prompt (`scout[N] exit X $ `) is for you; the marks are OSC 133, for a terminal that reads them.

## The user's panes: the shell hook, else heuristics

herdr says nothing about the commands a shell runs, so the optional **shell hook** (`pair shell-hook bash|zsh|fish`, see [install.md](install.md); [src/shell-hook.mjs](../src/shell-hook.mjs)) tells the Pair daemon itself, outside herdr:

- **When the shell starts** (`pair report --ready`): from then on Pair takes the pane's commands from the hook and stops polling its processes.
- **When each command starts and ends** (`--start`, `--exit`), with the command line as typed, the exit code, the shell's pid and the line's number. Each report runs in the background, so the prompt never waits; a start that arrives after its own end (it happens) is known by its number and ignored. Every command is caught, however short, in any pane, focused or not.
- **Keys at the prompt, in zsh**: a `zle-line-pre-redraw` hook sees the line or cursor change and says so at most twice a second (the first key at a new prompt always), straight to the daemon's socket through zsh's own `zsocket` (no process started; the keys themselves are never sent). That holds Pair's remarks back like typing in Neovim does, and takes the wheel back from the Driver; the Driver's own `type` does not count. bash and fish have no hook for keys, so there Pair reads the focused pane at its prompt for typing (below), and its processes only while a command runs.
- **Where a command's output starts**: when a command starts, Pair reads the pane once and finds the line it was typed on (the last that ends with it), and once it ends, reads its output from below that line. While the command runs, Pair looks at its processes once a second (twice with focus), only to see an editor open (`nvim`, or `git commit` once its hooks ran), so the Driver's `type` never goes into one.
- It also emits OSC 133 marks: `A` before the prompt, `C` before the output, `D;<exit>` at the end, ready for herdr to read them.

The output itself still comes from herdr's screen text: a shell hook cannot copy a command's output without taking the terminal away from it (no colours, pagers or progress bars, as in Pair's own pane), so more than 1000 lines still lose their beginning.

Without the hook, Pair reads what it can ([src/pane-text.mjs](../src/pane-text.mjs)):

- **Typing.** At each look at the focused pane while its shell waits at the prompt, Pair compares the pane's last lines with the last look: when only the last line changed, or Tab showed it again, you pressed keys there. A prompt that changes by itself (a clock in it) looks like typing too.
- **Short commands.** When the line you typed on moved up, with lines and a new prompt below it, a command ran between two looks, too short to be seen running. Pair names it by what follows the empty prompt on that line (the last line at the first look, and after each Enter).
- **Where a command's output starts.** At the line it was typed on, as the last look at the prompt showed it; else at the last line that ends with the command, else at one that contains its start. A command that was typed as an alias is named as typed. When the line is not found (the screen was cleared, or more than 1000 lines followed), the output is marked as the pane's recent lines.

## What is missing

Checked against herdr 0.9.5 (protocol 22), the newest at the time of writing:

- **Command boundaries and exit codes.** herdr knows nothing about the commands a shell runs: it drops OSC 133 marks, and there are no command start or end events and no exit status. `pane.exited` is about the pane's own process. Without the shell hook, Pair has no exit code for your commands, and a command that starts and ends between two looks at a pane that does not have focus is missed.
- **The output of one command.** `pane.read` returns recent screen text, at most 1000 lines, not the output of a command, so Pair cuts it out from the command's line, also with the hook.
- **Keystrokes.** Nothing says that the user typed in a pane. zsh's hook says it; for bash and fish Pair tells it from the prompt line, twice a second, and only for the focused pane.
- **Output changes as events.** The schema lists `pane_output_changed` with a `revision` and `events.wait` with a `min_revision`, but `events.wait` answers "currently supports pane agent status matches" for anything else; the `revision` of `pane.read` and `pane.list` follows the pane's metadata (its title), not its output; `pane.output_matched` fires once per subscription. So nothing pushes a change of a pane's text or foreground process, and Pair still polls panes without the hook.

Each gap is tracked as an issue: [#22](https://github.com/makefunstuff/pairing-buddy/issues/22) (command boundaries), [#23](https://github.com/makefunstuff/pairing-buddy/issues/23) (one command's output), [#24](https://github.com/makefunstuff/pairing-buddy/issues/24) (keystrokes), [#25](https://github.com/makefunstuff/pairing-buddy/issues/25) (a push stream).

## What herdr would need to add

A concrete proposal, in the API's own terms. Each part stands alone; the first does the most.

1. **Shell integration (OSC 133).** herdr parses `OSC 133 ; A`, `B`, `C` and `D ; <exit>` (the marks of the shell hook and of Pair's pane, also used by kitty, WezTerm, iTerm2 and VS Code) and keeps, per pane, the commands it saw: id, command line (the text between `B` and `C`), cwd, start and end time, exit code, and the output's range of lines in the scrollback.
   - Events `pane.command_started` `{pane_id, command_id, command, cwd}` and `pane.command_finished` `{pane_id, command_id, command, exit_code, duration_ms, output_lines}`, both subscribable through `events.subscribe`.
   - `pane.read` takes `source: "command"` with a `command_id` (or `"last_command"`) and returns exactly that command's output, unwrapped, with `truncated` when the scrollback no longer holds all of it.
   - `pane.process_info` or `pane.get` says whether the shell is at its prompt (`A` or `B` seen last) or running a command (`C`).
   With this, Pair would drop the polling of processes, the heuristics and the hook's reports; the hook would stay only as the snippet that emits the marks for shells that do not. It would also give the exact output and the exit code in panes whose shell has no hook of Pair's, as long as the shell emits the marks (fish 4 and many prompt frameworks do).
2. **Input activity.** `pane.input` events `{pane_id, at}` for keys and pastes from a client, at most a few a second, never with the keys themselves; or `last_input_at` in `pane.list` and `pane.get`. Pair would use it for the typing pause and the take-back in every pane, not only the focused one.
3. **Output changes as a subscription.** `pane.output_changed` `{pane_id, revision}` subscribable per pane or per workspace, at most a few a second, and a foreground-process change in `pane.updated`. Pair would then poll nothing. The smallest step is already in the schema: `events.wait` with `{event: "pane_output_changed", pane_id, min_revision}`, answered once the pane's output revision passes `min_revision`, with `pane.read` returning that same output revision.
4. **Longer reads.** `pane.read` with more than 1000 lines, or with a start line or revision to read from. Less needed with 1.
