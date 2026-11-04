// Pair's chat commands and the text of its notes, shared by the terminal's chat pane (src/chat.mjs) and the Herdr
// panel (this folder): plain JavaScript with no imports, so Node and Herdr's mod runtime both load it.

/** How often Pair speaks unasked: the config's "level" and /level. */
export const LEVELS = ['quiet', 'normal', 'chatty'];

/** The commands of the chat, as [name, arguments, what it does]: the help, the menu `/` opens, and Tab complete them. */
export const COMMANDS = [
  ['/goal', '<text>', 'set the session goal'],
  ['/level', LEVELS.join('|'), 'how often Pair speaks unasked'],
  ['/quiet', '', 'speak unasked only when it matters'],
  ['/normal', '', 'the usual level'],
  ['/chatty', '', 'speak unasked more often'],
  ['/scout', '', 'Pair may search and run commands in its own pane'],
  ['/navigate', '', 'back to watching and pointing (the default)'],
  ['/drive', '[what]', 'hand Pair the wheel for one change (or say "you take it")'],
  ['/drive!', '[what]', 'let Pair keep the wheel until you take it back'],
  ['/cancel', '', 'stop the answer Pair is working on (Esc)'],
  ['/why', '', 'the one idea worth keeping behind what Pair said last (or ?)'],
  ['/explain', '[n]', 'the same, about remark n of /remarks'],
  ['/remarks', '', 'the last remarks, numbered: +2 or -2 rates the second last'],
  ['/useful', '[n]', 'Pair\'s last remark was useful (or +)'],
  ['/noise', '[n]', 'it was not (or -); a remark you never see counts as not useful too'],
  ['/mute', '[kind]', 'no more remarks of this kind (the last remark\'s) this session'],
  ['/unmute', '[kind]', 'let them speak again (all of them)'],
  ['/gen', '', 'what /gen made here today, and what is not yours yet'],
  ['/gen here', '<what>', 'ask Pair for code at your cursor in Neovim (@here: over the selection)'],
  ['/gen file', '<what>', 'new files, as unsaved buffers to review in Neovim (:w in one takes it)'],
  ['/gen try', '<what>', 'a sample to read and run, in a folder outside the project, opened in a split in Neovim'],
  ['/gen scaffold', '[--branch|--copy] <what>', 'many files and their wiring, built in a copy of the project (--branch: a git worktree, --copy: Pair\'s copy, whatever gen.scaffold says); you keep a file at a time'],
  ['/gen board', '<what>|#n', 'a task for the board (Shepherdr), its brief from yours: y add only, d delegate, p plan first, r research, c copy'],
  ['/gen run', '', 'run the newest /gen try again, in Pair\'s pane, in the sandbox'],
  ['/gen tries', '', 'the /gen try folders still kept, and when each goes (gen.keepTries)'],
  ['/gen drop', '', 'delete the newest /gen scaffold\'s copy; what you did not keep of it is dropped'],
  ['/keep', '[path]', 'keep a file of the newest /gen try or scaffold: a new file as a buffer to review (:w takes it), a change as suggestions'],
  ['/gen cancel', '', 'stop the /gen request that runs or waits'],
  ['/plan', '[a; b; c|off]', 'the goal\'s steps, done and next: set your own, or drop them (p on an empty line edits them)'],
  ['/brief', '[note|off]', 'what /gen runs against: the goal, the board task and a note (NOTES.md); pin another, or none'],
  ['/brief sync', '', 'how the brief differs from its board task\'s brief, with the decisions since: y tells its agent, c copies'],
  ['/undo', '', 'undo Pair\'s last change: an edit of the Driver\'s, a suggestion you took, a /gen request'],
  ['/today', '', 'what Pair did here today'],
  ['/agents', '', 'your other agents and board tasks, the ones that need you first'],
  ['/review', '<id>', 'a board task\'s branch as a review in Neovim\'s :Pair gen list: what its reviewer said, ≠ brief, keep pieces'],
  ['/find', '<words>', 'find code in the project by what it does, or by its words (Alt-s in Neovim)'],
  ['/search', '<text>', 'find in the conversation (Ctrl-F)'],
  ['/copy', '[n]', 'copy Pair\'s last answer (or the nth last) to the clipboard'],
  ['/clear', '', 'clear the pane; the session and its history stay'],
  ['/end', '', 'end the session now with its debrief (it also ends by itself)'],
  ['/first', '<step>', 'tomorrow\'s first step, with a file:line (after the debrief, e edits it)'],
  ['/help', '', 'the keys and the commands (? on an empty line)'],
  ['/quit', '', 'close this pane (the session goes on)'],
];

