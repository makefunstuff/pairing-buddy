# Scout

As Scout, Pair investigates for you in its own pane (in herdr, or without it a `:terminal` in Neovim, see [neovim.md](neovim.md#without-herdr)): it searches the project, runs the tests, looks at `git log` and `git diff`. Every command is typed into that pane, so you see what runs and what it prints; the result also goes back to the model. Scout never types into your own panes (only the Driver's `type` does, after your yes and without Enter; see [driver.md](driver.md)).

Switch with `/scout` and `/navigate` in the chat, or `:Pair scout` and `:Pair navigate` in Neovim. Navigator is the default, and a new session always starts in it. While you hand Pair the wheel, the Driver has `search` and `run` too, in the same pane, under the same policy and limits.

## Pair's pane

Switching to Scout opens a pane below the chat pane, labelled `pair scout`. It runs `bash --noprofile` with an rc file of Pair's and the prompt `scout[N] exit X $ `: `N` counts the commands, `X` is the exit code of the last one. The shell writes each command's output and exit code to files as well (see [herdr.md](herdr.md#pairs-own-pane-exact)): that is how Pair knows that a command ended and how, which herdr cannot tell it, and reads all of its output. `HISTFILE` is empty, so Pair's commands stay out of your shell history. By default your rc files are not loaded, so your aliases and functions are not there; the pane can [load your rc file](#your-rc-file), and Pair's rc file comes after it. Where [bubblewrap](https://github.com/containers/bubblewrap) works, the shell runs in [a sandbox](#the-sandbox).

- One command runs at a time; Pair waits for it to end, then reads its whole output back, also when it printed more than the pane holds. The shell's output goes through `tee`, so a command writes to a pipe, not a terminal: no colours, no pager, no progress bars. A job you start in the background (`cmd &`) keeps running and does not block the pane.
- A command still running after two minutes is stopped with Ctrl-C, and the model is told so.
- Each question gets at most four searches or commands. After that the model is told to answer with what it found.
- Commands read the files as saved. When a buffer of the project has changes you have not saved, the model is told
  which, and can run a command on the buffers instead (`run` with `unsaved: true`, for tests or a build): it runs as
  `(cd <copy> && <command>)` in the scratch copy of the project that the [Driver's check](driver.md#the-check-on-the-unsaved-buffer)
  uses, with your unsaved text in it, and what it writes stays in the copy. `search` reads the saved files; the
  model reads a buffer with `read`.
- For a remark nobody asked for, Scout may read and search, but `run` answers "not now".
- Switching back to Navigator, or ending the session, closes the pane. A daemon that restarts finds its pane again by the label, so a change to `scoutPane` in the config shows once the pane opens anew.

The pane's shell is set by `scoutPane` in the config (`pair doctor` says how it runs):

```jsonc
"scoutPane": {
  "rc": "~/.bashrc",          // your rc file, loaded before Pair's prompt (true means ~/.bashrc); default: none
  "sandbox": "auto",          // "auto": in bubblewrap where it works; true: always (no bwrap, no pane); false: never
  "network": false,           // whether commands in the sandbox reach the network
  "writable": ["~/.cache"]    // folders besides the project that commands in the sandbox may write
}
```

### Your rc file

With `rc` set, the pane runs bash with an rc file of Pair's (`src/scout-pane.bash`) that loads yours first: your aliases, functions and environment (version managers, `PATH`) are there, as in your terminal. Then it puts back what Pair reads the pane by, whatever yours set up: no `PROMPT_COMMAND` or `PS0` of yours (Pair's rc file, read last, sets its own and its prompt), no `DEBUG`, `ERR` or `RETURN` traps, no `errexit`, `nounset` or `pipefail`, emacs keys (Ctrl-U clears the line) and no history file. So the exit codes stay right, and what your rc file prints when it starts stays above the first prompt.

- The command policy sees your aliases and functions: Pair lists them once, from a bash that loads the same rc file. An alias is judged by what it stands for (`ll` for `ls -l` runs at once, `ship` for `git push` is refused), and so is the next word after an alias that ends in a space, as bash does; a quoted or escaped name (`'rm'`, `\rm`) is the program, as in bash. A function asks you first, since Pair cannot see what it does. When the list cannot be made, every command asks.
- Prompt hooks do not run: a prompt such as starship, `direnv`'s hook and anything built on bash-preexec stay off in this pane. An rc file that starts another shell (`exec zsh`) or replaces readline (ble.sh) gives Pair no prompt to read, and the pane fails to open with a message saying so.
- Pair's own commands (the `search` tool's `rg`, the `cd` before tests on save) go through your aliases and functions too.
- Only bash rc files work: the pane's shell is bash.

### The sandbox

With `sandbox` at `"auto"` (the default) and bubblewrap (`bwrap`) installed and allowed to make namespaces, the pane's shell runs in a sandbox, and so does every command typed there: Scout's, the Driver's and your tests on save. The command policy still decides first what runs; the sandbox limits what an allowed command can do.

- The disk is read-only, except the project, the `runs/` folder of the data directory (where the tests on save and the hand-over's check write their output and their scratch copy), the pane's own folder in `panes/` (its shell's output log and exit codes) and the `writable` folders. Writing anywhere else fails with "Read-only file system".
- `/tmp` is a private, empty one: what a command writes there is gone when the pane closes.
- Your cache folder (`~/.cache`, or `XDG_CACHE_HOME`, and `GOCACHE` when it is elsewhere) is writable, but what a command writes there is thrown away when the pane closes: Go's build cache and the like work, and nothing in the sandbox can change what your own builds find there later. It is an overlay on the real folder where bubblewrap can make one (bubblewrap 0.10 and Linux 5.11 on), so what is cached already is still used; elsewhere it is an empty folder, and the first builds are slower.
- `XDG_RUNTIME_DIR` is empty, and every unix socket of yours that is listening when the pane opens is hidden wherever it is (Pair reads them from `/proc/net/unix`): herdr's API socket and its terminal clients' socket, the daemon's, your editors', agents' and password managers'. So are the docker and podman sockets, which are root's. A command cannot type into your panes through herdr, ask the daemon, reach your desktop session (D-Bus, Wayland, ssh-agent) or start a container.
- No network unless `network` is true; the loopback interface is there, so tests that serve on `localhost` still work. Name lookups are off too: the sockets of the daemons that look names up for a program (systemd-resolved, nscd, avahi, and the system D-Bus, where systemd-resolved answers too) are hidden, since a lookup of a made-up name would carry data out. Commands see only their own processes (`ps` lists the sandbox's).

The trade-offs:

- Reading is not limited: a command can still read any file you can, your home included. The policy asks before a command names a path outside the project, but a test or build can read what it likes. With the network off, what it reads can leave through the output Pair shows the model, or through a socket on the disk that Pair does not hide and whose daemon reaches the network for its clients.
- What the sandbox builds into your cache folder is gone when the pane closes, so the next pane builds it again. Listing `~/.cache` in `writable` keeps it, and lets a command change what is cached there for your own builds. Other caches, such as `~/.cargo` and `~/.npm`, are read-only unless listed: Cargo and npm still build and test.
- Tests that download, or talk to a service on another host, fail with the network off.
- Sockets of other users are not hidden, apart from those above: a command can still connect to one it may write to, such as a database's socket under `/run`, or, with `network` true, the system D-Bus. A socket of yours made after the pane opened is not hidden either, until the pane opens again.
- With `network` true, the sandbox shares your network, abstract unix sockets included (some D-Bus and X11 setups use them).
- Without bubblewrap (other systems, or one that forbids unprivileged namespaces) `"auto"` runs the pane as before, as you, and `pair doctor` warns; `true` makes the pane fail to open rather than run without a sandbox.

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

Without [the sandbox](#the-sandbox) an allowed test run can write what tests write, and a read-only program can still read any file inside the project. With it, writes stay in the project and the network is off, but reads are not limited.

## Test results

The output of every test run, yours, Scout's or the one on save, is parsed for the runner, the failed tests and the first error line (`src/test-output.mjs`):

| Runner | Recognised by | Failed tests | First error |
| --- | --- | --- | --- |
| cargo test | `test result:` | `test x ... FAILED` lines | The panic message, `left`/`right` and its location |
| go test | `--- FAIL:`, `ok`/`FAIL` package lines | `--- FAIL:` names (subtests rather than their parents) | The first line under the first failure, or the compiler error |
| jest | `Tests: ... total` | `●` headers | The first line under the first header, with `Expected`/`Received` and the location |
| vitest | `Tests  ... (N)` | `FAIL` lines | The error under the first `FAIL`, with its location |
| pytest | the `=== ... in 0.12s ===` summary, or with `-q` its bare `2 failed, 1 passed in 0.12s` line | `FAILED`/`ERROR` lines | The message of the first `FAILED` line, else the first `E` line |
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

- Most runners also name each test (`src/test-output.mjs`, `src/test-reports.mjs`), and `src/test-places.mjs` finds
  it: a Go test's function as `func Name(` in the `_test.go` files of its package (the package's directory from
  `go.mod`); a Python test's `def`, a Rust test's `fn`, a Zig `test "name"` block and a CMake `add_test(name` in the
  project's files of that kind, in the file the runner names first; a jest, vitest or TAP test by the location the
  runner gives, else by its title in quotes in its file, or by a title written with `%s`, `$name` or `${...}` that
  makes it (`test.each`, template strings). A test file that fails to load (a broken import) is marked on its first
  line. Tests outside the project, skipped ones and ones not found are left out. A JUnit report the command writes
  to a file (`--junitxml`, `--output-junit`, `--test-reporter-destination`) is read after the run, when the run
  wrote it. Neovim shows them in the sign column (see [docs/neovim.md](neovim.md#it-runs-what-youd-skip)).
- The run becomes the session's last test run, by Pair, with the file you saved and the tests that fail now and did
  not in Pair's run on save before it. Those raise the `regression` trigger
  ([docs/watcher.md](watcher.md#regressions)).
- A build or a run is read too (`src/run-output.mjs`): a crash, with the signal from the exit code when the shell
  said it in the pane rather than in the file, and the compiler's errors and warnings. Neovim shows them on their
  lines and in the statusline ([docs/neovim.md](neovim.md#a-crash-and-a-compiler-error)), and they raise the
  `crash` and `new_warning` triggers ([docs/watcher.md](watcher.md#crashes-and-new-warnings)). Scout's own commands
  are read for its report to the model: `Crashed: Segmentation fault` or `Build: 2 errors: probe.c:11: ...`.
- The command is yours, from your config: it does not go through the command policy, and the model can neither
  start nor change it. It runs in [the sandbox](#the-sandbox) when the pane has one, like Scout's commands.
- One run at a time, sharing the pane's queue with Scout. A save during a run stops it with Ctrl-C (or takes it out
  of the queue before it starts) and starts one for every file saved since the last run that ended; the stopped run
  reports nothing. After the baseline, a run covers only the tests the saved files affect where the runner can be
  told (`src/affected.mjs`, see [tests-on-save.md](tests-on-save.md#how-it-runs)); one that passes while earlier
  failures are still counted is followed by a whole run. A run is stopped with Ctrl-C after
  the project's `timeoutSeconds`, two minutes by default.
- Switching back to Navigator keeps the pane open while the project has a command; ending the session closes it.
  The session's first run (also after a daemon restart) is the baseline: what fails in it failed already, so it
  raises no regression. A run of your own is no baseline: it may have run other tests.
  Without herdr the pane is a `:terminal` in Neovim.
