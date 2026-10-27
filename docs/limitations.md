# Known limitations

What Pair cannot do well yet, one GitHub issue each. The full list, with the ones already fixed, is the
[tracking issue](https://github.com/makefunstuff/pairing-buddy/issues/51); open limitations carry the
[`limitation` label](https://github.com/makefunstuff/pairing-buddy/issues?q=is%3Aissue+is%3Aopen+label%3Alimitation).

## herdr

These need a change in herdr itself.

- **No command boundaries or exit codes.** Pair learns that a command ran in a herdr pane by polling, so a command
  shorter than about a second can be missed, and success or failure is guessed from the output. The
  [shell hook](cli.md#pair-shell-hook) reports exit codes and fixes this for panes that have it.
  [#22](https://github.com/makefunstuff/pairing-buddy/issues/22)
- **A command's output is cut from the screen text by a heuristic**, so a wrapped, cleared or very long output can
  hide failed tests. Pair's own pane is not affected: tests on save write to a file.
  [#23](https://github.com/makefunstuff/pairing-buddy/issues/23)
- **Typing at a shell prompt is guessed** from the pane's screen, since herdr reports no keystrokes; a prompt that
  changes by itself looks like typing. [#24](https://github.com/makefunstuff/pairing-buddy/issues/24),
  [herdr.md](herdr.md#what-is-missing)
- **Polling every second.** Pane changes cannot be subscribed to, which adds up to a second of delay to what Pair
  sees in herdr. [#25](https://github.com/makefunstuff/pairing-buddy/issues/25)
- **Pair's pane reads back at most the last 1000 lines** of a Scout or Driver command, so a long output loses its
  beginning. [#26](https://github.com/makefunstuff/pairing-buddy/issues/26)

## Without herdr

- **Your terminals' output is not seen.** Without herdr, Pair sees your commands' exit codes through the shell hook,
  but not what they printed; Scout's pane, tests on save and the Driver's `type` work inside Neovim
  ([workflows](workflows.md#with-or-without-herdr)). [#37](https://github.com/makefunstuff/pairing-buddy/issues/37)

## Neovim

- **Push-to-talk guesses when you let go** of `Alt-t` from the terminal's key repeats. If your terminal waits longer
  than about 0.65 s before it repeats a held key, a hold counts as a tap. Only one recording runs per project.
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
