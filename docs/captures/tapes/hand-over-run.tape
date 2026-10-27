# The hand-over without a test. probe.c on the left, your terminal on the right: you build and run it with make,
# then hand over with an intent and a number to reach. Pair types the edit as ghost text, builds and runs the
# unsaved buffer with your make -s run in a scratch copy, and hands back with the line the run printed next to
# your target; u takes the edit away.
Output out/hand-over-run.mp4
Source tapes/head.tape
Hide
Type "cd $CAP/loop && clear && nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua probe.c"
Enter
Sleep 1.5s
Type ":botright vnew | vertical resize 58 | terminal"
Enter
Sleep 700ms
Type ":echo"
Enter
Type "i"
Sleep 300ms
Type "clear"
Enter
Sleep 300ms
Show
Type "make -s run"
Enter
Sleep 2.5s
Escape
Ctrl+w
Type "h"
Type "13G"
Sleep 800ms
Type ":Pair drive make the ids spread over the table, avg probe stays under 2"
Sleep 600ms
Enter
Sleep 8.1s
Screenshot out/run-hand-back.png
Sleep 2.5s
Type "u"
Sleep 2s
