# Changelog

What changed in each release of pairing-buddy. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html): before 1.0, a minor version may
change config or commands, and its entry says how under **Upgrade notes**. [Releasing](https://github.com/makefunstuff/pairing-buddy/blob/main/docs/releasing.md) says how a
release is cut.

## [Unreleased]

### Added

- **Search by meaning, as quick as ripgrep with loose words.** `Alt-s` (or `:Pair find [words]`) opens a live
  picker in Telescope, else snacks.picker, else fzf-lua, used like `live_grep`: on every key, the pieces of code that
  have your words (identifiers split, so `removeUserFromTeam` is remove, user, from and team; words stemmed; comments
  and strings too), in a few milliseconds; once you stop typing for 150 ms, the pieces closest to what you mean join
  the list below them, so nothing you see moves. "method that removes user" finds `logout` in Pair's own code. The
  preview shows a piece at its line, `Enter` opens it, `<C-q>` sends the hits to quickfix; `/find <words>` in the chat
  and Scout's and the Driver's `search` tool (`meaning: true`, and whenever ripgrep finds nothing for plain words) get
  meaning and words fused by reciprocal rank. The pieces are functions, classes and methods with their doc comments,
  found by Neovim's tree-sitter in a headless Neovim where it has a parser, else blocks between blank lines. The
  index is a SQLite file per repository in Pair's data folder (`index/<repository>-<hash>.sqlite`), or with
  `"meaning": {"index": "project"}` in `.pair/` of the repository, listed in `.git/info/exclude`: positions, hashes,
  the words' FTS5 index and the vectors, no copy of the code's text. Worktrees of a repository share it, and a piece's
  vector by the hash of its text, so a worktree on another branch embeds only what that branch changed; a save embeds only the pieces that changed,
  and a first build runs in the background, its progress shown as Neovim's progress message. The words need no model;
  meaning runs on EmbeddingGemma 2 (text, 270M, Apache-2.0, 256 numbers a piece) on LiteRT-LM in a small Python helper
  after its one download (`:Pair find on`, 165 MB, pinned revision, SHA-256 checked), or on an embedding model of your own behind an OpenAI-compatible `/v1/embeddings`, the new
  `embedding` entry next to the models (nomic-embed-code, jina-embeddings-v2-base-code, with their prompts). The search
  embeds your words once and compares them with every vector: 1.5 ms for Pair's 6,639 pieces, 16 ms for 100,000. On
  Pair's own repository the first build took 9 minutes on the default two cores (13.5 MB) and a search by
  meaning 28 to 46 ms. `:Pair index rebuild` makes the index again, `:Pair find off` deletes the model and the indexes,
  `"meaning": false` turns it all off, `pair doctor` says whether the model answers and how big and how old each
  index is, and the ledger books each build and each piece you open from a search. With it on, the search trail's
  remark also gets the code closest to what each of your searches means; when Pair speaks is unchanged. See
  [meaning.md](docs/meaning.md).

- **`:Pair find on` installs search by meaning's runtime itself.** No more `python3 -m venv` and `pip install` by
  hand: it says up front what it fetches and how big (LiteRT-LM, 17 to 33 MB from PyPI, and EmbeddingGemma 2, 165 MB),
  makes a venv in Pair's data folder (`meaning/venv`) with your Python 3.10 or later (on PATH, or Homebrew's, pyenv's
  or `~/.local/bin`'s), downloads `litert-lm-api==0.19.0`'s wheel for your machine by its SHA-256, its progress shown
  in Neovim as the model's download is, and pip installs it from that file (`src/meaning-runtime.txt`, no index,
  `--require-hashes`, no other package). Without a Python 3.10+, its venv module or
  a wheel for the machine, it says what to do in one line, leaves nothing behind, and the word search keeps working.
  The ledger books the install, `:Pair find off` deletes the venv Pair made (never one you made, nor
  `"meaning": {"python": …}`, which still wins and is never installed into), and `pair doctor` says what turning it
  on fetches, and whose venv runs the model. Installing by hand stays possible ([meaning.md](docs/meaning.md#turn-embeddinggemma-on)).

- **Pair works on herdr-core and Shepherdr 2.1 as on herdr and Shepherdr 2.0**, and tells which one it is in from the
  terminal's environment, with nothing to configure (`HERDR_SOCKET_PATH` for herdr; `HC_SOCKET` and `HC_TERMINAL_ID`
  for herdr-core). On herdr-core, `pair` opens the chat in a terminal beside yours in the Herdr window; Pair watches
  the terminals of that space, takes the focus from the window (`herdr-app status`), runs Scout and the tests on save
  in a terminal of its own, lists the terminals that report their status as your other agents (Shepherdr 2.1's too, from its
  own `shepherdr` core session), and `Alt-a` shows one in the window. A daemon `pair` starts never takes a Shepherdr
  agent session's credential. `pair doctor` says which herdr it found and which Shepherdr answers. The board reads 2.1's task
  pages, its JSON spaces, its long `task show` in pieces, its artifact lines and its `task add` answer. What differs,
  and what Pair cannot do on herdr-core (the Driver's `type`; focus without the window; Shepherdr 2.1 outside its
  sessions), is in [herdr.md](docs/herdr.md#herdr-core-and-the-herdr-window), [agents.md](docs/agents.md#shepherdr-20-and-21)
  and [limitations.md](docs/limitations.md#herdr-core).

- **Pair reads along: a "fresh code" moment.** When you finish a function or hunk of three lines or more (you save, or
  move away from it for a while), the Watcher reads just those lines for a likely bug, and if it clears the bar Pair says one line
  at your next break, before a test finds it. Bugs only, not style; never while you type; the same speak gate, talk
  budget and held thought as every other remark. It is `fresh_code` in `pair stats`, `/mute fresh_code` turns it off,
  and on a slow server it is the first kind Pair stops asking about, unless your verdicts rank it higher.
- **`Alt-y` in the chat pane takes what Pair offered.** While you type, without picking a message, it takes the
  newest suggestion or `/gen here` block still showing in Neovim into its buffer, unsaved and one undo step, as
  `Alt-y` does there; the window with your code goes to it and lights its lines for a moment (`Ctrl-O` comes back),
  and the focus stays in the chat. A remark's action line and a gen card's show it (`Alt-y take`, in place of `a`
  and `k`, which still work once the message is picked) and take that one; `?` lists it.
- **A living thread: done and next.** When the session gets a goal, Pair proposes it as two to four steps in one line,
  at your next break; `p` in the chat puts them on the line to edit, `/plan a; b; c` sets your own, `/plan off` drops
  them. When a step lands (tests go green, you take Pair's code, a commit), Pair checks the debrief's facts of the
  session so far and says at your next break `done: X; next: Y`. The steps go with every question, so "what's left?"
  is answered from them. Each line costs the talk budget like a remark, and the ledger books each one; the plan lives
  in the session only, never in `NOTES.md` or the brief.

### Changed

- **Pair never works from a stale read.** Each remark, question, `/drive` and explanation carries the lines you changed
  since Pair's last turn, as they are now in your buffer, so a suggestion no longer puts back a bug you just fixed.
- **A remark you act on counts as useful.** Editing the lines a remark pointed at, within ten minutes, counts it as
  useful wherever its words showed, also when it reached you while you were in your terminal; the ledger books it
  (`counted useful`) and the chat marks it. Before, such a remark counted as ignored, and with `autoTune` enough of
  them raised the bar. Your own `+` or `-` still wins.
- **The day's end debrief calls only the remarks you rated noise "noise".** Remarks that got no answer are counted
  beside them (`…; 1 got no answer.`).
- **Pair speaks as one voice.** A one-change hand-over prints no role lines before and after it, and Pair says its
  check once, as speech: `Ran your npm test on it: 9 pass.`, not the raw command line and the result twice. Its pane
  shows `pair-run npm test` instead of the `cd` into a scratch copy and the file the output goes to. `Alt-g` means
  here: no `Shape?` question (a shape word first still asks for another). Closing words that only repeat the notes
  Pair just showed, or say a suggestion was made before you took it, are not shown. The ledger keeps every step:
  the hand-over (`wheel`), the whole command and its output, and the words it did not show, with why
  ([docs/tone.md](https://github.com/makefunstuff/pairing-buddy/blob/main/docs/tone.md#one-voice)).

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
