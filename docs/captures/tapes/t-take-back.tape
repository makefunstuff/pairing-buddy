# Tutorial · hand-over: any key you press while Pair types takes the wheel back, and what it typed goes.
Output out/t-take-back.mp4
Source tutorial/head.tape
Hide
Type "cd $CAP/hookd && clear && CAP_NO_HERDR=1 nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua internal/retry/backoff_test.go"
Enter
Sleep 1.5s
Source tutorial/chat.tape
Type "retries reach the budget"
Source tutorial/terminal.tape
Type "15G^"
Sleep 300ms
Show
Sleep 2s
Type ":Pair drive add edge cases to this table: 0, 2, 7, 64"
Sleep 800ms
Enter
# Pair is typing once the table has grown past its 22 lines.
Wait+Screen@180s / 24 /
Sleep 1s
Screenshot out/t-typing.png
Type "j"
Sleep 5s
Screenshot out/t-taken-back.png
Sleep 2s
