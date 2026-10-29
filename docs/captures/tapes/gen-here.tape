# /gen here (tutorial): in queue.go, under Lease, Alt-g asks for Release. The code shows as ghost lines under the
# cursor and as a card in the chat; Alt-y takes it into the buffer, unsaved, marked ┊ until you make it yours.
Output out/gen-here.mp4
Source tapes/head.tape
Hide
Type "cd $CAP/hookd && clear && nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua internal/queue/queue.go"
Enter
Sleep 1.5s
Type ":botright vnew | setlocal nonumber signcolumn=no | vertical resize 56 | terminal $CAP_REPO/bin/pair.mjs chat"
Enter
Sleep 2.5s
Ctrl+w
Type "h"
Type ":echo"
Enter
Type "28Gzz"
Sleep 400ms
Show
Sleep 1s
Alt+g
Sleep 800ms
Type "here Release, to end a job's lease early"
Sleep 600ms
Screenshot out/gen-ask.png
Enter
Sleep 6.5s
Screenshot out/gen-here-said.png
Escape
Sleep 1.5s
Screenshot out/gen-here.png
Sleep 1s
Alt+y
Sleep 2.5s
Screenshot out/gen-taken.png
Sleep 1.5s
