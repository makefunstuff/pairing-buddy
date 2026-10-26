# Notes in the margin. You finish a sentence in a design note; at the pause the rule marks a repeated paragraph, and
# when you stop, the model's four marks join it. Alt-l opens the code a mark names. You fix line 20 and its marks
# go; you write a decision, Alt-d logs it in docs/decisions.md; :Pair tasks lists the work, y copies it.
Output out/notes.mp4
Source tapes/head.tape
Hide
Type "cd $CAP/hookd && clear && nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua docs/dead-letters.md"
Enter
Sleep 2s
Type "21G$"
Sleep 300ms
Show
Sleep 800ms
Type "ak."
Escape
Sleep 2.5s
Screenshot out/notes-repeat.png
Sleep 10.5s
Screenshot out/notes-margin.png
Sleep 1.5s
Type "4G"
Sleep 400ms
Alt+l
Sleep 2.2s
Type ":close"
Enter
Sleep 800ms
Type "20G0f6"
Sleep 500ms
Type "r5"
Sleep 1.5s
Type "19Go"
Type "Decision: replay keeps the attempt cap; it gets the budget back, not new attempts"
Escape
Sleep 3s
Alt+d
Sleep 2s
Screenshot out/notes-decision.png
Sleep 1s
Type ":Pair tasks"
Enter
Sleep 2.2s
Screenshot out/notes-tasks.png
Sleep 1.5s
Type "y"
Sleep 2.5s
