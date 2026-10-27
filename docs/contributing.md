---
description: "How to contribute to pairing-buddy: run it from a clone, run the tests, report bugs with pair doctor, propose features, open pull requests."
---

# Contributing

pairing-buddy is open source under the
[MIT License](https://github.com/makefunstuff/pairing-buddy/blob/main/LICENSE), and contributions are welcome: bug
reports, ideas, docs fixes and pull requests. Everything you contribute is under the same licence. The full guide is
[CONTRIBUTING.md](../CONTRIBUTING.md); this page is the short version.

## Run it from a clone

You need Node.js 22.19+ and Neovim 0.11+ (bash and tmux too for the whole test suite).

```sh
git clone https://github.com/makefunstuff/pairing-buddy
cd pairing-buddy
npm ci
npm test
```

`npm link` then `pair setup` makes the clone your everyday Pair, and `dir = '/path/to/clone'` in the lazy.nvim spec
loads its plugin ([install](install.md#install)). To run a dev daemon next to an installed Pair, give it a config of its
own with its own `socket` and `dataDir`, and start it with `PAIR_CONFIG=... node bin/pair.mjs daemon`;
[CONTRIBUTING.md](../CONTRIBUTING.md#run-the-daemon-and-the-plugin-from-a-clone) has the commands, also for a Neovim
that loads the clone's plugin.

## Tests

- `npm test`: the model-free suite, with scripted models and fakes of herdr and the providers. Every change comes
  with tests here.
- `PAIR_LIVE_CONFIG=/path/to/stacks.json npm run test:live`: the live tests, against your own models.

[Tests](testing.md) says what each suite covers and the stack file's format.

## Report a bug

Use the [bug report form](https://github.com/makefunstuff/pairing-buddy/issues/new?template=bug_report.yml). It asks
for the output of `pair doctor`, your editor setup (Neovim version, plugin manager, herdr, tmux or Neovim alone) and
your model setup (provider or server and models, never keys). Remove home paths and hostnames before you paste.
[Troubleshooting](troubleshooting.md) and [known limitations](limitations.md) may already have your answer.

## Propose a feature

Use the [feature request form](https://github.com/makefunstuff/pairing-buddy/issues/new?template=feature_request.yml):
the moment in your work when you wanted it, what Pair would do, and why it matters. Ideas that keep Pair quiet and
keep your files yours fit best.

## Pull requests

Branch from `main`, keep a pull request to one change, add tests, and run `npm test`. Update the docs in the same pull
request: these pages in `docs/`, the README and `config.example.json`, for anything you add, remove or change. The
pull request template has the checklist. Files from elsewhere (a font, a vendored script) go in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) with their licence.
