# 05 · the first run. The slice is in the note. Handed the wheel twice, Pair types the Makefile and then main.c into
# new buffers; you save them, and make run shows the 25 steps that land in the frame after the stall.
Output out/first-run.mp4
Source tapes/head.tape
Hide
Type "cd $CAP/ticks && clear && nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua NOTES.md"
Enter
Sleep 2s
Type "9G"
Show
Sleep 1.2s
Type ":Pair drive the Makefile from the slice"
Sleep 500ms
Enter
Sleep 9.5s
Type ":Pair drive now main.c, as the slice says"
Sleep 500ms
Enter
Sleep 5.5s
Screenshot out/first-run-typing.png
Sleep 6s
Screenshot out/first-run-typed.png
Type ":wa"
Enter
Sleep 800ms
Type ":vertical botright terminal make run"
Enter
Sleep 4s
Screenshot out/first-run.png
Sleep 1.5s
