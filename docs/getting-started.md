# Getting started

From nothing to your first session in about five minutes. Each step links to the page with the details. To have
your AI coding agent do the setup, point it at
[INSTALL.md](https://github.com/makefunstuff/pairing-buddy/blob/main/INSTALL.md).

## What you need

- Node.js 22.19 or newer, and Neovim 0.11 or newer.
- A model: a local OpenAI-compatible server (llama.cpp, Ollama, vLLM, LM Studio), an API key for a provider, or a
  subscription login where the provider allows it ([Models and providers](models.md)).
- Optional: [herdr](https://herdr.dev), the best home for Pair. Without it, everything runs inside Neovim and tmux
  ([Workflows](workflows.md#with-or-without-herdr)).
- For Scout: `bash` and ripgrep (`rg`); bubblewrap (`bwrap`) if you want its commands in a sandbox.

## 1. Install the daemon

```sh
npm install -g github:makefunstuff/pairing-buddy   # puts `pair` on your PATH
pair setup
```

`pair setup` writes a commented config to `~/.config/pairing-buddy/config.json`, offers a login to a model provider
(Enter skips it), installs the daemon as a user service that starts at login (systemd or launchd), starts it, and
prints the next steps. Without systemd or launchd, `pair` starts the daemon itself ([install.md](install.md)).

## 2. Add the Neovim plugin

With lazy.nvim:

```lua
{
  'makefunstuff/pairing-buddy',
  main = 'pair',
  lazy = false,
  opts = {auto_connect = true},
}
```

With `auto_connect`, every Neovim connects to the daemon at startup. All options are in the
[Neovim plugin reference](neovim-plugin.md#setup).

## 3. Set your model

Open `~/.config/pairing-buddy/config.json` and set one model for both roles:

```jsonc
{
  "level": "normal",
  // A local OpenAI-compatible server...
  "model": {"api": "openai", "baseUrl": "http://localhost:8080/v1", "model": "your-model"}
  // ...or a provider you logged in to with `pair auth login PROVIDER`:
  // "model": {"provider": "openai", "model": "your-cloud-model"}
}
```

The daemon takes the change as you save; no restart. Two models, logins and keys are in
[Models and providers](models.md); every field is in the [configuration reference](config.md).

## 4. Check it

```sh
pair doctor
```

One line per part (config, service, daemon, plugin, Neovim, herdr, models), each with the fix when something is
wrong. See [Troubleshooting](troubleshooting.md) for what each line means.

Optional: add the shell hook to your shell's rc file, so Pair gets every command you run in your terminals with its
exit code from the shell itself, and in zsh your typing at the prompt too ([`pair shell-hook`](cli.md#pair-shell-hook)):

```sh
eval "$(pair shell-hook bash)"   # or zsh
pair shell-hook fish | source    # fish, in config.fish
```

## 5. Pair

Open Neovim in your project. In herdr, run `pair` in the pane next to it: a narrow chat pane opens on the right.
Without herdr, run `:Pair chat` in Neovim, or skip the chat: a Neovim alone is a whole session.

The session takes its goal from the herdr board task of your branch, or from the branch name, and asks in the chat
only when there is neither (on `main`, say); `:Pair goal <what>` sets it from Neovim. Then work as usual. Pair stays quiet until something is worth a word, and shows it under your line:

- `Alt-j` goes where Pair points; `Ctrl-O` comes back.
- `Alt-y` takes a suggested change.
- `Alt-u` / `Alt-n` tell Pair a remark was useful or noise, and tune when it talks.
- `:Pair ask <question>` asks something; `:Pair drive <what>` hands over the keyboard for one change.

The session ends by itself after 45 minutes without you, or a minute after its last Neovim and chat pane closed, with
a short note the next session starts from. `:Pair end` ends it at once, with a debrief.

## Next

- [How it works](how-it-works.md): what Pair sees and when it speaks.
- [Roles](roles.md): the Watcher, the Partner, and Navigator, Scout and Driver.
- [Workflows](workflows.md): exploring code, tests, notes, handing over, voice.
- [`pair` commands](cli.md) and [chat commands](cli.md#chat-commands).
