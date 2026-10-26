# Teach on request. make run fails twice in the :terminal (the shell hook reports it); Pair says why under your line,
# with each key saying what it does, and Alt-? asks for the idea worth keeping behind the remark.
# make run fails its check (exit 1), with no crash.
Output out/teach.mp4
Source tapes/head.tape
Hide
Type "cd $CAP/probe && clear && nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua +35 -c 'set ttimeoutlen=300' table.c"
Enter
Sleep 1.5s
Type ":botright split | resize 8 | terminal"
Enter
Sleep 700ms
Type ":echo"
Enter
Type "i"
Sleep 300ms
Type "clear"
Enter
Sleep 300ms
Show
Type "make run"
Enter
Sleep 2s
Type "make run"
Enter
Sleep 300ms
Escape
Sleep 400ms
Ctrl+w
Type "kzz"
Sleep 4.6s
Screenshot out/teach-hint.png
Sleep 2s
# VHS has no Alt+? key: Escape and ? in one go are what a terminal sends for it (hence ttimeoutlen above).
Escape
Type@1ms "?"
Sleep 1s
Screenshot out/teach-asked.png
Sleep 3.5s
Screenshot out/teach.png
Sleep 3s
