# Driver and suggestions

You drive; Pair sits in the second chair. Two things let it touch your code, both in plain sight:

- **`suggest`**, in every role: a change shown in your buffer that you accept with one key or ignore.
- **`edit`**, only as Driver: one change Pair makes in your buffer while you hand it the wheel.

Neither saves anything. Your buffer changes, and the disk changes only when you `:w`.

## Suggestions

`suggest(file, line, end_line, new_text, note)` shows that lines `line` to `end_line` would become `new_text`:

- The old lines are highlighted (`PairSuggestDelete`, linked to `DiffDelete`), with the note and the accept key at the end of the first one.
- The new lines appear below them as ghost text (`PairSuggestAdd`, linked to `DiffAdd`). They are virtual lines: not in the buffer, not in your undo tree.
- The chat shows the same note and the new text.

| You | What happens |
| --- | --- |
| Press the accept key (`Alt-y`, `<M-y>`, by default) or `:Pair accept` | The lines are replaced, as your own change: one `u` undoes it |
| Edit those lines yourself | The suggestion goes away: you ignored it |
| `:Pair dismiss` | The suggestion goes away |
| Do nothing | It stays until one of the above, or until Pair suggests something else |

The accept key is mapped in Normal mode, only in that buffer, and only while the suggestion shows (`accept_key` in `setup`; `false` maps nothing). Avoid `<Tab>`: terminals send it as Ctrl-I, so jumping forward in the jumplist would accept. A suggestion for a line past the end of the buffer is refused, and the model is told so. If the lines changed under the suggestion when you accept, nothing is replaced and you are told so. Lines added above it move it along.

## Handing over

| From | How |
| --- | --- |
| Neovim | `:Pair drive` or `:Pair drive <what to do>` |
| The chat | `/drive` or `/drive <what to do>`, or a line that is "you take it" or "your turn", alone or followed by punctuation and a request (`you take it: set the timeout to 30 s`); "your turn to explain ..." stays a question |

Then:

