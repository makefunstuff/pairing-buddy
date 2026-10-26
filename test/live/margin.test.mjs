// Notes in the margin against real models: the marks on a design note are few and specific and name the code, the
// tasks come from the note, and the prose triggers ask a question back instead of writing for you.
import assert from 'node:assert/strict';
import {cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, test} from 'node:test';
import {MemoryStorage} from '@earendil-works/pi-durable';
import {readProjectPath} from '../../src/files.mjs';
import {fold, initialState} from '../../src/fold.mjs';
import {codeFor, MARKS_PROMPT, noteInput, oneAnswer, parseMarks, parseTasks, TASKS_PROMPT} from '../../src/note-reading.mjs';
import {openPartner} from '../../src/partner.mjs';
import {proseTriggers} from '../../src/prose-triggers.mjs';
import {PairSession} from '../../src/session.mjs';
import {ROLE_TOOLS} from '../../src/tools.mjs';
import {createWatcher} from '../../src/watcher.mjs';
import {liveStacks, SKIP_REASON} from './stacks.mjs';

const HOOKD = fileURLToPath(new URL('../../docs/captures/hookd', import.meta.url));
const NOTE = readFileSync(new URL('../../docs/captures/notes/dead-letters.md', import.meta.url), 'utf8');
const FILE = 'docs/dead-letters.md';
const NOW = 1_000_000;

/** The webhook service of the captures, in git, with the dead-letters note in docs/. */
function project(note = NOTE) {
  const root = mkdtempSync(join(tmpdir(), 'pair-live-note-'));
  cpSync(HOOKD, root, {recursive: true});
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, FILE), note);
  execFileSync('git', ['init', '-q'], {cwd: root});
  execFileSync('git', ['add', '-A'], {cwd: root});
  return root;
}

const wordCount = text => text.split(/\s+/).filter(Boolean).length;

/**
 * What Pair shows for the prose trigger raised by `events`, through a real session and the live Partner, as the
 * daemon wires them (its editor is the files on disk); and the Watcher's score for it.
 */
async function remarkOn(stack, root, events, kind) {
  const state = events.reduce(fold, initialState({root, goal: 'dead letters for webhooks'}));
  const trigger = proseTriggers(state, NOW).find(found => found.kind === kind);
  assert.ok(trigger, `the events raise ${kind}`);
  let session;
  const hands = {
    ...Object.fromEntries(ROLE_TOOLS.navigator.map(name => [name, (_c, args) => session.useTool(name, args)])),
    roleOf: () => 'navigator',
  };
  const partner = await openPartner({storage: new MemoryStorage(), models: stack.models, model: stack.partner, thinking: stack.config.models.partner.thinking, hands});
  const conversation = await partner.createConversation();
  const shown = [];
  session = new PairSession({
    record: {id: 1, root, conversation_id: conversation, goal: state.goal, level: 'normal'},
    store: {addMessage() {}, addRemark: () => 1, dropRemark() {}},
    partner, score: async () => ({value: 9}), typingPauseMs: 2000,
    notify: (_to, message) => { if (message.type === 'message') shown.push(message.text); return 1; },
    requestEditor: async () => null,
    now: () => NOW,
  });
  session.state = state;
  await session.remark(trigger, 9);
  await partner.close();
  const score = await createWatcher({models: stack.models, model: stack.watcher, now: () => NOW})(trigger, state);
  return {said: shown.join('\n'), score: score.value};
}

const stacks = liveStacks();

