# Scout

As Scout, Pair investigates for you in its own herdr pane: it searches the project, runs the tests, looks at `git log` and `git diff`. Every command is typed into that pane, so you see what runs and what it prints; the result also goes back to the model. Pair never types into your own panes.

Switch with `/scout` and `/navigate` in the chat, or `:Pair scout` and `:Pair navigate` in Neovim. Navigator is the default, and a new session always starts in it.

## Pair's pane

Switching to Scout opens a pane below the chat pane, labelled `pair scout`. It runs `bash --noprofile --norc` with the prompt `scout[N] exit X $ `: `N` counts the commands, `X` is the exit code of the last one. That prompt is how Pair knows that a command ended and how, which herdr cannot tell it (see [herdr.md](herdr.md)). Without rc files your aliases and functions are not there, and `HISTFILE` is empty, so Pair's commands stay out of your shell history.

- One command runs at a time; Pair waits for the next prompt, then reads the output back (at most the last 1000 lines).
- A command still running after two minutes is stopped with Ctrl-C, and the model is told so.
- Each question gets at most four searches or commands. After that the model is told to answer with what it found.
- For a remark nobody asked for, Scout may read and search, but `run` answers "not now".
- Switching back to Navigator, or ending the session, closes the pane. A daemon that restarts finds its pane again by the label.

## The tools

| Tool | What is typed in the pane |
| --- | --- |
| `search(pattern, path?)` | `rg --line-number --no-heading --color never --max-columns 200 --max-count 20 -- '<pattern>' '<path>'` (the path defaults to `.` and must be inside the project), and the model sees the first 50 lines |
| `run(command)` | The command line as given, after the command policy allowed it; the model sees the exit code, the parsed test results and the last 3000 characters of output |

## The command policy

`src/command-policy.mjs` decides, before anything is typed, whether a command line runs, asks you first or is refused. It reads the command line like a shell (quotes, `&&`, `||`, `;`, `|`, redirections) and judges each command in it; the most careful verdict wins.

**Runs at once:**

- Read-only programs: `ls`, `cat`, `head`, `tail`, `wc`, `rg`, `grep`, `fd`, `find`, `tree`, `pwd`, `echo`, `printf`, `which`, `file`, `stat`, `du`, `df`, `diff`, `cmp`, `sort`, `uniq`, `cut`, `tr`, `jq`, `ps` and a few more.
- Git that only reads: `status`, `log`, `diff`, `show`, `blame`, `grep`, `ls-files`, `ls-tree`, `rev-parse`, `rev-list`, `describe`, `shortlog`, `cat-file`, and `branch`, `stash`, `remote`, `tag`, `config`, `reflog` when they only list.
- Tests and builds: `npm`/`pnpm`/`yarn`/`bun` `test` and `run test|build|lint|check|typecheck` (also `test:unit` and the like), `npx vitest|jest|mocha|tsc|eslint`, `cargo test|build|check|clippy|nextest|bench|doc`, `cargo fmt --check`, `go test|build|vet|list`, `pytest`, `python -m pytest|unittest`, `node --test`, `make` with no target or `test`, `check`, `build`, `lint`, `all`.
- Redirections to `/dev/null` and `2>&1`.

**Asks you first** (in the chat; `y` or `yes` allows it, anything else declines, and no answer within a minute declines):

- Programs that write or delete: `rm`, `rmdir`, `mv`, `cp`, `mkdir`, `touch`, `chmod`, `chown`, `ln`, `dd`, `truncate`, `tee`, `patch`.
- Installs: `npm install|i|ci|add|update|uninstall`, `cargo add|install`, `go get|install`, `pip install` and the like.
- Flags that turn a read into a write: `find -delete|-exec`, `sort -o`, `eslint --fix`, `cargo fmt`, `cargo clippy --fix`, `git diff --output`.
- Git that changes your working tree: `checkout`, `switch`, `restore`, `add`, `stash`, `clean`, a new `branch`.
- Writing to a file with `>` or `>>`.
- Anything it cannot see through: command substitution, variables, subshells, background jobs, programs given by path (`./deploy.sh`), interpreters running scripts (`python x.py`, `bash -c`).
- Paths outside the project: absolute paths, `~`, `..`.
- Every program not on the lists above.

Without a chat pane to ask in, the answer is no.

**Refused:**

- Git history: `commit`, `push`, `reset`, `rebase`, `merge`, `cherry-pick`, `revert`, `am`, `pull`, `filter-branch`, `update-ref`. You commit yourself.
- The network: `git fetch`, `git clone`, `curl`, `wget`, `ssh`, `scp`, `rsync`, `nc`, `npm publish`, `cargo publish`.
- Root: `sudo`, `su`, `doas`.
- Interactive programs that would wait for keys: `less`, `more`, `vim`, `nano`, `top`, `man`, `watch`.
- More than one line, and an empty command.

The pane is not a sandbox. An allowed test run can write what tests write, and a read-only program can still read any file inside the project.

## Test results

The output of every test run, yours or Scout's, is parsed for the runner, the failed tests and the first error line (`src/test-output.mjs`):

| Runner | Recognised by | Failed tests | First error |
| --- | --- | --- | --- |
| cargo test | `test result:` | `test x ... FAILED` lines | The panic message, `left`/`right` and its location |
| go test | `--- FAIL:`, `ok`/`FAIL` package lines | `--- FAIL:` names (subtests rather than their parents) | The first line under the first failure, or the compiler error |
| jest | `Tests: ... total` | `●` headers | The first line under the first header, with `Expected`/`Received` and the location |
| vitest | `Tests  ... (N)` | `FAIL` lines | The error under the first `FAIL`, with its location |
| pytest | the `=== ... in 0.12s ===` summary | `FAILED`/`ERROR` lines | The message of the first `FAILED` line, else the first `E` line |
| node --test (spec reporter) | `ℹ tests N` | `✖` lines | The error under the first failing test |

The session keeps the last test run (who ran it, when, what failed) and shows it to the models. For your own commands it also decides the failure triggers: a failed test run counts as failed without an exit code, a passing one does not, whatever words its test names contain, and the same failing test twice is the same error. Scout's own runs never raise a remark, since Pair already has their result.
