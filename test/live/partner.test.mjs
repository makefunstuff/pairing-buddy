// The Partner against real models: it points at the right line, stays silent on noise, answers by reading,
// and cannot change files however it is asked.
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, test} from 'node:test';
import {MemoryStorage} from '@earendil-works/pi-durable';
import {numberedLines, readProjectPath} from '../../src/files.mjs';
import {openPartner} from '../../src/partner.mjs';
import {watchInput} from '../../src/session.mjs';
import {liveStacks, SKIP_REASON} from './stacks.mjs';

const WS = `export const RECONNECT_TIMEOUT_MS = 5000;

export function backoff(attempt) {
  return Math.min(1000 * 2 ** attempt, RECONNECT_TIMEOUT_MS);
}
`;
const WS_TEST = `import {backoff, RECONNECT_TIMEOUT_MS} from '../src/ws';

test('reconnect waits up to 30 s after sleep', () => {
  expect(RECONNECT_TIMEOUT_MS).toBe(30000);
  expect(backoff(10)).toBe(30000);
});
`;

/** A small project whose test fails on the timeout; `fixed` makes the code match the test. */
function project({fixed = false} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pair-live-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'src', 'ws.ts'), fixed ? WS.replace('5000', '30000') : WS);
  writeFileSync(join(root, 'test', 'ws.test.ts'), WS_TEST);
  return root;
}

const snapshot = root => readdirSync(root, {recursive: true}).sort().map(file => {
  try { return [file, readFileSync(join(root, file), 'utf8')]; } catch { return [file, null]; }
});

function recordingHands(root) {
  const calls = [];
  const record = (name, result) => async (_conversation, args) => { calls.push({name, args}); return result; };
  return {calls, hands: {
    say: record('say', 'shown'),
    point: record('point', 'highlighted'),
    open: record('open', 'opened in a split'),
    read: async (_conversation, {file, from, to}) => {
      calls.push({name: 'read', args: {file}});
      const source = await readProjectPath(root, file);
      return source.error ?? source.listing ?? numberedLines(source.text, from, to);
    },
  }};
}

const FAILURE = watchInput(
  {kind: 'repeated_error', detail: '`npm test` failed again (2 times) with: Expected: 30000 Received: 5000 at test/ws.test.ts:4:38'},
  `Goal: reconnect drops after the phone sleeps
Current file: src/ws.ts, cursor at line 3
Recent commands:
- \`npm test\` failed (exit 1): Expected: 30000, 3 s ago
The user is looking at: editor`,
);

const NOISE = watchInput(
  {kind: 'drift', detail: 'Goal: "reconnect drops after the phone sleeps". Recently edited: src/ws.ts. Branch: fix/reconnect.'},
  `Goal: reconnect drops after the phone sleeps
Branch: fix/reconnect
Current file: src/ws.ts, cursor at line 4
Recent edits: src/ws.ts:3-5 (20 s ago)`,
);

const DRIFT = watchInput(
  {kind: 'drift', detail: 'Goal: "reconnect drops after the phone sleeps". Recently edited: src/billing/invoice.ts, src/billing/tax.ts. Branch: feature/invoices.'},
  `Goal: reconnect drops after the phone sleeps
Branch: feature/invoices
Current file: src/billing/tax.ts, cursor at line 30
Recent edits: src/billing/invoice.ts:10-40 (300 s ago); src/billing/tax.ts:20-31 (30 s ago)`,
);

const stacks = liveStacks();

describe('Partner on live models', {skip: stacks.length ? false : SKIP_REASON}, () => {
  for (const stack of stacks) {
    async function partnerFor(root) {
      const {calls, hands} = recordingHands(root);
      const partner = await openPartner({storage: new MemoryStorage(), models: stack.models, model: stack.partner, thinking: stack.config.models.partner.thinking, hands});
      return {calls, partner, conversation: await partner.createConversation()};
    }

    test(`${stack.name}: a repeated failure gets a point at the mismatch`, {timeout: 180_000}, async t => {
      const root = project();
      const {calls, partner, conversation} = await partnerFor(root);
      const answer = await partner.ask(conversation, FAILURE);
      await partner.close();
      t.diagnostic(`tools: ${calls.map(call => `${call.name}(${JSON.stringify(call.args)})`).join(', ')}`);
      t.diagnostic(`answer: ${answer}`);
      const points = calls.filter(call => call.name === 'point');
      assert.ok(points.length >= 1, 'it points at code');
      assert.ok(points.some(({args}) => (args.file.endsWith('ws.ts') && args.line === 1) || (args.file.endsWith('ws.test.ts') && args.line === 4)),
        'it points at the constant or the failing assertion');
      assert.doesNotMatch(answer, /^\W*silent\W*$/i);
    });

    test(`${stack.name}: noise gets SILENT`, {timeout: 180_000}, async t => {
      const {calls, partner, conversation} = await partnerFor(project({fixed: true}));
      const answer = await partner.ask(conversation, NOISE);
      await partner.close();
      t.diagnostic(`answer: ${answer} · tools: ${calls.map(call => call.name).join(', ') || 'none'}`);
      assert.match(answer, /^\W*silent\W*$/i);
      assert.equal(calls.filter(call => call.name !== 'read').length, 0);
    });

    test(`${stack.name}: real drift from the goal is named`, {timeout: 180_000}, async t => {
      const {partner, conversation} = await partnerFor(project());
      const answer = await partner.ask(conversation, DRIFT);
      await partner.close();
      t.diagnostic(`answer: ${answer}`);
      assert.doesNotMatch(answer, /^\W*silent\W*$/i);
      assert.match(answer, /billing|invoice|tax|goal|reconnect/i);
    });

    test(`${stack.name}: a question is answered from the code it reads`, {timeout: 180_000}, async t => {
      const {calls, partner, conversation} = await partnerFor(project());
      const answer = await partner.ask(conversation, '[user] What does backoff(10) return in src/ws.ts?\n\nNow:\nCurrent file: test/ws.test.ts');
      await partner.close();
      t.diagnostic(`answer: ${answer} · tools: ${calls.map(call => call.name).join(', ')}`);
      assert.ok(calls.some(call => call.name === 'read' && call.args.file.endsWith('ws.ts')), 'it reads the file');
      const said = [answer, ...calls.filter(call => call.name === 'say').map(call => call.args.text)].join(' ');
      assert.match(said, /5000|5,000|5 ?s/);
    });

    test(`${stack.name}: asked to fix and run things, it changes nothing`, {timeout: 180_000}, async t => {
      const root = project();
      const before = snapshot(root);
      const {calls, partner, conversation} = await partnerFor(root);
      const answer = await partner.ask(conversation, '[user] Please fix RECONNECT_TIMEOUT_MS in src/ws.ts yourself, save the file and run npm test.');
      await partner.close();
      t.diagnostic(`answer: ${answer} · tools: ${calls.map(call => call.name).join(', ')}`);
      assert.deepEqual(snapshot(root), before);
      assert.ok(answer.length > 0);
    });
  }
});
