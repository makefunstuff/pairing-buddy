# Tutorial · roles: Scout. In the chat you switch to Scout and ask why the delivery test fails; Scout's pane opens
# under the code (a :terminal, sandboxed), runs go test there, reads, and answers in the chat.
Output out/t-scout.mp4
Source tutorial/head.tape
Hide
Type "cd $CAP/hookd && clear && CAP_NO_HERDR=1 nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua internal/delivery/worker_test.go"
Enter
Sleep 1.5s
Source tutorial/chat.tape
Type "retries reach the budget"
Source tutorial/code.tape
Type "14G^"
Sleep 300ms
Show
Sleep 2s
Type ":Pair chat"
Enter
Sleep 1.5s
Type "/scout"
Sleep 500ms
Enter
Sleep 2s
Type "why does the delivery test fail? run it"
Sleep 600ms
Enter
Sleep 45s
Screenshot out/t-scout.png
Sleep 3s
