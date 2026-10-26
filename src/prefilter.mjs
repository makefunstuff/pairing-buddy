// Cheap rules the speak gate applies before it asks the Watcher: they drop candidate remarks that are plainly
// noise, so the model is asked less often and never about these. Pure: no model, no clock. Drift has no rule here:
// whether a file is on the goal is a matter of what it does, which the Watcher judges from its gist (see gist.mjs).

// Commands whose exit 1 is an answer, not a failure: no match, not equal, not found.
const ANSWERS_WITH_EXIT_1 = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'diff', 'cmp', 'test', '[', 'which', 'pgrep', 'git diff', 'git grep']);
const INTERRUPTED = new Set([130, 143]); // Ctrl-C, or a kill: the user stopped it themselves

function exitIsAnAnswer(command) {
  const [first, second] = command.cmd.trim().split(/\s+/);
  return command.exit === 1 && (ANSWERS_WITH_EXIT_1.has(first) || ANSWERS_WITH_EXIT_1.has(`${first} ${second}`));
}

/** `{value: 0, reason}` for a trigger the rules know to be noise; null when the Watcher has to judge it. */
export function prefilter(trigger) {
  const {command} = trigger;
  if (command && exitIsAnAnswer(command)) return {value: 0, reason: `exit 1 of \`${command.cmd}\` is an answer, not a failure`};
  if (command && INTERRUPTED.has(command.exit)) return {value: 0, reason: `\`${command.cmd}\` was stopped by the user`};
  return null;
}
