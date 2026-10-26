# 01 · it stops the wrong turn. The delivery test fails in the :terminal (the shell hook reports it); you open
# backoff.go and change the shift; Pair reads, says why under your edit, and Alt-j goes to the real cause.
Output out/wrong-turn.mp4
Source tapes/head.tape
Hide
Type "cd $CAP/hookd && clear && nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua internal/delivery/worker_test.go"
Enter
Sleep 1.5s
Type ":botright split | resize 8 | terminal"
Enter
Sleep 700ms
Type ":echo"
Enter
Type "i"
Sleep 300ms
Type "clear"
Enter
Sleep 300ms
Show
Type "go test ./internal/delivery/"
Enter
Sleep 2s
Escape
Ctrl+w
Type "k"
Sleep 500ms
Type ":e internal/retry/backoff.go"
Enter
Sleep 900ms
Type "20Gf("
Sleep 400ms
Type "da(aattempt"
Escape
Sleep 2.9s
Screenshot out/gaze.png
Sleep 3.3s
Screenshot out/remark.png
Sleep 2.5s
Type "u"
Sleep 900ms
Alt+j
Sleep 1.4s
Screenshot out/jump.png
Sleep 1.5s
Type "lx"
Sleep 500ms
Type ":w"
Enter
Sleep 600ms
Ctrl+w
Type "j"
Type "i"
Type "go test ./internal/delivery/"
Enter
Sleep 3s
