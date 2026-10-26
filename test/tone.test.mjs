import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseInput} from '../src/chat.mjs';
import {PairSession} from '../src/session.mjs';
import {pairExtension} from '../src/tools.mjs';
import {splitTeaching, teachInput, TONE, toneProblems, WORDS} from '../src/tone.mjs';

test('the tone checker finds what a colleague would not say, and leaves code alone', () => {
  assert.deepEqual(toneProblems('`worker.go:35` gives up on `>=`: 7s + 8s = 15s stops one attempt early.', {maxWords: WORDS.remark}), []);
  assert.deepEqual(toneProblems('`if (!ok)` returns before `x != y` is checked.'), [], 'a ! in code is no exclamation');
  assert.deepEqual(toneProblems('Good catch! The lease is right now 🎉'), ['praise: "Good catch"', 'emoji', 'exclamation mark']);
  assert.deepEqual(toneProblems('Sorry, I misread it.'), ['apology: "Sorry"']);
  assert.deepEqual(toneProblems('Sure, the fix is in queue.go:18. Let me know if it helps.'), ['filler: "Sure"']);
  assert.deepEqual(toneProblems('## Fix\n- change **this**'), ['a heading, list or bold']);
  assert.deepEqual(toneProblems('one two three four', {maxWords: 3}), ['4 words, more than 3']);
  assert.deepEqual(toneProblems('See https://en.cppreference.com/w/c/language/operator_arithmetic for it.', {maxWords: 4}), [], 'a link is one word');
});

test('the Partner\'s instructions carry the tone', () => {
  const [pair] = pairExtension({roleOf: () => 'navigator'}).sections;
  assert.ok(pair.render().endsWith(TONE));
});

test('a teaching keeps its words for the editor and its last link apart', () => {
  assert.deepEqual(splitTeaching('Integer division truncates first.\nhttps://en.cppreference.com/w/c/language/operator_arithmetic'),
    {text: 'Integer division truncates first.', link: 'https://en.cppreference.com/w/c/language/operator_arithmetic'});
  assert.deepEqual(splitTeaching('Scale both sides. Docs: [Division](https://ziglang.org/documentation/master/#Division).'),
    {text: 'Scale both sides. Docs: Division.', link: 'https://ziglang.org/documentation/master/#Division'});
  assert.deepEqual(splitTeaching('  No link here. '), {text: 'No link here.', link: null});
  const cpp = 'https://en.cppreference.com/w/c/language/operator_arithmetic';
  const wiki = 'https://en.wikipedia.org/wiki/Division_(mathematics)';
  assert.deepEqual(splitTeaching(`Cast first.\n\`${cpp}\``), {text: 'Cast first.', link: cpp}, 'in backticks');
  assert.deepEqual(splitTeaching(`Truncates.\n<${cpp}>`), {text: 'Truncates.', link: cpp}, 'in angle brackets');
  assert.deepEqual(splitTeaching(`Cast first (${wiki})`), {text: 'Cast first', link: wiki}, 'its own parentheses kept, the sentence\'s dropped');
  assert.deepEqual(splitTeaching(`Cast first: ${wiki}.`), {text: 'Cast first', link: wiki});
  assert.deepEqual(splitTeaching(`See [it](${wiki}).`), {text: 'See it.', link: wiki}, 'a markdown link keeps its label');
  assert.deepEqual(splitTeaching(`Integer division truncates; see ${cpp} for the rules.`),
    {text: `Integer division truncates; see ${cpp} for the rules.`, link: cpp}, 'in mid-sentence, the link stays in the words');
});

test('? and /why in the chat ask for the idea behind Pair\'s last words', () => {
  assert.deepEqual(parseInput('?'), {type: 'teach'});
  assert.deepEqual(parseInput('/why'), {type: 'teach'});
  assert.deepEqual(parseInput('why does it fail?'), {type: 'ask', text: 'why does it fail?'});
});

function session(answers) {
  const asked = [];
  const sent = [];
  const seen = [];
  const pair = new PairSession({
    record: {id: 1, root: '/project', conversation_id: 7, goal: 'grow the table', level: 'normal'},
    store: {addMessage() {}, addRemark: () => 1, dropRemark() {}, seeRemark: id => seen.push(id)},
    partner: {thinkingOf: () => 'off', ask: async (_id, input) => { asked.push(input); return answers.shift(); }},
    score: async () => ({value: 9, reason: 'worth it'}),
    typingPauseMs: 2000,
    notify: (role, message) => sent.push({role, ...message}),
    requestEditor: async () => null,
    now: () => 100_000,
  });
  return {pair, asked, sent, seen};
}

test('teaching: the Partner is asked about the words shown, the editor gets the idea and its link, and asking counts as seen', async () => {
  const {pair, asked, sent, seen} = session(['Compare scaled ints: `len * 10 > cap * 7`.\nhttps://en.cppreference.com/w/c/language/operator_arithmetic']);
  await pair.teach('`len / cap` is 0 below a full table: `table.c:2`', 4);
  assert.equal(asked[0], teachInput('`len / cap` is 0 below a full table: `table.c:2`'));
  assert.match(asked[0], new RegExp(`never more than ${WORDS.teach}\\.`));
  assert.deepEqual(seen, [4]);
  assert.deepEqual(sent.filter(message => message.role === 'editor'), [{role: 'editor', type: 'teaching', text: 'Compare scaled ints: `len * 10 > cap * 7`.', link: 'https://en.cppreference.com/w/c/language/operator_arithmetic'}]);
  assert.ok(sent.some(message => message.type === 'message' && message.sender === 'pair' && message.text.includes('cppreference')), 'the chat has it, link and all');
});

test('teaching from the chat is about what Pair said last, also when asked twice; with nothing said, the editor still hears back', async () => {
  const {pair, asked, sent} = session(['The shift is fine; `worker.go:35` is the cause.', 'Check which side of a red test is wrong first.', 'Same idea again.']);
  await pair.teach();
  assert.equal(asked.length, 0, 'nothing to explain yet');
  assert.deepEqual(sent.at(-1), {role: 'editor', type: 'teaching', text: '', link: null, note: 'Pair has said nothing yet to explain.'});
  await pair.ask('where is the bug?');
  await pair.teach();
  await pair.teach();
  assert.equal(asked[1], teachInput('The shift is fine; `worker.go:35` is the cause.'));
  assert.equal(asked[2], asked[1], 'the second ? is about the same words, not about the first teaching');
});

test('teaching while Pair is still answering: the chat and the editor that asked both hear why there is none', async () => {
  let release;
  const {pair, asked, sent} = session([]);
  pair.partner.ask = (_id, input) => { asked.push(input); return new Promise(resolve => { release = resolve; }); };
  const question = pair.ask('where is the bug?');
  await new Promise(resolve => setImmediate(resolve));
  await pair.teach('`table.c:35` divides two counts');
  assert.equal(asked.length, 1, 'only the question went to the Partner');
  const note = 'Pair is still answering; ask again once it is done.';
  assert.deepEqual(sent.filter(message => message.type === 'teaching'), [{role: 'editor', type: 'teaching', text: '', link: null, note}]);
  assert.ok(sent.some(message => message.type === 'message' && message.sender === 'system' && message.text === note));
  release('It is at `table.c:35`.');
  await question;
});
