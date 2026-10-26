# The three moments in one take, on one session: the wrong turn, the regression, the hand-over and the take-back.
# run.sh fills in @PBCAP@ (its scratch dir) and @HERE@ (this folder).
Output "@HERE@/../clips/moments.mp4"
Source "@HERE@/head.tape"
Hide
Type "source @PBCAP@/env.sh && nvim -i NONE -u @HERE@/init.lua internal/delivery/worker_test.go"
Enter
Sleep 2s
# The first save is the session's first test run: red on the delivery test, the baseline.
Type ":w"
Enter
Wait+Screen@30s /1 failing/
Type "15G^"
Sleep 1500ms
Show

# 1. The wrong turn
Sleep 4s
Type ":e internal/retry/backoff.go"
Sleep 500ms
Enter
Sleep 2500ms
Type "20G"
Sleep 800ms
Type "f("
Sleep 600ms
Type "ca(attempt"
Escape
Wait+Screen@40s /gives up on/
Sleep 7s
Alt+j
Sleep 6s
# Off camera: at the normal talk level, Pair speaks at most once in 3 minutes.
Hide
Sleep 175s
Show

# 2. The regression
Type "0f="
Sleep 900ms
Type "x"
Sleep 1500ms
Type ":w"
Sleep 400ms
Enter
Wait+Screen@60s /TestQueueLease/
Wait+Screen@60s /worker takes it/
Sleep 8s
Alt+j
Sleep 6s
Alt+y
Sleep 2500ms
Type ":w"
Sleep 400ms
Enter
Wait+Screen@60s /✓ go test/
Sleep 5s

# 3. The hand-over
Type ":e internal/retry/backoff_test.go"
Sleep 400ms
Enter
Sleep 1500ms
Type "15G^zt"
Sleep 2s
Type ":Pair drive the edge cases"
Sleep 800ms
Enter
Wait+Screen@60s /undoes it/
Sleep 7s
Type "u"
Sleep 3s
Ctrl+R
Sleep 3s

# 4. The take-back
Type "u"
Sleep 2s
Type ":Pair drive the edge cases"
Sleep 800ms
Enter
Sleep 2300ms
Type "j"
Sleep 5s
Hide
Type ":qa!"
Enter
Sleep 500ms