export const HELP = [
  ...COMMANDS.map(([name, args, what]) => `${`${name}${args ? ` ${args}` : ''}`.padEnd(30)} ${what}`),
  `${'anything else'.padEnd(30)} ask Pair; @here asks about what you selected in Neovim`,
].join('\n');

// Saying one of these hands Pair the wheel, the way you would to a person next to you: alone, or followed by
// a request after punctuation ("you take it: set the timeout"). "your turn to explain: ..." stays a question.
const HAND_OVER = /^(you take it|your turn)\s*([.!,:;-]|$)/i;
const HERE = /(^|\s)@here\b/;

/** The parsed form of one typed line: a daemon message, or a local action. */
export function parseInput(line) {
  const text = line.trim();
  if (!text) return null;
  const [command, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ');
  const number = /^[1-9]$/.test(arg) ? Number(arg) : undefined;
  if (command === '/goal' && arg) return {type: 'goal', text: arg};
  if (command === '/plan' && arg === 'off') return {type: 'plan_off'};
  if (command === '/plan' && arg) return {type: 'plan', text: arg};
  if (command === '/plan') return {type: 'plan_show'};
  if (command === '/first' && arg) return {type: 'first', text: arg};
  if (command === '/level' && LEVELS.includes(arg)) return {type: 'level', level: arg};
  if (['/quiet', '/normal', '/chatty'].includes(command) && !arg) return {type: 'level', level: command.slice(1)};
  if (command === '/scout') return {type: 'role', role: 'scout'};
  if (command === '/navigate') return {type: 'role', role: 'navigator'};
  if (command === '/drive') return {type: 'drive', text: arg};
  if (command === '/drive!') return {type: 'drive', text: arg, keep: true};
  if (command === '/end') return {type: 'end'};
  if (command === '/today') return {type: 'today'};
  if (command === '/find') return arg ? {type: 'find', query: arg} : {local: 'help'};
  if (command === '/agents') return {type: 'agents'};
  if (command === '/cancel') return {type: 'cancel'};
  if (command === '/undo') return {type: 'undo_last'};
  if (command === '/gen' && !arg) return {type: 'gen_list'};
  if (command === '/gen' && arg === 'cancel') return {type: 'gen_cancel'};
  if (command === '/gen' && arg === 'run') return {type: 'gen_try_run'};
  if (command === '/gen' && arg === 'tries') return {type: 'gen_tries'};
  if (command === '/gen' && arg === 'drop') return {type: 'gen_copy_delete'};
  if (command === '/keep') return {type: 'keep', path: arg};
  if (command === '/review') return {type: 'review', task: arg};
  if (command === '/brief') return !arg ? {type: 'brief'} : arg === 'off' ? {type: 'brief', off: true} : arg === 'sync' ? {type: 'brief', sync: true} : {type: 'brief', file: arg};
  if (command === '/gen') {
    // A request may take several lines (Alt-Enter): they go as typed.
    const request = text.slice(command.length).trim();
    return HERE.test(request) ? {type: 'gen', text: request.replace(/(^|\s)@here\b[ \t]*/, '$1').trim(), here: true} : {type: 'gen', text: request};
  }
  if (command === '/mute') return arg ? {type: 'mute', trigger: arg} : {type: 'mute'};
  if (command === '/unmute') return arg ? {type: 'unmute', trigger: arg} : {type: 'unmute'};
  // +2, -3, /useful 2: a verdict on an older remark, by its number in /remarks.
  const numbered = /^([+-])\s*([1-9])$/.exec(text);
  if (numbered) return {type: 'feedback', useful: numbered[1] === '+', number: Number(numbered[2])};
  if (['/useful', '/noise'].includes(command) && number) return {type: 'feedback', useful: command === '/useful', number};
  if (text === '+' || command === '/useful') return {type: 'feedback', useful: true};
  if (text === '-' || command === '/noise') return {type: 'feedback', useful: false};
  if (command === '/remarks') return {type: 'remarks'};
  if (text === '?' || command === '/why') return {type: 'teach'};
  if (command === '/explain') return number ? {type: 'teach', number} : {type: 'teach'};
  if (command === '/quit') return {local: 'quit'};
  if (command === '/help') return {local: 'help'};
  if (command === '/clear') return {local: 'clear'};
  if (command === '/copy') return number ? {local: 'copy', number} : {local: 'copy'};
  if (command === '/search') return {local: 'search', text: arg};
  if (command.startsWith('/')) return {local: 'unknown', command};
  if (HAND_OVER.test(text)) return {type: 'drive', text};
  return HERE.test(text) ? {type: 'ask', text, here: true} : {type: 'ask', text};
}

/** The chat's lines for a /find answer: how it ranked, then each piece's file:line and first line, best first. */
export function foundLines(message) {
  const how = message.state === 'on' && !message.problem ? 'by meaning and words'
    : `by words only (${message.problem ?? (message.state === 'disabled' ? 'search by meaning is off in the config' : ':Pair find on in Neovim adds meaning')})`;
  const building = message.chunks && message.embedded < message.chunks && message.state === 'on' ? `, index ${Math.floor(100 * message.embedded / message.chunks)}% built` : '';
  const passed = message.rerank?.skipped?.length ? ` (${message.rerank.skipped.map(skip => skip.model).join(', ')} not answering)` : ''; // the models before it in the list
  const reranked = !message.rerank ? '' : message.rerank.applied ? `, reranked by ${message.rerank.model}${passed}`
    : `, ${message.rerank.model}'s rerank kept the order (${message.rerank.problem})`;
  if (!message.results?.length) return [`find "${message.query}": nothing ${how}${building}`];
  return [
    `find "${message.query}", ${how}${building}${reranked}${message.ms !== undefined ? `, ${message.ms} ms` : ''}:`,
    ...message.results.slice(0, 10).map(result => `  ${result.file}:${result.line}  ${result.head}`),
  ];
}

const OUTCOMES = {dismissed: 'noise'};
const pad = n => String(n).padStart(2, '0');
/** The time of `at`, with its day when that is not today's. */
function when(at, now) {
  const date = new Date(at);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === new Date(now).toDateString() ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

/** The last remarks (newest first, see PairSession.remarkList) as numbered lines for the chat. */
export function remarkLines(remarks, now = Date.now()) {
  if (!remarks.length) return ['Pair has made no remark here yet.'];
  const width = Math.max(...remarks.map(remark => remark.trigger.length));
  return [
    ...remarks.map((remark, i) => [`${i + 1}`, when(remark.at, now), remark.trigger.padEnd(width), remark.text ?? '(its words were not kept)',
      `(${OUTCOMES[remark.outcome] ?? remark.outcome})`].join('  ')),
    '+2 or -2 rates the second last, and so on',
  ];
}

/** What a /gen request says, as the gen speaker says it: gen #7 · scaffold … as #7 · scaffold …, the name is in the gutter. */
export const genText = text => text.replace(/^gen (#\d+)/, '$1');

/** The answer to a "may Pair run this?" question: only y or yes allows it. */
export const allows = line => /^\s*y(es)?\s*$/i.test(line);
