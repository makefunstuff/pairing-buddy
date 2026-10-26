# Scout

As Scout, Pair investigates for you in its own herdr pane: it searches the project, runs the tests, looks at `git log` and `git diff`. Every command is typed into that pane, so you see what runs and what it prints; the result also goes back to the model. Scout never types into your own panes (only the Driver's `type` does, after your yes and without Enter; see [driver.md](driver.md)).

Switch with `/scout` and `/navigate` in the chat, or `:Pair scout` and `:Pair navigate` in Neovim. Navigator is the default, and a new session always starts in it. While you hand Pair the wheel, the Driver has `search` and `run` too, in the same pane, under the same policy and limits.

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

- Read-only programs: `ls`, `cat`, `head`, `tail`, `wc`, `rg`, `grep`, `fd`, `find`, `tree`, `pwd`, `echo`, `printf`, `which`, `file`, `stat`, `du`, `df`, `diff`, `cmp`, `sort`, `uniq`, `cut`, `tr`, `jq`, `xxd`, `ps` and a few more, unless a flag or operand below makes them write.
- Git that only reads: `status`, `log`, `diff`, `show`, `blame`, `grep`, `ls-files`, `ls-tree`, `rev-parse`, `rev-list`, `describe`, `shortlog`, `cat-file`, and `branch`, `stash`, `remote`, `tag`, `config`, `reflog` when they only list.
- Tests and builds: `npm`/`pnpm`/`yarn`/`bun` `test` and `run test|build|lint|check|typecheck` (also `test:unit` and the like), `npx vitest|jest|mocha|tsc|eslint`, `cargo test|build|check|clippy|nextest|bench|doc`, `cargo fmt --check`, `go test|build|vet|list|env`, `pytest`, `python -m pytest|unittest`, `node --test`, `make test|check|build|lint|all`.
- Redirections to `/dev/null` and `2>&1`.

**Asks you first** (in the chat; `y` or `yes` allows it, anything else declines, and no answer within a minute declines):

- Programs that write or delete: `rm`, `rmdir`, `mv`, `cp`, `mkdir`, `touch`, `chmod`, `chown`, `ln`, `dd`, `truncate`, `tee`, `patch`.
- Installs: `npm install|i|ci|add|update|uninstall`, `cargo add|install`, `go get|install`, `pip install` and the like.
- Flags and operands that turn a read into a write or run another program:
  - `find -exec|-execdir|-ok|-delete|-fprint`, `fd -x|--exec|-X|--exec-batch`, `rg --pre`;
  - `sort -o|--output|--compress-program`, `tree -o`, `file -C`, `date -s`, `git diff --output`;
  - a second file name for `uniq` and `xxd` (`uniq IN OUT` writes OUT).

  A short flag counts in every spelling: alone (`-o out`), with its value attached (`-oout`), or inside a cluster (`-ro`). A long flag also counts when it is shortened the way GNU tools accept, down to one letter (`--out=x`, `--o=x`).
- Tests and builds that change files or run something else: `cargo fmt`, `cargo clippy --fix`, `eslint --fix`, snapshot updates (`jest -u`, `vitest -u`, also passed through as in `npm test -- -u`), `cargo doc --open`, `go env -w|-u`, `go test -exec`, `go vet -vettool`, and `make` with no target, since the default target can be anything.
- Git that changes your working tree: `checkout`, `switch`, `restore`, `add`, `stash`, `clean`, a new `branch`; and any git command with global options other than `-C` and `--no-pager` (`git -c core.pager=sh log`).
- Writing to a file with `>` or `>>`.
- Anything it cannot see through: command substitution, variables, subshells, background jobs, programs given by path (`./deploy.sh`), interpreters running scripts (`python x.py`, `bash -c`).
- Paths outside the project: absolute paths, `~`, `..`.
- Every program not on the lists above.

Without a chat pane to ask in, the answer is no.

**Refused:**

- Git history: `commit`, `push`, `reset`, `rebase`, `merge`, `cherry-pick`, `revert`, `am`, `pull`, `filter-branch`, `update-ref`, whatever global options come before them (`git -c x=y commit`). You commit yourself.
- The network: `git fetch`, `git clone`, `curl`, `wget`, `ssh`, `scp`, `rsync`, `nc`, `npm publish`, `cargo publish`.
- Root: `sudo`, `su`, `doas`.
- Interactive programs that would wait for keys: `less`, `more`, `vim`, `nano`, `top`, `man`, `watch`.
- More than one line, and an empty command.

The pane is not a sandbox ([#28](https://github.com/makefunstuff/pairing-buddy/issues/28)). An allowed test run can write what tests write, and a read-only program can still read any file inside the project.

## Test results

The output of every test run, yours, Scout's or the one on save, is parsed for the runner, the failed tests and the first error line (`src/test-output.mjs`):

| Runner | Recognised by | Failed tests | First error |
| --- | --- | --- | --- |
| cargo test | `test result:` | `test x ... FAILED` lines | The panic message, `left`/`right` and its location |
| go test | `--- FAIL:`, `ok`/`FAIL` package lines | `--- FAIL:` names (subtests rather than their parents) | The first line under the first failure, or the compiler error |
| jest | `Tests: ... total` | `●` headers | The first line under the first header, with `Expected`/`Received` and the location |
| vitest | `Tests  ... (N)` | `FAIL` lines | The error under the first `FAIL`, with its location |
| pytest | the `=== ... in 0.12s ===` summary | `FAILED`/`ERROR` lines | The message of the first `FAILED` line, else the first `E` line |
| node --test (spec reporter) | `ℹ tests N` | `✖` lines | The error under the first failing test |
| go test -json | lines of JSON events with `Action` and `Package` | tests with a `fail` event (subtests rather than their parents) | `file.go:12: message` from the test's output, a panic and its first frame outside the runtime, or the compiler error |
| jest --json, vitest --reporter=json | a JSON line with `testResults` (also among npm's own lines) | `failed` assertion results, named `describe › test` | The first line of the failure message, with `Expected`/`Received`, and its line in the test file from the stack |

The session keeps the last test run (who ran it, when, what failed) and shows it to the models. For your own commands it also decides the failure triggers: a failed test run counts as failed without an exit code, a passing one does not, whatever words its test names contain, and the same failing test twice is the same error. Scout's own runs never raise a remark, since Pair already has their result.

## Tests on save

With a command for the project in `testOnSave` (see [tests-on-save.md](tests-on-save.md)), Pair runs it in this
pane each time you save a source file there (not notes or docs, and not files outside the project). It is typed as
`cd <project> && (<command>) > <data dir>/runs/<session>.out 2>&1` (from the root, whatever a Scout command's `cd`
did to the pane's shell; in parentheses, so all of `cc -o probe probe.c && ./probe` goes to the file): the pane shows the command line and its exit code in the prompt, and
the daemon reads the output back from the file, whole, however long it is. Then:

- A JSON report also gives each test (`src/test-places.mjs`): a Go test's function is found as `func Name(` in the
  `_test.go` files of its package (the package's directory from `go.mod`), a jest or vitest test by its title in
  quotes in its file, or the location the runner gives; a test file that fails to load (a broken import) is marked on
  its first line. Tests outside the project, skipped ones and ones not found (a `test.each` row) are left out. Neovim shows them in the sign column (see [docs/neovim.md](neovim.md#it-runs-what-youd-skip)).
- The run becomes the session's last test run, by Pair, with the file you saved and the tests that fail now and did
  not in Pair's run on save before it. Those raise the `regression` trigger
  ([docs/watcher.md](watcher.md#regressions)).
- A build or a run is read too (`src/run-output.mjs`): a crash, with the signal from the exit code when the shell
  said it in the pane rather than in the file, and the compiler's errors and warnings. Neovim shows them on their
  lines and in the statusline ([docs/neovim.md](neovim.md#a-crash-and-a-compiler-error)), and they raise the
  `crash` and `new_warning` triggers ([docs/watcher.md](watcher.md#crashes-and-new-warnings)). Scout's own commands
  are read for its report to the model: `Crashed: Segmentation fault` or `Build: 2 errors: probe.c:11: ...`.
- The command is yours, from your config: it does not go through the command policy, and the model can neither
  start nor change it. As with Scout's commands, the pane is not a sandbox.
- One run at a time, sharing the pane's queue with Scout; a save during a run starts one more run after it, for the
  last file saved. After two minutes a run is stopped with Ctrl-C.
- Switching back to Navigator keeps the pane open while the project has a command; ending the session closes it.
  The session's first run (also after a daemon restart) is the baseline: what fails in it failed already, so it
  raises no regression. A run of your own is no baseline: it may have run other tests.
  Without herdr there is no pane: nothing runs, the chat says why once, and Neovim's statusline says
  `◌ go test ./... · needs \`pair\` in herdr`.
