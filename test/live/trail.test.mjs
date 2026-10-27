// The search trail on live models, in the captures' Go project: the delivery test is red, and the user searched
// "give up", "dead letter", then found and opened backoff.go. The cue has to name the real cause in the code's
// words; the failing test's message is what makes that possible, so the trail alone is run too, for the record.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cpSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, test} from 'node:test';
import {MemoryStorage} from '@earendil-works/pi-durable';
import {describeState} from '../../src/describe.mjs';
import {numberedLines, readProjectPath} from '../../src/files.mjs';
import {fold, initialState} from '../../src/fold.mjs';
import {openPartner} from '../../src/partner.mjs';
import {watchInput} from '../../src/session.mjs';
import {trailMatches} from '../../src/trail.mjs';
import {detectTriggers} from '../../src/triggers.mjs';
import {createWatcher} from '../../src/watcher.mjs';
import {liveStacks, SKIP_REASON} from './stacks.mjs';
import {scratch} from '../temp.mjs';

const HOOKD = fileURLToPath(new URL('../../docs/captures/hookd', import.meta.url));
const hasGo = (() => { try { execFileSync('go', ['version']); return true; } catch { return false; } })();

/** The delivery test's output, run for real. */
function goTest(root) {
  try {
    return execFileSync('go', ['test', './internal/delivery/'], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  } catch (error) {
    return error.stdout + error.stderr;
  }
}

/** The project, the trail trigger with the project's matches for its words, and the state; `red`: the test ran. */
async function trail({red}) {
  const root = scratch('pair-live-trail-');
  cpSync(HOOKD, root, {recursive: true});
  const now = 1_000_000;
  const events = [
    ...(red ? [{kind: 'command_end', pane: 'w1:p2', cmd: 'go test ./internal/delivery/', exit: 1, output: goTest(root), at: now - 60_000}] : []),
    {kind: 'search', picker: 'Live Grep', query: 'give up', results: 0, at: now - 12_000},
    {kind: 'search', picker: 'Live Grep', query: 'dead letter', results: 1, at: now - 9000},
    {kind: 'search', picker: 'Find Files', query: 'retry', results: 2, file: 'internal/retry/backoff.go', at: now - 5000},
    {kind: 'enter', file: 'internal/retry/backoff.go', at: now - 5000},
    {kind: 'cursor', file: 'internal/retry/backoff.go', line: 12, at: now - 4000},
  ];
  const state = events.reduce(fold, initialState({root}));
  const trigger = detectTriggers(state, now).find(found => found.kind === 'search_trail');
  assert.ok(trigger, 'the trail raises its trigger');
  const seen = {...trigger, detail: `${trigger.detail}\n${await trailMatches(root, trigger.searches)}`};
  return {root, state, now, trigger, input: watchInput(seen, describeState(state, now))};
}

function recordingHands(root) {
  const calls = [];
  const record = (name, result) => async (_conversation, args) => { calls.push({name, args}); return result; };
  return {calls, hands: {
    roleOf: () => 'navigator',
    say: record('say', 'shown'),
    point: record('point', 'highlighted'),
    open: record('open', 'opened in a split'),
    suggest: record('suggest', 'Shown in the editor. The user accepts it with one key or ignores it.'),
    read: async (_conversation, {file, from, to}) => {
      calls.push({name: 'read', args: {file}});
      const source = await readProjectPath(root, file);
      return source.error ?? source.listing ?? numberedLines(source.text, from, to);
    },
  }};
}

const stacks = liveStacks();

describe('the search trail on live models', {skip: !stacks.length ? SKIP_REASON : hasGo ? false : 'go not installed'}, () => {
  for (const stack of stacks) {
    async function cue(input, root) {
      const {calls, hands} = recordingHands(root);
      const partner = await openPartner({storage: new MemoryStorage(), models: stack.models, model: stack.partner, thinking: stack.config.models.partner.thinking, hands});
      const answer = await partner.ask(await partner.createConversation(), input, {kind: 'remark'});
      await partner.close();
      const said = [...calls.filter(call => call.name === 'say').map(call => call.args.text ?? call.args), answer].join(' ');
      return {calls, said};
    }

    test(`${stack.name}: the Watcher scores the trail with the red test as worth a cue`, {timeout: 60_000}, async t => {
      const {state, now, trigger} = await trail({red: true});
      const score = createWatcher({models: stack.models, model: stack.watcher, now: () => now});
      const {value} = await score(trigger, state);
      t.diagnostic(`score: ${value}`);
      assert.ok(value >= 4, 'at least the chatty bar');
    });

    test(`${stack.name}: with the failing test, the cue names the real cause in the code's words`, {timeout: 240_000}, async t => {
      const {root, input} = await trail({red: true});
      const {calls, said} = await cue(input, root);
      t.diagnostic(`tools: ${calls.map(call => `${call.name}(${JSON.stringify(call.args)})`).join(', ')}`);
      t.diagnostic(`said: ${said}`);
      const points = calls.filter(call => call.name === 'point' || call.name === 'suggest');
      assert.ok(points.some(({args}) => args.file.endsWith('worker.go') && args.line === 35), 'it marks the >= in worker.go');
      assert.match(said, />=|ErrBudget|Budget/, 'in the code\'s own words');
    });

    test(`${stack.name}: the trail alone, for the record`, {timeout: 240_000}, async t => {
      const {root, input} = await trail({red: false});
      const {calls, said} = await cue(input, root);
      t.diagnostic(`tools: ${calls.map(call => `${call.name}(${JSON.stringify(call.args)})`).join(', ')}`);
      t.diagnostic(`said: ${said}`);
    });
  }
});
