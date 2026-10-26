# See a crash and a compiler error. Pair runs `make run` on each save: a missing semicolon marks its line; the
# fix builds and crashes, Alt-j goes to the frame in probe.c, and Pair says why; a new warning gets a margin note.
Output out/crash.mp4
Source tapes/head.tape
Hide
Type "cd $CAP/probe && clear && nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua probe.c"
Enter
Sleep 1.5s
Type ":echo"
Enter
Type "11G"
Sleep 400ms
Show
Sleep 800ms
Type "^C"
Type "return key * 31"
Escape
Sleep 300ms
Type ":w"
Enter
Sleep 3.5s
Screenshot out/build-error.png
Sleep 1s
Type "A;"
Escape
Sleep 300ms
Type ":w"
Enter
Sleep 1.8s
Alt+j
Sleep 300ms
Screenshot out/crash-jump.png
Sleep 6.7s
Screenshot out/crash.png
Sleep 2.5s
Type "uu"
Sleep 400ms
Type "25Go"
Type "unsigned worst = 0;"
Escape
Sleep 300ms
Type ":w"
Enter
Sleep 4s
Screenshot out/new-warning.png
Sleep 2s
