# Install Pair: a guide for your AI agent

This page is written for an AI coding agent (Claude Code, Codex, pi, …) that sets up pairing-buddy on the machine it
runs on. Tell your agent:

> Follow https://github.com/makefunstuff/pairing-buddy/blob/main/INSTALL.md

and it goes from nothing to a passing `pair doctor` and a first answer in Neovim. A person can follow it too; the
same steps are explained for people in [Getting started](docs/getting-started.md).

## Rules for the agent

- **Do the steps in order.** Each step is **Check**, then **Do** only if the check fails, then the check again. A
  check that passes means the step is done: skip it. That makes the guide safe to run again on a machine that is half
  set up.
- **Run the commands as written**, in a POSIX shell (`sh`, `bash` or `zsh`; in fish, run them with `bash -c '…'`).
  Use `$HOME`, never a path you made up. Do not run anything as root except where a step says `sudo`.
- **Ask the human** where a step says **Ask the human**, and before every `sudo` command: say what it installs and
  wait for a yes. Do not guess an answer.
- **Never print, log or commit a secret.** Do not `cat`, `grep` or echo `auth.json`, `service.env`, a key file, or a
  config line that holds a key. Keys and subscription logins are typed by the human at Pair's own prompt; you never
  see them.
- **Never delete a file of the human's** (a config, a plugin spec, a login) unless they said so. Back up a file
  before you edit it, and keep the edit minimal.
- **Stop and ask** when a check still fails after its **Do**, and show the human the output.

Lines starting with `#` in the expected output are comments; `…` stands for text that differs per machine.

## Step 1: Know the machine

**Run:**

```sh
uname -s; uname -m
[ -d /run/systemd/system ] && echo init=systemd || echo init=other
basename "${SHELL:-sh}"
for pm in brew apt-get dnf pacman zypper apk; do command -v "$pm" >/dev/null && echo "pm=$pm"; done
```

Write down four facts for the steps below:

