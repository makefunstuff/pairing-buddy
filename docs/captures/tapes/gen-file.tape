# /gen file (tutorial): asked in the chat, a test file comes back as a buffer to review in Neovim. :Pair gen list
# lists it, Enter opens it with its winbar, and :w takes it to its path.
Output out/gen-file.mp4
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
Type "/gen file a test that a released job can be leased again"
Sleep 500ms
Enter
Sleep 12s
Screenshot out/gen-file-card.png
Ctrl+\
Ctrl+n
Ctrl+w
Type "h"
Type ":Pair gen list"
Enter
Sleep 1.5s
Screenshot out/gen-list.png
Type "/release_test"
Enter
Type ":nohlsearch"
Enter
Enter
Sleep 1.5s
Screenshot out/gen-review.png
Type ":w"
Enter
Sleep 2s
Screenshot out/gen-file-taken.png
Sleep 1s
