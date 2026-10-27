# Without herdr: one Neovim, no herdr anywhere. :Pair chat opens the chat on the right; /scout, a question, and
# Scout's pane opens as a :terminal along the bottom, where go test runs (in the sandbox), and the answer comes in the chat.
Output out/no-herdr.mp4
Source tapes/head.tape
Hide
Type "cd $CAP/hookd && clear && CAP_NO_HERDR=1 nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua internal/delivery/worker_test.go"
Enter
Sleep 1.5s
Type "14G^"
Sleep 300ms
Show
Sleep 1.2s
Type ":Pair chat"
Sleep 400ms
Enter
Sleep 3s
Type "/scout"
Enter
Sleep 2s
Type "why does the delivery test fail? run it"
Sleep 300ms
Enter
Sleep 14s
Screenshot out/no-herdr.png
Sleep 3s
