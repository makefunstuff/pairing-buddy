# Tutorial · hand-over. :Pair drive and the cases you want: Pair (a real model) has the wheel, types the cases as you watch,
# tests the unsaved buffer and hands back; u takes the whole change away in one step, Ctrl-r brings it back.
Output out/t-hand-over.mp4
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
Wait+Screen@180s /u undoes/
Sleep 8s
Screenshot out/t-handed-back.png
Type "u"
Sleep 3s
Screenshot out/t-undone.png
Ctrl+R
Sleep 3s
