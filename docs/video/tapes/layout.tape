# The herdr layout of the session tapes: pair opens the chat pane, Neovim above a shell on the left; then the goal.
Hide
Type "cd ~/shop && clear && herdr"
Enter
Sleep 3s
Type "pair"
Enter
Wait+Screen@20s /What are/
Type "herdr pane resize --current --direction left --amount 0.12 >/dev/null; herdr pane split --current --direction down --ratio 0.6 >/dev/null; clear; nvim src/cart.mjs"
Enter
Sleep 3s
Alt+l
Sleep 500ms
Type "discount codes take a share of the subtotal"
Enter
Sleep 2s
