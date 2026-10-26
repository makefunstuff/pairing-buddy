# Recorded with VHS 0.11 from docs/video, as a user whose home holds ~/shop (sample-shop/), the Neovim config
# from the README's lazy.nvim spec and a pair config whose two models answer at the example endpoint.
Output "clips/session.mp4"
Source "tapes/head.tape"
Hide
Type "cd ~/shop && clear && herdr"
Enter
Sleep 3s
Show
Sleep 1500ms
Type "pair"
Sleep 400ms
Enter
Wait+Screen@20s /What are/
Sleep 2s
Hide
Type "herdr pane resize --current --direction left --amount 0.12 >/dev/null; herdr pane split --current --direction down --ratio 0.6 >/dev/null; clear; nvim src/cart.mjs"
Enter
Sleep 3s
Show
Sleep 2s
Alt+l
Sleep 800ms
Type "discount codes take a share of the subtotal"
Sleep 500ms
Enter
Sleep 3s
Alt+h
Sleep 300ms
Alt+j
Sleep 800ms
Type "pair doctor"
Enter
Wait+Screen@40s /✓ partner/
Sleep 4s
Type "clear; npm test"
Enter
Sleep 7s
Sleep 4s
Alt+l
Sleep 800ms
Type "the VIP20 test fails: why? suggest the fix"
Sleep 500ms
Enter
Sleep 45s
Sleep 8s
Alt+h
Sleep 300ms
Alt+k
Sleep 1s
Alt+y
Sleep 2s
Type ":w"
Enter
Sleep 1500ms
Alt+j
Sleep 800ms
Type "clear; npm test"
Enter
Wait+Screen@20s /pass 3/
Sleep 4s
