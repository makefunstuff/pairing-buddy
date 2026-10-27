# Tests on save

Pair can run a project's tests each time you save a source file in it: the run you would skip before you push. You
choose the command, per project, in the config; the model never chooses or starts one.

```jsonc
{
  "testOnSave": {
    "~/src/shop": "go test -json ./...",
    "~/src/web": "npx vitest run --reporter=json"   // or "npx jest --json"
  }
}
```

What it looks like in Neovim, step by step, is in [neovim.md](neovim.md#it-runs-what-youd-skip). How the run is typed
and read back is in [scout.md](scout.md#tests-on-save).

## How it runs

- The command runs in Pair's own pane, like Scout's (herdr's, or a `:terminal` in Neovim without it), in the project root. Its output goes to a file in the data
  directory (`runs/`), so a long run is read back whole and the pane stays readable. The pane stays open while the
  project has a command.
- One run at a time: a save during a run starts one more after it. A run that takes over two minutes is stopped.
- Without Pair's pane (neither herdr nor a Neovim) nothing runs, and the statusline says so.

## What you see

- Neovim's statusline shows a spinner and the command while it runs (the last results fade a little), then
  `✗ 1 failing · TestNoDoubleDelivery` until the next run, or `✓ go test ./... · 4 tests, 3 packages` for a few
  seconds.
- With a JSON report (`go test -json`, `jest --json`, `vitest --reporter=json`), each test function gets `✓` or `✗`
  in the sign column, and a failure's message shows after the line it failed on.
- The chat says when the run turns red or green, and after a long red, for how long it was red.
- When the run turns green after a red, Neovim lights up once; after ten minutes of red, or a regression, one line
  under yours says what passes again. [When it goes green](neovim.md#when-it-goes-green).
- A number in the output of a passing run without a test report, `make -s run` or a benchmark, that held still and
  then moved the right way gets the same moment.
- A build or a run works too (`"~/src/probe": "make run"`): a crash or a compiler error shows on its line and in the
  statusline (`✗ does not build · probe.c:11`, `✗ Segmentation fault · probe.c:19`), see [builds.md](builds.md).
- Other runners work too (`cargo test`, `pytest`, `npm test`): the statusline and the regressions use their output,
  without signs ([#40](https://github.com/makefunstuff/pairing-buddy/issues/40)).

## Regressions

A test that fails now and did not in Pair's run before is a **regression**. The session's first run is the baseline,
so tests that were red already never count. A regression is an unasked remark, through the speak gate and budget
like the others: the Partner reads the failing test, the code it tests and your change, and suggests the fix where it
breaks (or points at the cause). Its words show under your line, `Alt-j` goes to the suggestion and `Alt-y` takes it.
Details in [watcher.md](watcher.md#regressions).

## After the Driver's edit

When you hand Pair the wheel, the same command runs once on your unsaved buffer: with `go test -overlay`, or for other
runners in a scratch copy of the project (git's files and ignored files; ignored folders are left out, so builds and
caches stay in the copy, and only dependency folders such as `node_modules` are linked). The statusline says
`(unsaved)` after the command, and the run is no baseline for the next run on save. Details in
[driver.md](driver.md#tests-on-the-unsaved-buffer).
