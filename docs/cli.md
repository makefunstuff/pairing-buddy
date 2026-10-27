# Command reference

`pair` is one command for the daemon, the chat pane, setup, logins and checks. `pair help` prints the list.

## `pair`

Opens the chat pane next to the current herdr pane, starting the daemon if it is not running. Outside herdr it runs
the chat right there, like `pair chat`.

## `pair chat`

Runs the chat pane in this terminal, starting the daemon if needed. This is what `:Pair chat` runs in Neovim.

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

Checks the config, the service, the daemon, the plugin, Neovim, herdr, logins and keys, Pair's pane, voice and both
models, one line each, with the fix when something is wrong. It exits with 1 when a check fails.

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
| `pair auth login PROVIDER` | Log in with a subscription or store an API key (also `pair login PROVIDER`). A name pi-ai does not know stores a key for your own server, for `"auth"` |
| `pair auth logout PROVIDER` | Remove that login or key (also `pair logout PROVIDER`) |
| `pair auth list` | Every provider and whether a login or key is set; never the secrets. Also plain `pair auth` |
| `pair auth models PROVIDER` | The models a provider offers, for a model entry's `"model"` |

## `pair stats`

How often Pair spoke unasked, how much of it was useful, per trigger, and how the tuning moved
([memory.md](memory.md#pair-stats)).

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

Prints a hook for your shell that reports each command's exit code to the daemon, and emits OSC 133 marks for a
terminal that reads them. It names the shell by its process id, which tells Pair the `:terminal` buffer or tmux pane
the command ran in. Optional; most useful without herdr.

```sh
eval "$(pair shell-hook bash)"   # or zsh, in your rc file
pair shell-hook fish | source    # fish, in config.fish
```

`pair report --exit N --cmd TEXT [--shell PID]` is what the hook runs; you never need to.

## Chat commands

Typed in the chat pane. Anything that is not a command is a question for Pair, and a line that starts with "you
take it" or "your turn" hands Pair the wheel.

| Command | What it does |
| --- | --- |
| `/goal <text>` | Set the session goal |
| `/level quiet\|normal\|chatty` | How often Pair speaks unasked, for this session |
| `/navigate`, `/scout` | Switch [role](roles.md) |
| `/drive [what]` | Hand Pair the wheel for one change |
| `/drive! [what]` | The same, and Pair keeps the wheel until you take it back |
| `+` or `/useful`, `-` or `/noise` | Your verdict on Pair's last unasked remark |
| `/remarks` | The last nine remarks in the project; `+2` (or `/useful 2`) and `-3` (or `/noise 3`) rate an older one |
| `?` or `/why` | The idea worth keeping behind what Pair said last |
| `/today` | What Pair did here today, as in `:Pair today` |
| `/agents` | Your other agents and board tasks |
| `/first <step>` | Tomorrow's first step, as in `:Pair first` |
| `/end` | End the session now, with its debrief |
| `/quit` | Close the chat pane; the session goes on |

When Pair asks before running or typing a command, your next line is the answer: `y` or `yes` allows it, anything
else declines. The Neovim commands are in the [Neovim plugin reference](neovim-plugin.md#commands).

## Logs

The daemon logs to the journal under systemd (`journalctl --user -u pairing-buddy`), to
`~/Library/Logs/pairing-buddy.log` under launchd, and to `daemon.log` in the data directory when `pair` started it.
