import assert from 'node:assert/strict';
import {mkdtempSync, readdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {cleanQuestion, parseSlice, questionInput, questionProblem, sliceInput, sliceNote, sliceProblems, sliceText, stackOf} from '../src/blank-page.mjs';
import {PairSession} from '../src/session.mjs';

const SLICE = {
  files: [{path: 'Makefile', does: 'make run builds and runs it'}, {path: 'main.c', does: 'loop, fixed step, counters'}],
  run: 'make run', shows: 'one dot gliding; sim and frame counters differ', needs: ['raylib'],
  probes: ['drop the render rate: the dot stays smooth', 'stall the loop: the accumulator catches up'],
  test: 'accumulator stepping: given dt, the step count and leftover', later: ['particle swarm', 'mouse following'],
};

test('the stack comes from the user\'s words: C, C3, Odin and Zig with a Makefile, Go, JavaScript', () => {
  assert.equal(stackOf('a small raylib toy in C').name, 'C');
  assert.match(stackOf('a small raylib toy in C').files, /Makefile/);
  assert.equal(stackOf('a C3 thing').name, 'C3');
  assert.equal(stackOf('game of life in odin').name, 'Odin');
  assert.equal(stackOf('a zig allocator test').name, 'Zig');
  assert.equal(stackOf('a Go CLI').name, 'Go');
  assert.equal(stackOf('a node script').name, 'JavaScript');
  assert.equal(stackOf('something for C# devs'), null, 'C# is not C');
  assert.equal(stackOf('a cool thing'), null);
});

test('a question is asked with the answers so far; the slice is asked with its rules and the stack\'s two files', () => {
  const qa = [{question: 'What should it show first?', answer: 'two counters'}];
  const input = questionInput({idea: 'a raylib toy in C', qa, listing: ''});
  assert.match(input, /Ask question 2 of 3/);
  assert.match(input, /Q1: What should it show first\?\nA1: two counters/);
  assert.match(input, /At most 18 words/);
  assert.match(input, /nothing yet/);
  const slice = sliceInput({idea: 'a raylib toy in C', qa, listing: 'NOTES.md'});
  assert.match(slice, /for C: Makefile \(`make run` builds and runs it\) and main\.c/);
  assert.match(slice, /No README/);
  assert.match(slice, /The folder has: NOTES\.md/);
});

test('the question is cleaned of labels and quotes; one without a question mark, or too long, gets a second try', () => {
  assert.equal(cleanQuestion('**Q2:** "What should the window show?"'), 'What should the window show?');
  assert.equal(cleanQuestion('Sure.\nQuestion 3) Sim steps or wall clock?'), 'Sim steps or wall clock?');
  assert.equal(cleanQuestion('Tell me more.'), null);
  assert.match(questionProblem(null), /not a question/);
  assert.match(questionProblem(`${'word '.repeat(20)}?`), /21 words/);
  assert.equal(questionProblem('Sim steps or wall clock?'), null);
});

test('the slice is read from the JSON in the answer, and becomes the note\'s sections', () => {
  const slice = parseSlice(`Here it is:\n\`\`\`json\n${JSON.stringify(SLICE)}\n\`\`\``);
  assert.deepEqual(slice, SLICE);
  assert.equal(parseSlice('no json'), null);
  assert.equal(parseSlice('{not json}'), null);
  assert.equal(sliceText(slice), `## First run
- \`Makefile\`: make run builds and runs it
- \`main.c\`: loop, fixed step, counters
- run: \`make run\`
- shows: one dot gliding; sim and frame counters differ

## Then poke at it
- drop the render rate: the dot stays smooth
- stall the loop: the accumulator catches up

## A test, once it exists
- accumulator stepping: given dt, the step count and leftover

## Not yet
- particle swarm · mouse following`);
  const later = ['the cap on steps per frame', 'a moving dot or any drawing', 'interpolated positions between steps'];
  assert.deepEqual(sliceText({...slice, later}).split('\n').slice(-3), ['- the cap on steps per frame', '- a moving dot or any drawing', '- interpolated positions between steps'], 'one a line when they do not fit on one');
  assert.equal(sliceNote(3, 2), 'Your three answers as a first slice. Two files, nothing written yet.');
  assert.equal(sliceNote(1, 1), 'Your one answer as a first slice. One file, nothing written yet.');
});

test('a slice with scaffolding, too many files or a library nobody named breaks the rules', () => {
  const words = 'a small raylib toy in C';
  assert.deepEqual(sliceProblems(SLICE, words), []);
  const slop = {...SLICE, files: [...SLICE.files, {path: 'README.md', does: ''}, {path: 'src/util.c', does: ''}], needs: ['raylib', 'SDL2']};
  assert.deepEqual(sliceProblems(slop, words), [
    'It has 4 files; a first slice has two, at most 3.',
    'README.md has no place in a first slice.',
    'The user did not name SDL2: leave it out.',
  ]);
  assert.deepEqual(sliceProblems({...SLICE, run: '', probes: ['one']}, words), ['It does not say how to run it.', 'It needs 2 to 4 probes.']);
  assert.deepEqual(sliceProblems(null, words), ['That was not the JSON asked for.']);
});

/** A session in `root` whose Partner answers from `answers` in order; what the chat and the editor get. */
function session(root, answers) {
  const sent = [];
  const inputs = [];
  const pair = new PairSession({
    record: {id: 1, root, conversation_id: 7, goal: null, level: 'normal'},
    store: {addMessage() {}, setGoal() {}},
    partner: {thinkingOf: () => 'off', ask: async (_id, input) => {
      inputs.push(input);
      const answer = answers.shift();
      return typeof answer === 'function' ? answer() : answer;
    }},
    score: async () => ({value: 9, reason: ''}),
    typingPauseMs: 2000,
    notify: (to, message) => { sent.push({to, ...message}); return 1; },
    requestEditor: async message => (message.type === 'read' ? {text: '# toy\n\na raylib toy in C\n- two counters\n\n'} : null),
  });
  return {pair, sent, inputs};
}

test(':Pair new asks three questions one at a time, then suggests the slice under the note\'s last line', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pair-new-'));
  // The slice comes through the say tool, as some models send it: it is checked before the chat shows anything.
  const said = async () => { await pair.say(JSON.stringify(SLICE)); return ''; };
  const {pair, sent, inputs} = session(root, ['What should it show first?', 'Steps or wall clock?', 'Q3: What do you want to learn?', said]);
  await pair.startNew('a raylib toy in C', join(root, 'NOTES.md'));
  assert.equal(pair.state.goal, 'a raylib toy in C', 'the idea is the session\'s goal');
  assert.deepEqual(sent.filter(m => m.type === 'interview').map(m => [m.n, m.text]), [[1, 'What should it show first?']]);
  assert.equal(pair.blankPage.open, true, 'no remarks nobody asked for meanwhile');
  await pair.blankPage.answer('- two counters\n- and one dot');
  assert.match(inputs[1], /A1: two counters and one dot/, 'the answer without list dashes');
  await pair.blankPage.answer('steps');
  await pair.blankPage.answer('the accumulator');
  assert.deepEqual(sent.filter(m => m.type === 'interview').map(m => m.n ?? 'done'), [1, 2, 3, 'done']);
  assert.equal(sent.findLast(m => m.type === 'interview' && m.n).text, 'What do you want to learn?');
  const suggestion = sent.find(m => m.type === 'suggest');
  assert.deepEqual({...suggestion, text: suggestion.text.split('\n').slice(0, 3)}, {
    to: 'editor', type: 'suggest', file: join(root, 'NOTES.md'), line: 4, endLine: 4, insert: true,
    text: ['', '## First run', '- `Makefile`: make run builds and runs it'],
    note: 'Your three answers as a first slice. Two files, nothing written yet.', keyNote: 'takes it into the note', remark: null,
  });
  assert.equal(pair.blankPage.open, false);
  assert.deepEqual(sent.filter(m => m.type === 'message' && m.sender === 'pair').map(m => m.text.split('\n')[0]),
    ['What should it show first?', 'Steps or wall clock?', 'What do you want to learn?', '## First run'], 'the chat has the questions and the slice, no JSON');
  assert.deepEqual(readdirSync(root), [], 'nothing was written');
});

