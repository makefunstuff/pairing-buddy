// The blank page against real models, through a real PairSession in an empty folder: :Pair new asks three short
// questions one at a time, then shows a first slice of two files in the note, with the build file the stack wants.
// For C and Zig with a Makefile, the Driver then types both files: once saved, make takes the Makefile and its run
// target builds the source. Whether the program the model typed compiles and runs cleanly is only reported. The editor is played
// by buffers in memory: the folder on disk stays empty.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, test} from 'node:test';
import {MemoryStorage} from '@earendil-works/pi-durable';
import {openPartner} from '../../src/partner.mjs';
import {PairSession} from '../../src/session.mjs';
import {ROLE_TOOLS} from '../../src/tools.mjs';
import {liveStacks, SKIP_REASON} from './stacks.mjs';

/** Neovim's buffers, in memory: read serves them, edit changes them (a missing file is an empty buffer). */
function buffers() {
  const text = new Map();
  const of = file => text.get(file) ?? '';
  return {
    text: of,
    files: () => [...text.keys()],
    request(message) {
      if (message.type === 'read') return {text: text.has(message.file) ? of(message.file) : null};
      if (message.type !== 'edit') return {};
      const lines = of(message.file).split('\n');
      const replacement = message.text === '' ? [] : message.text.replace(/\n$/, '').split('\n');
      lines.splice(message.line - 1, Math.min(message.endLine, lines.length) - message.line + 1, ...replacement);
      text.set(message.file, lines.join('\n'));
      return {ok: true};
    },
  };
}

const IDEAS = {
  c: {
    idea: 'a tiny C program, built with a Makefile, to learn how a fixed-timestep loop behaves; it prints to the terminal',
    answers: [
      'the sim steps at 10 Hz while the loop runs as fast as it can, for three seconds, then it exits',
      'one line per second: steps so far and loop iterations so far, nothing else',
      'plain C and make, no libraries; I want to see the accumulator catch up when I add a sleep',
    ],
    build: /^Makefile$/,
    source: /\.c$/,
    main: 'main.c',
  },
  odin: {
    idea: 'an Odin toy with a Makefile: a game of life in the terminal',
    answers: ['a 20 by 20 grid with a glider, printed every generation', 'ten generations, then it stops', 'only core: no vendor packages'],
    build: /^Makefile$/,
    source: /\.odin$/,
  },
  zig: {
    idea: 'a zig toy with a Makefile, to see what an arena allocator gives back',
    answers: ['allocate a hundred small strings from an arena, print how many bytes it holds', 'then free it all at once and print it again', 'std only, and it exits by itself'],
    build: /^Makefile$/,
    source: /\.zig$/,
    main: 'main.zig',
  },
  go: {
    idea: 'a small Go CLI that counts words in the files I pass it',
    answers: ['the total per file and a grand total', 'plain text files, words split on whitespace', 'standard library only'],
    build: /^go\.mod$/,
    source: /\.go$/,
  },
  js: {
    idea: 'a node script that watches a folder and prints each file that changes',
    answers: ['the file name and the time, one line each', 'only the folder I pass, not its subfolders', 'node only, nothing from npm'],
    build: /^package\.json$/,
    source: /\.m?js$/,
  },
  // "go" here is English, not the stack.
  'js-go': {
    idea: 'a node script where deleted files go to a trash folder instead of away',
    answers: ['move the file into .trash with the time in its name', 'one file per call, the path is the only argument', 'node only, nothing from npm'],
    build: /^package\.json$/,
    source: /\.m?js$/,
  },
};

const stacks = liveStacks();

