# What Pair gets from Rex

Pair uses Rex's local control socket to watch terminals in the chat's Rex session. No backend setting is needed: the shell supplies `REX_SERVER`, `REX_SESSION` and `REX_BLOCK`. Run `pair` in a Rex terminal to open the chat in a split beside it. `pair chat` stays in the current terminal. When environments identify more than one backend, Pair uses the innermost one: herdr or herdr-core, then Rex, then tmux. In tmux inside Rex, the tmux panes are the user's terminals and the Rex block that holds the tmux client is not watched.

| Need | Rex method or event | Gap |
| --- | --- | --- |
| Which terminal has focus | `session.attach` and `session.view`; `session_view_changed` | The event carries a revision, not the new focus. Pair reads the session view again. |
| Terminals coming, going or changing | `session.view`, `session_view_changed`, `block_closed`, `block_event` | Rex provides no block-created or detailed focus event; Pair refreshes the view. |
| Which command runs | `terminal.process` and `process_changed` | Rex reports the foreground process, not the command line or its exit code. The shell hook gives Pair command boundaries and exit codes. |
| A command's output | `terminal.format` | A text snapshot, not output grouped by command. Pair reads it when needed. |
| The Driver's `type` | `terminal.write` | It types literal text without pressing Enter. Rex does not report when another client types. |
| Pair's chat pane | `session.new_split` | `pair` opens a horizontal split and passes its Pair settings through `env`; Rex has no environment option on the split. |
| Pair's own pane (Scout and tests on save) | `session.new_split`, `session.list_blocks`, `terminal.write`, `block.close` | Pair starts its shell beside the chat and finds it again by its label in `session.list_blocks`. |

## What is missing

Rex has no scroll-position information, so Pair treats terminals as not scrolled. It does not report user keystrokes; in zsh the shell hook reports prompt-line changes, and the hook supplies command boundaries and exit codes in bash, zsh and fish. Without the hook, Pair infers short commands and typing from terminal text, as it does with other backends.

Rex's `terminal.write` works for the Driver: Pair types the approved text without running it. The shell hook carries `REX_BLOCK` as the pane identity. A shell's process ID still identifies a nested Neovim `:terminal` before that inherited block ID.

The Rex socket is hidden in the Linux sandbox. On macOS there is no sandbox, so it is not.
