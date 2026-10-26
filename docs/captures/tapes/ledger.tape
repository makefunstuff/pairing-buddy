# The ledger. Off screen, a morning: Pair runs the tests on save, finds the regression and Alt-y takes its fix; you
# hand over the edge cases, then write a comment above them and save. On screen, :Pair today lists all of it, and u
# on the six cases takes them back while your comment stays; u again brings them back.
Output out/ledger.mp4
Source tapes/head.tape
Hide
Type "cd $CAP/hookd && clear && nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua internal/delivery/worker.go"
Enter
Sleep 1.5s
Type "35Gf="
Type ":w"
Enter
Sleep 4.5s
Type "x"
Sleep 700ms
Type ":w"
Enter
Sleep 8s
Alt+j
Sleep 1.5s
Alt+y
Sleep 800ms
Type ":w"
Enter
Sleep 5s
Type ":edit internal/retry/backoff_test.go"
Enter
Sleep 500ms
Type "15G^"
Type ":Pair drive the edge cases"
Enter
Sleep 11s
Type "8GO// Next waits Base, then twice as long each attempt, up to Max."
Escape
Type ":w"
Enter
Sleep 5s
Type ":echo"
Enter
Show
Sleep 1.2s
Type ":Pair today"
Sleep 500ms
Enter
Sleep 2.5s
Type "3k"
Sleep 1.2s
Screenshot out/ledger.png
Type "u"
Sleep 2.8s
Screenshot out/ledger-undone.png
Type "u"
Sleep 2.5s
