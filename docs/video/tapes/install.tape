# Recorded with VHS 0.11 from docs/video, as a user whose home holds ~/shop (sample-shop/), the Neovim config
# from the README's lazy.nvim spec and a pair config whose two models answer at the example endpoint.
Output "clips/install.mp4"
Source "tapes/head.tape"
Set FontSize 24
Hide
Type "cd ~ && clear"
Enter
Sleep 500ms
Show
Sleep 1s
Type "npm install -g github:makefunstuff/pairing-buddy"
Sleep 500ms
Enter
Wait+Screen@120s /added \d+ packages/
Sleep 2s
Type "pair setup"
Sleep 400ms
Enter
Wait+Screen@60s /Run `pair doctor`/
Sleep 7s
Type "clear; nvim ~/.config/pairing-buddy/config.json"
Enter
Sleep 2500ms
Type "/models"
Enter
Type "zt"
Sleep 4s
Type ":%s/your-//g"
Sleep 800ms
Enter
Sleep 4s
Type ":wq"
Enter
Sleep 800ms
Type "systemctl --user restart pairing-buddy"
Sleep 400ms
Enter
Sleep 2500ms
Type "nvim ~/.config/nvim/init.lua"
Enter
Sleep 8s
Type ":q"
Enter
Sleep 500ms
