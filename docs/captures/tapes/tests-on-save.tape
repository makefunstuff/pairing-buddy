# 02 · it runs what you'd skip. Pair runs go test -json ./... on each save; your fix for the budget breaks the
# queue's lease, Pair says why under your line, and Alt-y takes its fix.
Output out/tests-on-save.mp4
Source tapes/head.tape
Hide
Type "cd $CAP/hookd && clear && nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua internal/delivery/worker.go"
Enter
Sleep 1.5s
Type ":botright split internal/queue/queue_test.go | resize 19 | normal! 19Gzt"
Enter
Sleep 400ms
Type ":echo"
Enter
Ctrl+w
Type "k"
Type "35Gf="
Sleep 400ms
Show
Sleep 800ms
Type ":w"
Enter
Sleep 4.5s
Type "x"
Sleep 700ms
Type ":w"
Enter
Sleep 9s
Screenshot out/regression.png
Alt+j
Sleep 3s
Screenshot out/regression-fix.png
Alt+y
Sleep 1.2s
Type ":w"
Enter
Sleep 5s
