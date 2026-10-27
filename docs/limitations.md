# Known limitations

What Pair cannot do well yet, one GitHub issue each. The full list, with the ones already fixed, is the
[tracking issue](https://github.com/makefunstuff/pairing-buddy/issues/51); open limitations carry the
[`limitation` label](https://github.com/makefunstuff/pairing-buddy/issues?q=is%3Aissue+is%3Aopen+label%3Alimitation).

## herdr

These need a change in herdr itself. The [shell hook](cli.md#pair-shell-hook) takes away most of them for the
terminals that have it: commands, their start, end and exit code, and in zsh your typing come from the hook.

- **No command boundaries or exit codes without the hook.** In a herdr pane without it, Pair learns that a command
  ran by watching it, so a command shorter than about a second can be missed, and success or failure is guessed from
  the output. [#22](https://github.com/makefunstuff/pairing-buddy/issues/22)
- **A command's output is cut from the screen text**, also with the hook: from the line the command was typed on, at
  most 1000 lines, so a very long output loses its beginning. Pair's own pane is not affected: its shell writes each
  output to a file. [#23](https://github.com/makefunstuff/pairing-buddy/issues/23)
- **Output changes are polled without the hook.** herdr pushes focus and pane events, but a pane's output cannot be
  subscribed to, so Pair looks at the focused pane twice a second and at other panes running a command once a second.
  With the hook, a zsh pane is not polled at its prompt, and a running command is looked at only for an editor
  opening in it. [#25](https://github.com/makefunstuff/pairing-buddy/issues/25)
- **Typing at a bash or fish prompt is guessed** from the focused pane's screen, as those shells have no hook for
  keys; zsh's hook reports them ([herdr.md](herdr.md#what-is-missing)).

## Without herdr

Without herdr all of Pair works in Neovim and tmux ([workflows](workflows.md#with-or-without-herdr)). Two things
stay herdr's:

- **A terminal that is neither a Neovim `:terminal` nor a tmux pane** (a plain window of your terminal emulator):
  nothing lets another program read its screen, so Pair sees its commands and exit codes through the
  [shell hook](cli.md#pair-shell-hook), but not their output.
- **herdr's own agents** in [your other agents](agents.md), and `Alt-a` bringing one's pane to the front. The board's
  tasks are read without herdr.

## Neovim

- **Push-to-talk guesses when you let go** of `Alt-t` from the terminal's key repeats, since Neovim drops key-release
  events. A terminal that is slow to repeat turns a hold into a tap; `listen_mode = 'toggle'` (press to start, press
  again to ask) never guesses ([voice.md](voice.md#4-the-key)).
  [#55](https://github.com/makefunstuff/pairing-buddy/issues/55)
- **The search trail reads Telescope and snacks.picker only**, not fzf-lua.
  [#56](https://github.com/makefunstuff/pairing-buddy/issues/56)

## Models

- **The Watcher's speed depends on your server.** It should answer in about a second; a slow server or a high fixed
  cost per request makes remarks late, and two models on a server that holds one at a time reload on every switch.
  [One model](models.md#one-model) for both roles is the workaround; `pair doctor` warns.
  [#45](https://github.com/makefunstuff/pairing-buddy/issues/45)
- **The Anthropic API path and subscription logins are not tested against the real services** in CI; the token
  renewal is tested against fake providers.
  [#44](https://github.com/makefunstuff/pairing-buddy/issues/44)
