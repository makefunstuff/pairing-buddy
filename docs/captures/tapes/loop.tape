# The exploration loop. probe.c on the left, your terminal on the right: you build and run it with make, four
# times. The statusline reads every run next to the one before; after a change that moved nothing, Pair says why;
# when the numbers move, it says what is now true and counts the printf left from the hunt; :Pair runs is the
# notebook of the four runs, and x takes the printf out.
Output out/loop.mp4
Source tapes/head.tape
Hide
Type "cd $CAP/loop && clear && nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua probe.c"
Enter
Sleep 1.5s
Type ":botright vnew | vertical resize 58 | terminal"
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
Type "make -s run"
Enter
Sleep 2.5s
Escape
Ctrl+w
Type "h"
Type "36G"
Sleep 600ms
Type "o"
Type 'if (e < 6) printf("bucket %u\n", hash(id));'
Escape
Type ":w"
Enter
Sleep 600ms
Ctrl+w
Type "l"
Type "i"
Type "make -s run"
Enter
Sleep 2.5s
Escape
Ctrl+w
Type "h"
Type "13G"
Sleep 500ms
Type "cc"
Type "return (key * 31) & (CAP - 1);"
Escape
Type ":w"
Enter
Sleep 600ms
Ctrl+w
Type "l"
Type "i"
Type "make -s run"
Enter
Sleep 1.5s
Escape
Ctrl+w
Type "h"
Sleep 6s
Screenshot out/loop-same.png
Sleep 1.5s
Type "13G"
Sleep 400ms
Type "cc"
Type "return (uint32_t)(key * 2654435769u) >> 14;"
Escape
Type ":w"
Enter
Sleep 600ms
Ctrl+w
Type "l"
Type "i"
Type "make -s run"
Enter
Sleep 1.5s
Escape
Ctrl+w
Type "h"
Sleep 4.5s
Screenshot out/loop-moved.png
Sleep 1.5s
Alt+j
Sleep 1.5s
Type ":Pair runs"
Enter
Sleep 2.5s
Screenshot out/loop-runs.png
Sleep 1s
Type "x"
Sleep 1.5s
Type "q"
Sleep 2s
