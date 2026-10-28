# The chat pane's layouts: the chat scene's remark on save and question in a narrow pane (44 columns, as herdr's side
# panes often are): the gutter stays, code wraps between its tokens, the header, the └ line and the footer say less,
# and a remark names its file by its base name.
# Then the same pane made wide (112 columns): the words end by column 80, the code runs on, and the answer's time,
# duration and tokens sit in its margin.
Output out/chat-layout.mp4
Source tapes/head.tape
Hide
Type "cd $CAP/hookd && clear && nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua internal/delivery/worker.go"
Enter
Sleep 1.5s
Type ":botright vnew | setlocal nonumber signcolumn=no | vertical resize 44 | terminal $CAP_REPO/bin/pair.mjs chat"
Enter
Sleep 2.5s
Ctrl+w
Type "h"
Type ":echo"
Enter
Type "35Gf="
Sleep 400ms
Show
Sleep 1s
Type ":w"
Enter
Sleep 4.5s
Type "x"
Sleep 700ms
Type ":w"
Enter
Sleep 9s
Ctrl+w
Type "l"
Type "i"
Sleep 500ms
Type "why attempt 5 and not 4?"
Sleep 300ms
Enter
Sleep 7s
Screenshot out/chat-narrow.png
Ctrl+\
Ctrl+n
Type ":vertical resize 112"
Enter
Sleep 300ms
Type "i"
Sleep 1.5s
Screenshot out/chat-wide.png
Sleep 1s
