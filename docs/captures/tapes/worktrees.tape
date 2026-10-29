# Two worktrees (tutorial): a second worktree of hookd, on its own branch, with its own Neovim and chat: its own
# session, named after its folder, with the goal from its branch.
Output out/worktrees.mp4
Source tapes/head.tape
Hide
Type "cd $CAP/hookd && git worktree add -q ../hookd-lease -b lease-outlives-attempts && cd ../hookd-lease && clear"
Enter
Sleep 500ms
Type "nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua internal/queue/queue.go"
Enter
Sleep 1.5s
Type ":botright vnew | setlocal nonumber signcolumn=no | vertical resize 56 | terminal $CAP_REPO/bin/pair.mjs chat"
Enter
Sleep 3s
Ctrl+w
Type "h"
Type ":echo"
Enter
Show
Sleep 4s
Screenshot out/worktrees.png
Sleep 1s
