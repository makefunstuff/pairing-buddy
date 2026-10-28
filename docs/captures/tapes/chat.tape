# The chat pane: the full-screen pane on the right of Neovim (as `pair` opens it in herdr, here in a :terminal). Your
# fix for the budget breaks the queue's lease on save; Pair's remark shows in the chat, its suggestion as a diff. You
# ask why there; the status in the rule says what Pair reads, and the answer streams in. Ctrl-F finds the remark and picks
# it: the footer lists what you can do with it. ? shows every key.
Output out/chat.mp4
Source tapes/head.tape
Hide
Type "cd $CAP/hookd && clear && nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua internal/delivery/worker.go"
Enter
Sleep 1.5s
Type ":botright vnew | setlocal nonumber signcolumn=no | vertical resize 66 | terminal $CAP_REPO/bin/pair.mjs chat"
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
Screenshot out/chat-empty.png
Type ":w"
Enter
Sleep 4.5s
Type "x"
Sleep 700ms
Type ":w"
Enter
Sleep 9s
Screenshot out/chat-remark.png
Ctrl+w
Type "l"
Type "i"
Sleep 500ms
Type "why attempt 5 and not 4?"
Sleep 300ms
Enter
Sleep 1.3s
Screenshot out/chat-working.png
Sleep 5.5s
Screenshot out/chat-answer.png
Ctrl+f
Sleep 300ms
Type "outlive"
Sleep 500ms
Enter
Sleep 900ms
Screenshot out/chat-select.png
Ctrl+c
Sleep 300ms
Type "?"
Sleep 1.5s
Screenshot out/chat-help.png
Type "q"
Sleep 1.5s
