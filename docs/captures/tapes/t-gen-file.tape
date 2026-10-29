# Tutorial · /gen file. You ask in the chat for a new test file; it comes back as a buffer to review, checked with the
# tests on the unsaved buffers. Alt-Up and k open it in Neovim (its winbar: generated, :w takes it), and :w takes it.
Output out/t-gen-file.mp4
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
Type "/gen file internal/retry/schedule_test.go, a table test for Schedule"
Sleep 600ms
Enter
Sleep 3s
Wait+Screen@540s /to review/
Sleep 6s
Alt+[
Type@5ms "1;3A"
Sleep 2.5s
Type "k"
Sleep 5s
Escape
Ctrl+w
Type "h"
Sleep 3s
Type ":w"
Enter
Sleep 6s
