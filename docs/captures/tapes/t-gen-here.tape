# Tutorial · /gen here, and the brief. With the cursor under Next in backoff.go, you ask in the chat for code there;
# the gen card shows it as a diff, Alt-Up picks the card and k keeps it: the code lands in your buffer, unsaved,
# marked ┊. /undo takes it back. Then a request that goes against NOTES.md (logs through slog, never fmt.Printf):
# Pair asks first, and n follows the brief. VHS has no Alt+Up or End: Alt+[ and "1;3A" (or "F") are the bytes a
# terminal sends for them. End follows the conversation again after a pick.
Output out/t-gen-here.mp4
Source tutorial/head.tape
Hide
Type "cd $CAP/hookd && clear && CAP_NO_HERDR=1 nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua +25 internal/retry/backoff.go"
Enter
Sleep 1.5s
Source tutorial/chat.tape
Type "retries reach the budget"
Source tutorial/code.tape
Ctrl+w
Type "l"
Type "i"
Sleep 300ms
Show
Sleep 2s
Type "/gen here a Total method on Backoff: the sum of the waits before attempt n, no new imports"
Sleep 600ms
Enter
Sleep 3s
Wait+Screen@180s /k keep/
Sleep 5s
Alt+[
Type@5ms "1;3A"
Sleep 2.5s
Type "k"
Sleep 2s
Alt+[
Type@5ms "F"
Sleep 4s
Type "/undo"
Sleep 600ms
Enter
Sleep 2s
Alt+[
Type@5ms "F"
Sleep 3s
Type "/gen here log each wait in Next with fmt.Printf instead of slog"
Sleep 600ms
Enter
Wait+Screen@120s /gen #2 waits for your answer|gen #2 follows the brief/
Sleep 6s
Type "n"
Sleep 1s
Ctrl+u
Sleep 2s
Wait+Screen@180s /gen #2 ready/
Sleep 6s