| Fact | From | Values |
| --- | --- | --- |
| OS | `uname -s` | `Linux` or `Darwin` (macOS). Anything else: stop, Pair supports only these two |
| Service | OS and `init=` | macOS: **launchd**. Linux with `init=systemd`: **systemd**. Linux with `init=other`: **none** (Pair runs its own supervisor, see step 5) |
| Shell rc file | `basename "$SHELL"` | `bash`: `~/.bashrc`; `zsh`: `~/.zshrc`; `fish`: `~/.config/fish/config.fish` |
| Package manager | the `pm=` lines | `brew` on macOS (if missing, ask the human to install [Homebrew](https://brew.sh)); on Linux the first of `apt-get`, `dnf`, `pacman`, `zypper`, `apk` |

`uname -m` (`x86_64`, `aarch64` or `arm64`) is used for the downloads in step 3.

## Step 2: Ask the human once, up front

**Ask the human** these questions in one message, and keep the answers:

1. **The model.** Which way should Pair reach its model?
   - **a. A local server** that speaks the OpenAI API (llama.cpp, Ollama, vLLM, LM Studio, …): its base URL (usually
     ending in `/v1`) and the model id.
   - **b. An API key for a provider** (Anthropic, OpenAI, DeepSeek, OpenRouter, Mistral, …): which provider. They will
     type the key themselves at a prompt that does not echo it.
   - **c. A subscription login** (for example "Sign in with ChatGPT"): which provider. They will log in themselves in
     a browser. Tell them that whether a plan may be used from a tool like Pair is up to the provider; Anthropic's
     Claude subscriptions may not (details in [models.md](docs/models.md#before-you-use-a-subscription)).

   And: **one model for both roles, or two?** Pair asks a small, fast **Watcher** whether a moment is worth a word, and
   a **Partner** that writes what it says. One model for both is simplest. With a paid key or a subscription, every
   Watcher question is a request, so a small local or cheap Watcher next to a cloud Partner saves money.
2. **Optional parts** (each one is optional; Pair works without all of them):
   - [herdr](https://herdr.dev), the terminal workspace that is Pair's best home (chat pane beside Neovim, your
     terminals watched). Without it, everything runs inside Neovim and tmux.
   - ripgrep (`rg`) for Scout's code search, and on Linux bubblewrap (`bwrap`) to run Pair's commands in a sandbox.
     Recommended.
   - The shell hook, which tells Pair the exit codes of the commands you run (one line in the shell rc file).
   - Push-to-talk (whisper.cpp and a recorder).
3. **May you use `sudo`** to install packages with the package manager? Without it, step 3 installs Node.js and
   Neovim into `~/.local` instead.

## Step 3: Prerequisites

### 3.1 `~/.local/bin` on `PATH`

Steps below may put programs in `~/.local/bin` and `~/.local/opt/node/bin`. **Run** this every time (it adds the
line to the rc file only once). Set `rc` to the rc file from step 1:

```sh
rc=~/.bashrc   # or ~/.zshrc
grep -qs 'pairing-buddy PATH' "$rc" || printf '\n# pairing-buddy PATH\nexport PATH="$HOME/.local/bin:$HOME/.local/opt/node/bin:$PATH"\n' >> "$rc"
export PATH="$HOME/.local/bin:$HOME/.local/opt/node/bin:$PATH"
mkdir -p ~/.local/bin ~/.local/opt
```

For fish, in place of the first two lines: `fish -c 'fish_add_path $HOME/.local/bin $HOME/.local/opt/node/bin'`.

**Check:** `grep -c 'pairing-buddy PATH' "$rc"` prints `1` (fish: skip this check).

Every later step assumes this `export` has run in your shell. If your shell does not keep variables between commands,
start each command with it.

### 3.2 git and curl

**Check:** `git --version; curl --version | head -1`. Expected: `git version 2.…` and `curl 7.…` or `curl 8.…`.

**Do** (with the human's yes to sudo; macOS has both with the Xcode command line tools, `xcode-select --install`):

| pm | Command |
| --- | --- |
| apt-get | `sudo apt-get update && sudo apt-get install -y git curl ca-certificates` |
| dnf | `sudo dnf install -y git curl` |
| pacman | `sudo pacman -S --needed --noconfirm git curl` |
| zypper | `sudo zypper install -y git curl` |
| apk | `sudo apk add git curl` |
| brew | `brew install git curl` |

### 3.3 Node.js 22.19 or newer

**Check:**

```sh
node -e 'const [a, b] = process.versions.node.split(".").map(Number); console.log(a > 22 || (a === 22 && b >= 19) ? "ok " + process.version : "old " + process.version)'
```

Expected: `ok v22.19.0` or newer (`ok v24.…`). `old …` or `node: command not found` means **Do**:

- **macOS:** `brew install node`
- **Arch, Fedora, openSUSE, Alpine** (with sudo): `sudo pacman -S --needed --noconfirm nodejs npm`,
  `sudo dnf install -y nodejs npm`, `sudo zypper install -y nodejs npm` or `sudo apk add nodejs npm`. Run the check
  again; if it still says `old`, use the user-local install below (not on Alpine: its builds are for glibc).
- **Debian, Ubuntu, any other Linux, or no sudo:** the official build in `~/.local/opt/node`, no root needed
  (glibc Linux; on Alpine use `apk`):

  ```sh
  arch=$(uname -m | sed 's/^x86_64$/x64/; s/^aarch64$/arm64/')
  file=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep -o "node-v[0-9.]*-linux-$arch.tar.gz" | head -1)
  curl -fsSL "https://nodejs.org/dist/latest-v24.x/$file" | tar -xz -C ~/.local/opt
  ln -sfn ~/.local/opt/"${file%.tar.gz}" ~/.local/opt/node
  hash -r
  ```

Then the check again: `ok v24.…`. `command -v node` must print the node you just installed (for the user-local
install: `…/.local/opt/node/bin/node`); if an old one comes first, fix `PATH` before going on.

### 3.4 npm can install globally without root

**Check:**

```sh
p=$(npm prefix -g); d="$p/lib/node_modules"; [ -d "$d" ] || d="$p"; [ -w "$d" ] && echo "ok $p" || echo "root-owned $p"
```

Expected: `ok …`. Homebrew and the user-local install say `ok`. A Node.js from a Linux package manager says
`root-owned /usr`. **Do** then (never `sudo npm`): send global installs to `~/.local`, whose `bin` is on `PATH` from
3.1:

```sh
npm config set prefix "$HOME/.local"
```

and the check again: `ok …/.local`.

### 3.5 Neovim 0.11 or newer

**Check:**

```sh
nvim --version | head -1
```

Expected: `NVIM v0.11.…` or newer (`v0.12.…`). An older version or `command not found` means **Do**:

- **macOS:** `brew install neovim`
- **Arch, Fedora, openSUSE Tumbleweed, Alpine** (with sudo): `sudo pacman -S --needed --noconfirm neovim`,
  `sudo dnf install -y neovim`, `sudo zypper install -y neovim` or `sudo apk add neovim`; then check the version
  again.
- **Debian, Ubuntu** (their packages are often older than 0.11), **any other Linux, or no sudo:** the official build
  in `~/.local/opt` (glibc Linux, `x86_64` or `aarch64`):

  ```sh
  arch=$(uname -m | sed 's/^aarch64$/arm64/')
  curl -fsSL "https://github.com/neovim/neovim/releases/latest/download/nvim-linux-$arch.tar.gz" | tar -xz -C ~/.local/opt
  ln -sfn ~/.local/opt/nvim-linux-"$arch"/bin/nvim ~/.local/bin/nvim
  hash -r
  ```

Then the check again, and `command -v nvim` must name the new one.

### 3.6 Optional tools

Install only what the human chose in step 2, with their yes to sudo.

| Tool | Check | Expected | Install |
| --- | --- | --- | --- |
| ripgrep (recommended) | `rg --version \| head -1` | `ripgrep 1…` or newer | package `ripgrep` (all package managers above) |
| bubblewrap (Linux only, recommended) | `bwrap --version` | `bubblewrap 0.…` | package `bubblewrap` |
| tmux (without herdr) | `tmux -V` | `tmux 3.…` | package `tmux` |
| herdr | `herdr --version` | `herdr 0.9.5` or newer | see [herdr.dev](https://herdr.dev); ask the human if it offers more than one way |
| Push-to-talk | (step 9) | | see [voice.md](docs/voice.md#setup) |

`bash` is needed too and is there on every supported system (`bash --version`). bubblewrap may be installed and still
not work (some containers forbid user namespaces); `pair doctor` tells, and Pair then runs without the sandbox.

## Step 4: Install Pair

**Check:**

```sh
command -v pair && npm ls -g pairing-buddy
```

Expected: a path ending in `/bin/pair`, and a tree ending in `pairing-buddy@0.10.0` (or a newer version). If so, skip to step 5 (to upgrade, see [Upgrade](#upgrade)).

**Do:**

```sh
npm install -g github:makefunstuff/pairing-buddy
hash -r
```

Expected: `added … packages`, with no `npm error` line. `npm warn install-scripts` lines about `@google/genai`
and `protobufjs` are expected: newer npm versions skip those packages' scripts, and Pair runs without them. Then the
check again. `pair help` prints the list of commands.

If it fails with `EACCES`, go back to 3.4. If `pair` is not found although npm installed it, the npm prefix's `bin`
is not on `PATH`: `echo "$(npm prefix -g)/bin"` is the folder to add (step 3.1).

## Step 5: `pair setup` and the service

`pair setup` writes the config if there is none (`~/.config/pairing-buddy/config.json`, from the commented
example), stores the key variables the config names, installs the service and starts the daemon. It is safe to run
again; it keeps an existing config.

**Run it every time** (it also points the service at this install's Node.js and Pair):

```sh
pair setup </dev/null
```

(`</dev/null` skips its offer to log in; logins come in step 6.) Expected output, by the service from step 1:

```
# the first time only:
pair: created ~/.config/pairing-buddy/config.json from the example; set your models there, then run `pair doctor`
# systemd:
The daemon runs as pairing-buddy.service: it starts at login and restarts when it fails.
# launchd:
The daemon runs as the launchd agent io.github.makefunstuff.pairing-buddy: it starts at login and restarts when it fails.
# none:
No systemd or launchd here: `pair` starts the daemon under a supervisor that restarts it when it fails, but not at login (see docs/install.md).
# then, for all three:
Config: ~/.config/pairing-buddy/config.json (the daemon takes a change as you save it)
Models: one model for both roles: your-model at http://localhost:8080/v1. …
```

The `Models:` line names the example's model until step 6.

**Check the service:**

| Service | Command | Expected |
| --- | --- | --- |
| systemd | `systemctl --user is-enabled pairing-buddy.service; systemctl --user is-active pairing-buddy.service` | `enabled` and `active` |
| launchd | `launchctl print gui/$(id -u)/io.github.makefunstuff.pairing-buddy \| grep 'state ='` | `state = running` |
| none | `pair doctor 2>&1 \| grep -E '^[^ ]+ (service\|daemon) '` | `! service  no systemd or launchd here: …` and `✓ daemon   version 0.10.0, …` |

If it fails:

- **systemd: `Failed to connect to bus`** or `systemctl --user` errors: your shell has no user session (for example
  `su` or a container shell). Run `pair setup` in the human's own login (a desktop terminal or `ssh` as that user).
- **launchd: `Bootstrap failed`**: launchd agents load only in the logged-in desktop session, not over plain `ssh`.
  Ask the human to run `pair setup` in Terminal on the Mac.
- **Any service, not running:** the logs: `journalctl --user -u pairing-buddy.service -n 20` (systemd),
  `tail -n 20 ~/Library/Logs/pairing-buddy.log` (launchd), `tail -n 20 ~/.local/state/pairing-buddy/daemon.log`
  (none).
- **none:** nothing starts the daemon at login; `pair` and `pair chat` start it when it is not running. To have it
  start at login anyway, see [install.md](docs/install.md#install) ("Without systemd or launchd").

## Step 6: The model

The config is JSON with `//` comments. Its model is one entry, `"model": {…}`, for both roles; or `"models":
{"watcher": {…}, "partner": {…}}` for one model each. Set one of the two, never both. The daemon takes the change as
you save the file, without a restart.

**Check:**

```sh
pair doctor 2>&1 | grep -E '^[^ ]+ (config|models|watcher|partner) '
```

Done when the `config` line is `✓` and the `models` line (one model) or both `watcher` and `partner` lines are `✓`
with `answers in …`. `! config  … still has the example's model names` means the model is not set yet. Right after
a change, `! models  the daemon still has the … as down` can show for up to 30 s, until the daemon checks again; run
the check again then. (`pair doctor` colours its marks also into a pipe; the `grep` patterns here allow for that.)

**Do:**

1. Back up the config: `cp ~/.config/pairing-buddy/config.json ~/.config/pairing-buddy/config.json.bak`
2. Get the key or login in place, by the human's answer in step 2 (below). Never write a key into the config
   yourself.
3. Edit the config with your file-editing tool. If it still has the example's `"model": {…}` (with `"your-model"`
   in it), replace that whole object, from `"model": {` to its closing `}`, with the entry below, and leave every
   other line as it is. If it has a model of the human's own, **ask the human** before you change it.
4. Run the check again. It can take a few seconds per model.

**a. A local server.** First check that it answers (with the base URL from the human):

```sh
curl -fsS http://localhost:8080/v1/models | head -c 300; echo
```

Expected: JSON with `"data"`, listing the model id. Then:

```jsonc
"model": {"api": "openai", "baseUrl": "http://localhost:8080/v1", "model": "the-model-id"}
```

A server that wants a key: the human runs `pair auth login my-server` as in b. below (any name pi-ai does not know
stores a key for a server of your own; it asks for the key without echoing it), then add `"auth": "my-server"` to
the entry.

**b. An API key for a provider.** List the provider ids: `pair auth list` (the first word of each line after the
`✓` column). Ask the human to type in your session (Claude Code runs a line that starts with `!` in their terminal;
otherwise they run it in a terminal of their own):

```sh
! pair auth login PROVIDER
```

They choose the API key if it offers a choice, and paste the key at the prompt; nothing is shown. Expected:
`Stored the API key of PROVIDER in ~/.config/pairing-buddy/auth.json. …`. Check it: `pair auth list | grep -w
PROVIDER` shows `✓ PROVIDER  key stored` (a `not set` there means the login did not finish: ask the human to run it
again). Then pick a model with the human from `pair auth models PROVIDER`:

```jsonc
"model": {"provider": "PROVIDER", "model": "a-model-id"}
```

A provider entry takes no `api`, `baseUrl` or key fields: its key always comes from `pair auth login` (the service
does not see a key in your shell's environment).

**c. A subscription login.** The same as b., but at `pair auth login PROVIDER` the human chooses the subscription,
reads the terms line it prints, and signs in in the browser (on a machine without one, the copy-code or device-code
login where offered). Never start this login for them, and never reuse another tool's login. Check it:
`pair auth list | grep -w PROVIDER` shows `✓ PROVIDER  logged in; the token renews itself …`. Then the same
`"model": {"provider": "PROVIDER", "model": "…"}`. Keep the Watcher off the subscription if the human agrees:

```jsonc
"models": {
  "watcher": {"api": "openai", "baseUrl": "http://localhost:8080/v1", "model": "a-small-model"},
  "partner": {"provider": "PROVIDER", "model": "a-model-id"}
}
```

(and remove the `"model": {…}` object, since only one of the two may be set). `pair doctor` warns when the Watcher
runs on a subscription.

**An endpoint with a key in an environment variable** (`"apiKeyEnv": "NAME"` in an `api`/`baseUrl` entry): the
service does not see the shell's variables, so run `pair setup </dev/null` again after the edit, in a shell where
the variable is set. It stores it, readable by the human only, in `service.env` next to the config. Expected:
`Stored NAME for the service in ~/.config/pairing-buddy/service.env, readable by you only.`

The model's other fields (`contextWindow`, `thinking`, `compat`, …) are in [config.md](docs/config.md#model-entries);
picking models is in [models.md](docs/models.md). A failing models line names its fix; the usual ones are in
[step 8](#step-8-verify).

## Step 7: The Neovim plugin

### 7.1 Find the Neovim config and its plugin manager

**Run:**

```sh
cfg=$(nvim --headless --clean -c 'lua io.stdout:write(vim.fn.stdpath("config"))' -c 'qa!' 2>/dev/null); echo "config=$cfg"
ls "$cfg"/init.lua "$cfg"/init.vim 2>/dev/null
found() { grep -rlsE "$2" "$cfg" | sed "s|^|$1: |"; }
found lazy.nvim "folke/lazy.nvim|require\\(['\"]lazy['\"]\\)"
found packer "wbthomason/packer|require\\(['\"]packer['\"]\\)"
found vim-plug "plug#begin"
found mini.deps "mini\\.deps|MiniDeps"
found vim.pack "vim\\.pack\\.add"
found pair "makefunstuff/pairing-buddy|require\\(['\"]pair['\"]\\)"
```

`$cfg` is usually `~/.config/nvim` (`$XDG_CONFIG_HOME/nvim`, or `$NVIM_APPNAME`'s). Each `name: file` line is a file
that uses that manager. Pick:

- A `pair:` line: Pair is in the config already. Skip to 7.3.
- Lines of exactly one manager: use that manager's section in 7.2. LazyVim and other lazy.nvim distributions are
  lazy.nvim.
- Lines of more than one manager: **ask the human** which one their config really uses.
- None, but an `init.lua` or `init.vim`: **native packages**.
- No `init.lua` and no `init.vim`: there is no config yet. Use **native packages**, and create `$cfg/init.lua`.

Before you edit a file, back it up next to itself, keeping an older backup: `[ -e FILE.bak-pair ] || cp FILE
FILE.bak-pair`. Edit only what the section says.

### 7.2 Add Pair

**lazy.nvim.** If the config imports a folder of specs (`{import = "plugins"}`, or LazyVim), make a new file
`$cfg/lua/plugins/pair.lua` (that folder, by its name in the import):

```lua
return {
  'makefunstuff/pairing-buddy',
  main = 'pair',
  lazy = false,
  opts = {auto_connect = true},
}
```

Otherwise add the table without `return` to the list of specs in `require('lazy').setup({...})`, as one more item.
Then install it: `nvim --headless '+Lazy! sync' +qa`.

**packer.nvim.** Inside the function given to `require('packer').startup(…)`, add:

```lua
use {'makefunstuff/pairing-buddy', config = function() require('pair').setup({auto_connect = true}) end}
```

Then install it: `nvim --headless -c 'autocmd User PackerComplete quitall' -c 'PackerSync'`.

**vim-plug.** Between `call plug#begin(…)` and `call plug#end()` (in Lua: `vim.call('plug#begin')` …
`vim.call('plug#end')`), add one line:

```vim
Plug 'makefunstuff/pairing-buddy'
```

(in Lua: `vim.fn['plug#']('makefunstuff/pairing-buddy')`), and after `plug#end` the setup, in `init.vim`
`lua require('pair').setup({auto_connect = true})`, in `init.lua` `require('pair').setup({auto_connect = true})`.
Then install it: `nvim --headless +PlugInstall +qa`.

**mini.deps.** After the config's `MiniDeps` setup, add:

```lua
MiniDeps.add({source = 'makefunstuff/pairing-buddy'})
require('pair').setup({auto_connect = true})
```

mini.deps clones it the next time Neovim starts: `nvim --headless +qa`.

**vim.pack** (Neovim 0.12's own manager). Next to the config's other `vim.pack.add`, add:

```lua
vim.pack.add({'https://github.com/makefunstuff/pairing-buddy'})
require('pair').setup({auto_connect = true})
```

It clones it the next time Neovim starts: `nvim --headless +qa`.

**Native packages** (no plugin manager, or no config yet). Clone it into Neovim's package folder, or update it if it
is there:

```sh
dir=$(nvim --headless --clean -c 'lua io.stdout:write(vim.fn.stdpath("data"))' -c 'qa!' 2>/dev/null)/site/pack/pair/start/pairing-buddy
if [ -d "$dir/.git" ]; then git -C "$dir" pull --ff-only; else git clone --depth 1 https://github.com/makefunstuff/pairing-buddy "$dir"; fi
```

Then add one line at the end of `$cfg/init.lua` (create the folder and file if there is none):

```lua
require('pair').setup({auto_connect = true})
```

or, in an `init.vim`: `lua require('pair').setup({auto_connect = true})`.

### 7.3 Check the plugin

**Check:**

```sh
pair doctor 2>&1 | grep -E '^[^ ]+ plugin '
```

Expected: `✓ plugin   your Neovim config loads it`. If it says `does not load the plugin`, run
`nvim --headless -c 'lua print(pcall(require, "pair"))' -c 'qa!'` to see the error; usually the plugin is not
installed yet (run the manager's install command again) or the edit went into a file the config does not load. Also
start `nvim --headless +qa` once and make sure it prints no error that was not there before your edit; if it does,
put the backup back and try again.

### 7.4 The statusline (optional, recommended)

Pair shows its state in the statusline (`● pair`, `⠹ pair · thinking`, `✗ 1 failing · TestX`). Look for how the
config draws the statusline, and add Pair there:

- **lualine:** add `function() return require('pair').status() end` to a section, for example
  `sections = {lualine_x = {function() return require('pair').status() end, 'encoding', 'fileformat', 'filetype'}}`
  (keep the section's items that are already there).
- **A `statusline` option of its own:** add `%{%v:lua.require'pair'.statusline()%}` where the human wants it, for
  example before the position.
- **Neither:** `vim.o.statusline = "%f %m%=%{%v:lua.require'pair'.statusline()%}  %l:%c "` in `init.lua`.

Ask the human if the config has another statusline plugin; `require('pair').status()` returns plain text for any.

### 7.5 Tell the human the keys

Pair maps its keys only while there is something for them to do, and never over a mapping of the human's own:

| Key | What it does |
| --- | --- |
| `Alt-j` | Go where Pair points (`Ctrl-O` comes back), or show a held remark now |
| `Alt-y` | Take Pair's suggested change, as your own edit |
| `Alt-u` / `Alt-n` | Tell Pair its last remark was useful / noise; this tunes when it speaks |
| `Alt-?` | The idea behind Pair's words under your line |
| `Alt-t` (hold) | Ask aloud, once push-to-talk is set up |
| any key | Take the wheel back while Pair drives |

And the commands: `:Pair ask <question>`, `:Pair drive <what>` to hand over the keyboard for one change,
`:Pair chat` for the chat without herdr, `:Pair end` to end the session. All keys, options and commands are in
[the plugin reference](docs/neovim-plugin.md).

## Step 8: Verify

### 8.1 `pair doctor`

**Run:**

```sh
pair doctor; echo "exit=$?"
```

Done when it ends with `exit=0` (no check failed, so no `✗` line) and the only `!` lines are among these, which are
expected and fine on a fresh setup:

- `! service  no systemd or launchd here …` (service: none)
- `! neovim   none connected …` (no Neovim is open; 8.2 connects one)
- `! herdr    not installed …` or `not checked here …` (without herdr, or not run inside it)
- `! pane     no sandbox …` (no bubblewrap, or it cannot run here)

Fix any other line and run it again, until `exit=0`:

| Line | Fix |
| --- | --- |
| `✗ config  No config at …` / `is not valid JSON` | Run `pair setup </dev/null` / fix the edit from step 6, or put back `config.json.bak` |
| `! config  … still has the example's model names` | Step 6 |
| `✗ daemon  nothing answers on …` | `pair setup </dev/null` again, then the logs from step 5 |
| `! daemon  it runs version …` | `pair setup </dev/null` (it restarts the service on the new code). Service none: run the `kill …` the line names, then `pair setup </dev/null` |
| `✗ service  it runs Node.js from …, which is gone` | Node.js moved or was upgraded: `pair setup </dev/null` |
| `✗ service  installed but not running` | The logs from step 5, then `pair setup </dev/null` |
| `✗ plugin  …` | Step 7.3 |
| `✗ models` / `watcher` / `partner`  `nothing answers at …` | The local server is not running, or the base URL is wrong (check with `curl` as in step 6a) |
| `… does not serve "…"; it lists: …` | Use one of the listed ids as `"model"` |
| `… no login or key for PROVIDER` / `has expired or was revoked` | The human runs `! pair auth login PROVIDER` again |
| `✗ keys  NAME is not set` | Set it in the shell and run `pair setup </dev/null`, or use `pair auth login` and `"auth"` |
| `✗ logins …`, `✗ keys … others can read it` | `chmod 600` the file it names |
| `! watcher  the Watcher runs on your … subscription` | Step 6c: a local or pay-per-use Watcher, if the human agrees |
| `! watcher … takes 2.4 s` | Fine to start with; a smaller Watcher model is faster ([models.md](docs/models.md)) |
| `! thinking …` | On a local server: `pair doctor --thinking` prints a `"compat"` block to add to the model entry |
| `! context …` | Its text names the field; see [config.md](docs/config.md#model-entries) |
| `✗ voice …` | Step 9, or remove `"voice"` from the config |

What every line means: [troubleshooting.md](docs/troubleshooting.md).

### 8.2 A smoke test in Neovim

This starts a Neovim without a screen in a scratch project, connects it to the daemon, asks one question and prints
the start of the answer. It asks the real model once.

**Run:**

```sh
mkdir -p ~/pair-smoke && cd ~/pair-smoke && git init -q 2>/dev/null
printf 'def add(a, b):\n    return a - b\n' > calc.py
cat > smoke.lua <<'EOF'
local pair = require('pair')
local out = function(text) io.stdout:write(text .. '\n') end
vim.cmd('Pair start smoke test')
if not vim.wait(10000, function() return pair.status() ~= '' end, 200) then out('not connected'); vim.cmd('cquit 1') end
out('status: ' .. pair.status())
vim.cmd('Pair ask Is there a bug in this file? One sentence.')
-- Pair's words are virtual text: a note after the line it points at, or lines under the line you are on.
local ns, said = require('pair.draw').ns, nil
vim.wait(180000, function()
  for _, mark in ipairs(vim.api.nvim_buf_get_extmarks(0, ns, 0, -1, {details = true})) do
    for _, chunks in ipairs(mark[4].virt_lines or {mark[4].virt_text}) do
      local text = table.concat(vim.tbl_map(function(chunk) return chunk[1] end, chunks)):gsub('^%s+', '')
      if text ~= '' then said = (said and said .. ' ' or '') .. text end
    end
  end
  return said ~= nil
end, 500)
out('answer: ' .. (said or '(none within 3 minutes)'))
vim.cmd(said and 'qall!' or 'cquit 1')
EOF
nvim --headless calc.py -S smoke.lua; echo "exit=$?"
cd ~ && rm -rf ~/pair-smoke
```

Expected:

```
status: ● pair
answer: ● …   # Pair's words, for example "● should be a + b"
exit=0
```

- `not connected`: the daemon is not running (`pair doctor`, step 5), or the plugin's socket differs from the
  daemon's (`"socket"` in the config without the same `socket` in the plugin's setup).
- `(none within 3 minutes)`: the model did not answer; `pair doctor` names the models' state, and the daemon's log
  (step 5) the error.

### 8.3 Hand over to the human

Tell the human how to start:

- **With herdr:** open Neovim in a project in one pane, and run `pair` in the pane next to it: the chat opens on the
  right.
- **Without herdr:** open Neovim in a project (in tmux, if they use it), and run `:Pair chat` there for the chat; or
  skip the chat, a Neovim alone is a whole session.
- The statusline shows `● pair` once it is connected. `:Pair ask what does this function do?` asks something; the
  answer starts under the line. Pair says little unasked, which is on purpose.

## Step 9: Optional parts

Only those the human chose in step 2.

**herdr.** Installed in 3.6. Run `pair doctor` inside a herdr pane; expected `✓ herdr    answers in … ms, … panes in
this workspace`. Nothing to configure: `pair` in a herdr pane opens the chat beside it. The work board
(`herdr-projects`) and its goal for the branch are read when its command is on `PATH` ([agents.md](docs/agents.md)).

**The shell hook.** It tells Pair each command you run and its exit code. **Check:** `grep -s 'pair shell-hook' "$rc"`
(`rc` from step 3.1; for fish, `~/.config/fish/config.fish`). **Do**, if it prints nothing, back up the rc file and add one line at its end:

```sh
eval "$(pair shell-hook bash)"   # in ~/.bashrc
eval "$(pair shell-hook zsh)"    # in ~/.zshrc
pair shell-hook fish | source    # in ~/.config/fish/config.fish
```

It takes effect in new shells: `bash -ic 'type _pair_precmd >/dev/null && echo hook-ok' 2>/dev/null` (or `zsh -ic`)
prints `hook-ok`.

**Scout's sandbox.** With bubblewrap installed, `pair doctor` shows `✓ pane  commands run in a bubblewrap sandbox,
network off`. If bubblewrap cannot run here, it says so; then `"scoutPane": {"sandbox": false}` in the config
silences the warning (commands then run unsandboxed, after the command policy).

**Push-to-talk.** Follow [voice.md](docs/voice.md#setup): build whisper.cpp for the CPU, a recorder (`pw-record`,
`parec` or `arecord`), and a `"voice"` entry in the config. Expected: `✓ voice  pw-record records, whisper.cpp hears
a second in … s on the CPU`.

## Upgrade

```sh
npm install -g github:makefunstuff/pairing-buddy
pkill -f 'pair[.]mjs supervise'   # service none only: stops the old daemon (the brackets keep pkill off this shell)
pair setup </dev/null
```

Then update the plugin with its manager:

| Manager | Command |
| --- | --- |
| lazy.nvim | `nvim --headless '+Lazy! sync' +qa` |
| packer | `nvim --headless -c 'autocmd User PackerComplete quitall' -c 'PackerSync'` |
| vim-plug | `nvim --headless +PlugUpdate +qa` |
| mini.deps | `nvim --headless -c 'lua MiniDeps.update(nil, {force = true})' +qa` |
| vim.pack | `nvim --headless -c 'lua vim.pack.update(nil, {force = true})' +qa` |
| native packages | the clone-or-pull command from 7.2 |

Then `pair doctor`. Run `pair setup </dev/null` again after every Node.js upgrade too: the service names the Node.js
binary it runs, and the shell hook names it too (new shells pick that up by themselves).

## Uninstall

Ask the human before each part that deletes something of theirs.

```sh
pair uninstall                    # stops and removes the service; keeps the config and data
pkill -f 'pair[.]mjs supervise'   # service none only: stops the daemon
npm uninstall -g pairing-buddy
```

Expected: `Removed pairing-buddy.service. …` (systemd), `Removed the launchd agent io.github.makefunstuff.pairing-buddy.
…` (launchd) or `No service is installed.` (none); then `removed … packages`, and `command -v pair` prints nothing.

Then remove what step 7 added to the Neovim config (the spec file, the lines, or the cloned folder; the `.bak-pair`
backups show what was there before), and the shell hook line from step 9. With the human's yes, the config, logins
and data: `~/.config/pairing-buddy/` (holds `auth.json` with their logins and keys) and
`~/.local/state/pairing-buddy/` (the sessions and their notes).
