# Tutorial · exploring code: the wrong turn. The delivery test fails in your terminal; you open backoff.go and change
# the shift. Pair (a real model) reads, says under your edit why that is the wrong place, and Alt-j goes where it points.
Output out/t-wrong-turn.mp4
Source tutorial/head.tape
Hide
Type "cd $CAP/hookd && clear && CAP_NO_HERDR=1 nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua internal/delivery/worker_test.go"
Enter
Sleep 1.5s
Source tutorial/chat.tape
Type "retries reach the budget"
Source tutorial/terminal.tape
Type "14G^"
Ctrl+w
Type "j"
Type "i"
Sleep 300ms
Show
Sleep 2s
Type "go test ./internal/delivery/"
Enter
Sleep 3s
Escape
Ctrl+w
Type "k"
Sleep 800ms
Type ":e internal/retry/backoff.go"
Enter
Sleep 1s
Type "20Gf("
Sleep 600ms
Type "da(aattempt"
Escape
Wait+Screen@90s /worker\.go:3[56]/
Sleep 8s
Screenshot out/t-remark.png
Alt+j
Sleep 6s
Screenshot out/t-jump.png
Sleep 2s
