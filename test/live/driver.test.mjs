// The Driver against real models, through a real PairSession: handed the wheel, it makes one edit that
// does what was asked (ping-pong TDD included), types a command for the user without Enter, and as
// Navigator suggests a change instead of making it. The editor is played by in-memory buffers, so the
// files on disk must stay as they were.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cpSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, test} from 'node:test';
import {MemoryStorage} from '@earendil-works/pi-durable';
import {openPartner} from '../../src/partner.mjs';
import {PairSession} from '../../src/session.mjs';
import {ROLE_TOOLS} from '../../src/tools.mjs';
import {FILES, localPane, project} from './project.mjs';
import {liveStacks, SKIP_REASON} from './stacks.mjs';

/** Neovim's part, played by buffers in memory: read serves them, edit changes them as the plugin does. */
function buffers(root) {
  const text = new Map();
  const of = file => text.get(file) ?? readFileSync(file, 'utf8');
  return {
    text: file => of(join(root, file)),
    request(message) {
      if (message.type === 'read') return {text: of(message.file)};
      if (message.type !== 'edit') return {};
      const lines = of(message.file).split('\n');
      const replacement = message.text === '' ? [] : message.text.replace(/\n$/, '').split('\n');
      lines.splice(message.line - 1, Math.min(message.endLine, lines.length) - message.line + 1, ...replacement);
      text.set(message.file, lines.join('\n'));
      return {ok: true};
    },
  };
}

/** Whether the project's tests pass with the buffers' text in place of the files. */
function testsPass(root, editor) {
  const copy = mkdtempSync(join(tmpdir(), 'pair-driver-run-'));
  cpSync(root, copy, {recursive: true});
  for (const file of Object.keys(FILES)) writeFileSync(join(copy, file), editor.text(file));
  const {NODE_TEST_CONTEXT, ...env} = process.env;
  try {
    execFileSync('node', ['--test'], {cwd: copy, env, stdio: 'ignore', timeout: 60_000});
    return true;
  } catch {
    return false;
  }
}

const stacks = liveStacks();

