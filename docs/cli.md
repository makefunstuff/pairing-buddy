# Command reference

`pair` is one command for the daemon, the chat pane, setup, logins and checks. `pair help` prints the list.

## `pair`

Opens the chat pane next to the current herdr pane, starting the daemon if it is not running. Outside herdr it runs
the chat right there, like `pair chat`.

## `pair chat`

Runs the [chat pane](chat.md) in this terminal, starting the daemon if needed. This is what `:Pair chat` runs in
Neovim. `--plain` runs the [plain pane](chat.md#the-plain-pane), line by line, instead of the full-screen one; so does
a pipe or `TERM=dumb`.

## `pair setup`

Run once after installing, and again after an upgrade or a Node.js upgrade:

1. writes a commented config to `~/.config/pairing-buddy/config.json` if there is none;
2. in a terminal, offers a login to a model provider (Enter skips it);
3. stores the environment variables your model entries name in `apiKeyEnv` in `service.env`, for the service;
4. installs and starts the daemon as a service that starts at login: a systemd user service,
   `pairing-buddy.service`, on Linux, a launchd agent, `io.github.makefunstuff.pairing-buddy`, on macOS;
5. prints the next steps.

Without systemd or launchd it installs no service, and `pair` starts the daemon under a supervisor instead
([install.md](install.md#install)).

## `pair doctor`

Checks the config, the service, the daemon, the plugin, Neovim, herdr, logins and keys, Pair's pane, voice, both
models and the [decision model](decision.md#pair-doctor-and-pair-stats), one line each, with the fix when something is wrong. It exits with 1 when a check fails.

```sh
pair doctor              # every check
pair doctor --thinking   # find the thinking settings the Partner's OpenAI-compatible server takes
```

`--thinking` asks the Partner's server about a dozen times, trying the thinking switches and level fields Pair
knows, and ends with the `compat` block to paste into the config. See [Troubleshooting](troubleshooting.md).

## `pair auth`

Logins and keys for model providers, kept in `auth.json` next to the config, readable by you only
([Models and providers](models.md#logins-and-keys)).

| Command | What it does |
| --- | --- |
| `pair auth login PROVIDER` | Log in with a subscription or store an API key (also `pair login PROVIDER`). A name pi-ai does not know stores a key for your own server, for `"auth"`. Not on a terminal, it reads its answers from standard input, one per line: `pass show deepseek \| pair auth login deepseek` stores a key from a password manager (a choice comes first where the provider offers more than one login). Input that ends before an answer fails with "the input ended before an answer was given" and exit 1 |
| `pair auth logout PROVIDER` | Remove that login or key (also `pair logout PROVIDER`) |
| `pair auth list` | Every provider and whether a login or key is set; never the secrets. Also plain `pair auth` |
| `pair auth models PROVIDER` | The models a provider offers, for a model entry's `"model"`, then its decision models, for a [`decision`](decision.md) entry |

## `pair stats`

How often Pair spoke unasked, how much of it was useful, per trigger, and how the tuning moved
([memory.md](memory.md#pair-stats)). With a decision model, also what it sorted, the Watcher calls it saved, and its
remarks next to the rules' ([decision.md](decision.md#pair-doctor-and-pair-stats)). With `/gen` requests in the
window, also what they made and how much of it [became yours](gen.md#owning-generated-code).

```sh
pair stats               # the last 7 days, every project
pair stats --days 30     # another window
pair stats --project     # only the project this folder belongs to
pair stats --project DIR # only the project DIR belongs to
```

## `pair uninstall`

Stops and removes the service. The config and the data stay.

## `pair daemon` and `pair supervise`

`pair daemon` runs the daemon in the foreground. `pair supervise` does too, and restarts it 2 s after it crashes,
giving up after 5 failures in a minute: it is what `pair` starts when there is no service. Use either under your own
init system ([install.md](install.md#install)).

## `pair shell-hook`

Prints a hook for your shell that tells the daemon when the shell starts and when each command starts and ends, with
its exit code; in zsh also when you type at the prompt (at most twice a second, never the keys themselves). Pair then
catches every command however short, and no longer polls the terminal's processes to find them: it looks at them only
while a command runs, for an editor opening in it. A zsh terminal is not read at its prompt at all; bash and fish
report no keys, so the one with focus is still read twice a second at its prompt, for typing
([herdr.md](herdr.md#the-users-panes-the-shell-hook-else-heuristics)).
It emits OSC 133 marks for a terminal that reads them, and names the shell by its process id, which tells Pair the
`:terminal` buffer or tmux pane the command ran in. Optional; recommended in herdr too.

```sh
eval "$(pair shell-hook bash)"   # or zsh, in your rc file
pair shell-hook fish | source    # fish, in config.fish
```

`pair report --start|--exit N|--ready [--cmd TEXT] [--shell PID] ...` is what the hook runs; you never need to.

## Chat commands

Typed in the chat pane; `/` there lists them as you type, and Tab completes. Anything that is not a command is a
question for Pair (`@here` in it sends your selection in Neovim along), and a line that starts with "you take it" or
"your turn" hands Pair the wheel. The pane's keys are in [the chat pane](chat.md#every-key).

| Command | What it does |
| --- | --- |
| `/goal <text>` | Set the session goal |
| `/level quiet\|normal\|chatty` | How often Pair speaks unasked, for this session (`Alt-L` cycles it) |
| `/quiet`, `/normal`, `/chatty` | The same, shorter |
| `/navigate`, `/scout` | Switch [role](roles.md) |
| `/drive [what]` | Hand Pair the wheel for one change |
| `/drive! [what]` | The same, and Pair keeps the wheel until you take it back |
| `/cancel` | Stop the answer Pair is working on (`Esc` in the pane); while it drives, take the wheel back |
| `+` or `/useful`, `-` or `/noise` | Your verdict on Pair's last unasked remark (in the full-screen pane, `Alt-↑` picks it while its action line shows, then `+` or `-`) |
| `/remarks` | The last nine remarks in the project; `+2` (or `/useful 2`) and `-3` (or `/noise 3`) rate an older one |
| `?` or `/why` | The idea worth keeping behind what Pair said last (in the full-screen pane, `?` on an empty line shows the keys: type `/why`) |
| `/explain [n]` | The same; with `n`, about remark `n` of `/remarks` |
| `/mute [kind]` | No more remarks of this kind (by default the last remark's: `drift`, `failed_command`, …) for the session |
| `/unmute [kind]` | Let one kind, or all, speak again |
| `/gen here <what>` | Ask Pair for code at your cursor in Neovim; with `@here`, over the lines you selected there ([gen.md](gen.md)) |
| `/gen file <what>` | Ask Pair for new files: they open in Neovim as buffers to review, and `:w` in one writes it to its path ([gen.md](gen.md#new-files-gen-file)) |
| `/gen try <what>` | Ask Pair for a sample to read and run, in a folder of its own outside the project, run there in the sandbox; it opens in Neovim in a split ([gen.md](gen.md#samples-gen-try-and-keep)) |
| `/gen scaffold [--branch] <what>` | Ask Pair for many files and their wiring, built and run in a copy of the project in Pair's data folder (`--branch`: a git worktree on a branch `gen/<n>`); you keep a file at a time ([gen.md](gen.md#many-files-gen-scaffold)) |
| `/gen run` | Run the newest `/gen try` again, in Pair's pane, in its sandbox |
| `/gen tries` | The project's `/gen try` folders still kept, and when each goes (`gen.keepTries`) |
| `/keep [path]` | Move the newest `/gen try`'s main file into the project at `path`, as a buffer to review in Neovim that `:w` takes. When the newest is a scaffold, keep its file at `path`: a new file as a buffer to review, a change as suggestions in yours |
| `/gen drop` | Delete the newest `/gen scaffold`'s copy (or worktree); what you did not keep of it is dropped |
| `/gen` | Today's `/gen` requests in this project, and what is [not yours yet](gen.md#owning-generated-code) of the code you took (`┊ not yours yet: 2 files · 31 lines`) |
| `/gen cancel` | Stop the `/gen` request that runs or waits |
| `/brief [note\|off]` | What `/gen` runs against: the goal, the board task and a note (`NOTES.md` by default); with a note, pin it; `off` leaves the note out ([gen.md](gen.md#the-brief)) |
| `/undo` | Undo Pair's last change of the day: an edit of the Driver's, a suggestion you took, or a whole `/gen` request; as `u` in `:Pair today` |
| `/today` | What Pair did here today, as in `:Pair today` |
| `/agents` | Your other agents and board tasks |
| `/search <text>` | Find in the conversation (`Ctrl-F`) |
| `/copy [n]` | Copy Pair's last message (or the `n`th last) to the clipboard |
| `/clear` | Clear the pane; the session and its history stay |
| `/first <step>` | Tomorrow's first step, as in `:Pair first` |
| `/end` | End the session now, with its debrief |
| `/help` | The keys and the commands |
| `/quit` | Close the chat pane; the session goes on |

An unknown command is named, and stays on the line to fix. `/search`, `/copy`, `/clear` and the keys work in the
full-screen pane only.

When Pair asks before running or typing a command, your next line is the answer: `y` or `yes` allows it, anything
else declines; in the full-screen pane `y` or `n` on an empty line answers at once. A `/gen` question says what its
answers do: `y` takes the guess or the answer given, `n` cancels or leaves it to Pair, a shape word or other words
answer. The Neovim commands are in the
[Neovim plugin reference](neovim-plugin.md#commands).

## Logs

The daemon logs to the journal under systemd (`journalctl --user -u pairing-buddy`), to
`~/Library/Logs/pairing-buddy.log` under launchd, and to `daemon.log` in the data directory when `pair` started it.
