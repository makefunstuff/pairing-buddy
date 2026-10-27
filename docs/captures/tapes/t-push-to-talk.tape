# Tutorial · voice. In worker.go you hold Alt-t and ask aloud (the stage plays the question into the recorder);
# the meter moves under your line, you let go, whisper.cpp writes down what it heard, and Pair (a real model)
# answers in its place. Needs CAP_WHISPER_MODEL (see ../README.md).
Output out/t-push-to-talk.mp4
Source tutorial/head.tape
Hide
Type "cd $CAP/hookd && clear && CAP_NO_HERDR=1 nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua +31 internal/delivery/worker.go"
Enter
Sleep 1.5s
Source tutorial/chat.tape
Type "retries reach the budget"
Source tutorial/terminal.tape
Type "zz"
Sleep 300ms
Show
Sleep 2s
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Screenshot out/t-listening.png
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Alt+t
Sleep 40ms
Sleep 1.2s
Screenshot out/t-heard.png
Sleep 25s
Screenshot out/t-answer.png
Sleep 3s
