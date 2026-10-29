# Tutorial · the chat pane. You fix the budget check and save; the tests on save find the lease regression, and
# Pair's remark lands in the chat with its diff and action line. In the chat, Alt-Up picks it and + rates it useful.
# Then a question that names a file with @, the answer streaming in under what Pair read, the / menu, and ? for the
# keys. VHS has no Alt+Up: Alt+[ and "1;3A" are the bytes a terminal sends for it.
Output out/t-chat.mp4
Source tutorial/head.tape
Hide
Type "cd $CAP/hookd && clear && CAP_NO_HERDR=1 nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua +35 internal/delivery/worker.go"
Enter
Sleep 1.5s
Source tutorial/chat.tape
Type "retries reach the budget"
Source tutorial/code.tape
Type "f="
Sleep 300ms
Show
Sleep 2s
Type ":w"
Enter
Sleep 5s
Type "x"
Sleep 700ms
Type ":w"
Enter
Wait+Screen@120s /a apply/
Sleep 5s
Ctrl+w
Type "l"
Type "i"
Sleep 1s
Alt+[
Type@5ms "1;3A"
Sleep 3.5s
Type "+"
Sleep 4s
Type "why does the lease end before the last attempt? "
Sleep 300ms
Type "@queue"
Sleep 2s
Tab
Sleep 1s
Enter
Sleep 3s
Wait+Screen@120s /◉ watching/
Sleep 4s
Type "/"
Sleep 2.5s
Type "gen"
Sleep 2.5s
Ctrl+u
Sleep 1s
Ctrl+c
Sleep 1s
Type "?"
Sleep 5s
Type "q"
Sleep 2s
