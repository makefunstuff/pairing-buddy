# /gen scaffold (tutorial): a /healthz endpoint built and tested in Pair's copy of the project. :Pair gen list lists
# its files; k keeps one, as a buffer to review, and a change to a file of yours shows there as a suggestion.
Output out/gen-scaffold.mp4
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
Type "/gen scaffold a /healthz endpoint, served by a new cmd/hookd"
Sleep 500ms
Enter
Sleep 22s
Screenshot out/gen-scaffold-card.png
Ctrl+\
Ctrl+n
Ctrl+w
Type "h"
Type ":Pair gen list"
Enter
Sleep 1.5s
Screenshot out/gen-scaffold-list.png
Type "/queue.go"
Enter
Type ":nohlsearch"
Enter
Type "k"
Sleep 1.5s
Type "q"
Sleep 300ms
Type "G"
Sleep 2s
Screenshot out/gen-scaffold-kept.png
Sleep 1s