describe('Notes in the margin on live models', {skip: stacks.length ? false : SKIP_REASON}, () => {
  for (const stack of stacks) {
    const model = {models: stack.models, model: stack.partner};

    test(`${stack.name}: at most five marks on the note, specific, one of them the 5-versus-6 contradiction, and one about the code`, {timeout: 180_000}, async t => {
      const root = project();
      const code = await codeFor(root, NOTE);
      assert.deepEqual(code.map(place => place.file), ['internal/delivery/worker.go', 'internal/delivery/worker.go']);
      const answer = await oneAnswer(model, MARKS_PROMPT, noteInput(FILE, NOTE, code, 'dead letters for webhooks'));
      const marks = await parseMarks(answer, NOTE, async file => Boolean(await readProjectPath(root, file).then(source => source.text)));
      if (!marks.length) t.diagnostic(`the answer, with no mark in it: ${answer}`);
      for (const mark of marks) t.diagnostic(`${mark.kind} ${mark.line}${mark.other ? `/${mark.other}` : ''}${mark.file ? ` ${mark.file}:${mark.fileLine}` : ''}: ${mark.text}`);
      assert.ok(marks.length >= 2 && marks.length <= 5, `${marks.length} marks`);
      assert.ok(marks.every(mark => wordCount(mark.text) <= 35), 'each mark is short');
      assert.ok(marks.some(mark => [14, 20].includes(mark.line) && /\b5\b/.test(mark.text) && /\b6\b/.test(mark.text)), 'the 5 attempts of line 14 against the 6 of line 20');
      assert.ok(marks.some(mark => mark.file || /worker\.go|Deliver|ErrBudget|MaxAttempts/.test(mark.text)), 'a mark says what the code does');
    });

    test(`${stack.name}: tasks come from the note, and its open question becomes one`, {timeout: 180_000}, async t => {
      const tasks = parseTasks(await oneAnswer(model, TASKS_PROMPT, noteInput(FILE, NOTE, [])));
      for (const task of tasks) t.diagnostic(`${task.open ? 'open ' : ''}${task.title} (${task.lines})`);
      assert.ok(tasks.length >= 3 && tasks.length <= 8, `${tasks.length} tasks`);
      assert.ok(tasks.some(task => task.open && /keep|retention|long/i.test(task.title)), 'how long dead letters are kept is a decision to make');
    });

    test(`${stack.name}: stuck after a question in the note, it asks one question back and does not answer`, {timeout: 180_000}, async t => {
      const question = 'Should replay reset the attempt count?';
      const note = NOTE.replace('the full budget again.', `the full budget again.\n${question}`);
      const root = project(note);
      const {said, score} = await remarkOn(stack, root, [
        {kind: 'edit', file: FILE, from: 18, to: 19, text: `the full budget again.\n${question}`, at: NOW - 100_000},
        {kind: 'note', file: FILE, title: 'Dead letters', at: NOW - 99_000},
      ], 'note_stall');
      t.diagnostic(`watcher ${score}: ${said}`);
      assert.ok(score >= 6, `the Watcher lets it through at the normal bar (${score})`);
      assert.match(said, /\?\s*$/, 'a question back');
      assert.equal(said.match(/\?/g).length, 1, 'one question, nothing more');
      assert.ok(wordCount(said) <= 25, 'one short question');
      assert.doesNotMatch(said, /line (14|20|21)\b|\b6 attempts/i, 'about their question, not the contradiction the margin shows');
    });

    test(`${stack.name}: a section that leaves the note gets one question; one about the note itself gets silence`, {timeout: 240_000}, async t => {
      const pricing = '## Pricing tiers\n\nCustomers on the free plan get three seats; the team plan bills per seat each month.';
      const root = project(`${NOTE}\n${pricing}\n`);
      const off = await remarkOn(stack, root, [
        {kind: 'note', file: FILE, title: 'Dead letters', at: NOW - 100_000},
        {kind: 'edit', file: FILE, from: 28, to: 30, text: pricing, at: NOW - 70_000},
      ], 'note_drift');
      t.diagnostic(`off the note, watcher ${off.score}: ${off.said}`);
      assert.ok(off.score >= 6, `the Watcher lets it through at the normal bar (${off.score})`);
      assert.match(off.said, /\?/, 'asked, as a question');
      assert.match(off.said, /dead.letter/i, 'naming the note');

      const replay = '## Operators\n\nOperators replay one parked job at a time from the admin page.';
      const onRoot = project(`${NOTE}\n${replay}\n`);
      // "Operators" shares no word with the title: the rule lets it through, and the Partner reads the note.
      const on = await remarkOn(stack, onRoot, [
        {kind: 'note', file: FILE, title: 'Webhooks that fail', at: NOW - 100_000},
        {kind: 'edit', file: FILE, from: 28, to: 30, text: replay, at: NOW - 70_000},
      ], 'note_drift');
      t.diagnostic(`on the note, watcher ${on.score}: ${on.said || 'SILENT'}`);
      assert.ok(on.score < 6, `the Watcher holds it back (${on.score})`);
      assert.equal(on.said, '', 'silent about a section on the note\'s own subject');
    });
  }
});
