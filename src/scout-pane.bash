# The rc file of Pair's pane when the config names one of yours (scoutPane.rc). It loads yours, then puts back
# what Pair reads the pane by, whatever yours set up: its prompt with the command number and the last exit code,
# no prompt hooks or traps around commands, a shell that does not exit on errors, emacs keys (Ctrl-U clears the
# line) and no history file.
source "$PAIR_SCOUT_RC"
unset PAIR_SCOUT_RC PROMPT_COMMAND PS0
trap - DEBUG ERR RETURN
set +o errexit +o nounset -o emacs
HISTFILE=
PS1='scout[\#] exit $? $ '
