# Contributing to pairing-buddy

Thanks for helping. Bug reports, ideas, docs fixes and pull requests are all welcome. This page says how to run Pair
from a clone, how to test a change, and what a good issue or pull request looks like.

By contributing, you agree that your contribution is licensed under the project's [MIT License](LICENSE), the same
as the rest of the code. Don't submit code or media you can't license that way; if you add a third-party file (a
font, a vendored script, a sample), say so in the pull request and add it to
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with its licence.

## Set up a dev environment

You need Node.js 22.19+, Neovim 0.11+ and git. For the whole test suite also bash and tmux (zsh and fish are tested
where installed); for the docs site nothing more than Node.js. [herdr](https://herdr.dev) is optional: everything
runs without it.

```sh
git clone https://github.com/makefunstuff/pairing-buddy
cd pairing-buddy
npm ci
npm test
```

The project is plain JavaScript (ES modules, no build step) for the daemon and the CLI in `src/` and `bin/`, and Lua
for the Neovim plugin in `lua/` and `plugin/`. [How it works](docs/how-it-works.md) is the map: the daemon, its
models, the roles and how the plugin talks to it.

## Run the daemon and the plugin from a clone

**As your everyday Pair.** `npm link` in the clone puts its `pair` on your PATH, and `pair setup` then installs the
service with the clone's code; point lazy.nvim at the clone with `dir = '/path/to/clone'` in place of
`'makefunstuff/pairing-buddy'` ([install.md](docs/install.md#install)). After a change to the daemon, restart it
(`systemctl --user restart pairing-buddy` on Linux, or run `pair setup` again); after a change to the plugin, restart
Neovim.

**Next to an installed Pair.** One daemon owns a data folder, so give the dev daemon its own config with its own
`socket` and `dataDir` ([configuration](docs/config.md)), and reuse your logins and keys with `PAIR_AUTH`:

```sh
mkdir -p ~/.config/pairing-buddy-dev
cp config.example.json ~/.config/pairing-buddy-dev/config.json
# in it: your models, plus "socket": "/tmp/pair-dev.sock" and "dataDir": "/path/to/pair-dev-state"
export PAIR_CONFIG=~/.config/pairing-buddy-dev/config.json PAIR_AUTH=~/.config/pairing-buddy/auth.json
node bin/pair.mjs daemon      # the daemon in the foreground, its log on the terminal
node bin/pair.mjs doctor      # in another shell with the same variables
```

Then start a Neovim that loads the clone's plugin and talks to that socket. `--clean` leaves out your own config, so
an installed copy of the plugin does not load as well:

```sh
PAIR_SOCKET=/tmp/pair-dev.sock nvim --clean --cmd 'set rtp^=/path/to/clone' \
  --cmd 'lua require("pair").setup({auto_connect = true})' path/to/a/file/in/a/project
```

`node bin/pair.mjs chat` (with the same `PAIR_CONFIG`) opens the chat in a terminal, or `:Pair chat` in that Neovim.
Without a model you can still work on most things: the model-free tests below script the models.

## Run the tests

**Model-free suite.** `npm test` runs every test that needs no model, in a minute or two, with scripted models and
fakes of herdr and the providers. Tests that need Neovim, tmux, zsh or fish skip themselves when those are not
installed, and say so. `npm run check` runs the same suite. No CI runs on pull requests yet, so run it yourself
before you open one. Run one file with `node test/run.mjs test/gate.test.mjs`.

**Live tests with your own model.** These run the same decisions against real models and are skipped unless you
point them at a stack file:

```sh
PAIR_LIVE_CONFIG=/path/to/stacks.json npm run test:live
```

```json
{"stacks": [{"name": "local", "watcher": {"api": "openai", "baseUrl": "http://localhost:8080/v1", "model": "your-small-model"}, "partner": {"api": "openai", "baseUrl": "http://localhost:8080/v1", "model": "your-larger-model"}}]}
```

A stack may name a `provider` with a key from `pair auth` instead. `test/live/config.json` is read too and is
gitignored, so a local file there never gets committed. Live results vary from run to run; say in your pull request
which stack you ran and what passed. [Tests](docs/testing.md) lists what each suite covers.

Every change comes with tests in the model-free suite: a fake or a scripted model rather than a real one. Tests clean
up their temporary folders and must not touch your real config, data or running daemon.

**The docs site.** `cd site && npm ci && npm run dev` previews it; `npm run build && npm run check` builds it and
checks every page's link-preview tags, as the Pages workflow does.

## Code style

Match the code around you; there is no formatter or linter to run.

- JavaScript: ES modules, two-space indent, single quotes, semicolons, `const` by default. Node's standard library
  over new dependencies: a new runtime dependency needs a good reason in the pull request.
- Lua: two-space indent, `local` everything, Neovim 0.11 APIs (`vim.api`, `vim.fn`).
- Each file starts with a comment that says what it is for. Comments say why, not what; a function that is not
  obvious gets a one-line `/** ... */`.
- Names and messages in plain words. What Pair says to the user follows [its tone](docs/tone.md): short, specific,
  never chatty.
- Pair never writes the user's files. A change that would save a buffer or write to disk on the user's behalf will
  not be merged.
- Keep personal paths, hostnames, IP addresses, emails and keys out of code, tests, docs, captures and commit
  messages. Use `/path/to/...`, `localhost` and `example.com`.

## Report a bug

Open an issue with the **Bug report** template. Please include:

- The output of `pair doctor` (its daemon line names the version). Look it over first and replace any home path,
  hostname or address you'd rather not share.
- Your editor setup: Neovim version, plugin manager, and whether you run Pair in herdr, tmux or Neovim alone.
- Your model setup: the provider or server and the model for the Watcher and the Partner (never the key).
- What you did, what you expected, and what happened. A short log from `pair daemon` in the foreground or a
  screenshot helps.

Check [Troubleshooting](docs/troubleshooting.md) and [Known limitations](docs/limitations.md) first: your problem
may have a fix or an open issue already. For a security problem, don't post the details in public: open an issue
that only asks for a private way to send them.

## Propose a feature

Open an issue with the **Feature request** template before you write a lot of code. Say what you were doing, what
you wanted Pair to do, and why it matters to you. Pair speaks rarely and never writes your files on purpose, so ideas
that keep that are the easiest to take.

## Open a pull request

1. Fork, branch from `main`, and keep the pull request to one change.
2. Add or update tests, and run `npm test`.
3. Update the docs in the same pull request: `docs/*.md` (the docs site is built from them), the README, and
   `config.example.json` for anything you add, remove or change: features, commands, config keys and defaults,
   keys, behaviour, limitations. A change is not done while the docs disagree with the code.
4. Write a clear title and say what changed, why, and how you tested it (which live stack, if any). Link the issue.
5. Fill in the checklist in the pull request template.

Small fixes (typos, a broken link) can go straight to a pull request.

## How the project is built, and AI agents

Much of pairing-buddy is written by AI coding agents working from issues, each in its own branch, with a human
reviewing every pull request. You don't need any of that tooling to contribute. Two things from it help anyone:

- An issue that says what should happen, how to check it, and what the docs should then say makes a good task for a
  person or an agent alike.
- If you use an AI agent on a change, you are still its author: read the diff, run the tests, and make sure it meets
  this page. [INSTALL.md](INSTALL.md) is a step-by-step setup guide written for an agent, if you'd like yours to
  install Pair for you.
