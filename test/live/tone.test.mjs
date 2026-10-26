// Pair's tone against real models, through a real PairSession: what the user reads under their line and in the
// chat leads with file:line, stays within its words, and has no praise, apology, filler, emoji or "!". The project
// is a small C program with a Makefile (probe/), run for real: a table that never grows, since `len / cap` is
// integer division, so the average probe count fails its check (with exit 1, no crash).
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, test} from 'node:test';
import {MemoryStorage} from '@earendil-works/pi-durable';
import {openPartner} from '../../src/partner.mjs';
import {PairSession} from '../../src/session.mjs';
import {ROLE_TOOLS} from '../../src/tools.mjs';
import {detectTriggers} from '../../src/triggers.mjs';
import {toneProblems, WORDS} from '../../src/tone.mjs';
import {bashWithoutCores} from '../no-core.mjs';
import {liveStacks, SKIP_REASON} from './stacks.mjs';

const PROBE = fileURLToPath(new URL('./probe', import.meta.url));
const hasCc = spawnSync('cc', ['--version']).status === 0;
const PLACE = /\b[\w/-]+\.[ch]:\d+/; // table.c:35

/** The probe project in a scratch directory, fixed or not, and what `make run` printed there, for real. */
function probe({fixed = false} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pair-tone-'));
  cpSync(PROBE, root, {recursive: true});
  if (fixed) {
    const table = join(root, 'table.c');
    writeFileSync(table, readFileSync(table, 'utf8').replace('t->len / t->cap > 0.7', '(double)t->len / (double)t->cap > 0.7'));
  }
  const run = spawnSync(...bashWithoutCores('make --no-print-directory run'), {cwd: root, encoding: 'utf8'});
  return {root, exit: run.status, output: `${run.stdout}${run.stderr}`.trim()};
}

const stacks = liveStacks();

