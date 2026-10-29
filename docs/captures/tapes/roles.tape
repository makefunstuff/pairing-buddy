# The roles (tutorial): /scout in the chat; a question it answers by running the test in Pair's pane. The header
# names the role in its colour.
Output out/roles.mp4
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
Type "/scout"
Sleep 400ms
Enter
Sleep 1.5s
Screenshot out/role-scout.png
Type "why does the delivery test fail?"
Sleep 400ms
Enter
Sleep 6s
Screenshot out/role-answer.png
Sleep 1s
