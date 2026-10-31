# The chat pane and its keys

The chat pane is where you ask Pair things, read its longer answers, and act on what it said: take a suggestion, go
to a line, rate a remark. This walks through the keys you will use every day.

## 1. Open it

In herdr, run `pair` in a shell pane next to Neovim: the chat opens in a new pane to its right. Without herdr, `:Pair chat` in Neovim opens the same pane on the
right. Closing it leaves the session running; opening it again brings back the conversation.

The top rule names the project, the goal, the role and the talk level. The rule over where you type says what Pair
is doing now.

## 2. Ask

Type a question and `Enter`. `Alt-Enter` (or `Ctrl-J`) starts a new line. `↑` and `↓` move between the lines you type,
and from the first or last one through what you asked before.

- `@` lists the project's files: `@internal/queue/queue.go` names one for Pair to read; `Tab` or `Enter` inserts it.
- `@here` sends the lines you selected last in Neovim with the question, else the line you are on.
- `Esc` (or `Ctrl-C`) stops an answer. You can type your next question while it works.

![A question in the chat: the file Pair read for it under it, and its answer with a list and a code block](../images/chat-answer.png)

## 3. Run a command

`/` opens the command menu as you type: the command, its arguments, what it does. `↑` `↓` go through it, `Tab`
completes, `Enter` runs one that needs nothing more. A few to know:

| Command | What it does |
| --- | --- |
| `/goal <what>` | Sets the session's goal |
| `/scout`, `/navigate`, `/drive <what>` | Switches the role ([Roles and handing over](roles-and-hand-over.md)) |
| `/gen here <what>` | Asks for code at your cursor in Neovim ([/gen](gen-here-and-file.md)) |
| `/undo` | Takes back the last thing Pair changed today |
| `/today` | What Pair did here today |
| `/end` | Ends the session, with a debrief |

![The command menu: seven commands in three columns, the count in its rule and how many more under it](../images/chat-menu.png)

## 4. Act on a message

`Alt-↑` picks the last message; more presses go up, `Alt-↓` down. A bar marks it, and the footer lists what you can
do with it:

| Key | On the picked message |
| --- | --- |
| `a` | Take its suggestion in Neovim, unsaved, as `Alt-y` does there |
| `j` | Go to its file and line in Neovim; `Ctrl-O` there comes back |
| `c` | Copy its text |
| `+` / `-` | Rate the remark useful or noise; editing where it pointed marks it `✓ useful` by itself |
| `f` | Ask a follow-up about it |
| `e` | The idea behind it, as `/why` |
| `Enter` | Unfold a long message |
| `Esc` | Back to typing |

When a remark is the last thing said, its own line shows these keys under it: `Alt-↑` then the key.

![A remark that came on save, its suggestion as a diff, and its action line](../images/chat-remark.png)

## 5. Find, scroll, and the rest

- `PgUp` and `PgDn` scroll; `End` on an empty line follows the conversation again.
- `Ctrl-F` finds in the conversation: `↑` `↓` go from match to match, `Enter` picks the message it is in.
- `Alt-L` changes the talk level: quiet, normal, chatty.
- `?` on an empty line shows every key.

![The key help: keys, then the commands](../images/chat-help.png)

**In Neovim's `:Pair chat`**, Neovim passes every key to the pane while you type in it. `Ctrl-\ Ctrl-N` leaves it
for Neovim (then `Ctrl-W h` goes to your code). If your config maps `Esc` in Terminal mode, use `Ctrl-C` to stop an
answer.

## More

[The chat pane](../chat.md) has every key, the gen card, wide and narrow panes and the colours;
[chat commands](../cli.md#chat-commands) lists every command.