describe('Driver on live models', {skip: stacks.length ? false : SKIP_REASON}, () => {
  for (const stack of stacks) {
    /**
     * Runs one turn: `start(session)` hands over or asks. Resolves with what the chat showed, the tools
     * called, the editor's buffers and what was typed into the user's terminal. Every confirmation is a yes.
     */
    async function turn(start, {edited, takeBackAtFirstTool = false} = {}) {
      const {root} = project();
      const editor = buffers(root);
      const shown = [];
      const tools = [];
      const typed = [];
      let session;
      const hand = name => async (_conversation, args) => {
        // The user presses a key in Neovim while the model works: the wheel is theirs before this call runs.
        if (takeBackAtFirstTool && !tools.length) await session.takeBack();
        tools.push({name, args});
        return session[name](args);
      };
      const partner = await openPartner({
        storage: new MemoryStorage(),
        models: stack.models,
        model: stack.partner,
        thinking: stack.config.models.partner.thinking,
        hands: {...Object.fromEntries(ROLE_TOOLS.driver.map(name => [name, hand(name)])), roleOf: () => session.role},
      });
      const conversation = await partner.createConversation();
      session = new PairSession({
        record: {id: 1, root, conversation_id: conversation, goal: 'reconnect drops after the phone sleeps', level: 'normal', role: 'navigator'},
        store: {addMessage() {}, setRole() {}, setGoal() {}},
        partner, score: async () => ({value: 0, reason: ''}), typingPauseMs: 2000,
        notify: (to, message) => {
          if (to === 'chat' && message.type === 'message' && message.sender === 'pair') shown.push(message.text);
          if (to === 'chat' && message.type === 'confirm') setImmediate(() => session.answer(message.id, true));
          return 1;
        },
        requestEditor: async message => editor.request(message),
      });
      session.scout = localPane(root);
      session.panes = {type: async (pane, text) => typed.push([pane, text])};
      session.receive({kind: 'focus', target: 'terminal', pane: 'w1:p1', scrolled: false});
      if (edited) session.receive({kind: 'edit', ...edited});
      await start(session);
      await partner.close();
      const unchanged = Object.entries(FILES).every(([file, text]) => readFileSync(join(root, file), 'utf8') === text);
      return {root, shown: shown.join('\n'), tools, editor, typed, role: session.role, unchanged};
    }

    const report = (t, result) => {
      t.diagnostic(`tools: ${result.tools.map(call => `${call.name}(${JSON.stringify(call.args)})`).join(', ') || 'none'}`);
      t.diagnostic(`shown: ${result.shown}`);
    };
    const edits = result => result.tools.filter(call => call.name === 'edit');

    test(`${stack.name}: "your turn" after a failing test makes it pass with one edit to the code`, {timeout: 300_000}, async t => {
      // The user just wrote the test that wants 30 s; the code still says 5 s.
      const result = await turn(session => session.drive('your turn'), {
        edited: {file: 'test/ws.test.mjs', from: 5, to: 7, text: FILES['test/ws.test.mjs'].split('\n').slice(4, 7).join('\n'), at: Date.now() - 20_000},
      });
      report(t, result);
      assert.equal(edits(result).length, 1, 'one edit');
      assert.equal(result.editor.text('test/ws.test.mjs'), FILES['test/ws.test.mjs'], 'the test was left alone');
      assert.ok(testsPass(result.root, result.editor), 'the tests pass with the edited buffer');
      assert.equal(result.role, 'navigator', 'Pair handed back');
      assert.ok(result.unchanged, 'nothing was written to disk');
    });

    test(`${stack.name}: "you take it" with a request makes exactly that change`, {timeout: 300_000}, async t => {
      const result = await turn(session => session.drive('you take it: set the reconnect timeout to 30 seconds'));
      report(t, result);
      assert.equal(edits(result).length, 1, 'one edit');
      assert.match(result.editor.text('src/ws.mjs').split('\n')[0], /RECONNECT_TIMEOUT_MS = (30000|30_000|30 \* 1000)\b/);
      assert.equal(result.editor.text('src/ws.mjs').split('\n').slice(1).join('\n'), FILES['src/ws.mjs'].split('\n').slice(1).join('\n'), 'the rest is as it was');
      assert.equal(result.role, 'navigator');
      assert.ok(result.unchanged);
    });

    test(`${stack.name}: the Driver types the test command for the user and leaves Enter to them`, {timeout: 300_000}, async t => {
      const result = await turn(session => session.drive('you take it: put the command that runs the tests in my terminal'));
      report(t, result);
      assert.equal(result.typed.length, 1, 'typed once');
      assert.match(result.typed[0][1], /^(npm (run )?test|node --test)\b/);
      assert.equal(result.typed[0][0], 'w1:p1', 'into the user\'s pane');
      assert.ok(result.unchanged);
    });

    test(`${stack.name}: after a take-back the Driver changes nothing and still answers`, {timeout: 300_000}, async t => {
      const result = await turn(session => session.drive('you take it: set the reconnect timeout to 30 seconds'), {takeBackAtFirstTool: true});
      report(t, result);
      assert.equal(result.editor.text('src/ws.mjs'), FILES['src/ws.mjs'], 'the buffer is as it was');
      assert.deepEqual(result.typed, []);
      assert.equal(result.role, 'navigator');
      assert.ok(result.shown.trim().length > 0, 'it answered');
    });

    test(`${stack.name}: the Navigator suggests a change instead of making it`, {timeout: 300_000}, async t => {
      const result = await turn(session => session.ask('How should I change src/ws.mjs so the reconnect test passes? Show me.'));
      report(t, result);
      const suggestions = result.tools.filter(call => call.name === 'suggest');
      assert.ok(suggestions.length >= 1, 'it suggested');
      assert.ok(suggestions.some(({args}) => /ws\.mjs$/.test(args.file) && args.line === 1 && /30000|30_000|30 \* 1000/.test(args.text)), 'the right line and value');
      assert.deepEqual(edits(result), []);
      assert.equal(result.editor.text('src/ws.mjs'), FILES['src/ws.mjs'], 'nothing changed until the user accepts');
    });
  }
});
