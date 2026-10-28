# Neovim plugin reference

Setup, keys, commands, the statusline segment and the highlight groups. What each moment looks like is in
[The pair in Neovim](neovim.md).

## Keys

The keys exist only while there is something for them to do, and only where you have no mapping of your own.

| Key | What it does |
| --- | --- |
| `Alt-j` | Go where Pair points (`Ctrl-O` comes back), or show a held remark now |
| `Alt-y` | Take Pair's suggested change, as your own edit |
| `Alt-t` (hold, or tap twice) | Ask aloud: [push-to-talk](voice.md), when voice is set up |
| `Alt-u` / `Alt-n` | Tell Pair its last remark was useful / noise |
| `Alt-l` / `Alt-d` | In a Markdown note: open the code a mark names / log the decision on your line |
| `Alt-?` | The one idea worth keeping behind Pair's words under your line; again, open its link to the docs |
| `Alt-a` | Go to the agent whose news Pair relayed ([your other agents](agents.md)) |
| `Alt-g` | Ask Pair for code ([/gen](gen.md)): at the cursor, or in Visual mode over the selection; while Pair's question waits, show it again |
| any key | Take the wheel back while Pair drives |

Each key is an option of `setup` (below); `false` turns one off, and the commands work either way. In the
[chat pane](chat.md#acting-on-a-message), `a` on a suggestion takes it in this Neovim as `Alt-y` does, and `j` on a
message goes to its line, with a mark for `Ctrl-O`.

## Setup

The lazy.nvim spec is in [install.md](install.md#install). Without a plugin manager:
`vim.opt.rtp:append('/path/to/pairing-buddy')` and `require('pair').setup({auto_connect = true})`.

```lua
require('pair').setup({
  auto_connect = true,
  jump_key = '<M-j>',  -- false for none; :Pair jump works either way
  listen_key = '<M-t>', -- hold it to speak to Pair (docs/voice.md); false for none
  listen_mode = 'hold', -- 'toggle': press it to start, press it again to ask
  motion = true,       -- false: no fades, the gaze lights one line at a time without its trail, and the Driver's edit lands at once
  glyphs = {},         -- for example {voice = '\u{f444}', wheel = '\u{f030c}'} with a Nerd Font
  searches = true,     -- false: your Telescope, snacks.picker and fzf-lua searches stay in Neovim, and there is no search trail
  sounds = false,      -- true: short sounds while you are away from Neovim (see [sounds](neovim.md#sounds-while-you-are-away))
  sound_volume = 0.5,  -- 0 to 1
  land = true,         -- false: the morning pick-up does not open an empty Neovim where you stopped
  gen_key = '<M-g>',   -- asks Pair for code (/gen); false for none
  gen_input = 'ui',    -- 'cmdline': the /gen request and its questions on Neovim's own prompt, not vim.ui's
  gen_preview_lines = 30, -- a /gen block taller than this shows in a preview window
})
```

| Option | Default | Meaning |
| --- | --- | --- |
| `auto_connect` | `false` | Connect to the daemon at startup (the lazy.nvim spec sets it). A Neovim without a screen (`nvim --headless`, an agent's or a script's) or one started in the temp folder does not, so it never starts a session; `:Pair start` connects it anyway |
| `socket` | the daemon's default | The daemon's socket |
| `debounce_ms` | `2000` | How long after you stop typing an edit is sent. Each edit says who made it, you or Pair ([gen.md](gen.md)); Pair's are sent at once |
| `max_points` | `5` | Points kept at once |
| `jump_key` | `'<M-j>'` | Goes where Pair pointed last, or shows a held thought; from one suggestion on to the next. Mapped in Normal mode while it points somewhere or holds a thought |
| `accept_key` | `'<M-y>'` | Accepts the suggestion under the cursor, else the newest in the buffer. Mapped in Normal mode, only in a buffer with a suggestion and only while one shows. Avoid `<Tab>`: terminals send it for Ctrl-I, the jumplist's forward jump |
| `listen_key` | `'<M-t>'` | Hold it to speak to Pair ([voice.md](voice.md)). Mapped in Normal and Visual mode from the start |
| `listen_mode` | `'hold'` | `'hold'`: hold the key and let go, or tap it twice. `'toggle'`: press it to start, press it again to ask, never guessing when you let go; holding it is one press, however long the terminal waits to repeat it ([voice.md](voice.md#4-the-key)) |
| `listen_hold_ms`, `listen_release_ms` | `650`, `220` | In `'hold'`: no repeat this long after the press is a tap; no repeat this long is letting go. In `'toggle'`: a press this close to another is its repeat; a press this soon after the one that asked is that key's repeat |
| `listen_silence_ms` | `false` | A number: a recording you do not hold asks after you spoke and paused this long |
| `useful_key`, `noise_key` | `'<M-u>'`, `'<M-n>'` | Your verdict on Pair's last unasked remark. Mapped in Normal mode only while a remark waits for one |
| `teach_key` | `'<M-?>'` | Asks for the idea behind Pair's words under your line, then opens its link ([the idea behind it](neovim.md#the-idea-behind-it)). Mapped in Normal mode while they show |
| `agents_key` | `'<M-a>'` | Goes to the agent whose news Pair relayed, or puts the line away when it has no pane ([agents.md](agents.md)). Mapped in Normal mode while such a line shows |
| `motion` | `true` | Fades, the glow of a green, and the trail behind the gaze; without it the gaze still steps line by line |
| `decide_key`, `link_key` | `'<M-d>'`, `'<M-l>'` | In a note's margin: log the decision on your line, open the code a mark names. Mapped in Normal mode only in a note with such a mark ([notes.md](notes.md)) |
| `searches` | `true` | Read your Telescope, snacks.picker and fzf-lua searches for the [search trail](neovim.md#the-search-trail) |
| `sounds` | `false` | Short [sounds](neovim.md#sounds-while-you-are-away) for a green, a regression, a remark and the hand-back, only while Neovim does not have the focus |
| `sound_volume` | `0.5` | Their volume, 0 to 1 |
| `answers` | `true` | The first two lines of Pair's answer to a question you typed (`:Pair ask`, the chat) show under the line it was about, too ([what each thing looks like](neovim.md#what-each-thing-looks-like)) |
| `gen_key` | `'<M-g>'` | Asks Pair for code ([gen.md](gen.md#asking)): a dialog for the request, in Normal mode at the cursor, in Visual mode over the selected lines. While a question of Pair's waits, shows it again. Mapped in Normal and Visual mode from the start |
| `gen_input` | `'ui'` | Where the `/gen` request, its shape and Pair's questions are asked: `'ui'` through `vim.ui.input` and `vim.ui.select`, which snacks.nvim, dressing.nvim or noice.nvim show as floating dialogs (else Neovim's own prompt); `'cmdline'` always Neovim's own prompt and numbered list |
| `gen_preview_lines` | `30` | A `/gen` block taller than this shows as one line in place and in a preview window under it, instead of as ghost lines |
| `land` | `true` | The [morning pick-up](neovim.md#the-morning-pick-up-and-the-days-end) opens an empty Neovim (or a start screen) on the place the last session's debrief named |
| `glyphs` | plain Unicode | Pair's marks (below) |

Every key option takes `false` for none; the commands work either way. The keys are mapped only where you have no
mapping of your own, and all but `listen_key` and `gen_key` only while there is something for them to act on. Each says what it does
until you have used it once (`M-j goes there`); the keys you have used are kept in `stdpath('state')/pair/keys.json`.
The glyphs are plain Unicode, so they show in any font: `voice` `●`, `idea` `∴`, `mark` `▎`, `held` `•`, `away` `◌`, `wheel` `◎`, `listen` `◉`, `pass`
`✓`, `fail` `✗`, `warn` `△` and `agents` `◇`, and in a note's margin `question` `?`, `contradiction` `≠`, `code` `→`,
`decision` `◆` and `repeat` `≈`. The spinner is braille, `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`.

Once connected, the plugin stays connected: when the daemon restarts (an upgrade, `systemctl --user restart`, a
crash), it reconnects by itself, after 1, 2, 5, 10 and then every 30 seconds, and sends the current file again.
`:Pair stop` disconnects for good.

Colours need `termguicolors`, which Neovim turns on by itself in most terminals. Without it Pair links its groups
to standard ones and does not fade.

## Commands

| Command | What it does |
| --- | --- |
| `:Pair start [goal]` | Connect to the daemon (not needed with `auto_connect`), optionally setting the session goal |
| `:Pair new [idea]` | Start something new: three questions in `NOTES.md`, one at a time, then a first slice of two files ([details](blank-page.md)) |
| `:Pair goal <text>` | Set the session goal |
| `:Pair ask <text>` | Ask Pair something (the answer appears in the chat pane, and its start under your line); with a range (`:'<,'>Pair ask ...`), about those lines, and the answer starts under the last of them |
| `:Pair level quiet\|normal\|chatty` | How often Pair speaks unasked |
| `:Pair scout` | Switch to Scout: Pair may search and run commands in its own pane |
| `:Pair navigate` | Switch back to Navigator (the default) |
| `:Pair drive [what]` | Hand Pair the wheel for one change; any key takes it back. With a range, for those lines |
| `:Pair drive! [what]` | The same, and Pair keeps the wheel for each request after it until you take it back ([driver.md](driver.md#keeping-the-wheel)) |
| `:Pair jump` | Go where Pair pointed last (same as `Alt-j`); `Ctrl-O` comes back. While Pair holds a thought, show it now |
| `:Pair trail` | Show your searches since your last edit, as Pair saw them; `x` forgets them |
| `:Pair runs` | The session's builds and runs, newest last, with the change before each and its numbers; `⏎` its output, `d` its change, `x` removes the hunt's debug lines ([exploration.md](exploration.md)) |
| `:Pair gen [here] [what]` | Ask Pair for code ([gen.md](gen.md)): without words, in a dialog (same as `Alt-g`); with words, at once. With a range (`:'<,'>Pair gen`), over those lines, or in a note, the lines are the request. `:Pair gen +` opens the compose window for a longer request, `:Pair gen cancel` stops the request that runs or waits |
| `:Pair accept` | Accept Pair's suggestion under the cursor, else the newest in the buffer (same as `Alt-y`); for a suggestion in an unasked remark, that rates the remark useful |
| `:Pair dismiss` | Drop the same suggestion, and only that one; for a suggestion in an unasked remark, that rates the remark not useful |
| `:Pair useful` | Pair's last unasked remark was useful (same as `Alt-u`) |
| `:Pair noise` | It was not (same as `Alt-n`) |
| `:Pair why` | The idea worth keeping behind Pair's words under your line (same as `Alt-?`); again, it opens the link that came with it |
| `:Pair open` | Open the place Pair asked to show while you were typing |
| `:Pair agents` | Your other agents and board tasks, the ones that need you first; `⏎` goes to one ([agents.md](agents.md)) |
| `:Pair today` | The [ledger](neovim.md#the-ledger): everything Pair did in this project today; `⏎` goes there or shows the output, `u` undoes one of its edits later, or a whole `/gen` request |
| `:Pair decide` | Log the decision on the cursor's line of a note in `decisions.md` next to it (same as `Alt-d`; [notes.md](notes.md#the-decision-log)) |
| `:Pair tasks` | List the work in the current note as tasks; nothing is added until `y` ([notes.md](notes.md#tasks-only-when-you-ask)) |
| `:Pair clear` | Remove Pair's points and words and the marks in a note's margin, and end the questions of `:Pair new` |
| `:Pair context` | Show what Pair knows right now: the goal, the board task, git, your commands, buffers, jumps and searches; `x` hides a source for the session, `q` closes |
| `:Pair end` | End the session now with its [debrief](neovim.md#the-morning-pick-up-and-the-days-end), which the next session in this project starts from (it also [ends by itself](memory.md#no-ceremony-a-session-starts-and-ends-by-itself)) |
| `:Pair first <step>` | Tomorrow's first step, with a `file:line` to land on: it replaces the last debrief's in a session with no work yet, else this session's debrief takes it |
| `:Pair listen [cancel]` | Push-to-talk without the key: works as a tap of `Alt-t`; `cancel` drops what is being recorded ([voice.md](voice.md)) |
| `:Pair chat` | The chat in a terminal buffer on the right, for Neovim without herdr ([without herdr](neovim.md#without-herdr)) |
| `:Pair stop` | Disconnect this Neovim, and stop reconnecting |

## Statusline

`require('pair').status()` returns one quiet segment while connected, `◌ pair · reconnecting` while it waits to
connect again, and is empty when the plugin is not connected (before `:Pair start`, or after `:Pair stop`).
`require('pair').statusline()` is the same with Pair's highlight groups, for the `statusline` option or a statusline
plugin's section:

```lua
vim.o.statusline = "%f %m%=%{%v:lua.require'pair'.statusline()%}  %l:%c "
-- lualine: sections = {lualine_x = {function() return require('pair').status() end}}
```

| Segment | When |
| --- | --- |
| `● pair` | At rest. The role and talk level show only when they are not the usual ones: `● pair · scout`, `● pair · quiet` |
| `● reading worker.go` | While Pair reads |
| `⠹ pair · thinking` | While its model thinks |
| `● pair · held thought · M-j` | While a remark waits for your next break |
| `● pair · gen #4 · generating · 21s`, `● pair · gen #4 asks · M-g`, `● pair · gen #5 waits for the one before`, `● pair · gen #4 ready · M-y takes · :Pair dismiss` | While a [/gen request](gen.md) runs, waits for your answer or its turn, and while its code waits to be taken |
| `● pair · 5 notes in the margin`, `◆ logged · docs/decisions.md` | In a note with [marks](notes.md), and for a moment after a decision is logged |
| `● run 3 · exit 0 · 55 ms · avg probe 23.7 · same numbers as run 2` | For 15 minutes after a build or run: what it showed next to the one before, and once the hunt is over, `· 1 debug line from run 2 left · M-j` ([exploration.md](exploration.md)). A crash or a broken build shows with `✗` |
| `⠹ go test ./...`, `✗ 1 failing · TestX`, `✓ go test ./... · 4 tests, 3 packages` | [Tests on save](tests-on-save.md); `(unsaved)` after the command for the run on the Driver's edit |
| `◎ pair has the wheel · any key takes it back` | While it drives (`· thinking` while its model thinks, the hint again while it types) |
| `◌ pair · catching up` | While the [morning pick-up](neovim.md#the-morning-pick-up-and-the-days-end) reads where you stopped |
| `✗ 1 failing since yesterday · TestX` | A test that was red when the last session ended, until the next run |
| `◌ pair · partner down` (or `models down`) | While a model is down |
| `◌ pair · reconnecting` | While the daemon is away |

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
| `PairGazeLine` | a line it reads, in a window without line numbers | the background toward the accent |
| `PairSuggestDelete` | the lines a suggestion replaces, struck through | between background and foreground |
| `PairSuggestAdd` | a suggestion's new lines, and the text the Driver is typing | your foreground on a faint tint |
| `PairCursor` | the Driver's cursor | the background on the accent |
| `PairStatus`, `PairStatusDim`, `PairStatusWarn` | the statusline segment | the accent, the statusline's own colours, your colorscheme's warning colour |
| `PairStatusPass` | `✓` in the statusline after a passing run | your colorscheme's "ok" colour (`DiagnosticOk`) |
| `PairStatusGlow` | the statusline as it lights up for a green | the "ok" colour on the statusline, tinted toward it |
| `PairGlow`, `PairGlowLine` | the `✓` of a test that turned green, and its line, as they glow | the "ok" colour, and the background toward it |
| `PairPass` | `✓` on a passing test | the "ok" colour, faded toward the background |
| `PairFail` | `✗` on a failing test, and in the statusline | your colorscheme's error colour (`DiagnosticError`) |
| `PairFailNote` | why a test failed, after its line; a crash's or compiler error's words | your foreground toward the error colour |
| `PairWarn` | `△` on a warning no build before printed | your colorscheme's warning colour (`DiagnosticWarn`) |
| `PairWarnQuiet` | `△` on a warning the builds before printed too | the warning colour, faded toward the background |
| `PairWarnNote` | a new warning's words, after its line | your foreground toward the warning colour |
| `PairHeard` | your words as Pair heard them, in italics | between background and foreground |

## Ask about lines

`:'<,'>Pair ask why does this loop twice?` sends the selected lines with the question: the Partner gets them as
your buffer has them, numbered. `:'<,'>Pair drive tidy this up` hands over the wheel for those lines. The answer is
in the chat pane, as for any question.
