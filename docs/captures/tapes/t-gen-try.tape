# Tutorial · /gen try and /keep. You ask for a sample; Pair writes it in a folder outside the project and runs it in
# its pane, in a sandbox; it opens in a split, and the gen card says how the run went. /keep moves it into the
# project as a buffer to review.
Output out/t-gen-try.mp4
Source tutorial/head.tape
Hide
Type "cd $CAP/hookd && clear && CAP_NO_HERDR=1 nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua internal/retry/backoff.go"
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
Sleep 2s
Type "/gen try how context.WithTimeout stops a retry loop, in 30 lines"
Sleep 600ms
Enter
Sleep 3s
Wait+Screen@300s /k keep/
Sleep 8s
Type "/keep cmd/trytimeout/main.go"
Sleep 600ms
Enter
Sleep 8s
