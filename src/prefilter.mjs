// Cheap rules the speak gate applies before it asks the Watcher: they drop candidate remarks that are plainly
// noise, so the model is asked less often and never about these. Pure: no model, no clock.

// Commands whose exit 1 is an answer, not a failure: no match, not equal, not found.
const ANSWERS_WITH_EXIT_1 = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'diff', 'cmp', 'test', '[', 'which', 'pgrep', 'git diff', 'git grep']);
const INTERRUPTED = new Set([130, 143]); // Ctrl-C, or a kill: the user stopped it themselves

// Goal words too common in programming to tell one piece of work from another.
const COMMON = new Set(['after', 'before', 'should', 'would', 'could', 'with', 'from', 'into', 'that', 'this', 'when', 'then', 'than',
  'make', 'does', 'work', 'code', 'file', 'files', 'test', 'tests', 'change', 'update', 'issue', 'error', 'function', 'feature']);

/** The words of `text`, split at punctuation, underscores and camelCase humps, lowercased. */
export function words(text) {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

const goalWords = goal => words(goal).filter(word => word.length >= 4 && !COMMON.has(word));
// "sleep" matches "sleeps" and "reconnect" matches "reconnecting"; short words must match exactly.
const sameWord = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

/** Whether `file`, by its path or the text just written in it, shares a word with the goal. */
export function onGoal(state, file) {
  const written = state.edits.filter(edit => edit.file === file).map(edit => edit.text).join(' ');
  const fileWords = new Set(words(`${file} ${written}`));
  return goalWords(state.goal ?? '').some(goal => [...fileWords].some(word => sameWord(goal, word)));
}

function exitIsAnAnswer(command) {
  const [first, second] = command.cmd.trim().split(/\s+/);
  return command.exit === 1 && (ANSWERS_WITH_EXIT_1.has(first) || ANSWERS_WITH_EXIT_1.has(`${first} ${second}`));
}

/** `{value: 0, reason}` for a trigger the rules know to be noise; null when the Watcher has to judge it. */
export function prefilter(trigger, state) {
  const {command} = trigger;
  if (command && exitIsAnAnswer(command)) return {value: 0, reason: `exit 1 of \`${command.cmd}\` is an answer, not a failure`};
  if (command && INTERRUPTED.has(command.exit)) return {value: 0, reason: `\`${command.cmd}\` was stopped by the user`};
  if (trigger.kind === 'drift' && onGoal(state, trigger.file)) return {value: 0, reason: `${trigger.file} shares words with the goal`};
  return null;
}
