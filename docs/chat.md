---
description: "The chat pane beside Neovim: who speaks, what Pair is doing now, how to type, pick a message and act on it, every key, and the plain mode."
---

# The chat pane

The chat pane is where you talk to Pair and read what it says at more length than the one line under your cursor. In
herdr, `pair` opens it on the right of the pane you run it in; without herdr, `:Pair chat` opens it in a terminal
buffer on the right of Neovim, and `pair chat` runs it in any terminal. It is optional: a Neovim alone is a whole
session.

![The chat pane on the right of Neovim: a remark on save with its diff, a question, the status row while Pair reads, the answer streaming in, a remark picked, and the keys](images/chat.gif)

## What you see

From the top:

- **The header**: the project, the session's goal, and on the right Pair's [role](roles.md) and its
  [talk level](watcher.md) (`quiet`, `normal`, `chatty`), and how many kinds of remark you muted.
- **The conversation**, newest at the bottom. Each message has a gutter with its time and who speaks:

  | Gutter | Who |
  | --- | --- |
  | `you` | What you sent, on screen as soon as you press Enter |
  | `pair` | Pair's answer to a question; a `✎ suggested change` shows as a diff |
  | `watch` | What Pair said unasked: the kind of moment and the file and line first, then its words |
  | `⎿` | What Pair's tools did for your question: the files it read, the commands it ran, what it searched |
  | `··` | Notes: the goal, the tests on save, a verdict noted, the daemon going away |
  | `!!` | An error, such as a model that does not answer, with what to check |
  | `?` | Pair asks before it runs or types a command: `y` allows it, `n` declines |

  Pair's words are Markdown: `code` shows in Pair's accent, **bold** as bold, _italics_ in italics, a link as its
  words with the address after them, lists with a hanging indent, headings, quotes, and code blocks behind a bar, not
  re-wrapped. A table shows as written. A message longer than 18 lines folds to its first 12.
- **The status row**: what Pair does now. The answer streams into the conversation as the model writes it.

  | Status | Means |
  | --- | --- |
  | `◇ watching · looked at 12 moments, spoke 2 · 3m ago` | Idle. The Watcher looked at 12 moments this session and Pair spoke at 2: most moments are not worth a word |
  | `▖ thinking · 4s · Esc stops` | Pair works on your question |
  | `▖ reading queue.go 1-40`, `running go test ./...` | One of its tools is at work, and on what |
  | `looking at regression` (dim) | Pair looks at a moment of its own accord; it may say nothing |
  | `? Pair waits for your answer` | It asked to run or type a command |
  | `⚠ the pair daemon went away · reconnecting` | The daemon restarted; the pane carries on when it is back |

  On the right: the Partner's model, how long its last answer took, and the tokens and cost of it when the provider
  reports them; when you scrolled up, how many lines are below.

  ![Right after a question: the file Pair reads is a ⎿ line under it, and the status row says thinking and that Esc stops it](images/chat-working.png)
- **What you type**, after `›`, and under it **the keys that work now**: they change when Pair works, asks, or you
  pick a message.

![A remark on save: watch, regression, the file and line, the suggestion as a diff, and the keys to rate it](images/chat-remark.png)

## Talking to Pair

Anything you type that is not a command is a question for Pair; it is always answered, outside the talk level.

- **Enter** sends. **Alt-Enter** or **Ctrl-J** starts a new line (Shift-Enter too, in a terminal that reports it). A
  paste keeps its line breaks and does not send.
- **Up** and **Down** move between the lines of what you type, and from the first or the last line through what you
  sent before in this project, kept across panes and restarts.
