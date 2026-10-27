# The rc file of Pair's pane when the config names one of yours (scoutPane.rc). It loads yours, then puts back
# what Pair reads the pane by, whatever yours set up: no traps or prompt hooks around commands, a shell that
# neither exits on errors nor reports a pipeline by its failing part (errexit, nounset, pipefail off), emacs keys
# (Ctrl-U clears the line) and no history file; last, Pair's own rc file (src/pane-runs.mjs), with its prompt and
# the files it writes. Without PAIR_RUNS (listing your aliases and functions) it stops before that.
source "$PAIR_SCOUT_RC"
# First, so a DEBUG trap of yours does not run before each line below.
trap - DEBUG ERR RETURN
unset PAIR_SCOUT_RC PROMPT_COMMAND PS0
set +o errexit +o nounset +o pipefail -o emacs
HISTFILE=
[[ -n $PAIR_RUNS ]] && source "$PAIR_RUNS/pane.bash"
