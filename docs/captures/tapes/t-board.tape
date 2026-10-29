# Tutorial · the board (Shepherdr; board.mjs stands in). In the chat, /gen board hands a request to the board: Pair
# shows the command with its brief, and d adds the task and delegates it. While you type, HKD-22's agent is done;
# you save, and one line says so, in the statusline and the chat. :Pair agents lists the tasks; d opens HKD-22's diff
# and t a terminal in its worktree. Alt-r reviews it: the reviewer's facts, the brief's check, and its files to keep.
Output out/t-board.mp4
Source tutorial/head.tape
Hide
Type "cd $CAP/hookd && clear && CAP_NO_HERDR=1 nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua +35 internal/delivery/worker.go"
Enter
Sleep 1.5s
Source tutorial/chat.tape
Type "retries reach the budget"
Source tutorial/code.tape
Ctrl+w
Type "l"
Type "i"
Sleep 300ms
Show
Sleep 3s
Type "/gen board a dead-letter replay command"
Sleep 600ms
Enter
Wait+Screen@60s /gen #1 waits for your answer/
Sleep 7s
Type "d"
Sleep 6s
Escape
Ctrl+w
Type "h"
Sleep 1s
Type "O// a webhook out of budget is parked as a dead letter"
Escape
Sleep 2s
Type ":w"
Enter
Wait+Screen@60s /ready to merge/
Sleep 7s
Type ":Pair agents"
Enter
Sleep 4s
Type "d"
Sleep 6s
Type "q"
Sleep 1s
Type "t"
Sleep 2s
Type "git log --oneline -1"
Enter
Sleep 3s
Escape
Type ":close"
Enter
Sleep 1s
Type "q"
Sleep 2s
Alt+r
Sleep 12s
Type "/deadletter.go"
Enter
Sleep 1.5s
Type "k"
Sleep 6s
