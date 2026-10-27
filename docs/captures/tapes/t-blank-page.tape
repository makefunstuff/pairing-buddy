# Tutorial · the blank page. An empty folder, :Pair new and one sentence: Pair (a real model) asks a question at a
# time under your last answer, then suggests the first slice in the note, and Alt-y takes it in.
Output out/t-blank-page.mp4
Source tutorial/head.tape
Hide
Type "PS1='\W $ ' && alias nvim='CAP_NO_HERDR=1 nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua' && cd $CAP/ticks && clear"
Enter
Sleep 500ms
Show
Sleep 1.5s
Type "ls -a"
Enter
Sleep 2s
Type "nvim"
Enter
Sleep 2s
Type ":Pair new a tiny C toy with a Makefile, to see how a fixed-timestep loop catches up after a stall"
Sleep 800ms
Enter
Wait+Screen@60s /●.*\?/
Sleep 3s
Type "o- printed numbers: one line per frame with the frame, the steps that frame and the total"
Escape
Sleep 25s
Type "o- one real sleep of half a second at frame 20; the sim steps at 50 Hz"
Escape
Sleep 25s
Type "o- no cap on the steps yet: I want to see all 25 land in one frame"
Escape
Wait+Screen@90s /M-y/
Sleep 6s
Screenshot out/t-blank-slice.png
Alt+y
Sleep 4s
