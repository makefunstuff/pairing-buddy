# Notes and the blank page

Two ways Pair helps before there is code to read: in a Markdown note it puts a few marks in the margin, and in an
empty folder `:Pair new` asks three questions and proposes a first slice that runs. It never writes your prose.

## Notes in the margin

1. Open or write a Markdown note in the project, a design note or a plan. Write as usual.
2. When you stop for about ten seconds, Pair reads the note and puts at most five marks in the margin, each with one
   line under its line:

   | Mark | Says |
   | --- | --- |
   | `?` | a question the note leaves open |
   | `≠` | two lines that cannot both hold, or a line the code contradicts |
   | `→` | what the code a line names really does: `Alt-l` opens that code in a split |
   | `◆` | a decision worth logging: `Alt-d` logs it |
   | `≈` | a paragraph that repeats an earlier one |

   ![Five marks: a link to the code, the 5-versus-6 contradiction, two questions, and the repeat](../images/notes-margin.png)

3. Change a marked line and its mark goes. `:Pair clear` takes them all away.
4. **A decision.** Write a line that starts with `Decision:`. At the next pause it gets `◆`; `Alt-d` on it (or
   `:Pair decide`) writes an entry into `decisions.md` next to the note, in a split. Pair does not save it: you do.
5. **Tasks.** `:Pair tasks` lists the note's work as tasks in a panel. Nothing is added until you press `y`; `e`
   edits the titles first, `q` closes. With a `taskCommand` in the config, `y` runs it per task; without, it copies
   them as a checklist.

   ![The tasks panel over the note](../images/notes-tasks.png)

## The blank page

1. Make an empty folder, and start Neovim there:

   ```sh
   mkdir ticks && cd ticks && nvim
   ```

2. Say what you are making, in one sentence:

   ```vim
   :Pair new a tiny C toy with a Makefile, to see how a fixed-timestep loop catches up after a stall
   ```

   `NOTES.md` opens with your sentence under a heading, unsaved, and the sentence becomes the session's goal.
3. Pair asks a short question under your last line. Answer on the lines under it, then `Esc` and leave it for a
   second and a half: the answer goes, and the next question comes. Three in all.

   ![The third question under the second answer](../images/blank-question.png)

4. After the third answer, the first slice shows under the note as a suggestion: two files, how to run them, what to
   poke at, when the first test is worth writing, what to leave out. `Alt-y` takes it into the note; `:Pair dismiss`
   drops it.

   ![The slice under the last answer: two files, nothing written yet](../images/blank-slice.png)

5. Write the two files, or hand them over: `:Pair drive the Makefile from the slice`. The Driver types a new file
   into a buffer while you watch. `:wa` saves them, and `make run` runs it.

   ![After :wa, make run: frame 20 takes 25 steps, the rest one each](../images/first-run.png)

Nothing reaches the disk until you save: the note, the slice and the files are buffers until then.

## More

[Notes in the margin](../notes.md) (the decision log, what each mark needs) and [the blank page](../blank-page.md)
(the slice's rules, the stacks it knows).
