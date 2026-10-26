# Recorded with VHS 0.11 from docs/video, as a user whose home holds ~/shop (sample-shop/), the Neovim config
# from the README's lazy.nvim spec and a pair config whose two models answer at the example endpoint.
# localhost:8080/__down and /__up switch that stand-in endpoint off and on (hidden from the video).
# Recorded right after watcher.tape, on its data, so pair stats has numbers.
Output "clips/down.mp4"
Source "tapes/head.tape"
Source "tapes/layout.tape"
Alt+h
Sleep 300ms
Alt+j
Sleep 300ms
Show
Sleep 1s
Type "pair stats"
Enter
Sleep 8s
Hide
Alt+k
Sleep 300ms
Type ":silent !curl -s localhost:8080/__down"
Enter
Type ":echo ''"
Enter
Sleep 500ms
Alt+l
Sleep 300ms
Show
Sleep 1s
Type "what does subtotal return?"
Enter
Wait+Screen@90s /not answering/
Sleep 6s
Hide
Alt+h
Sleep 300ms
Alt+k
Sleep 300ms
Type ":silent !curl -s localhost:8080/__up"
Enter
Type ":echo ''"
Enter
Sleep 500ms
Show
Wait+Screen@60s /answers again/
Sleep 6s
