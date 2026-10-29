# Tutorial · overlap and /brief sync. You work on HKD-7's branch; HKD-8's agent is changing worker.go's budget check
# in its own worktree. The winbar says so. You change the same line: when you save, Pair says what HKD-8 does there.
# Then /brief sync in the chat: what HKD-7's brief on the board lacks from NOTES.md, and y tells its agent.
Output out/t-overlap.mp4
Source tutorial/head.tape
Hide
Type "cd $CAP/hookd && clear && CAP_NO_HERDR=1 nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua +35 internal/delivery/worker.go"
Enter
Sleep 1.5s
Type ":Pair chat"
Enter
Sleep 5s
Sleep 300ms
Escape
Ctrl+w
Type "h"
Type ":echo"
Enter
Type "f="
Sleep 2s
Show
Sleep 5s
Type "x"
Escape
Sleep 1.5s
Type ":w"
Enter
Wait+Screen@120s /overlap/
Sleep 10s
Ctrl+w
Type "l"
Type "i"
Sleep 1s
Type "/brief sync"
Sleep 600ms
Enter
Wait+Screen@60s /tell HKD-7/
Sleep 8s
Type "y"
Sleep 5s
