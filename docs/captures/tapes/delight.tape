# Delight, sized right. Exploring in C: you grow the interning table twice, and the average probe Pair's run on
# save prints holds still. The hash was the problem: its fix moves the number, the statusline lights up once, and
# one line under yours says what moved. Five seconds later it is gone.
Output out/delight.mp4
Source tapes/head.tape
Hide
Type "cd $CAP/intern && clear && nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua intern.h"
Enter
Sleep 1.5s
Type ":echo"
Enter
Type "5Gf8"
Sleep 400ms
Show
Sleep 800ms
Type "ciw16384"
Escape
Type ":w"
Enter
Sleep 2.5s
Type "ciw32768"
Escape
Type ":w"
Enter
Sleep 2.5s
Type ":e intern.c"
Enter
Sleep 600ms
Type "5Gf0"
Sleep 500ms
Type "ciw2166136261u"
Escape
Type "7Gcc"
Type "h = (h ^ (unsigned char)*s++) * 16777619u;"
Escape
Sleep 300ms
Type ":w"
Enter
Sleep 1.5s
Screenshot out/delight.png
Sleep 6s
