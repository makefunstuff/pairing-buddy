// Pair's tone: how its words read, in its instructions and in the live tests that hold it. A colleague in the
// second chair leads with the fact and the place, uses the numbers, and does not praise, apologise or cheer.
// The wording of TONE is the one that was tested against a plain assistant's before it shipped (docs/tone.md).

/** How many words each kind of turn may take; the live tests hold the Partner to them. */
export const WORDS = {remark: 30, answer: 80, teach: 45};

export const TONE = `How you sound: a senior colleague in the second chair, not an assistant.
- Lead with the fact, then the reason; name file:line. Use the numbers.
- Never praise, apologize, hedge with filler, or use emoji or exclamation marks. Say "I" rarely.
- If unsure, say so in a few words and say how you'd check.
- Celebrate only by naming what is now true, in one line.
- Plain sentences: no headings, bold or lists. Put code in \`backticks\`.
- Do not narrate your tools ("I pointed at", "Suggested a fix"): the user sees what they show.
- Say each thing once: the notes of point and suggest already show, so do not say them again.
- Never say you did what did not happen: a suggestion is made only when the user takes it, so not "Added".
- A remark nobody asked for, or what you changed: one or two short lines, at most ${WORDS.remark} words.
  An answer to the user: at most ${WORDS.answer} words, unless they ask for more.`;

// The limit again at the end of each input: small models follow an instruction in the message far better than a
// rule in the system prompt. They also overshoot a limit, so the input asks for less than the tests allow.
export const KEEP = {
  remark: `Say one thing, the fact and its file:line first, in about ${WORDS.remark * 2 / 3} words and never more than ${WORDS.remark}.`,
  answer: `Answer in about ${WORDS.answer / 2} words and never more than ${WORDS.answer}, naming file:line where it is about code.`,
};

/**
 * What the Partner is asked when the user wants the idea behind words of its own (`said`, as they were shown):
 * the one principle worth keeping, and a link to the docs only where it can be sure of one.
 */
export function teachInput(said) {
  return `[teach] The user asks for the idea behind what you said: "${said}"

Give the one idea worth keeping: a principle they can reuse next time, in plain words, in about ${WORDS.teach * 2 / 3} words
and never more than ${WORDS.teach}.
Start with the principle itself, not with a repeat of what you said. If it is about a language, a library or a tool
and you are sure of the address, end with one link to its official documentation, on a line of its own; else no link.
Answer in text, without tool calls.`;
}

// Things a colleague would not say. Code in backticks is left out first: `!=` or `!ok` is no exclamation.
const PRAISE = /\b(great|good catch|nice|well done|excellent|awesome|perfect|good job|good question|brilliant)\b/i;
const APOLOGY = /\b(sorry|apologi[sz]e|my mistake|my bad)\b/i;
const FILLER = /^(sure|certainly|of course|absolutely|happy to|i hope this helps)\b|\b(let me know|hope this helps|feel free)\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;
const MARKDOWN = /^\s*(#{1,6}\s|[-*]\s|\d+\.\s)|\*\*[^*]+\*\*/m;

// A link ends at a space, a backtick, a quote or an angle bracket. Punctuation after it, and a closing parenthesis it
// did not open (as in "(see https://...)"), are the sentence's, not the link's.
const LINK = /https?:\/\/[^\s`'"<>]+/g;

const prose = text => text.replace(/`[^`]*`/g, 'code').replace(LINK, 'link');
const wordCount = text => prose(text).split(/\s+/).filter(Boolean).length;

/** What in `text` breaks the tone, as short reasons; [] when nothing does. `maxWords` limits its length. */
export function toneProblems(text, {maxWords = Infinity} = {}) {
  const words = prose(text);
  const problems = [];
  if (PRAISE.test(words)) problems.push(`praise: "${words.match(PRAISE)[0]}"`);
  if (APOLOGY.test(words)) problems.push(`apology: "${words.match(APOLOGY)[0]}"`);
  if (FILLER.test(words.trim())) problems.push(`filler: "${words.trim().match(FILLER)[0]}"`);
  if (EMOJI.test(words)) problems.push('emoji');
  if (words.includes('!')) problems.push('exclamation mark');
  if (MARKDOWN.test(text)) problems.push('a heading, list or bold');
  const count = wordCount(text);
  if (count > maxWords) problems.push(`${count} words, more than ${maxWords}`);
  return problems;
}

const MARKDOWN_LINK = /\[([^\]]*)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/g; // [docs](https://...), parentheses and all

function trimLink(raw) {
  let link = raw.replace(/[.,;:!?]+$/, '');
  const count = char => link.split(char).length - 1;
  while (link.endsWith(')') && count(')') > count('(')) link = link.slice(0, -1).replace(/[.,;:!?]+$/, '');
  return link;
}

/**
 * A teaching as the editor shows it: its words, and its last link, which the teach key opens, or null. A markdown
 * link keeps its label in the words. A bare link that ends the teaching is taken out of them, with what wraps it
 * (backticks, brackets, "Docs:"); one in the middle of a sentence stays, so the sentence still reads.
 */
export function splitTeaching(text) {
  const labelled = [...text.matchAll(MARKDOWN_LINK)];
  if (labelled.length) return {text: text.replace(MARKDOWN_LINK, '$1').trim(), link: labelled.at(-1)[2]};
  const raw = text.match(LINK)?.at(-1);
  if (!raw) return {text: text.trim(), link: null};
  const link = trimLink(raw);
  const at = text.lastIndexOf(link);
  const ending = /^[\s`'">).,;:!?]*$/.test(text.slice(at + link.length));
  const words = ending ? text.slice(0, at).replace(/[\s`'"<(:-]+$/, '') : text;
  return {text: words.trim(), link};
}
