# The Watcher: fast and well-judged

Every candidate remark (a failed command you missed, the same error again, a new diagnostic, a stall, drift, the wrong turn, a regression, a crash, a new warning, and in a Markdown note a stall after a question or a section that drifts) goes through the speak gate before the Partner writes a word. The gate asks the Watcher model for a score from 0 to 10, so the Watcher must answer in well under a second, and must not make the Partner's model slower. This page says how Pair keeps it that way.

## The order of the gate

1. **Typing.** While you type, the trigger waits for your next pause; nothing is asked.
2. **Budget.** When the talk level's budget is spent (too many remarks this hour, or the last one too recent), the trigger is dropped; nothing is asked.
3. **Prefilter.** Cheap rules drop what is plainly noise, without a model (below).
4. **Watcher.** The model scores what is left. Below the trigger's bar the trigger is dropped; at or above it, the Partner gets it.

Each trigger is looked at once: a dropped trigger does not come back. Drift is the exception for the budget: it lasts as long as you stay in that file, so when the budget holds it back it is looked at again on each tick (logged once) until the budget allows, and then judged.

## The held thought

Once the Partner has written a remark, it shows at your next pause if it is about what you are doing right now: a wrong turn, a regression, the same failure again, a failure you did not look at. Everything else (drift, a stall, an error in code you wrote and moved on from) can wait, and is held until your next **breakpoint**:

- a save;
- a command or test run that ended (a commit is one too);
- out of Insert mode for 3 s without an edit: you stopped to look;
- no key or edit for 15 s, in any mode or editor.

Meanwhile Neovim shows a `•` in the sign column at the line it is about (where it points, else where its trigger is) and the statusline says `● pair · held thought · M-j`; nothing goes to the chat. `Alt-j` (or `:Pair jump`) shows it at once. A breakpoint that came while the Partner was still writing counts, so a remark that is ready while you already rest shows at once, without a dot.

A held thought is dropped, without a word, when what it saw is gone by then: the error is no longer in your code (on any line: lines added above it only move it), or you left the file that drifted. It is not stored as a remark, so it counts neither as useful nor as noise. It costs the talk budget only when it shows, so a thought you have not seen never holds back another remark. While a thought is held, other triggers that can wait are not judged; urgent ones still are, and show at your next pause as usual, while the held one keeps waiting for its breakpoint.

## The prefilter

The rules only ever drop; anything they are unsure of goes to the Watcher.

| Rule | Example |
| --- | --- |
| Exit 1 of a command whose exit 1 is an answer, not a failure | `grep`, `rg`, `ag`, `diff`, `cmp`, `test`, `[`, `which`, `pgrep`, `git diff`, `git grep` finding nothing or a difference |
| A command you stopped yourself | exit 130 (Ctrl-C) or 143 |

Drift has no rule here. Whether a file is part of the goal depends on what it does, and the words of its path do not
say that: `src/billing/ranking.ts` shares "ranking" with a goal about search ranking and is unrelated, and
`src/net/backoff.ts` shares no word with "reconnect waits 30 s after the phone sleeps" and is the heart of it. The
Watcher judges drift (below), told what the file is about.

## Scores remembered

The same moment twice gets the same score without a second request: the same failure under the same goal, the same
file you moved into again. The Watcher answers at temperature 0, so it would give the same number. A score is kept for
half an hour; a call that failed, gave no number or had to wait for the Partner is not kept.

## A short question, a short answer

