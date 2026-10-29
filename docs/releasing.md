---
description: "How to cut a pairing-buddy release: pick the version, bump it, write the changelog entry, tag the merge commit and create the GitHub release."
---

# Releasing

A release is a version in `package.json`, an entry in [CHANGELOG.md](../CHANGELOG.md), a tag `vX.Y.Z` on `main` and a
GitHub release with that entry as its notes. Pair is installed from GitHub (`npm install -g
github:makefunstuff/pairing-buddy`), so nothing is published to npm.

## 1. Pick the version

By [semver](https://semver.org/), from what merged since the last tag
(`git log --oneline vX.Y.Z..main`). Before 1.0:

- new features, or a change to config or commands: the next minor, `0.12.0`. Say in the entry's **Upgrade notes**
  what a user has to change, such as a default that moved or a key that is refused;
- only fixes: the next patch, `0.11.1`.

## 2. Bump it, on a branch

The version is written in `package.json`, and the code reads it from there: the daemon's startup line
(`pair daemon 0.11.0 listening on …`), `pair --version`, `pair doctor`'s daemon line and the version in the site's
nav. The lock file repeats it, so bump both with npm:

```sh
npm version 0.12.0 --no-git-tag-version
```

The docs show the version too: the README's "Version 0.11" line, and examples in
[Troubleshooting](troubleshooting.md) (`pair doctor`'s output) and INSTALL.md (`npm ls -g` and `pair doctor`). Update
those as well. `git grep -nE '\b0\.11\b' -- ':!*package-lock.json' ':!CHANGELOG.md'` finds them, in both the
`0.11` and the `0.11.0` form (some hits, such as a Neovim version, are not Pair's).

## 3. Write the changelog entry

In [CHANGELOG.md](../CHANGELOG.md) ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)), move what is under
`## [Unreleased]` into a new `## [0.12.0] - YYYY-MM-DD` entry, or write it from the merged pull requests:

```sh
gh pr list --state merged --base main --limit 100 --json number,title,mergedAt \
  --jq '.[] | select(.mergedAt > "2026-10-29") | "#\(.number) \(.title)"'
```

Group them under `### Added`, `### Changed` and `### Fixed`, one line per change in the user's words, each with a link
to its pull request. Use full `https://github.com/...` links, as the entry becomes the release's notes and a relative
link leads nowhere there. Add the link line at the bottom, `[0.12.0]: .../releases/tag/v0.12.0`, and move
`[Unreleased]` to compare from the new tag. No personal paths, hostnames, addresses or keys.

`npm test` then checks that `package.json`, `package-lock.json` and `pair --version` agree, and that the changelog has
a dated entry for the version with only full links (`test/version.test.mjs`). Open the pull request.

## 4. Tag and release, after the merge

Tag the merge commit on `main`, unsigned, and create the release with the entry as its notes:

```sh
git switch main && git pull
git tag -a v0.12.0 -m "pairing-buddy 0.12.0" --no-sign
git push origin v0.12.0
awk '/^## \[0\.12\.0\]/{on=1; next} /^## \[/{on=0} on' CHANGELOG.md > /tmp/notes.md
gh release create v0.12.0 --title "pairing-buddy 0.12.0" --notes-file /tmp/notes.md --verify-tag
```

## 5. Update an install

```sh
npm install -g github:makefunstuff/pairing-buddy
systemctl --user restart pairing-buddy   # macOS, or no service: pair setup </dev/null
pair --version
journalctl --user -u pairing-buddy -n 5  # pair daemon 0.12.0 listening on …
```

`pair doctor` says so when the running daemon is older than the installed `pair`. Update the Neovim plugin with its
manager too ([INSTALL.md](../INSTALL.md#upgrade)).
