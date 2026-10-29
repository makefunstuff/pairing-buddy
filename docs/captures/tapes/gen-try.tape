# /gen try (tutorial): a sample asked in the chat is written and run in a folder outside the project; it opens in a
# split under the code, and :Pair keep in it moves it into the project as a buffer to review.
Output out/gen-try.mp4
Source tapes/head.tape
Hide
Type "cd $CAP/hookd && clear && nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua internal/queue/queue.go"
Enter
Sleep 1.5s
Type ":botright vnew | setlocal nonumber signcolumn=no | vertical resize 56 | terminal $CAP_REPO/bin/pair.mjs chat"
Enter
Sleep 2.5s
Type "i"
Sleep 300ms
Show
Sleep 800ms
Type "/gen try an LRU of recent job ids in 30 lines"
Sleep 500ms
Enter
Sleep 300ms
Ctrl+\
Ctrl+n
Ctrl+w
Type "h"
Sleep 16s
Screenshot out/gen-try.png
Ctrl+w
Type "j"
Type ":Pair keep internal/queue/recent.go"
Sleep 400ms
Enter
Sleep 3s
Screenshot out/gen-keep.png
Sleep 1s
