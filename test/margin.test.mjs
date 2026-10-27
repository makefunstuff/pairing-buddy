import assert from 'node:assert/strict';
import {chmodSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {fold, initialState} from '../src/fold.mjs';
import {NoteMargin, READ_PAUSE_MS, taskArgs} from '../src/margin.mjs';
import {scratch} from './temp.mjs';

const NOTE = readFileSync(new URL('../docs/captures/notes/dead-letters.md', import.meta.url), 'utf8');
const ROOT = '/project';
const PATH = `${ROOT}/docs/dead-letters.md`;
const LOG = `${ROOT}/docs/decisions.md`;

const MODEL_MARKS = JSON.stringify([
  {kind: 'contradiction', line: 14, text: 'Line 14 says 5 attempts, line 20 says 6.', other_line: 20},
  {kind: 'question', line: 17, text: 'Replay as attempt 1 with full budget: does the 5-attempt cap apply again, so a dead receiver loops forever?'},
  {kind: 'question', line: 20, text: 'Does a receiver down for a minute reach 6 attempts inside 15 s?'},
]);

/** A margin over one note, a clock, and what reached the editors and the chat. `answers` are the model's, in order. */
function margin({answers = [MODEL_MARKS], taskCommand = null, root = ROOT} = {}) {
  const files = new Map([[PATH, NOTE]]);
  let clock = 100_000;
  let state = initialState({root, goal: 'dead letters'});
  const sent = [];
  const asked = [];
  const pair = new NoteMargin({
    root,
    state: () => state,
    receive: event => { state = fold(state, {at: clock, ...event}); },
    read: async path => files.get(path) ?? '',
    ask: async (system, input) => { asked.push({system, input}); return answers.shift() ?? '[]'; },
    notify: (to, message) => sent.push({to, ...message}),
    message: (sender, text) => sent.push({to: 'chat', sender, text}),
    typingPauseMs: 2000,
    taskCommand,
    now: () => clock,
  });
  return {
    pair, files, sent, asked,
    edit(text, from) {
      files.set(PATH, text);
      state = fold(state, {kind: 'edit', file: 'docs/dead-letters.md', from, to: from, text: text.split('\n')[from - 1], at: clock});
    },
    pass: ms => { clock += ms; },
    state: () => state,
    margins: () => sent.filter(message => message.type === 'margin'),
  };
}

test('at a pause the rules mark the repeat; once you stop writing, the model\'s marks join them', async () => {
  const m = margin();
  m.edit(NOTE, 21);
  m.pass(1000);
  await m.pair.tick();
  assert.equal(m.margins().length, 0); // still typing
  m.pass(1500);
  await m.pair.tick();
  assert.deepEqual(m.margins()[0].marks, [{kind: 'repeat', line: 26, text: 'Says again what line 9 says.', lineText: NOTE.split('\n')[25], other: 9, otherText: NOTE.split('\n')[8]}]);
  assert.equal(m.state().notes['docs/dead-letters.md'].title, 'Dead letters');
  assert.equal(m.asked.length, 0);
  m.pass(READ_PAUSE_MS);
  await m.pair.tick();
  assert.equal(m.asked.length, 1);
  assert.match(m.asked[0].input, /^Note: docs\/dead-letters\.md \("Dead letters"\)/);
  assert.deepEqual(m.margins().at(-1).marks.map(mark => [mark.kind, mark.line]), [['contradiction', 14], ['question', 17], ['question', 20], ['repeat', 26]]);
  m.pass(READ_PAUSE_MS);
  await m.pair.tick();
  assert.equal(m.asked.length, 1); // the note has not changed since
});

test('you change a line and its mark goes; a contradiction goes with either of its lines', async () => {
  const m = margin();
  m.edit(NOTE, 21);
  m.pass(READ_PAUSE_MS);
  await m.pair.tick();
  const fixed = NOTE.replace('We park after 6 attempts', 'We park after 5 attempts');
  m.edit(fixed, 20);
  m.pass(2000);
  await m.pair.tick();
  assert.deepEqual(m.margins().at(-1).marks.map(mark => [mark.kind, mark.line]), [['question', 17], ['repeat', 26]]);
  // A line inserted above moves the marks with their lines.
  m.edit(`# Dead letters\n\nNew first paragraph.\n${fixed.slice('# Dead letters\n'.length)}`, 3);
  m.pass(2000);
  await m.pair.tick();
  assert.deepEqual(m.margins().at(-1).marks.map(mark => [mark.kind, mark.line]), [['question', 19], ['repeat', 28]]);
});

test('a "Decision:" line gets its mark, and logging it quotes the question it answers, whose mark goes', async () => {
  const m = margin();
  m.edit(NOTE, 21);
  m.pass(READ_PAUSE_MS);
  await m.pair.tick();
  const decided = NOTE.replace('We park after 6', 'Decision: replay keeps the attempt cap; it gets the budget back, not new attempts\nWe park after 5');
  m.edit(decided, 20);
  m.pass(2000);
  await m.pair.tick();
  assert.deepEqual(m.margins().at(-1).marks.map(mark => [mark.kind, mark.line]), [['question', 17], ['decision', 20], ['repeat', 27]]);

  await m.pair.decide(PATH, 20);
  const log = m.sent.find(message => message.type === 'decision_log');
  assert.equal(log.to, 'editor');
  assert.equal(log.file, LOG);
  assert.equal(log.name, 'docs/decisions.md');
  assert.match(log.text, /^# Decisions\n\n## \d{4}-\d\d-\d\d · replay keeps the attempt cap; it gets the budget back, not new attempts\n\n- Status: decided\n- Where: docs\/dead-letters\.md:20 \(## How\)\n- Asked: "Replay as attempt 1 with full budget/);
  assert.match(m.sent.find(message => message.to === 'chat').text, /^Logged in docs\/decisions\.md: replay keeps/);
  m.files.set(LOG, log.text); // the editor put it in the log's buffer
  await m.pair.refresh('docs/dead-letters.md');
  assert.deepEqual(m.margins().at(-1).marks.map(mark => [mark.kind, mark.line]), [['repeat', 27]]);
});

test('the decide key on a line that decides nothing says so, and logs nothing', async () => {
  const m = margin();
  await m.pair.decide(PATH, 14);
  assert.deepEqual(m.sent.map(message => message.type ?? message.text), ['docs/dead-letters.md:14 is no decision: start the line with "Decision:".']);
});

test(':Pair tasks shows the model\'s tasks and adds nothing; the yes runs the task command once per task', async () => {
  const root = scratch('pair-tasks-');
  const script = join(root, 'add-task');
  writeFileSync(script, '#!/bin/sh\nprintf "%s|%s\\n" "$1" "$2" >> added.txt\n');
  chmodSync(script, 0o755);
  const tasks = [{title: 'Park failed webhooks after the last attempt', lines: 'lines 3-4, line 8'}, {title: 'Decide how long dead letters are kept', lines: 'line 25', open: true}];
  const m = margin({root, answers: [JSON.stringify(tasks)], taskCommand: [script, '{title}', '{description}']});
  m.files.set(join(root, 'notes.md'), NOTE);
  await m.pair.tasks(join(root, 'notes.md'));
  const shown = m.sent.find(message => message.type === 'tasks');
  assert.deepEqual(shown.tasks, tasks.map(task => ({open: false, ...task})));
  assert.equal(shown.name, 'notes.md');
  assert.equal(shown.adds, `${script} {title}`);
  assert.throws(() => readFileSync(join(root, 'added.txt')));
  await m.pair.addTasks(join(root, 'notes.md'), shown.tasks);
  assert.equal(readFileSync(join(root, 'added.txt'), 'utf8'),
    'Park failed webhooks after the last attempt|From notes.md, lines 3-4, line 8.\nDecide how long dead letters are kept|From notes.md, line 25.\n');
  assert.match(m.sent.at(-1).text, /^Added 2 tasks from notes\.md:\n- Park failed/);
});

test('the task command gets the title and the description as whole words, never through a shell', () => {
  assert.deepEqual(taskArgs(['gh', 'issue', 'create', '--title', '{title}', '--body', '{description}'], {title: 'a; rm -rf /'}, 'From x.md.'),
    ['gh', 'issue', 'create', '--title', 'a; rm -rf /', '--body', 'From x.md.']);
});

test('the config\'s taskCommand is a command as words; without one, :Pair tasks copies the list', async () => {
  const {parseConfig} = await import('../src/config.mjs');
  const models = {watcher: {api: 'openai', baseUrl: 'http://x', model: 'w'}, partner: {api: 'openai', baseUrl: 'http://x', model: 'p'}};
  assert.equal(parseConfig({models}).taskCommand, null);
  assert.deepEqual(parseConfig({models, taskCommand: ['gh', 'issue', 'create', '--title', '{title}']}).taskCommand, ['gh', 'issue', 'create', '--title', '{title}']);
  assert.throws(() => parseConfig({models, taskCommand: 'gh issue create'}), /taskCommand must be a command as a list of words/);
});

test('a reading that comes back empty is asked once more', async () => {
  const m = margin({answers: ['[]', MODEL_MARKS]});
  m.edit(NOTE, 21);
  m.pass(READ_PAUSE_MS);
  await m.pair.tick();
  assert.equal(m.asked.length, 2);
  assert.deepEqual(m.margins().at(-1).marks.map(mark => mark.line), [14, 17, 20, 26]);
  const quiet = margin({answers: ['[]', '[]']});
  quiet.edit(NOTE, 21);
  quiet.pass(READ_PAUSE_MS);
  await quiet.pair.tick();
  assert.equal(quiet.asked.length, 2, 'twice at most');
});
