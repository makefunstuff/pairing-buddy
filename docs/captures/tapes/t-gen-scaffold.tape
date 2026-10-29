# Tutorial · /gen scaffold --branch. You ask for a small command and its test, wired to the retry package, in a git
# worktree on a branch of its own; Pair builds and checks it there. The gen card lists its files; Alt-Up and k put
# /keep on the line with them in a menu, and Enter keeps one as a buffer to review.
Output out/t-gen-scaffold.mp4
Source tutorial/head.tape
Hide
Type "cd $CAP/hookd && clear && CAP_NO_HERDR=1 nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua internal/retry/backoff.go"
Enter
Sleep 1.5s
Source tutorial/chat.tape
Type "retries reach the budget"
Source tutorial/code.tape
Ctrl+w
Type "l"
Type "i"
Sleep 300ms
Show
Sleep 2s
Type "/gen scaffold --branch a cmd/schedule command that prints the waits for -base -max -n, using retry.Backoff, with a test"
Sleep 600ms
Enter
Sleep 3s
Wait+Screen@600s / kept/
Sleep 8s
Alt+[
Type@5ms "1;3A"
Sleep 2.5s
Type "k"
Sleep 3s
Enter
Sleep 8s
