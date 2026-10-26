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
2. It reads the code and calls `edit` once: the lines are replaced through Neovim's buffer API as one undo step. If the file is not shown in a window, it opens in a split. The chat says `Changed src/ws.mjs:1 (u undoes it).`
3. A second `edit` in the same answer is refused: one change per hand-over. An edit Neovim could not apply (a line past the end of the buffer) does not count.
4. It says in one sentence what it changed. It is told not to run the tests now: they read the file on disk, which changes only when you save.
5. When the answer ends, Pair is Navigator again by itself, also when it answered without an edit, for example with a question.

A hand-over needs Neovim connected (`:Pair start`), and is refused while Pair is still answering something else. No remark nobody asked for starts while Pair has the wheel.

## Taking the wheel back

Any key you press in Neovim while Pair has the wheel takes it back (scrolling, clicking and the terminal's focus reports are not keys, so you can scroll to watch):

- The plugin refuses edits from that key on, before the daemon has even heard of it.
- The daemon switches Pair back to Navigator: from then on the policy hook refuses `edit` and `type`, telling the model the user has the wheel, so it can suggest the change instead. The conversation is offered Navigator's tools from its next answer on (tools that vanish in the middle of an answer make some local models write the call as plain text).
- The chat says "You have the wheel back."

Typing in the chat pane or in a shell pane does not take the wheel back: herdr does not report keystrokes, and the chat is where you talk to Pair while it drives.

## Ping-pong TDD

1. You write a failing test, then say "your turn".
2. Pair is asked to read the test you just edited and the code it tests, and to make the test pass by changing the code, not the test.
3. It makes one edit and hands back.
4. You run the tests and write the next one.

As Driver Pair also has `search` and `run` in its own pane (the same command policy and limits as [Scout](scout.md)), so it may run the test before it edits. After the edit, the tests would still see the saved file, so saving and running them is yours.

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

Each conversation is offered only its role's tools, and the `beforeTool` hook refuses any other name (`src/tools.mjs`). The session checks again that Pair still has the wheel when the edit or the typing happens (`src/session.mjs`), and the Neovim plugin refuses an edit once you have pressed a key (`lua/pair/init.lua`). The Driver role is never stored: a hand-over is stored as Navigator, which is where every drive ends, so a daemon restart during one also brings back Navigator.
