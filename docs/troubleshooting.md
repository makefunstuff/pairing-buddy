# Troubleshooting

Start with `pair doctor`. It checks every part, one line each, and names the fix when something is wrong.

## `pair doctor`

`pair doctor` checks every part and says what is wrong in plain words, one line each, with the fix:

```
✓ config   ~/.config/pairing-buddy/config.json
✓ service  starts at login, running
✓ daemon   version 0.9.0, up 42 min, 2 sessions
✓ plugin   your Neovim config loads it
✓ neovim   2 connected, in shop, blog
✓ herdr    answers in 3 ms, 4 panes in this workspace
! watcher  your-small-model at http://localhost:8080/v1 answers, but takes 2.4 s: the Watcher scores every candidate remark and should take about 1 s. ...
✓ partner  your-larger-model at http://localhost:8081/v1 answers in 1.1 s
```

| Check | What it looks at |
| --- | --- |
| config | The file parses, and its models (and the decision model) are not still the example's |
| service | The systemd unit or launchd agent is installed, starts at login, runs, and its Node.js still exists |
| daemon | It answers on its socket, with the same version as `pair` |
| plugin | Neovim, started headless with your config, loads the plugin |
| neovim | How many Neovims are connected, in which projects |
| herdr | herdr answers on its socket (only checked when run inside herdr) |
| logins | `auth.json` is readable by you only (shown when there is one) |
| keys | The environment variables your model entries name in `apiKeyEnv` are set, and stored in `service.env` for the service (shown when there are any) |
| pane | Pair's pane: the `scoutPane.rc` file is there, and whether its commands run in the bubblewrap sandbox |
| voice | Off, or the recorder, the whisper.cpp model and program, and the `speak` command ([voice.md](voice.md)) |
| watcher, partner | The login or key the model needs is there and, for a subscription, still renews (with the token's expiry); the server answers and lists the model; one short completion works, and how long it took (about 1 s is the aim for the Watcher). One line, `models`, when both use the same model. A warning when the Watcher runs on a subscription |
| thinking | The Partner thinks when asked to, and its levels reach the server |
| decision | The [decision model](decision.md): none set, or its login or key, one small question and how long the answer took against its `timeoutMs`, and, while the daemon runs, how often it was asked and the gate fell back to its rules. It fails when the model does not answer in time; the gate then goes by its own rules |
| pace | When the daemon runs: the Watcher's median call (of its last 12), and the kinds of moment Pair is not asking about while that takes 1.5 s or more ([watcher.md](watcher.md#when-the-server-is-slow)) |
| roles | When both roles share a server or a provider: how [one model](models.md#one-model) serves both (on a server of your own the Watcher waits while the Partner works; a cloud provider answers both at once), and how the Watcher fared since the daemon started |
| swap | When two models share a server: whether it reloads when the roles switch (the Watcher asked right after the Partner, then again) |
| context | Where the Partner's window comes from (the config, the server or pi-ai's catalog), that the reply has the room its thinking needs, that the window is not so small that compaction comes every few turns, and not larger than the server serves |

It exits with 1 when a check fails, so scripts can use it too.

`pair doctor --thinking` finds the thinking settings an OpenAI-compatible Partner's server takes: it tries the known
thinking switches and level fields on the model, says what each did, and ends with the `compat` line to paste into
the config ([watcher.md](watcher.md#thinking-the-partner-not-the-watcher)).


## Common problems

| What you see | What to do |
| --- | --- |
| `✗ daemon  nothing answers on …` | Run `pair setup` to install and start the service, or `pair daemon` in a terminal to see why it stops. The logs are in the [command reference](cli.md#logs) |
| `✗ service  it runs Node.js from …, which is gone` | You upgraded or moved Node.js: run `pair setup` again |
| `! daemon  it runs version … and this pair is …` | The daemon still runs the old code after an upgrade: restart it with the command the line names (`systemctl --user restart pairing-buddy` under systemd), or run `pair setup` again |
| `✗ plugin  your Neovim config does not load the plugin` | Add the lazy.nvim spec from [Getting started](getting-started.md#2-add-the-neovim-plugin) |
| `! neovim  none connected` | Set `auto_connect = true` in the plugin's `opts`, or run `:Pair start`. A headless Neovim or one started in the temp folder never connects by itself |
| `! config  … still has the example's model names` | Set your own models in the config ([Models and providers](models.md)) |
| `✗ keys  … is not set` | The service does not see your shell's variables: set the variable, then run `pair setup` again, or store the key with `pair auth login NAME` and use `"auth"` |
| `! watcher … takes 2.4 s` | The Watcher should answer in about a second. Use a smaller model, or [one model](models.md#one-model) for both roles on a server that holds one model at a time |
| `! thinking …` | The Partner does not think, or its levels do not reach the server: run `pair doctor --thinking` and paste the `compat` it prints |
| `! pane  no sandbox` | Install bubblewrap (`bwrap`) for the sandbox, or set `"scoutPane": {"sandbox": false}` to silence it |
| The statusline says `◌ pair · partner down` | The model stopped answering. Pair checks every 30 seconds and says when it is back. A subscription login may have ended: `pair auth login PROVIDER` again ([when a model is down](models.md#when-a-model-is-down)) |
| Pair says nothing | That is often right: most moments are not worth a word. `:Pair context` shows what it sees; `/level chatty` lowers the bar for this session, and `pair stats` shows how often it spoke |
| A key such as `Alt-j` does nothing | The keys are mapped only while there is something for them to do, and only where you have no mapping of your own ([keys](neovim-plugin.md#keys)) |
| Pair misses short commands in your terminal, or calls a passing one failed | Without the [shell hook](cli.md#pair-shell-hook) Pair watches the pane and guesses from the output. Add the hook to your shell's rc file: each command's start, end and exit code then come from the shell |
| Typing in a bash or fish terminal does not hold Pair back or take the wheel back | Pair tells typing there only in the pane with focus, from its screen. In zsh the [shell hook](cli.md#pair-shell-hook) reports your keys from any terminal |
| No colours, or plain marks | Pair's colours need `termguicolors` ([setup](neovim-plugin.md#setup)) |

Still stuck? Look for your problem in the [known limitations](limitations.md), or
[open an issue](https://github.com/makefunstuff/pairing-buddy/issues) with the output of `pair doctor`.