- **/** opens the commands as you type, each with what it does; **Tab** completes, **Enter** runs one that needs
  nothing more. The [chat commands](cli.md#chat-commands) list them all.
- **@** opens the project's files (from git): `@internal/queue/queue.go` names one in your question, for Pair to read.
  **@here** sends the lines you selected last in Neovim with it, else the line you are on: the question names them
  (`queue.go:18-20`), as `:'<,'>Pair ask` does.
- **Esc** (or **Ctrl-C**) stops the answer Pair is working on; `/cancel` too. You can type your next question while
  it works.
- "you take it" or "your turn" hands Pair the wheel, as `/drive` does ([Driver](driver.md)).
- `/gen here <what>` asks Pair for code at your cursor in Neovim, `@here` in it over the lines you selected there
  ([/gen](gen.md)). When the request's shape is a guess, or Pair asks something about it, the question waits in the
  chat with what its answers do: `y` takes the guess or the answer given, `n` cancels or leaves it to Pair, and
  anything else you type is the answer.

![A question in the chat: the file Pair read for it under it, and its answer with a list and a code block](images/chat-answer.png)

## Acting on a message

**Alt-↑** picks the last message, and further presses go up (**Alt-↓** down; a click picks one too). A bar marks it,
and the footer lists what you can do with it:

| Key | On the message |
| --- | --- |
| `c` | Copy its text to the clipboard |
| `a` | Take its suggestion in Neovim, unsaved, as `Alt-y` does there; `/undo` undoes it |
| `j` | Go to its file and line in Neovim; `Ctrl-O` there comes back |
| `+` / `-` | Rate the remark useful or noise, as `Alt-u` and `Alt-n` do |
| `m` | Mute this kind of remark for the session (`/unmute` lets it back) |
| `f` | Ask a follow-up about the remark: what you type next goes with its words |
| `e` | The idea behind the remark, as `/why` |
| `Enter` | Unfold a long message, or the tool lines one per line |
| `Esc` | Back to typing; any other key does that too |

The last remark you have not rated shows `+ useful · - noise` under it; typing `+` or `-` and Enter still rates it.

![A remark picked with Ctrl-F: the bar on its left, and the keys that act on it in the footer](images/chat-select.png)

## Finding and scrolling

- **PgUp** and **PgDn** scroll half a pane, the mouse wheel three lines. **End** on an empty line (or PgDn to the
  bottom) follows the conversation again. What you read stays put while new messages come in below.
- **Ctrl-F** finds in the conversation (`/search <text>` too): the matches are underlined, **↑** and **↓** go to the
  older or newer one, **Enter** keeps the one you are on picked, **Esc** closes.
- **Alt-M** turns the mouse off, so that the terminal selects text with it again, and on. While it is on, most
  terminals still select text with Shift held.

## Every key

`?` on an empty line shows them; any key closes the list. `/help` does too.

![The key help: keys, then the commands](images/chat-help.png)

| Key | What it does |
| --- | --- |
| `Enter` | Send |
| `Alt-Enter`, `Ctrl-J` | A new line |
| `↑` `↓` | Move in what you type, else through what you sent |
| `Ctrl-A` `Ctrl-E`, `Home` `End` | Start and end of the line |
| `Ctrl-W`, `Alt-Backspace` | Delete the word before the cursor |
| `Ctrl-U` `Ctrl-K` | Delete to the start, to the end of the line |
| `Alt-B` `Alt-F`, `Ctrl-←` `Ctrl-→` | A word back, forward |
| `Tab` | Complete a `/command` or an `@file` |
| `Esc` | Stop Pair's answer, close a menu, leave a message |
| `Alt-↑` `Alt-↓` | Pick a message ([above](#acting-on-a-message)) |
| `PgUp` `PgDn`, wheel | Scroll |
| `Ctrl-F` | Find |
| `Alt-L` | The talk level: quiet → normal → chatty |
| `Alt-M` | The mouse on or off |
| `Ctrl-L` | Draw the pane again |
| `Ctrl-C` | Stop the answer; else clear what you typed; twice on an empty line, close the pane |
| `Ctrl-D` | Close the pane, on an empty line |
| `y` `n` | While Pair asks: allow, decline (for a `/gen` question: take the guess or the answer given, cancel or leave it to Pair) |
| `?` | The keys, on an empty line |

Closing the pane leaves the session running; `pair` or `:Pair chat` opens it again, with the conversation so far.

## In Neovim

`:Pair chat` runs the same pane in a terminal buffer. Neovim passes every key to it in Terminal mode, with two
exceptions to know of: `Ctrl-\ Ctrl-N` leaves Terminal mode, and if your config maps `Esc` in Terminal mode (a common
mapping, to leave it), `Esc` does that instead of stopping an answer: use `Ctrl-C` to stop, and `Ctrl-C` to leave a
picked message.

## Colours

The pane uses your terminal's own 16 colours, so it follows your theme, and Pair's accent: the colour Neovim derives
from your colorscheme, in true colour, so that Pair reads the same in both. Until a Neovim with `termguicolors`
connects, the accent is the terminal's cyan. `+` lines of a diff are green, `-` lines red, remarks yellow, errors
red; there are no background fills. With `NO_COLOR` set it prints no colours.

## The plain pane

When the pane's input or output is no terminal (a pipe, a script), with `TERM=dumb`, or with `pair chat --plain`, it
is the plain pane: lines as they come, a `navigator ›` prompt, one line per question, and `⎿` lines for the tools. It
takes the same commands but `/search`, `/copy` and `/clear`, which say they work in the full-screen pane only;
there `?` and Enter asks about what Pair said last, as `/why` does. Nothing above about keys, picking, the menu or the status row applies there.

## Limits

- Copying uses OSC 52, the terminal's way to the clipboard: kitty, WezTerm, foot, Alacritty and Ghostty take it, and
  tmux passes it on with `set-clipboard on`. Whether it reaches your clipboard through herdr depends on herdr; a
  terminal that does not take it drops it silently, and the pane cannot tell.
- Some terminals send Shift-Enter as a plain Enter; Alt-Enter and Ctrl-J always add a line.
- `@` completes from `git ls-files`; outside a git repository it offers `@here` only, and you can still type a path.
- Messages from before this version show without their remark, place or diff, as plain text.
- The cost shows only when the provider reports it: a local server's turns show their time and tokens.
