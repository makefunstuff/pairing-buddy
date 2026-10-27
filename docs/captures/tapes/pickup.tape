# The morning pick-up. Yesterday ended with the queue's lease too short. Neovim opens empty in the project and lands
# on queue.go:18, where the debrief said to start; the statusline catches up while Pair's gaze reads the lines again,
# one line says what is left, and the failing test is still in the statusline, "since yesterday". Alt-j goes to it.
Output out/pickup.mp4
Source tapes/head.tape
Hide
Type "cd $CAP/hookd && clear && nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua"
Enter
Sleep 300ms
Show
Sleep 1.4s
Screenshot out/pickup-catching-up.png
Sleep 2.6s
Screenshot out/pickup.png
Sleep 2s
Alt+j
Sleep 2.5s
Screenshot out/pickup-jump.png
Sleep 1s
