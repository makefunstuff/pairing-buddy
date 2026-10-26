# Taking the wheel back: a key while Pair types undoes what it typed, and does nothing else.
Output out/take-back.mp4
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
Sleep 2.2s
Type "j"
Sleep 2.8s
