# Install in two commands, in a sandbox home (the login `pair setup` offers is skipped with Enter): npm installs into it, and `pair setup` meets the systemctl stand-in.
# run.sh fills in @PBCAP@ (its scratch dir) and @HERE@ (this folder).
Output "@HERE@/../clips/install.mp4"
Source "@HERE@/head.tape"

Hide
Type "source @PBCAP@/env.sh && cd ~ && clear"
Enter
Sleep 1s
Show
Sleep 1500ms
Type "npm install -g github:makefunstuff/pairing-buddy"
Sleep 800ms
Enter
Wait+Screen@180s /added \d+ packages/
Sleep 3s
Type "pair setup"
Sleep 800ms
Enter
Wait+Screen@60s /Enter to skip/
Sleep 2500ms
Enter
Wait+Screen@60s /check everything/
Sleep 10s
Hide
