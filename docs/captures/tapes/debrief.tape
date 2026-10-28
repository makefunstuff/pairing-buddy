# The day's end. The lease fix turns the queue green; /end in the chat pane gives the day in a few lines: what is
# now true, what is left, tomorrow's first step and what Pair makes of your verdicts. e puts that step on the line
# to edit. Three hours of the day and its verdicts are seeded by the stage; the rest is the real plugin and daemon.
Output out/debrief.mp4
Source tapes/head.tape
Hide
Type "cd $CAP/hookd && clear && nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua internal/queue/queue.go"
Enter
Sleep 1.5s
Type ":botright vnew | setlocal nonumber signcolumn=no | vertical resize 58 | terminal $CAP_REPO/bin/pair.mjs chat"
Enter
Sleep 2.5s
Ctrl+w
Type "h"
Type ":echo"
Enter
Type "18Gf,"
Type ":w"
Enter
Sleep 5s
Show
Sleep 1s
Type "i + cfg.AttemptTimeout"
Escape
Sleep 300ms
Type ":w"
Enter
Sleep 5s
Ctrl+w
Type "l"
Type "i"
Sleep 400ms
Type "/end"
Sleep 300ms
Enter
Sleep 4s
Screenshot out/debrief.png
Sleep 1.5s
Type "e"
Enter
Sleep 1.5s
Screenshot out/debrief-edit.png
Sleep 1.5s
