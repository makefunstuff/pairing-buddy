# 04 · the blank page. An empty folder, :Pair new and one sentence: Pair asks three questions, one at a time, each
# under your last answer; then it suggests the first slice in the note, and Alt-y takes it in. Nothing is saved.
Output out/blank-page.mp4
Source tapes/head.tape
Hide
Type "PS1='\W $ ' && alias nvim='nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua' && cd $CAP/ticks && clear"
Enter
Sleep 500ms
Show
Sleep 800ms
Type "ls -a"
Enter
Sleep 1.4s
Type "nvim"
Enter
Sleep 1.5s
Type ":Pair new a tiny C toy with a Makefile, to see how a fixed-timestep loop catches up after a stall"
Sleep 500ms
Enter
Sleep 3s
Set TypingSpeed 40ms
Type "o- printed numbers. one line per frame: frame, steps this frame, total steps"
Escape
Sleep 3s
Type "o- a real sleep of half a second, once, at frame 20. the sim steps at 50 Hz"
Escape
Sleep 3.2s
Screenshot out/blank-question.png
Type "o- no cap yet, I want to see all 25 land in one frame. the cap comes after"
Escape
Sleep 5s
Screenshot out/blank-slice.png
Sleep 1.5s
Alt+y
Sleep 2.5s
