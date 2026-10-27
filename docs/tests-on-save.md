# Tests on save

Pair can run a project's tests each time you save a source file in it: the run you would skip before you push. You
choose the command, per project, in the config; the model never chooses or starts one.

```jsonc
{
  "testOnSave": {
    "~/src/shop": "go test -json ./...",
    "~/src/web": "npx vitest run --reporter=json",   // or "npx jest --json"
    "~/src/engine": {"command": "cargo test", "timeoutSeconds": 600},
    "~/src/tool": {"command": "pytest -v", "affected": false}
  }
}
```

A command alone, or `{command, timeoutSeconds, affected}`: `timeoutSeconds` (default 120) is how long a run may take
before it is stopped, and `affected: false` runs the whole command on every save (see below).

What it looks like in Neovim, step by step, is in [neovim.md](neovim.md#it-runs-what-youd-skip). How the run is typed
and read back is in [scout.md](scout.md#tests-on-save).

## How it runs

- The command runs in Pair's own herdr pane, like Scout's, in the project root. Its output goes to a file in the data
  directory (`runs/`), so a long run is read back whole and the pane stays readable. The pane stays open while the
  project has a command.
- Only the latest save counts: a save during a run stops that run (Ctrl-C) and starts one for every file saved since
  the last run that ended. A run that takes longer than its `timeoutSeconds` (two minutes by default) is stopped.
- The session's first run runs the whole command: it is the baseline. After it, a save runs only the tests it can
  affect, where the runner can be told, and the statusline shows the narrowed command:
  - `go test ./...`: the saved file's package and every package of the module that imports it, directly or not
    (`go test -json ./cart ./checkout`);
  - jest: `--findRelatedTests <saved files>`; vitest: `vitest related --run <saved files>`; both find the tests that
    import them, and pass (`--passWithNoTests`) when no test does;
  - pytest: a saved test file runs alone (`pytest -v tests/test_cart.py`); a saved source file runs everything.
  Other runners, a command that names its own packages or tests, and a list of commands (`make && ./probe`) run whole.
  A test that failed before and did not run now still counts as failing, and keeps its sign: the statusline says
  `✗ 2 still failing · TestRate` after a narrowed run that passed. Such a run is followed by one whole run, which
  says what still fails at all: a failing test you renamed or deleted is gone after it.
- Without Pair's pane (no `pair` running in herdr) nothing runs, and the statusline says so.

## What you see

- Neovim's statusline shows a spinner and the command while it runs (the last results fade a little), then
  `✗ 1 failing · TestNoDoubleDelivery` until the next run, or `✓ go test ./... · 4 tests, 3 packages` for a few
  seconds.
- Each test gets `✓` or `✗` in the sign column, and a failure's message shows after the line it failed on, for:
  - `go test -json`, `jest --json`, `vitest --reporter=json` (a jest test is placed by the line the runner gives with
    `--testLocationInResults`, else by its title);
  - `cargo test` (at its `fn`, the failure where it panicked), `pytest -v` or `pytest -rA` (at its `def`; without them
    only the failures), `zig test` and `zig build test` (at its `test "name"` block; `zig build` names only the
    failures), `ctest` (at its `add_test` in `CMakeLists.txt`; with `--output-on-failure`, the first line the test
    printed);
  - TAP (`node --test --test-reporter=tap`, `prove`, `bats --tap`) and JUnit XML, printed (`node --test
    --test-reporter=junit`) or written to the file the command names (`pytest --junitxml=report.xml`, `ctest
    --output-junit report.xml`, `--test-reporter-destination=report.xml`).
  A JS test whose title is made at run time (`test.each` with `%s` or `$name`, a template string) is found by the
  title it was written with.
- The chat says when the run turns red or green, and after a long red, for how long it was red.
- When the run turns green after a red, Neovim lights up once; after ten minutes of red, or a regression, one line
  under yours says what passes again. [When it goes green](neovim.md#when-it-goes-green).
- A number in the output of a passing run without a test report, `make -s run` or a benchmark, that held still and
  then moved the right way gets the same moment.
- A build or a run works too (`"~/src/probe": "make run"`): a crash or a compiler error shows on its line and in the
  statusline (`✗ does not build · probe.c:11`, `✗ Segmentation fault · probe.c:19`), see [builds.md](builds.md).
- Other runners work too (`npm test`, `node --test` with its default reporter): the statusline and the regressions use
  their output, without signs.

## Regressions

A test that fails now and did not in Pair's run before is a **regression**. The session's first run is the baseline,
so tests that were red already never count. A regression is an unasked remark, through the speak gate and budget
like the others: the Partner reads the failing test, the code it tests and your change, and suggests the fix where it
breaks (or points at the cause). Its words show under your line, `Alt-j` goes to the suggestion and `Alt-y` takes it.
Details in [watcher.md](watcher.md#regressions).

## After the Driver's edit

When you hand Pair the wheel, the same command runs once on your unsaved buffers, the Driver's edit and every other
buffer of the project you have not saved: with `go test -overlay`, or for other runners in a scratch copy of the
project, kept between runs so a build in it builds only what changed. The statusline says `(unsaved)` after the
command, and the run is no baseline for the next run on save. Details in
[driver.md](driver.md#the-check-on-the-unsaved-buffer).

The runs on save themselves read the files as saved: what they test is what you saved.
