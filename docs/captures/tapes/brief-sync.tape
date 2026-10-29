# /brief sync (tutorial): on HKD-31's branch, NOTES.md has a line the task's brief on the board lacks; the chat says
# so and offers to tell its agent.
Output out/brief-sync.mp4
Source tapes/head.tape
Hide
Type "cd $CAP/hookd && clear && nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua internal/queue/queue.go"
Enter
Sleep 1.5s
Type ":botright vnew | setlocal nonumber signcolumn=no | vertical resize 56 | terminal $CAP_REPO/bin/pair.mjs chat"
Enter
Sleep 2.5s
Ctrl+w
Type "h"
Type ":echo"
Enter
Ctrl+w
Type "l"
Type "i"
Sleep 300ms
Show
Sleep 800ms
Type "/brief sync"
Sleep 400ms
Enter
Sleep 2s
Screenshot out/brief-sync.png
Type "y"
Sleep 2s
Screenshot out/brief-told.png
Sleep 1s
