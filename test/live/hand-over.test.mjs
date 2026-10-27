// The hand-over without a test against real models, through a real PairSession: the hash table of
// docs/captures/loop, built and run with `make -s run` in the user's terminal. They hand over with an intent and
// an observable ("avg probe stays under 2"); the Driver edits, Pair builds and runs the unsaved buffer in a scratch
// copy with the user's own command, and the hand-back says what the run printed next to the target. The editor is
// played by an in-memory buffer, so the files on disk must stay as they were.
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, describe, test} from 'node:test';
import {MemoryStorage} from '@earendil-works/pi-durable';
import {openPartner} from '../../src/partner.mjs';
import {PairSession} from '../../src/session.mjs';
import {ROLE_TOOLS} from '../../src/tools.mjs';
import {bashWithoutCores} from '../no-core.mjs';
import {localPane} from './project.mjs';
import {liveStacks, SKIP_REASON} from './stacks.mjs';

const PROJECT = new URL('../../docs/captures/loop/', import.meta.url);
const PROBE = readFileSync(new URL('probe.c', PROJECT), 'utf8');
const hasBuild = ['cc', 'make'].every(tool => spawnSync(tool, ['--version']).status === 0);
const stacks = liveStacks();
const scratch = []; // the projects made, removed when the tests end
after(() => scratch.forEach(dir => rmSync(dir, {recursive: true, force: true})));

/** The loop project in a scratch git repository, built and run once as the user did: its folder and that run. */
function project() {
  const root = mkdtempSync(join(tmpdir(), 'pair-live-hand-over-'));
  scratch.push(root);
  copyFileSync(new URL('Makefile', PROJECT), join(root, 'Makefile'));
  writeFileSync(join(root, 'probe.c'), PROBE);
  execFileSync('git', ['init', '-q'], {cwd: root});
  const run = spawnSync(...bashWithoutCores('make -s run'), {cwd: root, encoding: 'utf8'});
  return {root, output: run.stdout + run.stderr, exit: run.status};
}

describe('the hand-over without a test, on live models', {skip: !stacks.length ? SKIP_REASON : hasBuild ? false : 'needs cc and make'}, () => {
  for (const stack of stacks) {
    test(`${stack.name}: an intent and a number to reach: one edit, the unsaved buffer built and run, ✓ or ✗ with the number`, {timeout: 300_000}, async t => {
      const {root, output, exit} = project();
      let buffer = PROBE;
      let handback = null;
      const tools = [];
      let session;
      const hand = name => async (_conversation, args) => { tools.push({name, args}); return session[name](args); };
      const partner = await openPartner({
        storage: new MemoryStorage(),
        models: stack.models,
        model: stack.partner,
        thinking: stack.config.models.partner.thinking,
        hands: {...Object.fromEntries(ROLE_TOOLS.driver.map(name => [name, hand(name)])), roleOf: () => session.role},
      });
      const conversation = await partner.createConversation();
      session = new PairSession({
        record: {id: 1, root, conversation_id: conversation, goal: 'see how well the entity table spreads its keys', level: 'normal', role: 'navigator'},
        store: {addMessage() {}, addAction: () => 1, updateAction() {}, lastRemark: () => null, setRole() {}, setGoal() {}},
        partner, score: async () => ({value: 0, reason: ''}), typingPauseMs: 2000,
        notify: (_to, message) => {
          if (message.type === 'handback') handback = message;
          if (message.type === 'confirm') setImmediate(() => session.answer(message.id, true)); // every question gets a yes
          return 1;
        },
        requestEditor: async message => {
          if (message.type === 'read') return {text: buffer};
          if (message.type !== 'edit') return {};
          const lines = buffer.split('\n');
          lines.splice(message.line - 1, message.endLine - message.line + 1, ...(message.text === '' ? [] : message.text.replace(/\n$/, '').split('\n')));
          buffer = lines.join('\n');
          return {ok: true};
        },
      });
      session.scout = localPane(root);
      session.receive({kind: 'command_end', pane: 'w1:p3', cmd: 'make -s run', exit, output, cwd: root});
      await session.drive('you take it: make the hash spread the ids over the whole table, avg probe stays under 2');
      await partner.close();
      t.diagnostic(`tools: ${tools.map(call => `${call.name}(${JSON.stringify(call.args)})`).join(', ')}`);
      t.diagnostic(`hand-back: ${JSON.stringify(handback)}`);
      assert.equal(tools.filter(call => call.name === 'edit').length, 1, 'one edit');
      // The Driver may run its own experiments before it edits; the check is the one run in the scratch copy.
      const checks = session.scout.ran.filter(command => command.includes('.unsaved/tree'));
      assert.equal(checks.length, 1, 'one check on the unsaved buffer');
      assert.match(checks[0], /\.unsaved\/tree' && \(make -s run\) > /, 'with the user\'s command, in the scratch copy');
      // Under 2 at this load takes more than a good hash, and a model does not always find it: the check has to say
      // which it was, with the number the run printed.
      const printed = /^avg probe (\d+(?:\.\d+)?)$/.exec(handback?.check ?? '');
      assert.ok(printed, 'the hand-back has the line the run printed for the target');
      t.diagnostic(`reached the target: ${Number(printed[1]) < 2}`);
      assert.equal(handback.tests, Number(printed[1]) < 2 ? 'pass' : 'fail', 'its mark says whether the number met the bound');
      assert.ok(handback.text.trim().length > 0, 'Pair says what it changed');
      assert.equal(readFileSync(join(root, 'probe.c'), 'utf8'), PROBE, 'nothing was written to disk');
    });
  }
});
