# The pair in Neovim

Pair sits in the second chair. In Neovim it has a small visual language: a few marks in one colour, all in your
own font, and no windows, boxes, borders or field labels. Everything it shows follows one test: would you keep it
on screen for an eight-hour day?

![Pair stops a wrong turn: it reads, says why under your edit, and Alt-j goes to the real cause](images/wrong-turn.gif)

*The capture above is the plugin and the daemon as shipped, in a clean Neovim with the ayu colorscheme. The test
run is real `go test`; only the models' words are scripted.*

## Six marks, one accent

| Mark | Where | What it means |
| --- | --- | --- |
| `●` and a line or two | under the line you are on | Pair's voice: what it says unasked, in your font, indented with your code |
| a lit line number | the number column | its gaze: the lines it is reading, one after another, with a short trail |
| `▎` | the sign column | a line it points at, or the line its words are about |
| `M-j` | after its words | go where it points; your cursor never moves by itself |
| `◎` | the statusline | it has the wheel (the Driver); any key takes it back |
| `◌` | the statusline | it is not there: reconnecting, or a model is down |

**One accent, from your colorscheme.** Pair takes its colour from the colorscheme you use, so it fits in light and
dark: of the colorscheme's own colours for regular expressions, its terminal cyan, its hints and its specials, it
picks the one whose hue is furthest from every colour your code is drawn in, and makes sure it reads on your
background. So Pair is never mistaken for syntax. With ayu that is its regexp teal; with Neovim's own colorscheme,
its cyan. Pair's words are your foreground tinted toward the accent, and `code` in them is the accent.

Every highlight group is defined with `default = true`, and only when the colorscheme has not defined it: a
colorscheme or your config can set any of them and keeps its own. Pair sets them again when you change the
colorscheme or `background`.

## The wrong turn

The moment this language was made for: a test is red, and you start fixing it in a file the failure does not name.

1. You ran the tests in your terminal; the failure names `worker_test.go`. You open `backoff.go` and change the
   shift, sure it is off by one.
2. Once you pause, Pair looks: its gaze crosses the line numbers of `backoff.go`, then the statusline says
   `● reading worker.go`.
3. Two quiet lines appear under your edit, fading in over a quarter of a second: the shift is fine, and the real
   cause is `worker.go:33`, which gives up on `>=`. They end with `M-j`.
4. You undo. The words go with your edit: an edit counts as having seen them, neither useful nor noise.
5. `Alt-j` goes there. The line is tinted, the `>=` is underlined, and Pair's note sits after the line.
   `Ctrl-O` brings you back.

![The remark under the edited line](images/remark.png)

![After Alt-j: the line tinted, the >= underlined, the note after it](images/jump.png)

The trigger behind it, `edit_while_red`, goes through the speak gate like the others: the Watcher scores whether a
check of that file would save you time, and the Partner reads your change, the failing test and the code it tests.
If your change is or may be the fix, it stays silent; only when the failure clearly comes from elsewhere does it
point there. Details in [docs/watcher.md](watcher.md).

## What each thing looks like

**Words.** One or two lines under the line you are on, indented with your code, with `●` before them. At most
three lines; the chat pane has all of them. Your next edit, anywhere, takes them away.

**Points.** The lines Pair points at get `▎` in the sign column and a faint tint; the code it means on the first
line is underlined. Its note goes after the line when it fits in the window, else under the line, and moves when
you resize. Editing a pointed line removes the point. The last point is where `Alt-j` (or `:Pair jump`) goes.

**The gaze.** While Pair reads a file you have open, the line numbers it reads light up in the accent, one after
another, with a trail of two fading behind, in about 0.8 s whatever the length. The statusline names the file for
two seconds, also when it is not on screen. Without line numbers, the statusline alone shows it.

![The gaze mid-sweep: line 18 lit, 17 fading behind it, and the statusline naming the file](images/gaze.png)

**Suggestions.** The old lines are struck through from their first character (the indent stays clean), the new
lines sit right under them on a faint tint, and the note follows with `M-y`.

![A suggestion in Neovim's own light colorscheme](images/suggestion.png)

**The statusline.** One quiet segment: `● pair` at rest, the `●` in the accent while Pair's words are on screen,
`● reading worker.go` while it reads, `◎ pair has the wheel · any key takes it back` while it drives. The role and
the talk level show only when they are not the usual ones (`● pair · scout`, `● pair · quiet`).

![A model down, then the daemon away](images/statusline.png)

## Setup

```lua
require('pair').setup({
  auto_connect = true,
  jump_key = '<M-j>',  -- false for none; :Pair jump works either way
  motion = true,       -- false: no fades and no sweeping gaze
  glyphs = {},         -- for example {voice = '\u{f444}', wheel = '\u{f030c}'} with a Nerd Font
})
```

The keys (`jump_key`, `accept_key`, `useful_key`, `noise_key`) are mapped only while there is something for them
to act on, and only where you have no mapping of your own. The glyphs are plain Unicode, so they show in any font:
`voice` `●`, `mark` `▎`, `away` `◌`, `wheel` `◎`, `pass` `✓` and `fail` `✗`.

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
| `PairSign` | `▎` in the sign column | the accent |
| `PairPoint` | a line Pair points at | the background, faintly toward the accent |
| `PairSpan` | the code it means there, underlined | the background toward the accent |
| `PairGaze` | a line number it reads | the accent, bold |
| `PairSuggestDelete` | the lines a suggestion replaces, struck through | between background and foreground |
| `PairSuggestAdd` | a suggestion's new lines | your foreground on a faint tint |
| `PairStatus`, `PairStatusDim`, `PairStatusWarn` | the statusline segment | the accent, the statusline's own colours, your colorscheme's warning colour |

## Ask about lines

`:'<,'>Pair ask why does this loop twice?` sends the selected lines with the question: the Partner gets them as
your buffer has them, numbered. `:'<,'>Pair drive tidy this up` hands over the wheel for those lines. The answer is
in the chat pane, as for any question.
