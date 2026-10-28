---
description: "The chat pane beside Neovim: who speaks, what Pair is doing now, how to type, pick a message and act on it, every key, and the plain mode."
---

# The chat pane

The chat pane is where you talk to Pair and read what it says at more length than the one line under your cursor. In
herdr, `pair` opens it on the right of the pane you run it in; without herdr, `:Pair chat` opens it in a terminal
buffer on the right of Neovim, and `pair chat` runs it in any terminal. It is optional: a Neovim alone is a whole
session.

![The chat pane on the right of Neovim: a remark on save with its diff, a question, the status while Pair reads, the answer streaming in, a remark picked, and the keys](images/chat.gif)

## What you see

Four rows of chrome, two of them rules with words in them; the rest is the conversation. From the top:

- **The header, in the top rule**: `── pair · hookd · the session's goal ──── navigator · normal ──`. The project, the
  goal, and on the right Pair's [role](roles.md) and its [talk level](watcher.md) (`quiet`, `normal`, `chatty`), and
  how many kinds of remark you muted. When the pane is narrow the goal is cut first, then left out (always under 52
  columns), then the role is shortened (`nav`), then the muted count, the level and the role give way.
- **The conversation**, newest at the bottom. Each message has a 7-column gutter with who speaks, the same in a wide
  pane and a narrow one:

  | Gutter | Who |
  | --- | --- |
  | `you` | What you sent, on screen as soon as you press Enter |
  | `pair` | Pair's answer to a question; a `✎ suggested change` shows as a diff. Also what Pair asks you: the session's goal, its greeting with last time's note, and whether it may run or type a command |
  | `watch` | What Pair said unasked: the kind of moment and the file and line first, then its words |
  | `⎿` | What Pair's tools did for your question: the files it read, the commands it ran, what it searched |
  | `··` | Notes: the tests on save, a verdict noted, a level changed |
  | `!!` | An error, such as a model that does not answer, with what to check |

  The time is not on each message: a dim `── 21:19 ──` in the middle of the pane says it at the start, and again
  after a pause of five minutes or more, with the day (`── Thu 29 Oct · 00:12 ──`) when it is another day than the
  message before it. A picked message (`Alt-↑`, [below](#acting-on-a-message)) shows its own time on the right of the
  footer.

  ```
                              ── 21:19 ──
   watch regression · internal/queue/lease.go:18
         the lease ends before the last attempt does, so the third retry
         finds the job taken and gets a 409.
         │ - return &Lease{ttl: cfg.Budget}
         │ + return &Lease{ttl: cfg.Budget + cfg.AttemptTimeout}
         + useful · - noise · Alt-↑ more

   you   why does the third retry get a 409 and not a 200?
         ⎿ read internal/queue/lease.go 1-40 · searched AttemptTimeout
  ```

  Before Pair runs or types a command it asks, as `pair`: the question in words, and the command under it behind a
  bar, whole (backticks in it too), to read and copy. `y` allows it, `n` or `Esc` declines (and drops what you had typed), or type an answer (the name of another
  terminal, where it offers one); the footer shows those keys, and the message says what you answered.

  ```
   pair  May I run this in my pane (go test runs code)?
         │ go test ./internal/queue -run TestLease -count=1
  ── ? waiting for your answer ──────────────────────── qwen3-coder-30b · 6.4s ──
  y/N › or type an answer
   y allow · n decline · Esc decline
  ```

  The goal you type, or the one Pair took from the board or the branch, is in the header; the conversation does not
  say it again. Only a goal set elsewhere (`:Pair goal`) while Pair's question for it is open shows as a `··` note
  under the question, to answer it.

  Pair's words are Markdown: `code` shows in Pair's accent, **bold** as bold, _italics_ in italics, a link as its
  words with the address after them, lists with a hanging indent, headings, quotes, and code blocks behind a bar. A
  table shows as written. A message longer than 18 lines folds to its first 12.

  Code blocks, diffs and the command of a question wrap between tokens, with a hanging indent: at a space first, else
  before a dot or after an opening bracket, a slash or a value's `=`, never inside a name, a number or a flag
  (`cfg.AttemptTimeout`, `my-component-name`, `v1.2.3-rc.1`, `--config=`). A name longer than the whole line breaks
  after a dash in it; only a word with none is cut. A line indented deeper than half the pane shows at half of it, so
  its words keep the other half. A `code` span in a sentence wraps at its own spaces, so it starts on the line of the
  word before it.

  **In a wide pane** the words end by column 80, the measure that reads well; code blocks and diffs use the whole
  width. The margin on the right holds what a turn of Pair's took, on the first line of what it said in it (an answer,
  or a remark): `21:19 · 6.4s · 3.4k tok`. With less room the tokens go first, then the duration.

  **In a narrow pane** (under 52 columns) the gutter stays, so a message spends no row on its name. What gives way,
  instead of being cut in the middle:

  - the `⎿` line names files by their base name and counts the tools that do not fit: `⎿ read lease.go 1-40 · +1`;
  - a remark's place is its file's base name: `regression · lease.go:18`;
  - the header drops the goal and shortens the role (`── pair · hookd ──── nav · normal ──`);
  - the status keeps its words whole and drops what it can: the model first, then the counts
    (`── ◇ watching · 3m ago ──`), `? waiting`, `▖ reading lease.go 1-40 2s`, `⚠ reconnecting`;
  - the footer says its keys short (`/ cmds · @ files · Alt-↑ pick · ? keys`);
  - the `@` menu cuts a path at its start, a folder at a time, so two files never look the same:
    `@…/retry/backoff.go`, `@…/backoff_test.go`.

  ![A 44-column chat pane: the gutter kept, the suggestion's diff wrapped between tokens with a hanging indent, the ⎿ line by base name, nav in the header and the short footer](images/chat-narrow.png)

  ![The same pane 112 columns wide: the words end by column 80, the diff runs on, and each turn's time, duration and tokens on the right of what Pair said](images/chat-wide.png)
- **The status, in the rule over what you type**: what Pair does now, as `── ▖ writing 6s ──── qwen3-coder-30b ──`.
  It names no keys (those are in the footer), and its word is in body text, so it ranks above the footer. The answer
  streams into the conversation as the model writes it.

  | Status | Means |
  | --- | --- |
  | `◇ watching · looked at 12 moments, spoke 2 · 3m ago` | Idle. The Watcher looked at 12 moments this session and Pair spoke at 2: most moments are not worth a word |
  | `▖ thinking 4s` | Pair works on your question; `Esc` stops it |
  | `▖ writing 6s` | Its answer is arriving, word by word |
  | `▖ reading queue.go 1-40`, `running go test ./...` | One of its tools is at work, and on what |
  | `▖ looking at regression` | Pair looks at a moment of its own accord; it may say nothing |
  | `? waiting for your answer` | It asked to run or type a command |
  | `◆ Pair drives` | Pair has the wheel ([Driver](driver.md)) |
  | `⚠ the pair daemon went away · reconnecting` | The daemon restarted; the pane carries on when it is back |

  On the right: the Partner's model, how long its last answer took, and the tokens and cost of it when the provider
  reports them; when you scrolled up, how many lines are below (and `End` in the footer goes back down). The right
  side gives way first, from its end; then the status is said shorter ([narrow panes](#what-you-see)).

  ![Right after a question: the file Pair reads is a ⎿ line under it, and the status in the rule says thinking](images/chat-working.png)
- **What you type**, after `›`, and under it **the keys that work now**: they change when Pair works, asks, or you
  pick a message. The footer holds keys only; a short note (copied, taken in Neovim) shows there for a moment.

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

![A question in the chat: the file Pair read for it under it, and its answer with a list and a code block](images/chat-answer.png)

## Acting on a message

**Alt-↑** picks the last message, and further presses go up (**Alt-↓** down; a click picks one too). A bar marks it,
and the footer lists what you can do with it, with the message's time on the right:

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
| `y` `n` | While Pair asks: allow, decline; `Esc` declines too |
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
connects, the accent is the terminal's cyan. There are no background fills, gradients or glows. With `NO_COLOR` set
it prints no colours.

Each colour has one job, so that it still means something, and so that what you must read is never in the colours
that light themes wash out:

| Colour | Only for |
| --- | --- |
| Body text | Everything addressed to you: answers, questions, notes, the status word, the empty card, the help |
| Pair's accent | Pair's name, `code` in its words, the prompt, the spinner, the bar of a picked message |
| Yellow | The Watcher: the `watch` label and a remark's kind and place; the `?` of a question waiting for you; `y` and `n` (bold) in the footer while it waits |
| Dim | Chrome: the rules, the time dividers and an answer's time in the margin, what a key in the footer does, the `⎿` tool lines, a fold, a link's address |
| Green, red | `+` and `-` lines of a diff; an error, in red |

Light themes are where dim and yellow fade: against the background, dim is about 2 : 1 in Tokyo Night Day and
Solarized Light, and yellow is 3.0 : 1 in Solarized Light and 1.7 : 1 in xterm's default light (body text wants
4.5 : 1). So no sentence is set in either: the y/N question is body text with its command behind a bar, and only the
keys `y` and `n`, in bold, keep the yellow.

## The plain pane

When the pane's input or output is no terminal (a pipe, a script), with `TERM=dumb`, or with `pair chat --plain`, it
is the plain pane: lines as they come, a `navigator ›` prompt, one line per question, and `⎿` lines for the tools. It
takes the same commands but `/search`, `/copy` and `/clear`, which say they work in the full-screen pane only;
there `?` and Enter asks about what Pair said last, as `/why` does. Nothing above about keys, picking, the menu, the
rules or the status applies there: Pair's question ends in `[y/N]`, and the goal is said in the conversation.

## Limits

- Copying uses OSC 52, the terminal's way to the clipboard: kitty, WezTerm, foot, Alacritty and Ghostty take it, and
  tmux passes it on with `set-clipboard on`. Whether it reaches your clipboard through herdr depends on herdr; a
  terminal that does not take it drops it silently, and the pane cannot tell.
- Some terminals send Shift-Enter as a plain Enter; Alt-Enter and Ctrl-J always add a line.
- `@` completes from `git ls-files`; outside a git repository it offers `@here` only, and you can still type a path.
- Messages from before this version show without their remark, place or diff, as plain text.
- The cost shows only when the provider reports it: a local server's turns show their time and tokens.
- An answer's time, duration and tokens show in its margin only in a pane wider than 80 columns, and only for
  answers given while the pane is open: the conversation it shows again after a restart has its times in the dividers.
