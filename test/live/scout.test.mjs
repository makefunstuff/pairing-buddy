// Scout against real models, through a real PairSession: it searches to answer "where else", runs the tests
// to say what fails, leaves commits to the user, and in the Navigator role points to /scout instead.
// Pair's pane is replaced by a local bash in a scratch project; the command policy still decides what runs.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, test} from 'node:test';
import {MemoryStorage} from '@earendil-works/pi-durable';
import {openPartner} from '../../src/partner.mjs';
import {PairSession} from '../../src/session.mjs';
import {liveStacks, SKIP_REASON} from './stacks.mjs';

const FILES = {
  'package.json': '{"type": "module", "scripts": {"test": "node --test"}}\n',
  'src/ws.mjs': 'export const RECONNECT_TIMEOUT_MS = 5000;\n\nexport const backoff = attempt => Math.min(1000 * 2 ** attempt, RECONNECT_TIMEOUT_MS);\n',
  'src/config.mjs': 'import {RECONNECT_TIMEOUT_MS} from \'./ws.mjs\';\n\nexport const config = {reconnectTimeoutMs: RECONNECT_TIMEOUT_MS, retries: 5};\n',
  'test/ws.test.mjs': `import assert from 'node:assert/strict';
import {test} from 'node:test';
import {backoff, RECONNECT_TIMEOUT_MS} from '../src/ws.mjs';

test('reconnect waits up to 30 s after sleep', () => {
  assert.equal(RECONNECT_TIMEOUT_MS, 30000);
});

test('backoff doubles', () => {
  assert.equal(backoff(1), 2000);
});
`,
};

/** A git repository with a failing test: the code waits 5 s, the test wants 30 s. */
function project() {
  const root = mkdtempSync(join(tmpdir(), 'pair-scout-'));
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(join(root, file, '..'), {recursive: true});
    writeFileSync(join(root, file), text);
  }
  const git = (...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {cwd: root, encoding: 'utf8'});
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'start');
  return {root, commits: () => git('rev-list', '--count', 'HEAD').trim()};
}

/** Pair's pane, played by a local bash: it runs what the session lets through and records it. */
function localPane(root) {
  const ran = [];
  // Without this, node --test in the project thinks it runs inside this test file and skips its tests.
  const {NODE_TEST_CONTEXT, ...env} = process.env;
  return {ran, open: async () => {}, close: async () => {}, run: async command => {
    ran.push(command);
    try {
      return {exit: 0, output: execFileSync('bash', ['-c', `${command} 2>&1`], {cwd: root, env, encoding: 'utf8', timeout: 60_000}).trimEnd(), timedOut: false};
    } catch (error) {
      return {exit: error.status ?? 1, output: String(error.stdout ?? '').trimEnd(), timedOut: false};
    }
  }};
}

const stacks = liveStacks();

describe('Scout on live models', {skip: stacks.length ? false : SKIP_REASON}, () => {
  for (const stack of stacks) {
    /** Asks Pair `question` in `role`; resolves with what the chat showed, the tools called and the commands run. */
    async function ask(role, question) {
      const {root, commits} = project();
      const shown = [];
      const tools = [];
      let session;
      const hand = name => (_conversation, args) => { tools.push({name, args}); return session[name](args); };
      const partner = await openPartner({
        storage: new MemoryStorage(),
        models: stack.models,
        model: stack.partner,
        thinking: stack.config.models.partner.thinking,
        hands: {...Object.fromEntries(['say', 'point', 'open', 'read', 'search', 'run'].map(name => [name, hand(name)])), roleOf: () => session.role},
      });
      const conversation = await partner.createConversation();
      session = new PairSession({
        record: {id: 1, root, conversation_id: conversation, goal: 'reconnect drops after the phone sleeps', level: 'normal', role},
        store: {addMessage() {}, setRole() {}, setGoal() {}},
        partner, score: async () => ({value: 0, reason: ''}), typingPauseMs: 2000,
        notify: (to, message) => { if (to === 'chat' && message.type === 'message' && message.sender === 'pair') shown.push(message.text); return 0; },
        requestEditor: async () => { throw new Error('no editor'); },
      });
      const pane = localPane(root);
      session.scout = pane;
      await partner.setRole(conversation, role);
      await session.ask(question);
      await partner.close();
      return {shown: shown.join('\n'), tools, ran: pane.ran, commits: commits()};
    }

    const report = (t, result) => {
      t.diagnostic(`tools: ${result.tools.map(call => `${call.name}(${JSON.stringify(call.args)})`).join(', ') || 'none'}`);
      t.diagnostic(`shown: ${result.shown}`);
    };

    test(`${stack.name}: Scout searches to answer "where else"`, {timeout: 240_000}, async t => {
      const result = await ask('scout', 'Where else do we use RECONNECT_TIMEOUT_MS?');
      report(t, result);
      assert.ok(result.ran.some(command => /^(rg|grep)\b/.test(command)), 'it searched in its pane');
      assert.match(result.shown, /config/);
    });

    test(`${stack.name}: Scout runs the tests and says what fails`, {timeout: 240_000}, async t => {
      const result = await ask('scout', 'Run the tests and tell me what fails.');
      report(t, result);
      assert.ok(result.ran.some(command => /npm (run )?test|node --test/.test(command)), 'it ran the tests in its pane');
      assert.match(result.shown, /30000|30 ?s|5000|reconnect waits/i);
    });

    test(`${stack.name}: Scout leaves the commit to the user`, {timeout: 240_000}, async t => {
      const result = await ask('scout', 'Commit everything with the message "wip".');
      report(t, result);
      assert.equal(result.commits, '1', 'nothing was committed');
      assert.ok(result.shown.length > 0, 'it answered');
    });

    test(`${stack.name}: the Navigator cannot run tests and points to /scout`, {timeout: 240_000}, async t => {
      const result = await ask('navigator', 'Run the tests and tell me what fails.');
      report(t, result);
      assert.deepEqual(result.ran, []);
      assert.ok(!result.tools.some(call => ['run', 'search'].includes(call.name)), 'it was not offered run or search');
      assert.match(result.shown, /scout/i);
    });
  }
});
