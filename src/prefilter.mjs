// Cheap rules the speak gate applies before it asks the Watcher: they drop candidate remarks that are plainly
// noise, so the model is asked less often and never about these. Pure: no model, no clock.

// Commands whose exit 1 is an answer, not a failure: no match, not equal, not found.
const ANSWERS_WITH_EXIT_1 = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'diff', 'cmp', 'test', '[', 'which', 'pgrep', 'git diff', 'git grep']);
const INTERRUPTED = new Set([130, 143]); // Ctrl-C, or a kill: the user stopped it themselves

// Goal words too common in programming, or in the paths of any project, to tell one piece of work from another.
const COMMON = new Set(['after', 'before', 'should', 'would', 'could', 'with', 'from', 'into', 'that', 'this', 'when', 'then', 'than',
  'make', 'does', 'work', 'code', 'file', 'files', 'test', 'tests', 'change', 'update', 'issue', 'error', 'function', 'feature',
  'index', 'main', 'server', 'client', 'user', 'users', 'core', 'common', 'util', 'utils', 'helper', 'helpers', 'module',
  'service', 'services', 'model', 'models', 'type', 'types', 'config', 'page', 'pages', 'component', 'components']);

/** The words of `text`, split at punctuation, underscores and camelCase humps, lowercased. */
export function words(text) {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

const goalWords = goal => words(goal).filter(word => word.length >= 4 && !COMMON.has(word));
/** `word` and what it may be without a plural or verb ending: "sleeps" may be "sleep", "caches" "cache" or "cach". */
const forms = word => [word, ...['s', 'es', 'ed', 'ing'].filter(end => word.endsWith(end) && word.length - end.length >= 3).map(end => word.slice(0, -end.length))];
// Whole words only, give or take an ending: a prefix ("form" in "formatted") says nothing about the work.
const sameWord = (a, b) => forms(a).some(form => forms(b).includes(form));

/**
 * Whether the path of `file` shares a word with the goal. Only the path: what was typed in a file is full of
 * ordinary words ("wait", "index", "user") that any goal may share.
 */
export function onGoal(goal, file) {
  const pathWords = words(file);
  return goalWords(goal ?? '').some(word => pathWords.some(part => sameWord(word, part)));
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
  if (trigger.kind === 'drift' && onGoal(state.goal, trigger.file)) return {value: 0, reason: `the path ${trigger.file} shares a word with the goal`};
  return null;
}