describe('The blank page on live models', {skip: stacks.length ? false : SKIP_REASON}, () => {
  for (const stack of stacks) {
    /** :Pair new `idea` in an empty folder, answering each question in turn; resolves when the slice is shown. */
    async function interview({idea, answers}) {
      const root = mkdtempSync(join(tmpdir(), 'pair-new-'));
      const note = join(root, 'NOTES.md');
      const editor = buffers();
      editor.request({type: 'edit', file: note, line: 1, endLine: 1, text: `# toy\n\n${idea}`});
      const questions = [];
      const shown = [];
      const tools = [];
      let slice = null;
      let session;
      const partner = await openPartner({
        storage: new MemoryStorage(),
        models: stack.models,
        model: stack.partner,
        thinking: stack.config.models.partner.thinking,
        hands: {...Object.fromEntries(ROLE_TOOLS.driver.map(name => [name, (_conversation, args) => (tools.push(`${name}(${JSON.stringify(args)})`), session[name](args))])), roleOf: () => session.role},
      });
      session = new PairSession({
        record: {id: 1, root, conversation_id: await partner.createConversation(), goal: null, level: 'normal', role: 'navigator'},
        store: {addMessage() {}, addAction: () => 1, updateAction() {}, setRole() {}, setGoal() {}},
        partner, score: async () => ({value: 0, reason: ''}), typingPauseMs: 2000,
        notify: (to, message) => {
          if (message.type === 'message') shown.push(`${message.sender}: ${message.text}`);
          if (message.type === 'interview' && !message.done) questions.push(message.text);
          if (message.type === 'suggest') slice = message;
          if (message.type === 'role') return 1; // a Neovim is attached
          return 1;
        },
        requestEditor: async message => editor.request(message),
      });
      await session.configurePartner('navigator');
      await session.startNew(idea, note);
      for (const answer of answers) {
        assert.equal(questions.length, answers.indexOf(answer) + 1, `one question waits for each answer: ${shown.join(" / ")}`);
        await session.blankPage.answer(`- ${answer}`);
      }
      return {root, note, editor, session, partner, questions, shown, tools, slice};
    }

    for (const [name, script] of Object.entries(IDEAS)) {
      test(`${stack.name}: ${name}: three short questions, then a two-file slice with the right build file`, {timeout: 300_000}, async t => {
        const result = await interview(script);
        t.diagnostic(`questions: ${result.questions.join(' | ')}`);
        t.diagnostic(`slice:\n${result.slice?.text ?? result.shown.join('\n')}`);
        assert.equal(result.questions.length, 3, 'three questions');
        for (const question of result.questions) {
          assert.ok(question.split(/\s+/).length <= 18, `at most 18 words: ${question}`);
          assert.match(question, /\?$/, 'a question');
          assert.doesNotMatch(question, /[{};]|```/, 'no code');
        }
        assert.ok(result.slice, 'the slice is shown in the note');
        assert.equal(result.slice.insert, true, 'as lines to add, nothing struck');
        const files = [...result.slice.text.matchAll(/^- `([^`]+)`/gm)].map(match => match[1]);
        assert.equal(files.length, 2, `two files: ${files}`);
        assert.ok(files.some(file => script.build.test(file)), `the build file: ${files}`);
        assert.ok(files.some(file => script.source.test(file)), `the source file: ${files}`);
        assert.doesNotMatch(result.slice.text, /readme|license|\.gitignore/i, 'no scaffolding');
        assert.deepEqual(readdirSync(result.root), [], 'nothing was written');
        await result.partner.close();
      });
    }

    for (const name of ['c', 'zig']) {
      test(`${stack.name}: ${name}: handed the wheel twice, Pair types the Makefile and the source, and once saved make run builds the source`, {timeout: 600_000}, async t => {
        const result = await interview(IDEAS[name]);
        const {session, editor, root} = result;
        session.notify = (to, message) => (message.type === 'message' && result.shown.push(`${message.sender}: ${message.text}`), 1);
        await session.drive('you take it: write the Makefile from the slice');
        await session.drive(`you take it: now write ${IDEAS[name].main} from the slice`);
        t.diagnostic(`tools: ${result.tools.join('\n')}`);
        t.diagnostic(`shown: ${result.shown.join('\n')}`);
        t.diagnostic(`buffers: ${editor.files().map(file => file.slice(root.length + 1)).join(', ')}`);
        for (const file of editor.files().filter(file => file !== result.note)) t.diagnostic(`${file.slice(root.length + 1)}:\n${editor.text(file)}`);
        assert.deepEqual(readdirSync(root), [], 'still nothing on disk: the user saves');
        // The user saves both and runs it.
        const copy = mkdtempSync(join(tmpdir(), 'pair-new-run-'));
        for (const file of editor.files().filter(file => file !== result.note)) writeFileSync(join(copy, file.slice(root.length + 1)), editor.text(file));
        // The slice's part is the wiring: make reads the Makefile, and its run target builds the source Pair typed.
        const plan = spawnSync('make', ['-n', 'run'], {cwd: copy, encoding: 'utf8'});
        t.diagnostic(`make -n run (exit ${plan.status}):\n${plan.stdout}${plan.stderr}`);
        assert.equal(plan.status, 0, 'make takes the Makefile');
        assert.ok(plan.stdout.includes(IDEAS[name].main), `and make run builds ${IDEAS[name].main}`);
        // Whether the program the model typed then compiles and runs cleanly is the user's next step: only reported.
        const run = spawnSync('make', ['run'], {cwd: copy, encoding: 'utf8', timeout: 30_000});
        t.diagnostic(`make run (exit ${run.status}):\n${run.stdout}${run.stderr}`);
        await result.partner.close();
      });
    }
  }
});
