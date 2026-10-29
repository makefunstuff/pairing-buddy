---
description: "Install Pair: what it needs, the daemon and the Neovim plugin, a check with pair doctor, and a working session in herdr."
---

# Install and daily use

## Requirements

- Node.js 22.19 or newer
- Neovim 0.11 or newer
- [herdr](https://herdr.dev), the best home for Pair: the chat pane beside Neovim, your terminals watched with their
  output, Scout's pane below the chat. Without it all of Pair still works inside Neovim
  ([neovim.md](neovim.md#without-herdr)).
- For Scout: `bash` and [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`); optionally [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`), to run Pair's commands in [a sandbox](scout.md#the-sandbox)
- Optional, for the [context card](neovim.md#what-it-knows-the-context-card), the goal and
  [your other agents](agents.md): the work board, [Shepherdr](https://github.com/eliasstravik/shepherdr) (`shepherdr`
  on the daemon's PATH), and GitHub's `gh` for the pull request
- A model: any OpenAI-compatible local server (for example llama.cpp or Ollama), an Anthropic-compatible API, or any
  provider [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) supports, with an API key or a subscription
  login ([models.md](models.md)).

## Install

**Or let your AI agent do it:** tell your coding agent "follow
https://github.com/makefunstuff/pairing-buddy/blob/main/INSTALL.md". [That guide](https://github.com/makefunstuff/pairing-buddy/blob/main/INSTALL.md)
takes it from a fresh machine to a passing `pair doctor`: the prerequisites, the service, your model, the plugin in
your plugin manager, upgrade and uninstall, and it asks you where only you can answer.

Once, in two parts: the daemon as an npm package, and the Neovim plugin with lazy.nvim. Both come from this GitHub
repository.

```sh
npm install -g github:makefunstuff/pairing-buddy   # puts `pair` on your PATH
pair setup
```

`pair setup`:

1. Writes a commented config to `~/.config/pairing-buddy/config.json` if there is none yet. Set your models there
   ([config.md](config.md)).
2. In a terminal, offers to log in to a model provider (a subscription or an API key; see
   [Logins and keys](models.md#logins-and-keys)). Enter skips it.
3. Stores the environment variables your model entries take keys from (`apiKeyEnv`) for the service, which does not
   get your shell's environment ([models.md](models.md#logins-and-keys)).
4. Installs the daemon as a service that starts at login and restarts when it fails: a systemd user service,
   `pairing-buddy.service`, on Linux, and a launchd agent, `io.github.makefunstuff.pairing-buddy`, on macOS. Without
   either, see below.
5. Starts it, and prints the next steps.

Then add the plugin to your lazy.nvim specs:

```lua
{
  'makefunstuff/pairing-buddy',
  main = 'pair',
  lazy = false,
  opts = {auto_connect = true},
}
```

With `auto_connect`, every Neovim connects to the daemon at startup. Without a plugin manager:
`vim.opt.rtp:append('/path/to/pairing-buddy')` and `require('pair').setup({auto_connect = true})` in your config.
The plugin's options are in [neovim-plugin.md](neovim-plugin.md#setup).

**Upgrading.** Run `npm install -g github:makefunstuff/pairing-buddy` and `pair setup` again, also after upgrading
Node.js: the service names the Node.js binary it runs, and setup rewrites it and restarts the daemon.

**Uninstalling.** `pair uninstall` stops and removes the service, and keeps the config and data.

**From a clone.** `npm ci && npm link` in it, then `pair setup` (the service then runs the clone's code), and
`dir = '/path/to/clone'` in place of the GitHub name in the lazy.nvim spec.

**Without systemd or launchd.** `pair setup` then installs no service: `pair` starts the daemon in the background
when it is not running, under a supervisor (`pair supervise`) that restarts it 2 s after it crashes or fails, and
gives up after 5 failures in a minute. A clean stop (`kill` with SIGTERM) stops both. Nothing starts it at login; to
have that, run `pair supervise` from your init system as your user, or `pair daemon` under a supervisor of its own
that restarts it on failure, for example a runit user service (`exec pair daemon` in its `run` file) or an OpenRC
user service with `supervisor=supervise-daemon`. Set `PAIR_CONFIG` there if your config is not in the default place.

## Check it: `pair doctor`

`pair doctor` checks every part and says what is wrong in plain words, one line each, with the fix. What each line
looks at, and the usual fixes, are in [Troubleshooting](troubleshooting.md).

## A session in herdr

1. In the herdr pane next to your Neovim, run `pair`. It opens a narrow chat pane on the right (and starts the daemon
   if it is not running).
2. Neovim is connected already with `auto_connect`; otherwise run `:Pair start` there.
3. Pair shows the note of the last session in this project, if there was one ("Last time: …"), and the goal: the
   title of the work board's (Shepherdr's) task for this branch, else the words of the branch name. Only without either does
   it ask; type the goal, or `later` to skip it (`/goal <text>` sets one any time).
4. Work as usual. Pair stays quiet unless a remark clears the bar. Tell it whether a remark helped: `+` or `-` in the
   chat, `Alt-u` or `Alt-n` in Neovim.
5. Stop when you are done. The session ends by itself, with a short note kept for the next one, after 45 minutes
   without you or a minute after its last Neovim and chat pane closed. `/end` in the chat (or `:Pair end`) ends it at
   once ([memory.md](memory.md#no-ceremony-a-session-starts-and-ends-by-itself)).

The chat pane is optional: a Neovim alone is a whole session.

**Chat commands.** `/goal`, `/level`, `/scout`, `/navigate`, `/drive`, `+` and `-` for your verdict, `/why`,
`/mute`, `/undo`, `/end` and the rest are in the [command reference](cli.md#chat-commands); `/` in the chat lists
them as you type. Anything else you type is a question for Pair, and "you take it" or "your turn" hands it the
wheel. What the pane shows and its keys (`?` lists them) are in [the chat pane](chat.md).

**The shell hook.** Optional, for exact command boundaries and exit codes in your own panes: add it to your shell's rc file.
Pair then catches every command however short and looks at the pane's processes only for an editor while a command
runs. In zsh the hook also reports your keys at the prompt, so the pane is not read there at all; bash and fish report
no keys, so the pane with focus is still read twice a second at its prompt, for typing ([herdr.md](herdr.md#the-users-panes-the-shell-hook-else-heuristics)):

```sh
eval "$(pair shell-hook bash)"   # or zsh
pair shell-hook fish | source    # fish, in config.fish
```

It runs `pair report` in the background before and after each command, so the prompt never waits; zsh's keys go
straight to the daemon's socket, at most twice a second, and never the keys themselves. It also emits OSC 133 marks
(prompt, output, end with the exit code) for a terminal that reads them. It names the shell by its process id, which
tells Pair the `:terminal` buffer or tmux pane the command ran in.

**Without herdr**, run `:Pair chat` in Neovim (or `pair chat` in any terminal). Scout's pane and the tests on save
run in a `:terminal` along the bottom of Neovim, and the Driver's `type` goes to your own `:terminal` buffers
([neovim.md](neovim.md#without-herdr)). Pair reads your own `:terminal` buffers in Neovim, and the panes of the tmux
session Neovim or the chat runs in: which one you are in, the commands you run there and their output, and with the
shell hook their exit codes. Terminals in neither (another window of your terminal emulator) send only the shell
hook's exit codes, without output.

**Several projects** work at once: each project has its own session, chat pane and goal, and the daemon serves them
all. A project is the git root of the folder Neovim and `pair` start in, so each git worktree is a project of its
own: two pieces of work in one repository each get their own session in their own worktree. In a monorepo, where
the git root is too coarse, [`sessionRoots`](config.md#session-roots) makes smaller folders projects.

**Several Neovims** in one project share its session. Pair shows points, suggestions and edits in the Neovim you are
in: the one with focus, which Neovim learns from the terminal's focus reports and Pair from herdr's focused pane;
when none has it (you are in the chat pane, or the browser), the one you were in last. A Neovim's own doings, such
as its LSP's diagnostics or a file it reloads while you are elsewhere, never make it the one. Pair reads a file from
whichever Neovim has it loaded, the one you are in first.

**Restarts.** If the daemon restarts, the chat pane's status says so, the pane waits for it and carries on,
without showing the history twice. Neovim reconnects by itself too ([neovim-plugin.md](neovim-plugin.md#setup)). If you had asked something the
restart cut off, Pair finishes that answer and shows it marked as late, in the chat and in Neovim, also when they
reconnect after it. A remark Pair was making unasked, or a hand-over, is dropped instead.

**The chat pane's colours.** It uses the terminal's own colours and Pair's accent from Neovim, in true colour, so
the two read as one ([colours](chat.md#colours)). Until a Neovim with `termguicolors` connects it uses the terminal's
cyan, and with `NO_COLOR` set it prints no colours.

## Other commands

- `pair auth` logs in to model providers and lists what is set ([models.md](models.md#logins-and-keys)).
- `pair stats` shows how often Pair spoke unasked and what you made of it ([memory.md](memory.md#pair-stats)).
- `pair daemon` runs the daemon in the foreground; `pair supervise` too, restarting it when it fails.
- The daemon's log goes to the journal under systemd (`journalctl --user -u pairing-buddy`), to
  `~/Library/Logs/pairing-buddy.log` under launchd, and to `daemon.log` in the data directory when `pair` started it.
