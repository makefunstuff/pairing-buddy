# Getting started, after `pair setup`: a login with `pair auth`, one local model for both roles, and `pair doctor`.
# The sandbox has the plugin in its Neovim config, one Neovim connected, and the service from the systemctl
# stand-in; the model is local-model.mjs. The key typed here is made up and goes only to the sandbox's auth.json.
# run.sh fills in @PBCAP@ (its scratch dir) and @HERE@ (this folder).
Output "@HERE@/../clips/start.mp4"
Source "@HERE@/head.tape"
Set FontSize 28
Hide
Type "source @PBCAP@/env.sh && cd ~ && clear"
Enter
Sleep 1s
Show
Sleep 1200ms
Type "pair auth login anthropic"
Sleep 600ms
Enter
Wait+Screen@20s /Choose/
Sleep 1500ms
Type "2"
Sleep 500ms
Enter
Wait+Screen@20s /Enter Anthropic API key/
Sleep 800ms
Type@40ms "sk-made-up-for-this-video"
Sleep 400ms
Enter
Wait+Screen@20s /auth models/
Sleep 3500ms
Type "clear"
Enter
Sleep 300ms
Type "cat ~/.config/pairing-buddy/config.json"
Sleep 500ms
Enter
Sleep 4500ms
Type "pair doctor"
Sleep 500ms
Enter
Wait+Screen@60s /context/
Sleep 9s
Hide
