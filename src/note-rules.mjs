// What a Markdown note says, read by rules alone: its title, sections, paragraphs and decisions, and a paragraph
// that says again what an earlier one said. Pure: no model, no files. A model reading the note misses a repeat
// (BDY-20), and finding one is cheap: the words two paragraphs share, weighed by how rare they are in the note.
import {words} from './prefilter.mjs';

/** Whether `file` is a Markdown note. */
export const isNote = file => /\.(md|markdown)$/i.test(file ?? '');

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
// "Decision: …", also as a list item or in bold: the line that logs with the decide key.
const DECISION = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?decision(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.+?)\s*$/i;

/**
 * The note's lines as `{line, text, heading, section, code}`: `heading` is the heading text on a heading line,
 * `section` the heading the line is under (null above the first), `code` true inside a fenced block.
 */
export function noteLines(text) {
  let section = null;
  let code = false;
  return text.split('\n').map((line, i) => {
    if (FENCE.test(line)) {
      code = !code;
      return {line: i + 1, text: line, heading: null, section, code: true};
    }
    const heading = !code && HEADING.exec(line);
    if (heading) section = `${heading[1]} ${heading[2]}`;
    return {line: i + 1, text: line, heading: heading ? heading[2] : null, section, code};
  });
}

/** The note's title: its first top-level heading, else its file name without the extension. */
export function noteTitle(text, file = '') {
  return noteLines(text).find(line => line.heading && /^# /.test(line.text))?.heading
    ?? file.split('/').at(-1).replace(/\.[^.]+$/, '');
}

/** The decision a line states ("Decision: x" gives "x"), or null. */
export const decisionOf = line => (DECISION.exec(line)?.[1] ?? null);

/** The note's decisions: `{line, text, section}` of each line that starts with "Decision:". */
export function decisions(text) {
  return noteLines(text)
    .filter(line => !line.code && decisionOf(line.text))
    .map(line => ({line: line.line, text: decisionOf(line.text), section: line.section}));
}

/**
 * The note's paragraphs, `{line, text}`: runs of lines between blank lines, headings, fences and decisions, where
 * each list item starts one of its own. A decision is none: it restates the question it settles.
 */
export function paragraphs(text) {
  const found = [];
  let open = null;
  for (const line of noteLines(text)) {
    const apart = !line.text.trim() || line.heading || line.code || decisionOf(line.text);
    if (apart || ITEM.test(line.text)) open = null;
    if (apart) continue;
    if (open) open.text += ` ${line.text.trim()}`;
    else found.push(open = {line: line.line, text: line.text.replace(ITEM, '').trim()});
  }
  return found;
}

// Words that carry no idea of their own.
const STOP = new Set(('a an the and or but nor so yet if then than that this these those there here it its it\'s is are was were be been '
  + 'being am do does did done have has had having can could should would will shall may might must to of in on at by for from with '
  + 'into onto over under about as not no yes all any each every some more most less very just also only even still again once '
  + 'we you they he she i me us them our your their my his her what which who whom whose when where why how one two able '
  + 'get gets got make makes made let lets via per up down out off like such other same both either neither').split(' '));

/** A word without a plural or verb ending, so "operators" and "operator", "files" and "file" meet. */
const stem = word => word.replace(/(?<=\w{3})(?:ing|ed)$/, '').replace(/(?<=\w(?:s|x|z|ch|sh))es$|(?<=\w{3})s$/, '');

/** The idea words of `text`: no stop words, no numbers, stemmed. */
export const ideaWords = text => new Set(words(text).map(stem).filter(word => word.length > 1 && !STOP.has(word) && !/^\d+$/.test(word)));

const MIN_WORDS = 4; // a paragraph with fewer idea words is too short to say "the same thing"
const MIN_SHARED = 3;
const SAME = 0.5;

/**
 * How much of what `a` and `b` say is the same, 0 to 1: the weight of their shared words, counted in both, over
 * the weight of all their words, each weighed by `weight(word)` (rarer words weigh more). 0 when they share fewer
 * than three, so a short line that names the same thing as a long one is no repeat of it.
 */
export function overlap(a, b, weight = () => 1) {
  const shared = [...a].filter(word => b.has(word));
  if (shared.length < MIN_SHARED) return 0;
  const sum = list => list.reduce((total, word) => total + weight(word), 0);
  return (2 * sum(shared)) / (sum([...a]) + sum([...b]));
}

// "Option A: …", "- `debug`: …", "**Odin port** — …": a short label that names what the paragraph is about.
const LABEL = /^(?:`([^`]+)`|\*\*([^*]+)\*\*|([^:`*]{1,30}?))\s*(?::|—|–)\s/;

/**
 * What a paragraph is about: its label, if it has one, and its first idea word ("The arena allocator …" is about
 * the arena).
 */
function subjectOf(text, words) {
  const label = LABEL.exec(text);
  const named = label && (label[1] ?? label[2] ?? label[3]).trim();
  return {label: named && named.split(/\s+/).length <= 4 ? named.toLowerCase() : null, word: words.values().next().value};
}

/**
 * Whether two paragraphs are parallel rather than one repeating the other: each is about its own thing. Labelled
 * ones by different labels; others when each one's first idea word is one the other does not have. Two allocators,
 * two options or three build targets described alike say different things.
 */
function parallel(a, b) {
  if (a.subject.label && b.subject.label) return a.subject.label !== b.subject.label;
  return !b.words.has(a.subject.word) && !a.words.has(b.subject.word);
}

/**
 * Paragraphs that say again what an earlier one said: `{line, other, text}` with the line of each repeat and of the
 * paragraph it repeats.
 */
export function repeats(text) {
  const blocks = paragraphs(text)
    .map(block => {
      const words = ideaWords(block.text);
      return {...block, words, subject: subjectOf(block.text, words)};
    })
    .filter(block => block.words.size >= MIN_WORDS);
  const counts = new Map();
  for (const block of blocks) for (const word of block.words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const weight = word => Math.log(1 + blocks.length / counts.get(word));
  const found = [];
  blocks.forEach((block, j) => {
    const earlier = blocks.slice(0, j).find(other => !parallel(other, block) && overlap(other.words, block.words, weight) >= SAME);
    if (earlier) found.push({line: block.line, other: earlier.line, text: `Says again what line ${earlier.line} says.`});
  });
  return found;
}
