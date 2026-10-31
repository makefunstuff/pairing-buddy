---
description: "How Pair talks: short, specific and plain, like a colleague in the second chair rather than an assistant, and how that is tested."
---

# Pair's tone

Pair has a visual language in Neovim ([neovim.md](neovim.md)). This is the same for its words. Most of what makes
a partner pleasant to sit next to all day is how it talks, and models drift toward the assistant tone unless the
spec is explicit and tested.

## The spec

It is in the Partner's instructions in [src/tone.mjs](../src/tone.mjs) (the idea's 45-word limit in the request for it):

- A senior colleague in the second chair, not an assistant.
- Lead with the fact, then the reason; name `file:line`. Use the numbers.
- Never praise, apologize, hedge with filler, or use emoji or exclamation marks. Say "I" rarely.
- If unsure, say so in a few words and say how you'd check.
- Celebrate only by naming what is now true, in one line.
- Plain sentences: no headings, bold or lists. Put code in `backticks` (Neovim shows it in the accent).
- Do not narrate your tools ("I pointed at", "Suggested a fix"): the user sees what they show.
- Say each thing once: the notes of `point` and `suggest` already show, so do not say them again.
- Never say you did what did not happen: a suggestion is made only when the user takes it, so not "Added".
- A remark nobody asked for, or what the Driver changed: one or two short lines, **at most 30 words**. An answer:
  **at most 80 words**, unless you ask for more. The idea behind a remark: **at most 45**.

Each watch and question input ends with its limit again, asking for less (about 20 of a remark's 30 words, 40 of an
answer's 80, 30 of the idea's 45): models follow an
instruction next to the moment far better than a rule in the system prompt, and they overshoot a hard limit.

What it changes, on the same moment (a test is red and you edit the wrong file; the bug is `>=` in `worker.go:35`),
from one model under two instructions:

> **A plain assistant:** `>=` here treats a wait that exactly fills the budget as over-budget, so attempt 5 is
> dropped; use `>` to allow waits that land exactly on `cfg.Budget`. *(27 words)*
>
> **The pair:** The shift was already right; `worker.go:35` uses `>=`, so 7s+8s=15s stops one attempt early.
> Change it to `>`. *(18 words)*

And when the tests go green after a long red, the plain assistant wrote a 213-word review with "Good catch" and
bold headings; the pair wrote one line on what is now true and one next step, in 29 words.

## One voice

What Pair does around its words reads like the same colleague, not a tool log:

- **No ceremony for one change.** A hand-over of one change prints no role lines before or after it; the edit, the
  check and Pair's sentence say what happened. `/scout`, `/navigate` and `/drive!` still say what the role may do.
- **Checks said as speech.** After its edit, Pair says `Ran your \`npm test\` on it: 9 pass.`, once: the command as you
  know it, without the redirects and pipes around it. The model hears that you already have it, and does not repeat
  it. A run on save says `\`npm test\` after you saved cart.js: 2 failed (…)` the same way.
- **Plumbing out of sight.** Pair's pane shows `pair-run npm test`, not the `cd` into a scratch copy and the file
  its output goes to ([scout.md](scout.md#tests-on-save)).
- **One remark, once.** The notes of its points and suggestions show in the editor and the chat; closing words that
  only say them again are not shown.
- **Only what happened.** Words that say a suggestion was made (`Added the bogo branch`) are not shown before you
  take it.

Nothing is hidden for it: the ledger (`:Pair today`) keeps every step, the hand-over (`wheel`), the whole command
line and its output (`⏎ output`), and the words it did not show, with why.

## The idea behind it

There is one tone, not a menu of personalities. Teaching is on request: `Alt-?` on Pair's words in Neovim (or `/why`
in the chat) asks for the one idea worth keeping behind them: a principle you can reuse next time, in plain words,
not a repeat of the remark. When it is about a language, a library or a tool and the model is sure of the address,
it ends with one link to the official documentation, which `Alt-?` then opens. How it looks:
[neovim.md](neovim.md#the-idea-behind-it).

## The tests that hold it

[test/live/tone.test.mjs](../test/live/tone.test.mjs) runs a real Pair session against your live model stacks
(see [testing.md](testing.md#live-tests-against-real-models)) on a small C program with a Makefile, [test/live/probe](../test/live/probe/):
an open-addressing table that never grows, since `t->len / t->cap` is integer division, so `make run` reports an
average probe of 12.6 and fails its check. The program is built and run for real.

| Moment | Holds |
| --- | --- |
| `make run` failed twice: a remark | names `file:line`, at most 30 words |
| `Alt-?` on that remark | at most 45 words, not the remark again; a link, if any, opens |
| "why is the average probe 12.6?" | names `file:line`, at most 80 words |
| green after 23 minutes of red: "was that really it?" | names what is now true, at most 80 words |

Every one of them is checked by `toneProblems` for praise ("great", "good catch", "nice", ...), apology,
filler openers and closers ("Sure", "let me know"), emoji, `!` outside code, headings, lists and bold, and its
word limit. Code in backticks and links count as one word each.

The Partner's other live tests (wrong turns, regressions, Scout, the Driver, memory) run with the same instructions.
