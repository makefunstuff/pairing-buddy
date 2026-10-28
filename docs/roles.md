# Roles

Pair has two models behind it and three roles in front of you.

## The two models

| Model | Its job | Speed |
| --- | --- | --- |
| <span class="role watcher">Watcher</span> | Looks at each moment that might deserve a remark (a failed command you did not see, the same error twice, editing a file unrelated to the failing test) and scores it from 0 to 10. Most moments score low, and Pair stays quiet | About a second. It answers with one number and never thinks |
| <span class="role partner">Partner</span> | Writes what Pair says, answers your questions and uses the tools of the current role | A few seconds. It thinks before it answers |

One model can play both. Only a moment that clears the bar of your [talk level](config.md#talk-levels), within its
budget, reaches the Partner, and never while you type. Details in [The Watcher](watcher.md) and
[Models and providers](models.md).

## The three roles

Pair has one role at a time. It shows in the chat pane's header, in the role's colour from the website (Navigator
blue, Scout green, Driver red), and in Neovim's statusline.

### Navigator (the default)

Watches, comments, answers your questions, points at lines and suggests changes. A suggestion shows in place, the
old line struck through and the new one under it; `Alt-y` takes it as your own edit. The model gets no tool to run commands or
edit; your [tests on save](tests-on-save.md) still run in Pair's pane, if you set them.

Switch back to it with `/navigate` in the chat or `:Pair navigate`.

### Scout

Everything Navigator does, plus searches (ripgrep) and commands such as tests, builds and `git log`, typed in Pair's
own pane where you see every one and its output. What may run is decided in code, not by the model:

- read-only commands, tests and builds run;
- writes and installs ask you first;
- commits, pushes, the network and `sudo` are refused.

At most four commands per question. Where bubblewrap works, the pane is a [sandbox](scout.md#the-sandbox) in which
only the project is writable. Switch with `/scout` or `:Pair scout`. Details in [Scout](scout.md).

### Driver

Takes the keyboard for one change when you hand it over: `:Pair drive <what>`, `/drive <what>`, or "you take it" /
"your turn" in the chat. It types the change into your buffer while you watch, a line at a time, up to five edits,
as one undo step, and never saves. Before it hands back, it checks your unsaved buffer with the project's tests, or
with the build and run you last ran. Any key you press takes the wheel back.

`:Pair drive!` (or `/drive!`) keeps the wheel for each request after it, until you take it back. Details in
[Driver and suggestions](driver.md).

## A /gen request is not a role

`/gen here <what>` (or `Alt-g` in Neovim) asks Pair for code in any role. The request runs in a conversation of its
own with the gen tools, and Pair stays in the role it has: it is a commission, not a fourth role. It proposes code
where you asked, which you take with one key; it never edits or types. It runs against your
[brief](gen.md#the-brief) (the goal, the board task and a note), whatever the role. Details in [/gen](gen.md).

## Tools per role

| Tool | <span class="role navigator">Navigator</span> | <span class="role scout">Scout</span> | <span class="role driver">Driver</span> | A /gen request |
| --- | --- | --- | --- | --- |
| `say`, `read`, `recall` | yes | yes | yes | yes |
| `point`, `open`, `suggest` | yes | yes | yes | |
| `search` (in Pair's pane) | | yes | yes | yes |
| `run` (in Pair's pane) | | yes | yes | |
| `edit` (your buffer, unsaved) | | | yes | |
| `type` (one line into your terminal, after your yes) | | | yes | |
| `propose` (code where you asked, taken with one key), `ask` (at most two questions) | | | | yes |

Each conversation is offered only its role's tools, and a policy in code refuses any other
([How it works](how-it-works.md#what-it-can-do)). Nothing in the daemon writes your files or saves buffers.
