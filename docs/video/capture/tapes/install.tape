# Install in two commands, in a sandbox home: npm installs into it, and `pair setup` meets the systemctl stand-in.
# run.sh fills in @PBCAP@ (its scratch dir) and @HERE@ (this folder).
Output "@HERE@/../clips/install.mp4"
Source "@HERE@/head.tape"
Set FontSize 28
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
Wait+Screen@60s /pair doctor/
Sleep 10s
Hide