test('a slice that breaks the rules gets one more try with what is wrong, and is not shown when it breaks them again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pair-new-'));
  writeFileSync(join(root, 'NOTES.md'), '# toy\n');
  const slop = JSON.stringify({...SLICE, files: [...SLICE.files, {path: 'README.md'}]});
  const {pair, sent, inputs} = session(root, ['A?', 'B?', 'C?', slop, slop]);
  await pair.startNew('a raylib toy in C', 'NOTES.md');
  for (const answer of ['a', 'b', 'c']) await pair.blankPage.answer(answer);
  assert.match(inputs.at(-1), /^README\.md has no place in a first slice\. Answer again, as asked\.$/);
  assert.equal(sent.find(m => m.type === 'suggest'), undefined);
  assert.match(sent.findLast(m => m.type === 'message').text, /broke its own rules, so it is not shown: README\.md/);
});

test('without an idea, Pair first asks what we are making, without the model', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pair-new-'));
  const {pair, sent, inputs} = session(root, ['What should it show first?']);
  await pair.startNew('', join(root, 'NOTES.md'));
  assert.deepEqual(sent.filter(m => m.type === 'interview').map(m => [m.n, m.text]), [[0, 'What are we making?']]);
  assert.equal(inputs.length, 0);
  await pair.blankPage.answer('a zig allocator test');
  assert.equal(pair.state.goal, 'a zig allocator test');
  assert.match(inputs[0], /Their idea: "a zig allocator test"[\s\S]*question 1 of 3/);
});

test('notes outside the project are refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pair-new-'));
  const {pair, sent} = session(root, []);
  await pair.startNew('x', '/etc/NOTES.md');
  assert.match(sent.at(-1).text, /inside the project/);
  assert.equal(pair.blankPage, null);
});

test('the Driver can create a file not written yet as a new buffer, and read it back from the editor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pair-new-'));
  const requests = [];
  const pair = new PairSession({
    record: {id: 1, root, conversation_id: 7, goal: null, level: 'normal', role: 'driver'},
    store: {addMessage() {}}, partner: {}, score: async () => ({}), typingPauseMs: 2000, notify: () => 1,
    requestEditor: async message => { requests.push(message); return message.type === 'edit' ? {ok: true, from: 1, to: 2} : {text: null}; },
  });
  pair.role = 'driver';
  assert.match(await pair.read({file: 'Makefile'}), /does not exist yet/);
  assert.match(await pair.read({file: '../Makefile'}), /not inside the project/);
  assert.match(await pair.edit({file: 'Makefile', line: 1, endLine: 1, text: 'run:\n\tcc main.c'}), /^Changed/);
  assert.deepEqual(requests.at(-1), {type: 'edit', file: join(root, 'Makefile'), line: 1, endLine: 1, text: 'run:\n\tcc main.c'});
  assert.deepEqual(readdirSync(root), [], 'still only a buffer');
});
