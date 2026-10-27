# pairing-buddy

A pair programmer for Neovim that knows when to speak.

Pair is a Neovim plugin and a daemon that work next to you like a colleague in the second chair: it watches you code,
says one short line under your cursor when it spots something, runs the tests you would skip, and takes the keyboard
only when you hand it over. It is not code completion and not a chat sidebar, and it never writes your files: its
edits land unsaved in your buffer as one undo step, and the disk changes only when you save.

**Docs: [makefunstuff.github.io/pairing-buddy](https://makefunstuff.github.io/pairing-buddy/)** (source in
[`docs/`](docs/), built from [`site/`](site/)).

https://github.com/user-attachments/assets/d723d090-0b41-45b0-83df-e57fda572562

*The tutorial, 13 minutes with a voiceover and captions, one idea per scene, recorded live with a real model.
Chapters: 0:00 what Pair is · 0:59 setup and `pair doctor` · 2:44 the roles · 4:19 exploring code · 5:19 tests · 6:42
notes and the blank page · 9:12 the hand-over · 10:50 voice · 11:36 with or without herdr · 12:12 the keys to
remember. Its script and how to render it again are in [docs/video](docs/video/).*

Version 0.9.

## Why

Most AI coding tools sit beside your work: you stop, describe the problem, and read a long answer. A good human pair
does something else. They notice when you start fixing the wrong file, run the tests you would skip, keep quiet while
you think, and take the keyboard only when you hand it over. Pair aims for that:

- **It speaks rarely.** A small, fast model, the Watcher, scores each moment first, and most moments are not worth a
  word. On a slow server Pair skips the moments you can see on screen, and still asks
  about the ones you cannot ([watcher](docs/watcher.md#when-the-server-is-slow)). An optional
  [decision model](docs/decision.md) (a classifier such as TypeSafe's Jev or Cloudflare's Clef) can sort the moments
  first and say, with a probability, whether one is worth interrupting you for. Remarks that can wait are held until your next break.
- **It shows, in place.** Its words appear under the line you are on, it points at the line it means, and a suggested
  change is one key to take.
- **It runs what you'd skip.** Save, and it runs the project's tests and tells you what your fix broke elsewhere.
- **You stay in charge.** One role at a time: Navigator points and suggests, Scout also runs commands in its own pane,
  and the Driver edits only when you hand over, while you watch. Any key takes the wheel back.

## Quick start

You need Node.js 22.19+, Neovim 0.11+, and a model: a local OpenAI-compatible server, an API key for any provider
[pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) supports, or a subscription login where the provider
allows it. [herdr](https://herdr.dev) is the best home for Pair; without it, everything runs inside Neovim and
tmux.

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
[Getting started](docs/getting-started.md) walks through it. Optionally add the
[shell hook](docs/cli.md#pair-shell-hook) (`eval "$(pair shell-hook bash)"`, or zsh, or fish) to your shell's rc file:
Pair then gets every command you run, with its exit code, from the shell itself, and in zsh your typing too.

**Let your AI agent set it up.** Tell your coding agent "follow
https://github.com/makefunstuff/pairing-buddy/blob/main/INSTALL.md": [INSTALL.md](INSTALL.md) takes it from a fresh
machine to a passing `pair doctor`, step by step with checks, and asks you where only you can answer (which model,
your keys and logins).

## Documentation

- [Getting started](docs/getting-started.md) and [install and daily use](docs/install.md)
- [How it works](docs/how-it-works.md), [roles](docs/roles.md) and [workflows](docs/workflows.md)
- [Models and providers](docs/models.md): local servers, API keys, subscription logins, one model for both roles,
  and the optional [decision model](docs/decision.md)
- Reference: [configuration](docs/config.md), [Neovim plugin](docs/neovim-plugin.md), [commands](docs/cli.md)
- [Troubleshooting](docs/troubleshooting.md) and [known limitations](docs/limitations.md)
- [Data and privacy](docs/data.md), [tests](docs/testing.md)
- [Contributing](CONTRIBUTING.md), also [on the site](docs/contributing.md)

The site is [VitePress](https://vitepress.dev): `cd site && npm ci && npm run dev` previews it, and the
[Pages workflow](.github/workflows/pages.yml) builds and deploys it on every push to main. Its look is pixel art:
the palette (PICO-8's 16 colours) and the fonts (Pixelify Sans for headings and labels, Inter for text) are in
[`site/.vitepress/theme/tokens.css`](site/.vitepress/theme/tokens.css), and the sprites, the favicon and the PNG icons
(with the web manifest) are drawn as pixel grids in [`site/sprites/build.mjs`](site/sprites/build.mjs)
(`npm run sprites` redraws them).

A shared link shows the page's own title and description: a docs page's `description` from its frontmatter, or else its
first paragraph, cut to 155 characters ([`site/.vitepress/meta.mjs`](site/.vitepress/meta.mjs)). Give a page a
`description` when it opens with a list, a heading or a code block. The preview image, `site/public/og-v2.png`
(1200x630), is [`site/og/card.html`](site/og/card.html): `npm run og` redraws it with a headless Chrome or Chromium,
and the PNG is committed. X caches card images by URL, so a changed design goes out under a new file name (change it
in `site/og/build.mjs` and `meta.mjs`); otherwise X keeps showing the old image.
After `npm run build`, `npm run check` checks every built page has the full set of tags with absolute URLs (the Pages
workflow runs it before it deploys), and `node og/previews.mjs OUT` renders mock X, Slack and Discord previews of the
built pages into `OUT/previews.png`.

## Contributing and license

Bug reports, ideas and pull requests are welcome: [CONTRIBUTING.md](CONTRIBUTING.md) says how to run Pair from a
clone, run the tests, report a bug (with `pair doctor` output) and open a pull request.

pairing-buddy is under the [MIT License](LICENSE). The fonts, a vendored animation library and a colorscheme used by
the site and the video keep their own licences: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
