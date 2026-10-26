# :Pair context. No goal is typed: the session took it from the board task of the branch. A test fails in the
# :terminal, you search with Telescope and /, and the card shows all of it; x hides a source and brings it back.
Output out/context-card.mp4
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
Type " g"
Sleep 700ms
Type ">= cfg.Budget"
Sleep 1.2s
Enter
Sleep 900ms
Type " f"
Sleep 700ms
Type "backoff.go"
Sleep 1s
Enter
Sleep 700ms
Type "/Max"
Enter
Sleep 900ms
Type ":Pair context"
Enter
Sleep 2.5s
Screenshot out/context.png
Sleep 1s
Type "/^ terminal"
Enter
Type ":noh"
Enter
Sleep 600ms
Type "x"
Sleep 2s
Screenshot out/context-trimmed.png
Sleep 1s
Type "x"
Sleep 1.5s
Type "q"
Sleep 1s