- The Watcher sees a few lines: the goal, the current file and cursor, where you are looking, your last keystroke, and what just happened. The Partner gets the full picture only once the gate lets the remark through.
- It answers with the score alone, a single number, and may write at most 8 tokens. A JSON answer with a reason took about ten times as many tokens, and on a local server every token written adds to the wait.
- Drift gets a question of its own: how clearly the file you now edit is unrelated to the goal, by what it does, with the goal named in the question. Asked whether you would want a remark, models score how important the work is instead. With the path comes the file's gist: its leading comment (a licence does not count) and the first names it defines, at most 240 characters, read from your buffer when the Watcher is asked. Live, a fast cloud model scored `src/billing/ranking.ts` ("ranks overdue invoices for the dunning run") 10 under a goal about search ranking, the catalog's BM25 scoring 0, a backoff file 3 under a reconnect goal and a sheep counter in `src/sleep/` 10.
- The wrong turn (`edit_while_red`: you edit, while a test run is red, a source file the failure does not name) gets one too: the Watcher cannot see the code, so it is asked how much a quick check of whether that file can cause the failure would save you, with the files the failure names next to it. Asked how likely the cause is elsewhere, models hedge in the middle of the scale.
- A smaller Watcher model than the Partner's is faster, but small models tend to judge drift badly (scoring it 0 or 1), and on a server that keeps one model loaded every swap costs far more than it saves. One mid-sized model for both roles is the tested setup.
- Drift is checked once for each file you move into, right when you start editing it, and again on another branch or after a new goal (`/goal`), not once every ten minutes.

## The wrong turn

