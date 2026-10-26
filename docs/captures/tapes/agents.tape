# Your other agents: you change the hash in probe.c while #21 asks a question, #22 passes review and the notes agent
# finishes. Nothing shows while you type; you save, and one line comes in the statusline. :Pair agents has them all.
Output out/agents.mp4
Source tapes/head.tape
Hide
Type "cd $CAP/hashtab && clear && nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua probe.c"
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
Type "make -s && ./probe"
Enter
Sleep 2s
Escape
Ctrl+w
Type "k"
Sleep 600ms
Type "12G$F4"
Sleep 500ms
Type "cw44"
Sleep 300ms
Escape
Type "A // 20 bits: half the slots, more probes?"
Escape
Sleep 1.5s
Type ":w"
Enter
Sleep 5s
Screenshot out/agents-line.png
Sleep 2s
Type ":Pair agents"
Enter
Sleep 2.8s
Screenshot out/agents-list.png
Sleep 1.2s
Type "q"
Sleep 600ms
Ctrl+w
Type "j"
Type "i"
Type "make -s && ./probe"
Enter
Sleep 2.5s
