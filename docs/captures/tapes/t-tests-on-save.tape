# Tutorial · tests: Pair runs go test on each save. Your fix for the budget breaks the queue's lease: a regression.
# Pair (a real model) says why under your line and suggests a fix as a ghost diff; Alt-j goes there, Alt-y takes it.
Output out/t-tests-on-save.mp4
Source tutorial/head.tape
Hide
Type "cd $CAP/hookd && clear && CAP_NO_HERDR=1 nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua internal/delivery/worker.go"
Enter
Sleep 1.5s
Source tutorial/chat.tape
Type "delivery retries reach the budget"
Source tutorial/terminal.tape
Type "35Gzzf="
Sleep 400ms
Show
Sleep 2s
Type ":w"
Enter
Sleep 7s
Type "x"
Sleep 1s
Type ":w"
Enter
Wait+Screen@150s /M-j goes/
Sleep 7s
Screenshot out/t-regression.png
Alt+j
Wait+Screen@20s /M-y/
Sleep 6s
Screenshot out/t-suggestion.png
Alt+y
Sleep 2.5s
Screenshot out/t-taken.png
Type ":w"
Enter
Wait+Screen@30s /pass/
Sleep 6s
Screenshot out/t-green.png
Sleep 2s