1. Pair becomes the Driver for one answer. The chat prompt and `require('pair').status()` show `driver`.
2. It reads the code and calls `edit` once. Neovim types the change while you watch (see [the visible hand-over](neovim.md#the-visible-hand-over)): ghost text with Pair's cursor, each line entering the buffer only when it is whole, all of it one undo step. If no window shows those lines, they open in a split. The edit's answer to the model waits until the typing is done. The chat says `Changed src/ws.mjs:1 (u undoes it).`
   A file that does not exist yet (inside the project, in a folder that does) opens as a new buffer and is typed there, for example the `Makefile` of a [first slice](blank-page.md#the-first-run). Its `read` says it does not exist yet, or shows the buffer once Pair has typed it. The disk has it when you save it.
3. A second `edit` in the same answer is refused: one change per hand-over. An edit Neovim could not apply (a line past the end of the buffer), or that you stopped halfway, does not count.
4. If the project has a test command (`testOnSave`), Pair runs it on the unsaved buffer and tells the model the result (below). It says in one sentence what it changed and, when the tests ran, whether they pass. It is told not to run the tests itself: they would read the file on disk, which changes only when you save.
5. When the answer ends, Pair is Navigator again by itself, also when it answered without an edit, for example with a question.
6. The hand-back line: its words under the last line it changed, `✓` or `✗` in the sign column there when the tests ran, `▎` on the lines it changed, and `u undoes it`. They go with your next edit. After that, `u` on the edit's line in `:Pair today` still undoes it: Neovim merges the undo into the buffer as it is then, and keeps your later edits, or changes nothing when you edited the same lines ([the ledger](neovim.md#the-ledger)).

A hand-over needs Neovim connected (`:Pair start`), and is refused while Pair is still answering something else. No remark nobody asked for starts while Pair has the wheel.

## Tests on the unsaved buffer

After the Driver's edit, when the project has a command in `testOnSave`, Pair runs that command once on the buffer as it is, before anything is saved. It runs in Pair's own pane like the tests on save, so you see it, and the model never chooses it.

- **Go**: a command with `go test` in it gets `-overlay`: Go reads the edited file from the buffer's text, and nothing else changes. `go test -json ./...` runs as `go test -overlay <file> -json ./...`.
- **Other runners** (jest, vitest, pytest, cargo, ...): the command runs in a scratch copy of the project, with the buffer's text in the edited file. The copy has the files git knows (tracked, or untracked and not ignored) and the files git ignores, such as `.env`. Folders git ignores are left out, so what a run builds or caches there (`dist`, `coverage`, `target`, `.pytest_cache`) is made in the copy and never reaches your project; a Rust or TypeScript build starts from scratch. Only dependency folders are linked from the project, at any depth (a workspace package's own `node_modules` too): `.venv` and `venv` as they are, and `node_modules` package by package, without its caches (`.cache`, `.vite`), so a cache a run writes stays in the copy. A project that is not a git repository, has more than 5000 files to copy, or whose edited file is in a dependency folder is not tested; the model is told why. The copy is removed after the run.
- The statusline shows `⠹ go test ./... (unsaved)`, then `✓ go test ./... (unsaved) · 4 tests, 3 packages` or `✗ 1 failing · TestX`, and the signs on your test functions show this run's results, at the lines your buffer has them on. The chat gets one line about it.
- The run is not a baseline for the [tests on save](tests-on-save.md): a test that fails on the buffer and then on save still counts as newly failing against the last run on save.
- Without a `testOnSave` command, or without Pair's pane, nothing runs and the model is told to leave the tests to you.

## Taking the wheel back

Any key you press in Neovim while Pair has the wheel takes it back (scrolling, clicking and the terminal's focus reports are not keys, so you can scroll to watch):

- While Pair is typing its edit, the edit stops and what it typed so far is undone: one change or none. That key, and any you press until the undo is done, does nothing else, so it cannot change the buffer under a half-typed edit. The model is told `Not changed: the user has taken the wheel back.`
- The plugin refuses edits from that key on, before the daemon has even heard of it.
- The daemon switches Pair back to Navigator: from then on the policy hook refuses `edit` and `type`, telling the model the user has the wheel, so it can suggest the change instead. The conversation is offered Navigator's tools from its next answer on (tools that vanish in the middle of an answer make some local models write the call as plain text).
- The chat says "You have the wheel back."

Typing in the chat pane or in a shell pane does not take the wheel back: herdr does not report keystrokes, and the chat is where you talk to Pair while it drives.

## Ping-pong TDD

1. You write a failing test, then say "your turn".
2. Pair is asked to read the test you just edited and the code it tests, and to make the test pass by changing the code, not the test.
3. It makes one edit and hands back.
4. You run the tests and write the next one.

As Driver Pair also has `search` and `run` in its own pane (the same command policy and limits as [Scout](scout.md)), so it may run the test before it edits. After the edit, the tests on disk would still see the saved file: with a `testOnSave` command, Pair runs them on the unsaved buffer instead, and says whether they pass. Saving is yours.

## Typing into your terminal

`type(text)` puts one line into your terminal pane, the one you last looked at or ran a command in. It is only for the Driver:

- It asks first in the chat: ``Pair wants to type `npm test` into your terminal (pane …), without pressing Enter. Allow?`` `y` or `yes` allows it; anything else, or no answer within a minute, declines.
- It never presses Enter: running the line is up to you.
- It takes one line of plain text. Enter, Ctrl-C and any other control character or escape sequence are refused, in the session and again at the herdr call.
- What [Scout's command policy](scout.md#the-command-policy) refuses is refused here too (`git commit`, `git push`, `curl`, `sudo`, ...).
- It goes only to one of your terminal panes, never to the chat, Scout's pane or an editor pane.
- If you take the wheel back while the question is open, a yes types nothing.

## The policy in code

| Tool | Navigator | Scout | Driver |
| --- | --- | --- | --- |
| `say`, `point`, `open`, `read`, `suggest` | yes | yes | yes |
| `search`, `run` | no | yes | yes |
| `edit` | no | no | once per hand-over |
| `type` | no | no | after a yes, without Enter |

Each conversation is offered only its role's tools, and the `beforeTool` hook refuses any other name (`src/tools.mjs`). The session checks again that Pair still has the wheel when the edit or the typing happens (`src/session.mjs`), and the Neovim plugin refuses an edit once you have pressed a key, and undoes one you stop halfway (`lua/pair/init.lua`, `lua/pair/drive.lua`). The Driver role is never stored: a hand-over is stored as Navigator, which is where every drive ends, so a daemon restart during one also brings back Navigator.
