# pairing-buddy

A pair programmer for Neovim that knows when to speak.

Pair is a Neovim plugin and a daemon that work next to you like a colleague in the second chair: it watches you code,
says one short line under your cursor when it spots something, runs the tests you would skip, and takes the keyboard
only when you hand it over. It is not code completion and not a chat sidebar, and it never writes your files: its
edits land unsaved in your buffer as one undo step, and the disk changes only when you save.

**Docs: [makefunstuff.github.io/pairing-buddy](https://makefunstuff.github.io/pairing-buddy/)** (source in
[`docs/`](docs/), built from [`site/`](site/)).

https://github.com/user-attachments/assets/b4e38d1e-9e9d-4c28-a3fd-4dce40bd11a8

*The six-minute tour, with captions. Chapters: 0:00 why · 0:38 getting started · 1:34 exploring code · 3:04 tests ·
3:37 notes and the blank page · 4:20 handing over · 4:53 the day around it · 5:25 and the rest · 5:47 the keys. Its
script and how to render it again are in [docs/video](docs/video/).*

Version 0.9.

## Why

Most AI coding tools sit beside your work: you stop, describe the problem, and read a long answer. A good human pair
does something else. They notice when you start fixing the wrong file, run the tests you would skip, keep quiet while
you think, and take the keyboard only when you hand it over. Pair aims for that:

- **It speaks rarely.** A small, fast model, the Watcher, scores each moment first, and most moments are not worth a
  word. Remarks that can wait are held until your next break.
- **It shows, in place.** Its words appear under the line you are on, it points at the line it means, and a suggested
  change is one key to take.
- **It runs what you'd skip.** Save, and it runs the project's tests and tells you what your fix broke elsewhere.
- **You stay in charge.** One role at a time: Navigator points and suggests, Scout also runs commands in its own pane,
  and the Driver edits only when you hand over, while you watch. Any key takes the wheel back.

## Quick start

You need Node.js 22.19+, Neovim 0.11+, and a model: a local OpenAI-compatible server, an API key for any provider
[pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) supports, or a subscription login where the provider
allows it. [herdr](https://herdr.dev) is the best home for Pair; without it, everything runs inside Neovim.

```sh
npm install -g github:makefunstuff/pairing-buddy   # puts `pair` on your PATH
pair setup                                         # writes the config, offers a login, installs the service
```

Add the plugin with lazy.nvim:

```lua
{
  'makefunstuff/pairing-buddy',
  main = 'pair',
  lazy = false,
  opts = {auto_connect = true},
}
```

Set your model in `~/.config/pairing-buddy/config.json` ([models](docs/models.md)), run `pair doctor` to check every
part, then `pair` in the herdr pane next to Neovim (or `:Pair chat` in Neovim), and work.
[Getting started](docs/getting-started.md) walks through it.

## Documentation

- [Getting started](docs/getting-started.md) and [install and daily use](docs/install.md)
- [How it works](docs/how-it-works.md), [roles](docs/roles.md) and [workflows](docs/workflows.md)
- [Models and providers](docs/models.md): local servers, API keys, subscription logins, one model for both roles
- Reference: [configuration](docs/config.md), [Neovim plugin](docs/neovim-plugin.md), [commands](docs/cli.md)
- [Troubleshooting](docs/troubleshooting.md) and [known limitations](docs/limitations.md)
- [Data and privacy](docs/data.md), [tests](docs/testing.md)

The site is [VitePress](https://vitepress.dev): `cd site && npm ci && npm run dev` previews it, and the
[Pages workflow](.github/workflows/pages.yml) builds and deploys it on every push to main.
