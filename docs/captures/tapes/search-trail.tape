# 04 · the search trail. The delivery test fails in the :terminal; you grep for "give up" (nothing), "dead letter"
# (one comment) and find-file "retry", which opens backoff.go. Pair says where it is in the code's word; :Pair trail
# shows what it saw, and Alt-j goes there.
Output out/search-trail.mp4
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
Sleep 800ms
Type " sg"
Sleep 700ms
Type "give up"
Sleep 1.4s
Escape
Escape
Sleep 700ms
Type " sg"
Sleep 700ms
Type "dead letter"
Sleep 1.6s
Escape
Escape
Sleep 700ms
Type " sf"
Sleep 700ms
Type "retry"
Sleep 1.4s
Enter
Sleep 900ms
Type "12G"
Sleep 7s
Screenshot out/trail-cue.png
Sleep 2s
Type ":Pair trail"
Enter
Sleep 1.5s
Screenshot out/trail-panel.png
Sleep 2.5s
Type "q"
Sleep 600ms
Alt+j
Sleep 1.4s
Screenshot out/trail-jump.png
Sleep 2s
