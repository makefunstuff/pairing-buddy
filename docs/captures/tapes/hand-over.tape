# 03 · the visible hand-over. You hand over with :Pair drive; Pair types six table cases as ghost text, tests the
# unsaved buffer with go test -overlay and hands back; u takes all six away and Ctrl-R brings them back.
Output out/hand-over.mp4
Source tapes/head.tape
Hide
Type "cd $CAP/hookd && clear && nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua internal/retry/backoff_test.go"
Enter
Sleep 2s
Type "15G^"
Sleep 300ms
Show
Sleep 1.2s
Type ":Pair drive the edge cases"
Sleep 600ms
Enter
Sleep 5.5s
Screenshot out/driving.png
Sleep 6s
Screenshot out/hand-back.png
Sleep 1.5s
Type "u"
Sleep 1.8s
Ctrl+R
Sleep 2.5s
