# Changelog

What changed in each release of pairing-buddy. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html): before 1.0, a minor version may
change config or commands, and its entry says how under **Upgrade notes**. [Releasing](https://github.com/makefunstuff/pairing-buddy/blob/main/docs/releasing.md) says how a
release is cut.

## [Unreleased]

### Changed

- **A remark you act on counts as useful.** Editing the lines a remark pointed at, within ten minutes, counts it as
  useful wherever its words showed, also when it reached you while you were in your terminal; the ledger books it
  (`counted useful`) and the chat marks it. Before, such a remark counted as ignored, and with `autoTune` enough of
  them raised the bar. Your own `+` or `-` still wins.
- **The day's end debrief calls only the remarks you rated noise "noise".** Remarks that got no answer are counted
  beside them (`…; 1 got no answer.`).

## [0.11.0] - 2026-10-29

Pair can now write code you ask for (`/gen`), works with the Shepherdr work board, has a rebuilt chat pane, and its
voice can go through OpenRouter.

### Upgrade notes

- The `board` setting now defaults to `"shepherdr"`, and the herdr-projects board is no longer read. If you used it,
  install [Shepherdr](https://github.com/makefunstuff/pairing-buddy/blob/main/docs/agents.md#where-it-reads), or set `"board": null` to read no board
  ([#109](https://github.com/makefunstuff/pairing-buddy/pull/109)).
- 0.10.0 ignores a `voice.openrouter` block, and refuses a `voice` block without `voice.model`: upgrade before you
  move your voice to OpenRouter
  ([#96](https://github.com/makefunstuff/pairing-buddy/pull/96)).
- After `npm install -g github:makefunstuff/pairing-buddy`, restart the daemon (`systemctl --user restart
  pairing-buddy`, or `pair setup`) and Neovim: `pair doctor` says when the daemon still runs the old version.

### Added

- **The chat pane, full screen.** A header with the project, goal, role and level; answers that stream in, with
  Markdown, diffs and folds; a status for every state; multi-line input with history per project; a `/` command menu,
  `@` file completion and `@here`; `Esc` stops an answer; `Alt-↑` picks a message to copy, apply, jump to, rate or ask
  about; `Ctrl-F` finds; `?` lists the keys. `pair chat --plain` keeps the line-by-line pane
  ([#95](https://github.com/makefunstuff/pairing-buddy/pull/95)).
- Chat pane: a remark ends in an action line with its keys (`+ - a j`); find underlines every match and steps through
  them; the command menu counts and scrolls; reconnecting says how long the daemon was away
  ([#101](https://github.com/makefunstuff/pairing-buddy/pull/101)).
- Chat pane: time dividers instead of a time on every message, a layout for panes under 52 columns, and text that ends
  by column 80 in wide panes ([#99](https://github.com/makefunstuff/pairing-buddy/pull/99)).
- Chat pane: Pair's pixel head in the empty pane, a colour per role, remarks held under an answer that is still
  streaming, and synchronized output where the terminal supports it
  ([#104](https://github.com/makefunstuff/pairing-buddy/pull/104)).
- **Voice through OpenRouter.** `voice.openrouter` with `hear` (speech-to-text instead of whisper.cpp) and `speak`
  (read-aloud instead of a `speak` command), `voice.play` for the player, errors in plain words in Neovim and the chat,
  and `pair doctor` checks for the key, the models and the player
  ([#96](https://github.com/makefunstuff/pairing-buddy/pull/96)).
- **`/gen`: ask Pair for code.**
  - Every edit the plugin sends says who made it (you, Pair or a `/gen` request), so the triggers about your code skip
    Pair's own edits ([#98](https://github.com/makefunstuff/pairing-buddy/pull/98)).
  - `/gen here` (`:Pair gen here`) for code at your cursor or over a selection, requests numbered in the ledger, and
    `/undo` for a whole request ([#100](https://github.com/makefunstuff/pairing-buddy/pull/100)).
  - The brief: each request runs against the goal, the branch's board task and a note (`gen.brief`, `NOTES.md` by
    default), asks when the request goes against it, and flags `≠ brief` and `? guessed` lines; `/brief` and
    `:Pair brief` show or pin it ([#102](https://github.com/makefunstuff/pairing-buddy/pull/102)).
  - `/gen file`: new files as `pair://gen/<n>/<path>` buffers that `:w` takes to their path, and `:Pair gen list` to
    review them ([#103](https://github.com/makefunstuff/pairing-buddy/pull/103)).
  - `/gen try`: a sample in a folder of its own outside the project, run in the sandbox; `/gen run`, `/keep`,
    `/gen tries`, and the `gen.keepTries` and `gen.network` settings
    ([#105](https://github.com/makefunstuff/pairing-buddy/pull/105)).
  - `/gen scaffold`: many files built and checked in a copy of the project, or a git worktree with `--branch` or
    `gen.scaffold: "worktree"`, kept one file at a time; `gen.limits` bound a request
    ([#106](https://github.com/makefunstuff/pairing-buddy/pull/106)).
  - Owning generated code: a `┊` mark on code you took until you change it, `:Pair own`, the count in the statusline,
    `:Pair today` and `pair stats` ([#107](https://github.com/makefunstuff/pairing-buddy/pull/107)).
  - The gen card in the chat pane: a `gen` speaker, an action line (`k` keep, `Enter` list, `d` drop, `u` undo) and the
    request at work in the status ([#108](https://github.com/makefunstuff/pairing-buddy/pull/108)).
- **Pair + board, on Shepherdr.**
  - One board adapter; `o`, `d` and `t` open a task's report or PR, its branch diff and a terminal in its worktree;
    `/gen board` composes a task to add; the chat header counts the repository's tasks
    ([#109](https://github.com/makefunstuff/pairing-buddy/pull/109)).
  - Hand-off with context: the task's brief is built from yours, `/gen board #n` hands on a request too big for
    `gen.limits`, the task opens in `pair://board/new` to edit, and you pick add, delegate, plan first or research only
    ([#110](https://github.com/makefunstuff/pairing-buddy/pull/110)).
  - `:Pair review <id>`, `/review` and `Alt-r`: a task's branch in the review list, its files in the order that matters,
    kept a change or a file at a time ([#111](https://github.com/makefunstuff/pairing-buddy/pull/111)).
  - Overlap: a winbar note on a file a working task also changes (`board_winbar`), a new `overlap` remark when you edit
    the same lines, the task's brief in the `/gen` brief, and `/brief sync`
    ([#112](https://github.com/makefunstuff/pairing-buddy/pull/112)).
- `pair --version` (also `pair version` and `pair -v`), a changelog, and [docs/releasing.md](https://github.com/makefunstuff/pairing-buddy/blob/main/docs/releasing.md) on how to cut a
  release.

### Changed

- `board` defaults to `"shepherdr"`; the relay's states are needs you, ready to merge, failed, done, working and
  waiting ([#109](https://github.com/makefunstuff/pairing-buddy/pull/109)).
- Chat pane: yellow and dim mean one thing each, Pair's run question is a `pair` message with the command under it,
  `Esc` declines it, and the status sits in the rule above the input
  ([#97](https://github.com/makefunstuff/pairing-buddy/pull/97)).
- Chat pane: `⚠` is a yellow `!` and `⎿` is `└`; the elapsed time shows only after 3 s
  ([#104](https://github.com/makefunstuff/pairing-buddy/pull/104)).
- Pair's own edits no longer count as your typing, your active time or your current file
  ([#98](https://github.com/makefunstuff/pairing-buddy/pull/98)); the Watcher no longer remarks on errors in code that
  is still Pair's ([#107](https://github.com/makefunstuff/pairing-buddy/pull/107)).
- The `thinking` setting takes a `gen` level for `/gen` requests
  ([#100](https://github.com/makefunstuff/pairing-buddy/pull/100)).
- [The decision model](https://github.com/makefunstuff/pairing-buddy/blob/main/docs/decision.md) page has measured results for Liquid AI's d1 and LFM3 models, which did not
  pass the speak gate's bar and are not integrated ([#94](https://github.com/makefunstuff/pairing-buddy/pull/94)).

### Fixed

- Chat pane: a line as wide as the pane lost its last character in Neovim's terminal, and the "↓ N lines below" count
  never showed ([#97](https://github.com/makefunstuff/pairing-buddy/pull/97)).
- Chat pane: code, diffs and commands in a narrow pane no longer break inside a name or a flag
  ([#99](https://github.com/makefunstuff/pairing-buddy/pull/99)).
- Chat pane: a remark's keys no longer act on a question typed on an empty line
  ([#101](https://github.com/makefunstuff/pairing-buddy/pull/101)).
- Docs that disagreed with the code: the Driver's edits per hand-over, the tools per role, the data folders, the
  logins per provider, keep-warm's default, the commands, keys and the board
  ([#93](https://github.com/makefunstuff/pairing-buddy/pull/93),
  [#113](https://github.com/makefunstuff/pairing-buddy/pull/113)).

## [0.10.0] - 2026-10-27

The baseline: the first version under this changelog. Pair watches you work in Neovim and herdr and speaks rarely,
as Navigator, Scout or Driver, with a Watcher that scores each moment and an optional decision model; it never writes
your files. 0.10.0 brought the polish and hand-over for everyday work
([#92](https://github.com/makefunstuff/pairing-buddy/pull/92)), the licence and contributing guide
([#91](https://github.com/makefunstuff/pairing-buddy/pull/91)), the decision model for the gate and the Watcher
([#87](https://github.com/makefunstuff/pairing-buddy/pull/87)) and the docs site
([#83](https://github.com/makefunstuff/pairing-buddy/pull/83)). Earlier versions were not released.

[Unreleased]: https://github.com/makefunstuff/pairing-buddy/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/makefunstuff/pairing-buddy/releases/tag/v0.11.0
[0.10.0]: https://github.com/makefunstuff/pairing-buddy/tree/4f05838116850c1b5b1bd98f503267e51fea4776
