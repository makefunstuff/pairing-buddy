# Getting started, after `pair setup`: the one-model config, the key `pair auth` stored, and `pair doctor`.
# The sandbox has the plugin in its Neovim config, one Neovim connected, and the service from the systemctl
# stand-in; the model is DeepSeek, its key in the sandbox's auth.json (run.sh puts it there; it is never shown).
# run.sh fills in @PBCAP@ (its scratch dir) and @HERE@ (this folder).
Output "@HERE@/../clips/start.mp4"
Source "@HERE@/head.tape"
Hide
Type "source @PBCAP@/env.sh && cd ~ && clear"
Enter
Sleep 1s
Show
Sleep 1500ms
Type "cat ~/.config/pairing-buddy/config.json"
Sleep 600ms
Enter
Sleep 5s
Type "pair auth list | grep deepseek"
Sleep 600ms
Enter
Sleep 5s
Type "pair doctor"
Sleep 600ms
Enter
Wait+Screen@90s /context/
Sleep 10s
Hide
