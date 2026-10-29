# :Pair review (tutorial): HKD-31 is ready to merge; its branch opens as a review list, Enter shows a file's diff,
# and k keeps the change under the cursor in your own buffer, unsaved.
Output out/review.mp4
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
Type ":Pair review HKD-31"
Sleep 400ms
Enter
Sleep 3s
Screenshot out/review.png
Type "/worker.go"
Enter
Type ":nohlsearch"
Enter
Enter
Sleep 1.5s
Screenshot out/review-diff.png
Sleep 1s
