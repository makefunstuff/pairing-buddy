# Workflows

What a day with Pair looks like, one kind of work at a time. Each section links to the page with the details.

## Exploring code

You read, search and try things; Pair follows along and speaks only when it can save you time.

- **The wrong turn.** While a test is red and you edit a file the failure does not name, Pair traces the test and,
  only if the cause is elsewhere, says so under your edit ([the wrong turn](neovim.md#the-wrong-turn)).
- **The search trail.** Three Telescope or snacks.picker searches in circles, and Pair says where the thing is, in
  the code's own word. `:Pair trail` shows the searches it saw ([the search trail](neovim.md#the-search-trail)).
- **The exploration loop.** Build, run, change one thing, run again: each run gets a number and is read next to the
  one before. When a change did nothing, Pair says why. `:Pair runs` keeps the runs ([exploration.md](exploration.md)).
- **Crashes and compiler errors.** A segfault, a sanitizer report or a panic lands on the line of its frame in your
  code; gcc, clang, zig, odin and c3c errors and warnings on theirs ([builds.md](builds.md)).
- **What it knows.** `:Pair context` shows on one card everything that goes with a remark: the goal, the board task,
  git, your commands, buffers, jumps and searches ([the context card](neovim.md#what-it-knows-the-context-card)).
- **The idea behind it.** `Alt-?` under Pair's words gives the one idea worth keeping, with a link to the docs when
  it is sure of one ([the idea behind it](neovim.md#the-idea-behind-it)).

## Tests

Set a test command per project in [`testOnSave`](config.md#testonsave), and each save runs it in Pair's pane,
narrowed to the tests the save affects where Pair can tell. A failing test gets a `✗` on its function and its
failure under the assert; a test your change broke elsewhere gets a remark and a suggested fix. When the tests turn
green after a red, the statusline lights up once ([tests-on-save.md](tests-on-save.md),
[when it goes green](neovim.md#when-it-goes-green)).

No tests? Builds and runs are read the same way, and you can [hand over without a test](#handing-over).

## Notes and the blank page

- **Notes in the margin.** In a Markdown note, Pair puts at most five marks: `?` a question the note leaves open,
  `≠` two lines that cannot both hold, `→` what the code it names really does, `◆` a decision, `≈` a repeat.
  `Alt-d` logs a decision in `decisions.md`; `:Pair tasks` lists the note's work and adds nothing until you press `y`
  ([notes.md](notes.md)).
- **The blank page.** In an empty folder, `:Pair new` and one sentence: Pair asks three short questions in
  `NOTES.md`, one at a time, then suggests a first slice of two files that runs. No scaffolding, nothing on disk
  until you save ([blank-page.md](blank-page.md)).

## Handing over

Give Pair the keyboard for one change with `:Pair drive <what>`, `/drive <what>` or "you take it" in the chat. The
statusline says `pair has the wheel · any key takes it back`; Pair types the edit into your buffer while you watch,
checks the unsaved buffer with your tests, and hands back. One `u` undoes it all.

Without a test, say what you expect to see: `you take it: make the ids spread over the table, avg probe stays under
2`. Pair builds and runs your unsaved buffer in a scratch copy with your own last command, and hands back with the
line it printed next to your target: `✓ avg probe 1.1` ([driver.md](driver.md)).

Ping-pong works too: write a failing test, say "your turn".

## Voice

Hold `Alt-t` in Neovim (or tap it twice), ask aloud, let go. whisper.cpp writes it down on your CPU in about half a second, and the
answer comes under your line. It is read aloud only if you are away from the editor when it comes. Off until you
set [`voice`](config.md#voice) ([voice.md](voice.md)).

## The day around it

- **The ledger.** `:Pair today` lists everything Pair did here today, one line each; `u` undoes one of its edits
  later ([the ledger](neovim.md#the-ledger)).
- **The day's end and the morning.** `/end` gives a debrief: what is now true, what is left, tomorrow's first step as
  a place. The next morning Neovim opens there, and Pair says in one line what is left
  ([the morning pick-up](neovim.md#the-morning-pick-up-and-the-days-end), [memory.md](memory.md)).
- **Your other agents.** When another herdr agent or a board task needs you, Pair says so in one line at your next
  break; `Alt-a` goes there ([agents.md](agents.md)).

## With or without herdr

[herdr](https://herdr.dev) is the best home for Pair: the chat pane sits beside Neovim, Pair sees your terminals and
their output, and Scout's pane opens below the chat.

Without herdr, all of Pair works inside Neovim and tmux:

- `:Pair chat` opens the chat in a terminal buffer on the right (or run `pair chat` in any terminal);
- Scout's pane and the tests on save run in a `:terminal` along the bottom of Neovim;
- Pair reads your own `:terminal` buffers and the panes of the tmux session you work in: which one you are in, the
  commands you run and their output, and with the [shell hook](cli.md#pair-shell-hook) their exit codes;
- the Driver's `type` goes to one of those terminals, after your yes.

Only a terminal that is neither (a plain window of your terminal emulator) sends just its exit codes, without output,
and herdr's own agents need herdr ([without herdr](neovim.md#without-herdr), [what Pair gets from herdr](herdr.md)).