describe('Pair\'s tone on live models', {skip: !stacks.length ? SKIP_REASON : !hasCc ? 'no C compiler' : false}, () => {
  for (const stack of stacks) {
    /** A session in the probe project, with Navigator's tools; `chat` and `editor` collect what each was sent. */
    async function pairIn(root) {
      const chat = [];
      const editor = [];
      let session;
      const partner = await openPartner({
        storage: new MemoryStorage(),
        models: stack.models,
        model: stack.partner,
        thinking: stack.config.models.partner.thinking,
        hands: {...Object.fromEntries(ROLE_TOOLS.navigator.map(name => [name, (_conversation, args) => session[name](args)])), roleOf: () => session.role},
      });
      const conversation = await partner.createConversation();
      session = new PairSession({
        record: {id: 1, root, conversation_id: conversation, goal: 'the table keeps the average probe under 3', level: 'normal', role: 'navigator'},
        store: {addMessage() {}, addAction: () => 1, updateAction() {}, addRemark: () => 1, dropRemark() {}, seeRemark() {}},
        partner, score: async () => ({value: 9, reason: ''}), typingPauseMs: 2000, log: line => console.error(line),
        notify: (to, message) => {
          if (to === 'chat' && message.type === 'message' && message.sender === 'pair') chat.push(message.text);
          if (to === 'chat' && message.type === 'message' && message.sender === 'system') console.error(`system: ${message.text}`); // a model that fails says so here
          if (to === 'editor') editor.push(message);
          return 1;
        },
        requestEditor: async message => (message.type === 'read' ? {text: readFileSync(message.file, 'utf8')} : {}),
      });
      return {session, chat, editor, close: () => partner.close()};
    }

    const holds = (t, text, maxWords, what) => {
      t.diagnostic(`${what}: ${text}`);
      assert.deepEqual(toneProblems(text, {maxWords}), [], `${what} keeps the tone`);
    };

    test(`${stack.name}: a remark on a failed run names file:line in a few words, and asked why, it gives the idea worth keeping`, {timeout: 300_000}, async t => {
      const run = probe();
      assert.notEqual(run.exit, 0, `the probe fails for real:\n${run.output}`);
      const {session, editor, close} = await pairIn(run.root);
      const now = Date.now();
      session.receive({kind: 'edit', file: 'table.c', from: 35, to: 35, at: now - 60_000});
      session.receive({kind: 'focus', target: 'editor', at: now - 30_000});
      session.receive({kind: 'command_end', pane: 'w1:p2', cmd: 'make run', exit: run.exit, output: run.output, at: now - 5000});
      const trigger = detectTriggers(session.state, now).find(found => found.kind === 'failed_command');
      assert.ok(trigger, 'the failed run raises a trigger');
      await session.remark(trigger, 9);

      const remark = editor.find(message => message.type === 'remark');
      assert.ok(remark?.text, 'a remark under the line');
      holds(t, remark.text, WORDS.remark, 'the remark');
      assert.match(remark.text, PLACE, 'it names the place as file:line');

      await session.teach(remark.text);
      const teaching = editor.find(message => message.type === 'teaching');
      assert.ok(teaching?.text, 'the idea behind it');
      holds(t, teaching.text, WORDS.teach, 'the teaching');
      assert.notEqual(teaching.text.trim(), remark.text.trim(), 'not a repeat of the remark');
      if (teaching.link) {
        t.diagnostic(`link: ${teaching.link}`);
        const response = await fetch(teaching.link, {redirect: 'follow', signal: AbortSignal.timeout(15_000)});
        assert.ok(response.status < 400, `its link opens (${response.status})`);
      }
      await close();
    });

    test(`${stack.name}: a question gets a short answer with the place, without headings or lists`, {timeout: 300_000}, async t => {
      const run = probe();
      const {session, chat, close} = await pairIn(run.root);
      session.receive({kind: 'command_end', pane: 'w1:p2', cmd: 'make run', exit: run.exit, output: run.output, at: Date.now() - 20_000});
      const answer = await session.ask('why is the average probe 12.6? the table should grow at 0.7');
      await close();
      t.diagnostic(`the chat: ${chat.join(' | ')}`);
      t.diagnostic(`its words: ${answer}`);
      // Its words, said or answered: a point's own line in the chat ("table.c:35 <note>") is no answer.
      assert.ok(answer, 'it answers in words, not only with a point');
      holds(t, chat.join('\n'), WORDS.answer, 'the chat');
      assert.match(answer, PLACE, 'its words name the place as file:line');
    });

    test(`${stack.name}: green after a long red is named, not praised`, {timeout: 300_000}, async t => {
      const red = probe();
      const green = probe({fixed: true});
      assert.equal(green.exit, 0, `the fix passes for real:\n${green.output}`);
      const {session, chat, close} = await pairIn(green.root);
      const now = Date.now();
      session.receive({kind: 'command_end', pane: 'w1:p2', cmd: 'make run', exit: red.exit, output: red.output, at: now - 23 * 60_000});
      session.receive({kind: 'edit', file: 'table.c', from: 35, to: 35, at: now - 60_000});
      session.receive({kind: 'command_end', pane: 'w1:p2', cmd: 'make run', exit: 0, output: green.output, at: now - 5000});
      const answer = await session.ask('finally. 23 minutes on that one. it passes now, was that really it?');
      await close();
      t.diagnostic(`the chat: ${chat.join(' | ')}`);
      t.diagnostic(`its words: ${answer}`);
      assert.ok(answer, 'it answers in words, not only with a point');
      holds(t, chat.join('\n'), WORDS.answer, 'the chat');
      // What the fix made true, in its own words: the line it changed, or what changed there (the ratio is no longer
      // integer division, so the table grows at 0.7 and the average drops to 2.3).
      assert.match(answer, /table\.c:35|grow|double|cast|integer|0\.7|2\.3|2048/i, 'its words name what is now true');
    });
  }
});
