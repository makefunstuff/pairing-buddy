# Tutorial · notes. You finish a sentence in a design note; when you stop, Pair (a real model) reads the note and
# marks the margin: a question it leaves open, two lines that disagree, what the code it names really does.
# :Pair tasks then lists the work the note asks for.
Output out/t-notes.mp4
Source tutorial/head.tape
Hide
Type "cd $CAP/hookd && clear && CAP_NO_HERDR=1 nvim -i NONE --listen $CAP/nvim.sock -u $CAP_HERE/init.lua docs/dead-letters.md"
Enter
Sleep 1.5s
Source tutorial/chat.tape
Type "dead letters for webhooks"
Source tutorial/terminal.tape
Type "21G$"
Sleep 300ms
Show
Sleep 2s
Type "ak."
Escape
Sleep 40s
Screenshot out/t-notes-margin.png
Sleep 2s
Type ":Pair tasks"
Enter
Sleep 30s
Screenshot out/t-notes-tasks.png
Sleep 2s
