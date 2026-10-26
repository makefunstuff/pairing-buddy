# The pair in Neovim

Pair sits in the second chair. In Neovim it has a small visual language: a few marks in one colour, all in your
own font, and no windows, boxes, borders or field labels, except the one card you open yourself to see what it knows.
Everything it shows follows one test: would you keep it on screen for an eight-hour day?

![Pair stops a wrong turn: it reads, says why under your edit, and Alt-j goes to the real cause](images/wrong-turn.gif)

*The capture above is the plugin and the daemon as shipped, in a clean Neovim with the ayu colorscheme. The test
run is real `go test`; only the models' words are scripted. It is recorded from a tape in [captures/](captures/).*

## A few marks, one accent

| Mark | Where | What it means |
| --- | --- | --- |
| `●` and a line or two | under the line you are on | Pair's voice: what it says unasked, in your font, indented with your code |
| a lit line number | the number column | its gaze: the lines it is reading, one after another, with a short trail |
| `▎` | the sign column | a line it points at, or the line its words are about |
| `•` | the sign column, and `held thought` in the statusline | a remark that waits for your next break, about this line ([below](#the-held-thought)) |
| `M-j` | after its words | go where it points; your cursor never moves by itself |
| `◎` | the statusline | it has the wheel (the Driver); any key takes it back |
| a block after ghost text | where it types | its cursor, while it types the change you handed over |
| `◌` | the statusline | it is not there: reconnecting, or a model is down |
| `◉` and a meter | under your line, and the statusline | it listens while you hold `Alt-t` ([push-to-talk](voice.md)) |
| `⠹` | the statusline | it thinks before it answers, or runs your tests |
| `✓` `✗` | the statusline, and the sign column of your tests | tests it ran for you when you saved |

**One accent, from your colorscheme.** Pair takes its colour from the colorscheme you use, so it fits in light and
dark: of the colorscheme's own colours for regular expressions, its terminal cyan, its hints and its specials, it
picks the one whose hue is furthest from every colour your code is drawn in, and makes sure it reads on your
background. So Pair is never mistaken for syntax. It also keeps at least 30° of hue away from the colorscheme's
error colour, so Pair is never mistaken for an error. With ayu that is its regexp teal; with Neovim's own
colorscheme, its cyan. Pair's words are your foreground tinted toward the accent, and `code` in them is the accent.

**On a grey palette.** Many desktop themes are greys with one signal colour, often a warm red. When your code is
drawn in greys, with at most that one colour, Pair takes a quiet teal instead: the one other colour on screen, so
when it speaks, you see it, and it never reads as an error. Before, such a palette gave Pair its red.

**The chat pane in the same colour.** Neovim sends the accent to the daemon, and the chat pane prints Pair's name and
the `code` in its words in it, in true colour, with long lines wrapped under the words. Before a Neovim with
`termguicolors` connects it uses the terminal's cyan; with `NO_COLOR` set it prints no colours.

![One look: Neovim on a grey palette with one warm red; Pair's teal under the code, in the statusline and in the chat pane](images/held-shown.png)

Every highlight group is defined with `default = true`, and only when the colorscheme has not defined it: a
colorscheme or your config can set any of them and keeps its own. Pair sets them again when you change the
colorscheme, `background` or `termguicolors`.

## The wrong turn

The moment this language was made for: a test is red, and you start fixing it in a file the failure does not name.

1. You ran the tests in your terminal; the failure names `worker_test.go`. You open `backoff.go` and change the
   shift, sure it is off by one.
2. Once you pause, Pair looks: its gaze crosses the line numbers of `backoff.go`, then the statusline says
   `● reading worker.go`.
3. Two quiet lines appear under your edit, fading in over a quarter of a second: the shift is fine, and the real
   cause is `worker.go:35`, which gives up on `>=`. They end with `M-j`.
4. You undo. The words go with your edit: an edit counts as having seen them, neither useful nor noise.
5. `Alt-j` goes there. The line is tinted, the `>=` is underlined, and Pair's note sits after the line.
   `Ctrl-O` brings you back.

![The remark under the edited line](images/remark.png)

![After Alt-j: the line tinted, the >= underlined, the note after it](images/jump.png)

The trigger behind it, `edit_while_red`, goes through the speak gate like the others: the Watcher scores whether a
check of that file would save you time, and the Partner reads your change, the failing test and the code it tests.
It traces the test through the code as it is now, thinking first if its model can: if your change is the fix, or it is not
sure, it stays silent; only when the failure still comes from elsewhere does it point there. Details in [docs/watcher.md](watcher.md).

## It runs what you'd skip

The second moment: you save a fix, the tests you ran pass, and you would push. Pair runs the whole suite as you
save, in its own pane, and finds what your fix broke somewhere you were not looking. You set the command per project
(`testOnSave` in the config, see the [README](../README.md#tests-on-save)); the model never starts a run.

![On save: the spinner, the failing test, the remark, the suggestion, Alt-y, and green](images/tests-on-save.gif)

*The plugin and the daemon as shipped, in a clean Neovim with ayu. Both test runs are real `go test -json ./...`
runs on the project; only the models' words are scripted.*

1. You save `worker.go` as it is, and the statusline spins: `⠹ go test ./...`. This first run of the session is the
   baseline: it is red on the delivery test, the bug from the wrong turn, and that raises nothing.
2. You change `>=` to `>`, the fix, and save. The delivery test passes now, but the statusline turns to
   `✗ 1 failing · TestNoDoubleDelivery`: a test that passed in the run before. In `queue_test.go`, below, the test function gets a `✗` and its
   neighbour a quiet `✓`; the message `t.Fatalf` printed sits under line 34, where it failed.
3. Pair reads the test, then `queue.go` (the statusline names each file; where the file is on screen, its gaze
   crosses the line numbers), and two lines appear under your change: attempt 5 now starts at 15 s, the moment the
   queue's lease on the job runs out, so a second worker takes it. They end with `M-j`.
4. `Alt-j` goes to `queue.go:18`, where its fix waits: the old line struck through, the new one under it, and `M-y`.
5. `Alt-y` takes it, `:w` saves it, the tests run again: `✓ go test ./... · 4 tests, 3 packages` for a few seconds,
   and the `✗` turns into a `✓`, rising from the background.

![The remark under your change; a cross on the failing test below, the failure under the line it failed on](images/regression.png)

![After Alt-j: the suggestion in queue.go, the old line struck through](images/regression-fix.png)

![The statusline while the tests run, when one fails, and when they pass](images/test-statusline.png)

The run on save is never a remark by itself: the statusline and the signs say how it went, and the chat says when it
turns red or green. Only a **regression**, a test that fails now and did not in Pair's run before, goes through the
speak gate as an unasked remark, so a suite that stays red the same way stays quiet. The Partner is asked to keep
your change working (you made it for a reason) and to suggest the fix where it breaks, thinking first if its model
can. Details in [docs/watcher.md](watcher.md#regressions).

**What the run shows.**

- **Statusline.** `⠹ go test ./...` while it runs, with the flags that only ask for JSON left out. Then
  `✗ 1 failing · TestNoDoubleDelivery` (`+2` when more fail, `does not build` for a Go build error) until the next
  run, or `✓ go test ./... · 4 tests, 3 packages` for six seconds before it rests at `● pair` again. Pair reading,
  driving, or away comes first. Without Pair's pane (no `pair` in herdr) it says `◌ go test ./... · needs \`pair\` in
  herdr` instead, until a run can start.
- **Signs.** With a JSON report (`go test -json`, `jest --json`, `vitest --reporter=json`), each test that ran gets
  `✓` or `✗` in the sign column of its function (Go) or its `test(...)` line (jest, vitest), in every buffer you have
  open and in test files you open later. Passing signs are quiet; failing ones are your colorscheme's error colour.
  A sign whose result changed since the last run fades in; while the next run is on, the last results show half
  faded.
- **Failures.** The failed test's message (`t.Errorf`, a panic, `expect(...)`) shows after the line it failed on,
  or under it when the line is too long for the window.

![A failing test in Neovim's own light colorscheme](images/tests-light.png)

## The visible hand-over

The third moment: you write the first case of a table test and hand over the boring part with
`:Pair drive the edge cases`. You watch Pair type, it tests what it typed before anything is saved, and it gives the
keyboard back.

![The hand-over: Pair types six cases as ghost text, tests the unsaved buffer, and hands back; u takes all six away, Ctrl-R brings them back](images/hand-over.gif)

*The plugin and the daemon as shipped, in a clean Neovim with ayu. The test run is a real `go test -overlay` on the
unsaved buffer; only the models' words are scripted.*

1. The statusline says `◎ pair has the wheel · any key takes it back`. Pair reads the test and the code it tests;
   its gaze crosses the line numbers.
2. It types. The new text arrives as ghost text with Pair's cursor at its end; the indent comes at once, as your
   editor would put it. A line enters the buffer only when it is whole, so your buffer and your language server
   never see half a line, and nothing goes red while it types. Each line it entered gets `▎` in the sign column.
   Text it replaces is struck through for a moment first; within a line, only the part that changes is.
3. It runs your project's test command on the **unsaved** buffer: `⠹ go test ./... (unsaved)` (see
   [docs/driver.md](driver.md#tests-on-the-unsaved-buffer)).
4. It hands back: its words under the last line it changed, `✓` (or `✗`) in the sign column there and in the
   statusline, the `▎` still on the lines it changed, and `u undoes it`. Like any of its words, they go with your
   next edit.
5. Everything it typed is one undo step: one `u` takes it all away, `Ctrl-R` brings it back. Nothing is saved
   until you `:w`.

![While it drives: the ghost text and Pair's cursor, a bar on each line it entered, the wheel in the statusline](images/driving.png)

![Handed back: six cases, ✓ in the margin and the statusline, and its note on the case you would have skipped](images/hand-back.png)

**Taking it back halfway.** Any key you press while Pair types ends it at once, and leaves **no change**: the
lines it already entered are undone, and that key, and any you press until they are, does nothing else, so it
cannot change the buffer under a half-typed edit. Scrolling and clicking to watch are not keys. After the typing,
a key still takes the wheel back, and leaves the one change.

![A key halfway: the lines Pair typed go, and the statusline is back at ● pair](images/take-back.gif)

A long edit types faster, to take about four seconds; with `motion = false` it lands at once, as one undo step.
If no window shows the lines it changes, they open in a split first, so you can watch; your cursor stays where it was.

## The held thought

Most of what Pair has to say is not urgent. A remark about drift, a stall, or an error in a line you wrote and left
is held for your next natural break: a save, a run or a commit that ended, leaving Insert mode for a few seconds, or
a quiet stretch. A wrong turn, a regression or a failure you missed still speak at your next pause in typing.

![The held thought: you write ring_pop in C and go on; a dot waits by the line, and the remark shows when you save](images/held-thought.gif)

*The plugin and the daemon as shipped, in a clean Neovim on mini.base16 with a grey palette, `clangd` for the
diagnostics, and the real chat pane on the right. Only the models' words are scripted.*

1. You write `ring_pop` in C and go on typing. `clangd` marks `capacity` on line 26: nothing declares it.
2. You stop for a moment to think; Pair looks, reads `ring.h`, and has its remark ready. It does not say it: you are
   still in Insert mode, still writing. A `•` appears in the margin at line 26, and the statusline says
   `● pair · held thought · M-j`. The chat stays as it was.
3. You finish the function and save. Now the remark shows: line 26 tinted with `capacity` underlined and its note,
   the words under your line, and the same words in the chat, in the same teal.

![While you type: the dot by line 26, and the statusline](images/held.png)

![At the save: the point, the note, the words under your line, and the chat](images/held-shown.png)

`Alt-j` shows a held thought at once, and goes where it points once it shows. If you fix the line yourself before
your break, the dot goes and Pair says nothing. The rules are in [docs/watcher.md](watcher.md#the-held-thought).

## What each thing looks like

**Words.** One or two lines under the line you are on, indented with your code, with `●` before them. At most
three lines; the chat pane has all of them. Your next edit, anywhere, takes them away.

**Points.** The lines Pair points at get `▎` in the sign column and a faint tint; the code it means on the first
line is underlined. Its note goes after the line when it fits in the window, else under the line, and moves when
you resize. Editing a pointed line removes the point. The last point is where `Alt-j` (or `:Pair jump`) goes, unless Pair suggested a change since: then it goes to the suggestion, where `Alt-y` takes it.

**The gaze.** While Pair reads a file you have open, the line numbers it reads light up in the accent, one after
another, with a trail of two fading behind, in about 0.8 s whatever the length. The statusline names the file for
two seconds, also when it is not on screen. Without line numbers, the statusline alone shows it.

![The gaze mid-sweep: line 19 lit, 18 and 17 fading behind it, and the statusline naming the file](images/gaze.png)

**Suggestions.** The old lines are struck through from their first character (the indent stays clean), the new
lines sit right under them on a faint tint, and the note follows with `M-y`.

![A suggestion in Neovim's own light colorscheme](images/suggestion.png)

**The statusline.** One quiet segment: `● pair` at rest, the `●` in the accent while Pair's words are on screen,
`● reading worker.go` while it reads, `◎ pair has the wheel · any key takes it back` while it drives, and the
tests on save as above (`(unsaved)` after the label for the run on the Driver's edit). The role and
the talk level show only when they are not the usual ones (`● pair · scout`, `● pair · quiet`). While a thought is
held, `● pair · held thought · M-j`, the `●` in the accent.

![A model down, then the daemon away](images/statusline.png)

## What it knows: the context card

`:Pair context` shows everything the pair uses, as it is this second, on one card you can read and trim: the goal,
the board task of your branch, git, the commands you ran, and where you have been in the editor. It is the same
text the Partner gets with every remark and question, so what is not on the card is not sent. It is read again every
two seconds while it is open.

![:Pair context: the goal from the board task, the board, git, the failing run, and the buffers, jumps and searches](images/context.png)

*The card in the capture, made by the daemon and plugin as shipped: no goal was typed, it came from the board task
of the branch. The test run, the two Telescope searches and the `/` search are real; the board is a stand-in for
herdr's work board ([captures/board.mjs](captures/board.mjs)).*

| Source | Rows | Read from |
| --- | --- | --- |
| goal | what the session is for, and where it came from | the board task, else the branch name, else what you typed |
| board | the task, its state, and how many of the repo's other tasks are working or need you | the herdr work board: the task whose number is in the branch name, in this repo |
| git | branch, last commit, how many files changed, the pull request | `git`, and `gh pr view` at most every five minutes |
| terminal | the last three commands, how they ended and how long ago | the herdr panes and the shell hook |
| editor | your buffers, the jumplist, and your searches with what you opened from them | Neovim, and Telescope's prompt as you leave it; `/` and `?` too |

- **`x` hides a source** for the rest of the session: it is struck through on the card and no longer sent. `x` on
  it again brings it back. `q` or `Esc` closes the card. Hiding works from then on: what went with earlier questions
  stays in the session's conversation.
- **A budget per source.** Six buffers, four jumps and three searches go; the card says how many more were cut.
- **The board's own launches are not yours.** A command that launches one of the board's agents is left out of the
  commands, and the card counts it as not sent, so Pair never thinks you ran it.
- **Matched by repo and number.** The branch `work/7-retries` belongs to task 7 of this repo only: another repo's
  task 7 is never taken for it. The repo is the folder of the main checkout (also from a worktree) or the name in
  `origin`'s URL.
- Searches are only watched: Telescope's prompt is read as you leave it, and the search counts once you land
  somewhere new. Telescope's actions and your mappings are left alone.

![x on the terminal: its rows are struck through and no longer go to the Partner](images/context-trimmed.png)

## Setup

```lua
require('pair').setup({
  auto_connect = true,
  jump_key = '<M-j>',  -- false for none; :Pair jump works either way
  listen_key = '<M-t>', -- hold it to speak to Pair (docs/voice.md); false for none
  motion = true,       -- false: no fades, the gaze lights one line at a time without its trail, and the Driver's edit lands at once
  glyphs = {},         -- for example {voice = '\u{f444}', wheel = '\u{f030c}'} with a Nerd Font
})
```

With `auto_connect`, a Neovim without a screen (an agent's or a script's, `nvim --headless`) and one started in the
temp folder do not connect, so they never start a session; `:Pair start` connects them anyway.

The keys (`jump_key`, `accept_key`, `useful_key`, `noise_key`) are mapped only while there is something for them
to act on, and only where you have no mapping of your own; `listen_key` is mapped from the start, also only where it is free. The glyphs are plain Unicode, so they show in any font:
`voice` `●`, `mark` `▎`, `held` `•`, `away` `◌`, `wheel` `◎`, `listen` `◉`, `pass` `✓` and `fail` `✗`. The spinner is braille, `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`.

For the statusline, `require('pair').status()` is plain text and `require('pair').statusline()` the same with
Pair's highlight groups, for the `statusline` option or a statusline plugin's section:

```lua
vim.o.statusline = "%f %m%=%{%v:lua.require'pair'.statusline()%}  %l:%c "
-- lualine: sections = {lualine_x = {function() return require('pair').status() end}}
```

Colours need `termguicolors`, which Neovim turns on by itself in most terminals. Without it Pair links its groups
to standard ones and does not fade.

## Highlight groups

| Group | What | Made from |
| --- | --- | --- |
| `PairAccent` | the `●` before Pair's words | the accent |
| `PairNote` | Pair's words and notes | your foreground toward the accent |
| `PairCode` | `code` in its words | the accent |
| `PairKey` | the key after its words | between background and foreground |
| `PairSign` | `▎` and `•` in the sign column | the accent |
| `PairPoint` | a line Pair points at | the background, faintly toward the accent |
| `PairSpan` | the code it means there, underlined | the background toward the accent |
| `PairGaze` | a line number it reads | the accent, bold |
| `PairSuggestDelete` | the lines a suggestion replaces, struck through | between background and foreground |
| `PairSuggestAdd` | a suggestion's new lines, and the text the Driver is typing | your foreground on a faint tint |
| `PairCursor` | the Driver's cursor | the background on the accent |
| `PairStatus`, `PairStatusDim`, `PairStatusWarn` | the statusline segment | the accent, the statusline's own colours, your colorscheme's warning colour |
| `PairStatusPass` | `✓` in the statusline after a passing run | your colorscheme's "ok" colour (`DiagnosticOk`) |
| `PairPass` | `✓` on a passing test | the "ok" colour, faded toward the background |
| `PairFail` | `✗` on a failing test, and in the statusline | your colorscheme's error colour (`DiagnosticError`) |
| `PairFailNote` | why a test failed, after its line | your foreground toward the error colour |
| `PairHeard` | your words as Pair heard them, in italics | between background and foreground |

## Ask about lines

`:'<,'>Pair ask why does this loop twice?` sends the selected lines with the question: the Partner gets them as
your buffer has them, numbered. `:'<,'>Pair drive tidy this up` hands over the wheel for those lines. The answer is
in the chat pane, as for any question.
