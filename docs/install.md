# Install and daily use

## Requirements

- Node.js 22.19 or newer
- Neovim 0.11 or newer
- [herdr](https://herdr.dev) for the chat pane, terminal watching, Scout's pane and tests on save. Pair also works
  without it, with the chat in any terminal, as Navigator only.
- For Scout: `bash` and [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`)
- Optional, for the [context card](neovim.md#what-it-knows-the-context-card) and the goal: herdr's work board
  (`herdr-projects`) and GitHub's `gh` for the pull request
- A model: any OpenAI-compatible local server (for example llama.cpp or Ollama), an Anthropic-compatible API, or any
  provider [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) supports, with an API key or a subscription
  login ([config.md](config.md)).

## Install

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
   [Logins and keys](config.md#logins-and-keys)). Enter skips it.
3. Installs the daemon as a systemd user service, `pairing-buddy.service`: it starts at login and restarts when it
   fails.
4. Starts it, and prints the next steps.

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
The plugin's options are in [neovim.md](neovim.md#setup).

**Upgrading.** Run `npm install -g github:makefunstuff/pairing-buddy` and `pair setup` again, also after upgrading
Node.js: the unit names the Node.js binary it runs, and setup rewrites it and restarts the daemon.

**Uninstalling.** `pair uninstall` stops and removes the service, and keeps the config and data.

**From a clone.** `npm ci && npm link` in it, then `pair setup` (the service then runs the clone's code), and
`dir = '/path/to/clone'` in place of the GitHub name in the lazy.nvim spec.

**Without systemd.** Skip `pair setup`: `pair` then starts the daemon in the background when it is not running, and
`pair daemon` runs it in the foreground. Nothing restarts it after a crash
([#31](https://github.com/makefunstuff/pairing-buddy/issues/31)).

## Check it: `pair doctor`

`pair doctor` checks every part and says what is wrong in plain words, one line each, with the fix:

```
✓ config   ~/.config/pairing-buddy/config.json
✓ service  starts at login, running
✓ daemon   version 0.9.0, up 42 min, 2 sessions
✓ plugin   your Neovim config loads it
✓ neovim   2 connected, in shop, blog
✓ herdr    answers in 3 ms, 4 panes in this workspace
! watcher  your-small-model at http://localhost:8080/v1 answers, but takes 2.4 s: the Watcher scores every candidate remark and should take about 1 s. ...
✓ partner  your-larger-model at http://localhost:8081/v1 answers in 1.1 s
```

| Check | What it looks at |
| --- | --- |
| config | The file parses, and its models are not still the example's |
| service | The unit is installed, enabled, running, and its Node.js still exists |
| daemon | It answers on its socket, with the same version as `pair` |
| plugin | Neovim, started headless with your config, loads the plugin |
| neovim | How many Neovims are connected, in which projects |
| herdr | herdr answers on its socket (only checked when run inside herdr) |
| logins | `auth.json` is readable by you only (shown when there is one) |
| watcher, partner | The login or key the model needs is there and, for a subscription, still renews (with the token's expiry); the server answers and lists the model; one short completion works, and how long it took (about 1 s is the aim for the Watcher). One line, `models`, when both use the same model |
| thinking | The Partner thinks when asked to, and its levels reach the server |
| roles | When both roles share a server: how [one model](config.md#one-model) serves both, and how the Watcher fared since the daemon started |
| context | The Partner's reply has the room its thinking needs, and the window is not so small that compaction comes every few turns |

It exits with 1 when a check fails, so scripts can use it too.

## A session in herdr

1. In the herdr pane next to your Neovim, run `pair`. It opens a narrow chat pane on the right (and starts the daemon
   if it is not running).
2. Neovim is connected already with `auto_connect`; otherwise run `:Pair start` there.
3. Pair shows the note of the last session in this project, if there was one ("Last time: …"), and the goal: the
   title of the herdr work board's task for this branch, else the words of the branch name. Only without either does
   it ask; type the goal, or `later` to skip it (`/goal <text>` sets one any time).
4. Work as usual. Pair stays quiet unless a remark clears the bar. Tell it whether a remark helped: `+` or `-` in the
   chat, `Alt-u` or `Alt-n` in Neovim.
5. Stop when you are done. The session ends by itself, with a short note kept for the next one, after 45 minutes
   without you or a minute after its last Neovim and chat pane closed. `/end` in the chat (or `:Pair end`) ends it at
   once ([memory.md](memory.md#no-ceremony-a-session-starts-and-ends-by-itself)).

The chat pane is optional: a Neovim alone is a whole session.

**Chat commands.** `/goal <text>`, `/level quiet|normal|chatty`, `/scout`, `/navigate`, `/drive [what]`, `+` or
`/useful` and `-` or `/noise` (your verdict on Pair's last unasked remark), `/today` (what Pair did here today, as in
`:Pair today`, without the keys), `/end`, and `/quit` (closes the pane; the
session goes on). A line that starts with "you take it" or "your turn" hands Pair the wheel too; anything else is a
question for Pair. When Pair asks before running or typing a command, your next line is the answer: `y` or `yes`
allows it, anything else declines.

**The shell hook.** Optional, for exit codes and short commands; add it to your shell's rc file:

```sh
eval "$(pair shell-hook bash)"   # or zsh
```

**Without herdr**, run `pair chat` in any terminal. Pair then sees your editor and, with the shell hook, your
commands' exit codes, but no terminal output.

**Several projects** work at once: each project (git root) has its own session, chat pane and goal, and the daemon
serves them all. Several Neovims in one project share its session; Pair shows points, suggestions and edits in the
Neovim you used last (the one that last sent an edit, a cursor move or a file change), and reads a file from
whichever Neovim has it loaded.

**Restarts.** If the daemon restarts, the chat pane says so, waits for it and carries on, without printing the
history again. Neovim reconnects by itself too ([neovim.md](neovim.md#setup)).

**The chat pane's colours.** It prints Pair's name and the `code` in its words in Pair's accent from Neovim, in true
colour, so the two read as one; long lines wrap under the words. Until a Neovim with `termguicolors` connects it uses
the terminal's cyan, and with `NO_COLOR` set it prints no colours.

## Other commands

- `pair auth` logs in to model providers and lists what is set ([config.md](config.md#logins-and-keys)).
- `pair stats` shows how often Pair spoke unasked and what you made of it ([memory.md](memory.md#pair-stats)).
- `pair daemon` runs the daemon in the foreground.
- The daemon's log goes to the journal under the service (`journalctl --user -u pairing-buddy`), and to `daemon.log`
  in the data directory when `pair` started it.