`edit_while_red` is raised when the last test run (yours, or Scout's) failed in the last ten minutes, its output names source files, and you then edit a source file it does not name. A test file and the code it tests count as one name: `worker_test.go` and `worker.go`, `test/ws.test.ts` and `src/ws.ts`, `test_ws.py` and `ws.py`. It is raised once per run and file, and not at all once a newer run passed. It is judged before drift, since it is the more specific moment.

The Partner gets the failure and your change, and is told the red run is older than your change. It reads your lines, the failing test and the code it tests, and traces the test through the code as it is now, with the real numbers. If the trace passes (your change was the fix), or it is not sure, it answers SILENT. Only when the trace still fails somewhere else does it point there, with the few characters it means as `code` (an operator, a name), and say why in one or two sentences.

The Partner thinks first, as for every remark (below). Without thinking, a fast model traced the test wrongly and told users to change code that already passed; with it, it stayed silent in every live run where the edit was the fix, and still found the real cause when it was not. In Neovim its words show under your edit and `Alt-j` goes to the point ([docs/neovim.md](neovim.md#the-wrong-turn)).

## Regressions

`regression` is raised when the tests Pair ran on save ([docs/scout.md](scout.md#tests-on-save)) fail where the run
before did not: a test that fails now and did not fail in Pair's last run on save. The session's first run (also
after a daemon restart) has nothing to compare with: it is the baseline, and raises nothing. It is raised once per run,
within two minutes of it, and is judged before the wrong turn. A run that is red the same way again is no news:
the statusline already says so.

The Watcher gets a question of its own: you saved a file, the tests run right after show these tests failing, which
did not fail before, and you have not run them; how much would hearing now what broke save you, 0 if it is plainly
the test you are working on, 10 if your change broke something elsewhere.

The Partner reads the failing test, the code it tests and your change, and finds how the change breaks it. It is
told that you made the change for a reason, often another test, so its fix has to keep that working: it undoes your
change only if it is plainly wrong. If a small change fixes it, it calls `suggest`, else it points at the cause, and
says why in one or two sentences. Before it was told to keep your change, a fast model in live runs undid the
user's fix about one time in three. Like every remark, the check thinks first. The
live test accepts any fix that makes all the project's tests pass, and checks that by running them. In Neovim the words show under your
line, and `Alt-j` goes to the suggestion, where `Alt-y` takes it.

## Crashes and new warnings

Builds and runs are read by `src/run-output.mjs` (see [builds.md](builds.md)), yours in the
terminal and Pair's on save. Two triggers come from them: a crash is judged first of all, a new warning just
before drift.

`crash` is raised when the last build or run died of a signal (from its exit code, or the shell's or make's words
when herdr gives no exit code) or reported a fault: a sanitizer, a failed assert, a panic. It is raised also while
you look at the terminal, since the terminal says that it crashed, not why; it replaces `failed_command` for that
command. Its key is the crash and its place, so the same crash at the same place is raised once; again, it is the
same error a second time (`repeated_error`). The Watcher is asked how much hearing where and why it crashed would
save you: 0 if the output already names the line and the cause plainly, 10 if you would have to hunt for it. The
Partner gets the stack, innermost first, reads the code at the frame in the project (or the code you changed last
when there is no stack), and points at the line with the characters that are wrong. Live, with a fast model: a bare
segfault of a hash table whose mask you just removed scored 7 or 8, and the Partner pointed at the unmasked hash or
the index it gives in every run.

`new_warning` is raised once per build when it printed a warning in a file you edited in this session that no build
before it in the session printed (each command's first run is its baseline; a file you did not touch, which an
incremental build compiles again after a header changed, brings no news; the line is not part of a warning's
identity, since it moves as you edit). The
Watcher is asked how likely it is a real bug worth a word now: 0 for something untidy while exploring (an unused
variable or parameter), 10 for a likely bug (an uninitialised value, a wrong format, an overflow, a missing return).
The Partner reads the line and speaks only for a bug; otherwise it answers SILENT. Live: a `-Wformat` warning (`%d`
with a double) scored 8 and got a point at the `printf`; an unused variable scored 2 and got SILENT.

## The exploration loop

Every build and run is read next to the one before by `src/run-log.mjs` ([exploration.md](exploration.md)). Two
triggers come from it, judged after a new warning and before drift, once per run.

`same_result` is raised when you changed the code since the last run of the command and it printed the same numbers
(or, without numbers, the same output). A print, a comment or a note is no change. The Watcher gets the runs, each
with the change before it and its numbers, and the last three outputs. It is asked how much hearing why the change
did nothing would save you: 0 if the change plainly could not touch these numbers, 10 if you meant it to and will try
more changes blindly. The Partner reads the change and the code the run goes through, points at the line that
explains it and says why with the real numbers. Live, on the research's hash table (ids 64 apart, `* 31` that keeps
them so): scored 8, and the Partner pointed at `id = e * 64` and said why in numbers.

`number_moved` is raised when a change of the code moved a number by a quarter or more, one whose words say which
way is better, or a time that halved or doubled. When the runs before held the same numbers, the detail says that
it ends a hunt. The Watcher is asked how much one sentence on what is now true would help: 0 for the plain result of
a first try, 10 for the end of a hunt or a number that got much worse. The Partner says what is now true and why this
change worked where the others did not, or SILENT. Live: the shift that ends the hunt scored 8, and the remark
named 23.7 → 1.1.

## The search trail

`search_trail` is raised from your picker searches in Neovim ([docs/neovim.md](neovim.md#the-search-trail)): three
or more since your last edit, within four minutes, one of them closed with nothing opened or the same words again that opened another file,
once you have paused three seconds after the last. Each new search in the trail raises it again; an edit ends the
trail. It is judged after the others.

The Watcher gets a question of its own, with the trail a line per search and what fails now: how much being told
where it is in the code would save you, 0 if the last search plainly found it, 10 if your words are not the code's
and you go in circles. In the live test the trail scored 7 each time, above the bar at `normal`.

The Partner gets the trail, what fails now (the last red test run, else the last failed command, from the last ten
minutes), and what ripgrep finds in the project for each query, any case: the files whose path has it and the first
lines that do. As Navigator it cannot search, and that a query is nowhere in the project is half the story. It is
asked to work out what you look for, read the code, point at the place with the code's own word for it, and say in
one sentence where it is and, if something fails, how that place causes it. The live test runs the captures' Go
project with and without the failing test: with it, the cue named `ErrBudget` and the `>=` at `worker.go:35` in
every run; from the trail alone it pointed at the attempt limit, line 31, which is why the failure always goes
with it.

## In a note

Two triggers are about prose ([docs/notes.md](notes.md#what-the-triggers-mean-in-prose)). `note_stall` is raised
when you wrote a line that ends with `?` in a Markdown note and then nothing for 90 s (but not after five minutes:
then you are away); `note_drift` a minute after you begin a section whose heading and words share no word with
the note's title or the goal. Each is judged once. The Watcher gets a question of its own for each: would one
question back help them answer their question themselves, and is the section about something other than the
note's title. Asked only whether a remark would save time, a tested model scored them 3 and 2, under the normal
bar; asked this way, 7 and 8, and 2 for a section on the note's own subject. The Partner asks one question back,
never the answer, or asks once whether the section still belongs in the note; it answers SILENT when it does.

## Keep-warm

Many local servers unload a model that has not been asked for a few minutes, and loading it again takes from seconds to minutes: the Watcher's call then times out, and Pair stays quiet until the model is back. While you work (a key, an edit or a command in the last five minutes), the daemon makes sure the Watcher's model has been asked something in the last four minutes: if not, it sends the Watcher's own instructions with a one-token answer. When you stop working, the pings stop too, and the server may unload the model as it likes.

`"keepWarm": false` turns this off. With an `anthropic` Watcher it is off unless you set it: a cloud model is never unloaded, and each ping would be a paid request.

## Two roles, one loaded model

Some servers keep only one model in memory and swap on request (a llama.cpp router with one model at a time, or a model switcher in front of a single-model server). With two different models for the Watcher and the Partner on such a server, every remark would swap twice: once for the Watcher's score and once for the Partner's words.

The simple fix is one model for both roles (`"model"` in the config; see [config.md](config.md#one-model)): a mid-sized model answers the Watcher's short question fast enough, without thinking, and the Partner asks it with thinking. On a shared server the Watcher also waits while the Partner works, so a score never queues behind a long answer, and your question cancels a remark still being written. If you configure two models on one server anyway, Pair avoids the swaps where the server says which models it has loaded (its `/models` list then marks each one loaded or not): while only the Partner's model is loaded, the Watcher scores with that one. When the Watcher's own model is loaded, or none is, the Watcher uses its own.

A server that does not say what it has loaded shows it in the time it takes. The daemon times each Watcher call and notes whether a Partner turn came before it. The Watcher's usual time is known once two of its calls came with no Partner turn before them. From then on, when two calls in a row after a Partner turn take over 2 s and over four times that usual time, the server is reloading on each switch, and the Watcher scores with the Partner's model. A server that is slow every time is not taken for one that swaps: before the usual time is known, slow calls count for nothing. `pair doctor` measures it too: it asks the Watcher right after the Partner and then again, and a `swap` line says whether the first took far longer. The daemon's log says when the Watcher switches. The health probe follows the same choice, so it does not swap models either.

What Pair cannot change is a server that is slow on every request: each new moment (one not remembered, above) waits for one Watcher call, and `pair doctor` warns when that takes over 1.5 s.

## Thinking: the Partner, not the Watcher

The Watcher only scores. It runs on every candidate remark, answers with one number in at most 8 tokens, and must stay
under a second; thinking would make it many times slower and leave no room for the number. Pair never asks it to
think: with `"reasoning": true` on its entry, Pair switches its thinking off, and `pair doctor` warns when the
Watcher's model thinks anyway (a model that thinks by default, on a server whose thinking switch Pair does not know).
Keep-warm and the time it takes are as they were.

The Partner's words are what you act on, so it thinks before it answers, in every role:

| Kind of turn | Default | Key in `thinking` |
| --- | --- | --- |
| An answer to your question, as Navigator | `medium` | `navigator` |
| A Scout investigation | `medium` | `scout` |
| A Driver change | `medium` | `driver` |
| A remark nobody asked for | `low` | `remark` |

A remark may come a few seconds later than it would without thinking; the Watcher has already decided it is worth
saying, and a wrong remark costs you more than the wait. `"thinking": "high"` makes every turn think more,
`"thinking": {"remark": "medium"}` only remarks, and `"thinking": "off"` switches it off: an explicit choice, never
the default. Off, the wrong turn and the regression checks trace the code badly (above).

- **Room for it.** Thinking counts toward `maxTokens`, so the Partner's default is 2048 for the answer plus the
  thinking budget of its highest level (8192 for `medium`, 16384 for `high`). With too little, the thinking uses up
  the answer and Pair says nothing.
- **Time for it.** While the Partner thinks, the model may take up to four minutes to start its reply instead of 90
  seconds, for servers that send nothing until the thinking is done.
- **Levels, or only on and off.** With the `anthropic` API each level is a thinking budget of its own, and a
  provider's levels come from pi-ai's catalog. An OpenAI-compatible server gets a level only if its entry says how:
  `"compat": {"supportsReasoningEffort": true}` sends it as `reasoning_effort` (OpenAI's API and many cloud servers
  take it), and `"compat": {"thinkingTokenBudgetField": "<field>"}` sends the level's token budget in the field the
  server names (`thinking_budget_tokens` for llama.cpp, `thinking_token_budget` for vLLM, `thinking_budget` for
  SGLang). `compat.thinkingFormat` sets the thinking switch of the model's chat template (see pi-ai's "OpenAI
  Compatibility Settings"), and `compat.chatTemplateKwargs` the values the template gets. `"thinkingLevelMap"` on the
  entry sends a level by the server's own name for it, for example `{"minimal": "low", "xhigh": "high"}` for a
  server that has only three. Pair sends none of this by default, since most local servers reject or ignore it.
- **`pair doctor --thinking` finds them.** There is no way to ask a server which fields it takes, so the probe
  tries them on the Partner's model, one request at a time (a dozen or two in all, a minute or so on a local
  server): first how thinking switches (as Pair asks by default, the chat template's `enable_thinking` or
  `thinking`, a `thinking` field, `reasoning_effort`), thinking off must not think and `high` must; then how levels
  get through. A server that rejects a `reasoning_effort` it does not have reads the field; otherwise a level counts
  when `high` thinks clearly more than `low` held to a 32-token budget. It keeps the other keys of your `compat`, and
  ends with the line to paste, a level map included when the server rejects `minimal` or `xhigh` and your
  `thinking` uses them. Against a cloud API that takes `reasoning_effort` it found that in five requests.
- **Models that cannot switch it.** With `"reasoning": false` Pair sends no thinking level, and the model thinks as
  it always does. A model with a thinking switch in its chat template needs it set, or Pair cannot switch it at all.
- **`pair doctor` checks it.** It asks the Partner a short sum with thinking on and says whether it failed (the model
  cannot think) or answered without thinking. It also says whether your levels send the model different requests,
  or only switch thinking on. With thinking off, or `"reasoning": false`, it says whether the model thinks anyway.
  Where something is off, it points to `pair doctor --thinking`.
- **What it bought.** Against a fast cloud model that takes the level as `reasoning_effort`, three runs each of the
  live suite and the scripted session, with thinking off and then with these defaults: real drift was named in 0 of
  3 runs without thinking and 3 of 3 with it; the regression's fix landed in the right file 2 of 3 times without and
  3 of 3 with; the whole suite went from 92 to 96 passes of 96. Answers to questions took about 1 to 4 s longer;
  remarks, at `low`, about as long as before; the Watcher's median stayed under a second (789 ms before, 800 ms
  after).
- **What you see.** While the model of a turn that thinks is at work, the Neovim statusline spins
  `⠹ pair · thinking` (or `◎ pair has the wheel · thinking` as Driver). While one of its tools runs, the statusline
  shows that instead: what it reads, or as Driver, `any key takes it back` while it types. It goes back to rest with
  the answer, or silence.

## Measuring it

`pair doctor` times one short answer of each model. The live tests time the Watcher on each scenario, and the scripted session (`test/live/dogfood.test.mjs`) plays a twelve-minute session through a real Pair session on a simulated clock: edits, a failing test watched, a `grep` that finds nothing, the same failure again, a typo in new code, a failure missed while in the editor, a stall, a question, and drift into unrelated code. It prints the whole session like a transcript, with every gate decision and every remark, and checks that Pair spoke two to four times, on the repeated failure and on the drift among them.
