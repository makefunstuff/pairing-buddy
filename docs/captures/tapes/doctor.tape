# pair doctor (tutorial): one line per part, run in your terminal in Neovim, with the scene's daemon and models.
Output out/doctor.mp4
Source tapes/head.tape
Hide
Type "cd $CAP/hookd && clear && nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua internal/delivery/worker.go"
Enter
Sleep 1.5s
Type ":terminal"
Enter
Sleep 700ms
Type "i"
Type "alias pair=$CAP_REPO/bin/pair.mjs; clear"
Enter
Sleep 500ms
Show
Sleep 600ms
Type "pair doctor"
Sleep 300ms
Enter
Sleep 9s
Screenshot out/doctor.png
Sleep 1s
