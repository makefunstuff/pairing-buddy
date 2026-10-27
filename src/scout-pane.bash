# The rc file of Pair's pane when the config names one of yours (scoutPane.rc). It loads yours, then puts back
# what Pair reads the pane by, whatever yours set up: its prompt with the command number and the last exit code,
# no traps or prompt hooks around commands, a shell that neither exits on errors nor reports a pipeline by its
# failing part (errexit, nounset, pipefail off), emacs keys (Ctrl-U clears the line) and no history file.
source "$PAIR_SCOUT_RC"
# First, so a DEBUG trap of yours does not run before each line below.
trap - DEBUG ERR RETURN
unset PAIR_SCOUT_RC PROMPT_COMMAND PS0
set +o errexit +o nounset +o pipefail -o emacs
HISTFILE=
PS1='scout[\#] exit $? $ '
