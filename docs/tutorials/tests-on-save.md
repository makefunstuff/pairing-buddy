# Tests on save

Give Pair your project's test command once, and each save runs the tests in Pair's own pane: the run you would skip
before you push. When your fix breaks a test somewhere else, Pair says why under your line and suggests the fix.

## 1. Name the command

In `~/.config/pairing-buddy/config.json`, one entry per project, its folder and its command:

```jsonc
"testOnSave": {
  "~/src/hookd": "go test -json ./...",
  "~/src/web": "npx vitest run --reporter=json"
}
```

Save the config; the daemon takes it at once. A report format (`go test -json`, jest's or vitest's JSON, `pytest -v`,
`cargo test`, TAP, JUnit) lets Pair put a sign on each test. The model never picks or starts a command.

## 2. Save a file

Save any source file of the project. The statusline spins with the command, `⠹ go test ./...`. The session's first
run is the baseline: what fails in it already raises nothing. After it, a save runs only the tests it can affect
where the runner can tell (for `go test`, the saved package and those that import it).

![On save: the spinner, the failing test, the remark, the suggestion, Alt-y, and green](../images/tests-on-save.gif)

## 3. Read the result

- The statusline says `✗ 1 failing · TestNoDoubleDelivery` until the next run, or `✓ go test ./... · 4 tests,
  3 packages` for a few seconds.
- Each test gets `✓` or `✗` in the sign column, and a failure's message shows after the line it failed on.

![The statusline while the tests run, when one fails, and when they pass](../images/test-statusline.png)

## 4. When your change broke something

A test that passed in the run before and fails now is a regression. Pair reads the test and the code, and says what
broke in two lines under your change, ending with `M-j`:

![The remark under your change; a cross on the failing test below, the failure under the line it failed on](../images/regression.png)

1. `Alt-j` goes to the fix it suggests (`Ctrl-O` comes back): the old line struck through, the new one under it.
2. `Alt-y` takes it, unsaved. `:w` saves it, and the tests run again.

![After Alt-j: the suggestion in queue.go, the old line struck through](../images/regression-fix.png)

When the tests turn green after a red, the statusline lights up once.

## More

[Tests on save](../tests-on-save.md) has every runner, the timeout and `affected: false`;
[it runs what you'd skip](../neovim.md#it-runs-what-youd-skip) the whole moment; [builds and crashes](../builds.md)
a `make run` instead of tests.
