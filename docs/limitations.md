# Known limitations

What Pair cannot do well yet, one GitHub issue each. The full list, with the ones already fixed, is the
[tracking issue](https://github.com/makefunstuff/pairing-buddy/issues/51); open limitations carry the
[`limitation` label](https://github.com/makefunstuff/pairing-buddy/issues?q=is%3Aissue+is%3Aopen+label%3Alimitation).

## herdr

These need a change in herdr itself.

- **No command boundaries or exit codes.** Pair learns that a command ran in a herdr pane by watching it, so a command
  shorter than about a second can be missed, and success or failure is guessed from the output. The
  [shell hook](cli.md#pair-shell-hook) reports exit codes and fixes this for panes that have it.
  [#22](https://github.com/makefunstuff/pairing-buddy/issues/22)
- **A command's output is cut from the screen text by a heuristic**, so a wrapped, cleared or very long output can
  hide failed tests. Pair's own pane is not affected: tests on save write to a file.
  [#23](https://github.com/makefunstuff/pairing-buddy/issues/23)
- **Typing at a shell prompt is guessed** from the pane's screen, since herdr reports no keystrokes; a prompt that
  changes by itself looks like typing. [#24](https://github.com/makefunstuff/pairing-buddy/issues/24),
  [herdr.md](herdr.md#what-is-missing)
- **Output changes are polled.** herdr pushes focus and pane events, but a pane's output cannot be subscribed to,
  so Pair looks at the focused pane twice a second and at other panes running a command once a second: what you
  see there reaches Pair up to a second later. [#25](https://github.com/makefunstuff/pairing-buddy/issues/25)

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

## Models

- **The Watcher's speed depends on your server.** It should answer in about a second; a slow server or a high fixed
  cost per request makes remarks late, and two models on a server that holds one at a time reload on every switch.
  [One model](models.md#one-model) for both roles is the workaround; `pair doctor` warns.
  [#45](https://github.com/makefunstuff/pairing-buddy/issues/45)
- **The Anthropic API path and subscription logins are not tested against the real services** in CI; the token
  renewal is tested against fake providers.
  [#44](https://github.com/makefunstuff/pairing-buddy/issues/44)
