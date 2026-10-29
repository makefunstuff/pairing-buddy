# /gen board (tutorial): :Pair gen board opens the task's brief, written from yours, to edit; :w asks how to add it,
# and the pick adds it to the board (the stand-in, board.mjs).
Output out/gen-board.mp4
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
Show
Sleep 800ms
Type ":Pair gen board park webhooks that run out of attempts, for a replay later"
Sleep 500ms
Enter
Sleep 2.5s
Screenshot out/board-compose.png
Type ":w"
Enter
Sleep 1.5s
Screenshot out/board-pick.png
Type "1"
Enter
Sleep 3s
Screenshot out/board-added.png
Sleep 1s
