# The held thought, and one look. Neovim on a grey palette with one warm red, the chat pane beside it. You write
# ring_pop in C and go on; the error in a line you left can wait, so Pair holds its remark (a dot in the margin, a
# word in the statusline) until you save. The pair's teal is the one other colour, in Neovim and in the chat.
Output out/held-thought.mp4
Set Shell bash
Set FontFamily "JetBrainsMono Nerd Font"
Set FontSize 18
Set Width 1400
Set Height 840
Set Padding 0
Set Margin 0
Set Framerate 25
Set TypingSpeed 55ms
Set Theme { "name": "greys", "background": "#131517", "foreground": "#c8cacb", "cursor": "#c8cacb", "selection": "#2a2f32", "black": "#131517", "red": "#d9694a", "green": "#a3a9ad", "yellow": "#b5b9bb", "blue": "#bfc3c5", "magenta": "#868d91", "cyan": "#8f969a", "white": "#c8cacb", "brightBlack": "#5a6064", "brightRed": "#d9694a", "brightGreen": "#a3a9ad", "brightYellow": "#b5b9bb", "brightBlue": "#bfc3c5", "brightMagenta": "#868d91", "brightCyan": "#8f969a", "brightWhite": "#e4e4e4" }
Hide
Type "cd $CAP/ringbuf && clear && CAP_SCHEME=greys nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua ring.c"
Enter
Sleep 2s
Type ":botright vnew | vertical resize 56 | terminal $CAP_REPO/bin/pair.mjs chat"
Enter
Sleep 2.5s
Ctrl+w
Type "h"
Type ":echo"
Enter
Type "G"
Sleep 500ms
Show
Sleep 1s
Type "o"
Enter
Type "// Takes the oldest value; -1 when the ring is empty."
Enter
Type "int ring_pop(struct ring *r, int *out) {"
Enter
Type "if (r->len == 0)"
Enter
Type "return -1;"
Enter
Type "*out = r->buf[r->head];"
Enter
Type "r->head = (r->head + 1) % capacity;"
Enter
Sleep 600ms
Type "r->len--;"
Enter
Type "return 0;"
Enter
Sleep 2.6s
Type "}"
Enter
Enter
Type "// next: ring_len, how many values it holds"
Sleep 1.2s
Screenshot out/held.png
Sleep 600ms
Escape
Sleep 400ms
Type ":w"
Enter
Sleep 2.2s
Screenshot out/held-shown.png
Sleep 1.2s
Alt+j
Sleep 2.5s
