# Recorded with VHS 0.11 from docs/video, as a user whose home holds ~/shop (sample-shop/), the Neovim config
# from the README's lazy.nvim spec and a pair config whose two models answer at the example endpoint.
Output "clips/watcher.mp4"
Source "tapes/head.tape"
Source "tapes/layout.tape"
Show
Sleep 1s
Type "/level chatty"
Enter
Sleep 2s
Alt+h
Sleep 300ms
Alt+j
Sleep 500ms
Type "npm test"
Enter
Sleep 8s
Type "npm test"
Enter
Wait+Screen@60s /\+ useful/
Sleep 6s
Type "npm test"
Enter
Sleep 100s
Sleep 30s
Alt+l
Sleep 500ms
Type "+"
Enter
Sleep 2s
Alt+h
Sleep 300ms
Alt+k
Sleep 500ms
Type ":e src/email/newsletter.mjs"
Enter
Sleep 1s
Type "Go"
Enter
Type "export function unsubscribeLink(email) {"
Enter
Type "return `https://shop.example/unsubscribe?e=${encodeURIComponent(email)}`;"
Enter
Type "}"
Escape
Sleep 100s
Sleep 20s
