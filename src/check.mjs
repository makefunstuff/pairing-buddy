// The Driver's check when there is no test to pass: what the user expects to see (an observable: "avg probe stays
// under 2", "the window shows both counters") and the command whose output shows it. The command is the user's,
// never the model's: one in backquotes in the hand-over, else the project's command on save, else the build and
// run the user ran last in their terminal. A number with a bound is checked here, in code; any other expectation
// the Partner compares with the output. Pure: no files, no clock.
import {isAbsolute, relative} from 'node:path';
import {commandPolicy} from './command-policy.mjs';
import {isRun} from './run-log.mjs';
import {shellQuote} from './scout-pane.mjs';

const QUOTED = /`([^`\n]+)`/;
// Words that only lead in to the command: "run `make -s run`", "check it with `odin run .`".
const LEAD_IN = /(?:\s*[,;:]?\s*\b(?:and\s+)?(?:check|test|try|run|build|verify)?\s*(?:it\s+)?(?:with|using|by|via)?\s*)$/i;
const EXPLICIT = /\b(?:expect(?:ed|ing)?|check|so that you see|you should see)\s*:\s*/i;
const CLAUSE = /\s*(?:[,;]|\s[—–]\s|\s-\s|\.\s+)\s*/;
// A clause that says what the user expects to see, rather than what to change: these words, or a bound on a number
// (targetOf). "keep the old name", "iterate over the slice" are changes.
const OBSERVABLE = /\b(?:prints?|printing|shows?|outputs?|displays?|stays?|remains?|expect(?:s|ed)?)\b/i;

/**
 * The hand-over in its parts: `{intent, expect, command}`. `words` are the user's ("you take it: make the table
 * grow when the load passes 0.7, avg probe stays under 2"); `expect` is the clause after the first that says what
 * to see, or what follows "expect:", and `command` the one in backquotes. Each is null when the words have none.
 */
export function parseHandOver(words = '') {
  let text = words.replace(/^(?:you take it|your turn)\s*[.!,:;-]?\s*/i, '').trim();
  const quoted = text.match(QUOTED);
  const command = quoted ? quoted[1].trim() : null;
  if (quoted) text = (text.slice(0, quoted.index).replace(LEAD_IN, '') + text.slice(quoted.index + quoted[0].length)).trim();
  const explicit = text.match(EXPLICIT);
  if (explicit) return {intent: text.slice(0, explicit.index).replace(/[\s,;.]+$/, '') || null, expect: tidy(text.slice(explicit.index + explicit[0].length)), command};
  const clauses = text.split(CLAUSE).filter(Boolean);
  const at = clauses.findIndex((clause, index) => index > 0 && (OBSERVABLE.test(clause) || targetOf(clause)));
  if (at < 0) return {intent: tidy(text), expect: null, command};
  return {intent: tidy(clauses.slice(0, at).join(', ')), expect: tidy(clauses.slice(at).join(', ')), command};
}

const tidy = text => text.replace(/^(?:and|so|then)\s+/i, '').replace(/[\s,;.]+$/, '').trim() || null;

const BOUNDS = {
  '<': /^(?:under|below|less than|fewer than|<)$/i,
  '<=': /^(?:at most|no more than|<=|≤)$/i,
  '>': /^(?:over|above|more than|>)$/i,
  '>=': /^(?:at least|no less than|>=|≥)$/i,
  '=': /^(?:=|==|equals?|exactly)$/i,
};
const BOUND = /^(.*?)\s*(?:\b(?:stays?|keeps?|remains?|is|are|goes|gets|drops?|falls?|should be|must be|be)\s+)*(\b(?:under|below|less than|fewer than|at most|no more than|over|above|more than|at least|no less than|equals?|exactly)\b|<=|>=|==|≤|≥|<|>|=)\s*(-?\d+(?:\.\d+)?)/i;
// Words before a label that are no part of it: "keep avg probe under 2", "and the worst stays under 4".
const NOT_LABEL = /^(?:and|so|with|keep(?:ing)?|make sure|while|the|its|it|that)\s+/i;
// A label that is a sentence, not a number's name: "it should print an error for n over 100" is the Partner's to judge.
const NOT_A_NAME = /\b(?:prints?|shows?|outputs?|should|must|when|if|for|error)\b/i;

/** The number an expectation bounds, `{label, op, value}` ("avg probe stays under 2": "avg probe", "<", 2), or null. */
export function targetOf(expect) {
  const match = expect?.match(BOUND);
  if (!match) return null;
  let label = match[1].trim();
  while (NOT_LABEL.test(label)) label = label.replace(NOT_LABEL, '');
  const op = Object.keys(BOUNDS).find(key => BOUNDS[key].test(match[2].replace(/\s+/g, ' ')));
  return label && !NOT_A_NAME.test(label) ? {label: label.toLowerCase(), op, value: Number(match[3])} : null;
}

/**
 * Every number an expectation bounds, each as targetOf gives it: "avg probe under 2 and worst under 5" bounds two.
 * Empty when it bounds none.
 */
export const targetsOf = expect => (expect ?? '').split(/\s*(?:[,;]|\band\b)\s*/i).map(targetOf).filter(Boolean);

const MEETS = {'<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b, '=': (a, b) => a === b};
const words = text => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Of a run's numbers (as run-log.mjs measures them), the one `target` names: its label, else one with all its words. */
export function numberFor(numbers, target) {
  const all = Object.values(numbers);
  const wanted = words(target.label);
  return all.find(number => number.label.toLowerCase() === target.label)
    ?? all.find(number => wanted.every(word => words(number.label).includes(word)))
    ?? all.find(number => words(number.label).length && words(number.label).every(word => wanted.includes(word)))
    ?? null;
}

/** A number as the hand-back shows it, by the label the user gave it: "avg probe 1.3". */
const numberText = (label, number) => `${label} ${number.text}${number.unit ? `${/^[a-zµ]/i.test(number.unit) ? ' ' : ''}${number.unit}` : ''}`;

/**
 * How the check went: `{mark, text}`, mark 'pass', 'fail' or null (the Partner judges), and text what the run
 * printed for it ("avg probe 1.3 · worst 89"), or null. A run that failed (`red`, with `failure` its words: "does
 * not build", "Segmentation fault") fails whatever was expected. Each of the `targets` is checked against the number
 * it names: one missed fails it, all met pass it; a bound on a number the run did not print, or an expectation
 * without one, is the Partner's to judge. Without an expectation, a run that went through passes, with `text`.
 */
export function judge({red, failure, numbers, targets = [], expect, text}) {
  if (red) return {mark: 'fail', text: failure};
  const found = targets.map(target => ({target, number: numberFor(numbers, target)})).filter(each => each.number);
  const printed = found.map(({target, number}) => numberText(target.label, number)).join(' · ') || null;
  if (found.some(({target, number}) => !MEETS[target.op](number.value, target.value))) return {mark: 'fail', text: printed};
  if (found.length && found.length === targets.length) return {mark: 'pass', text: printed};
  return expect ? {mark: null, text: printed} : {mark: 'pass', text};
}

/** The mark the Partner's words start with ("✓ avg probe 1.3 …"), or null. */
export function markOf(said) {
  const first = said.trim()[0];
  return first === '✓' ? 'pass' : first === '✗' ? 'fail' : null;
}

/** The first word of one simple command, past variables, `time` and the like. */
const firstWord = command => command.trim().replace(/^(?:\w+=\S*\s+)+/, '').replace(/^(?:time|nice|env|command)\s+/, '').split(/\s+/)[0] ?? '';
// A script by its path builds what it needs (`./build.sh`); a program by its path without one (`./probe`) is built.
const SCRIPT = /\.(?:sh|bash|zsh|py|rb|pl|lua|js|mjs)$/;
const parts = cmd => cmd.split(/&&|\|\||[;|]/);
const builtProgram = part => isRun(part) && firstWord(part).includes('/') && !SCRIPT.test(firstWord(part));
/** Whether `cmd` builds something: a run of a built program by its path (`./probe`) does not. */
const builds = cmd => parts(cmd).some(part => isRun(part) && !builtProgram(part));
/** Whether `cmd` runs a built program (`./probe`) and builds nothing first: in the copy that is the old program. */
const runsOldProgram = cmd => parts(cmd).some(builtProgram) && !builds(cmd);

/**
 * The command that checks the Driver's edit: `{command, from, ask}`, with `from` saying whose it is and `ask` why
 * the user is asked first, or `{none}` with why there is none. `given` is the one in the hand-over, `testCommand`
 * the project's on save, `runs` the run log (run-log.mjs). The user's last run that only runs a program (`./probe`)
 * gets the build they ran before it (`make && ./probe`); with none known it is no check, since the scratch copy has
 * the old program. One that ran in another folder of the project runs there. What the command policy refuses never
 * runs; a command from the terminal that Scout would ask about (`make install`, `./deploy.sh`) asks too. The
 * user's own words in the hand-over and their command on save are theirs to run.
 */
export function checkCommand({given = null, testCommand = null, runs = [], root}) {
  const checked = (command, from, terminal = false) => {
    const policy = commandPolicy(command);
    if (policy.verdict === 'refuse') return {none: `\`${command}\` is not run for a check: ${policy.reason}`};
    if (runsOldProgram(command)) return {none: `\`${command}\` runs the program as it was built, so in the copy it would run the old code; the user can name the build and run in backquotes`};
    return {command, from, ask: terminal && policy.verdict === 'ask' ? policy.reason : null};
  };
  if (given) return checked(given, 'the command in the hand-over');
  if (testCommand) return checked(testCommand, 'the project\'s command on save');
  const mine = runs.filter(run => run.by === 'you');
  const last = mine.at(-1);
  if (!last) return {none: 'no command on save, and no build or run in the user\'s terminal yet'};
  const build = builds(last.cmd) ? null : mine.findLast(run => run.cwd === last.cwd && builds(run.cmd));
  const folder = last.cwd ? relative(root, last.cwd) : '';
  if (folder.startsWith('..') || isAbsolute(folder)) return {none: `\`${last.cmd}\` ran in ${last.cwd}, outside the project, so it checks nothing here`};
  const inside = folder ? `cd ${shellQuote(folder)} && ` : '';
  return checked(`${inside}${build ? `${build.cmd} && ` : ''}${last.cmd}`, 'the build and run the user ran last in their terminal', true);
}
