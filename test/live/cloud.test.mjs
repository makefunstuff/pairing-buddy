// The Anthropic path, once: with ANTHROPIC_API_KEY and PAIR_LIVE_ANTHROPIC_MODEL set, the cloud model answers the
// probe as both roles, scores a repeated failure above the normal bar, and as Partner answers a short question.
// Skipped when either is unset.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {MemoryStorage} from '@earendil-works/pi-durable';
import {BUDGETS} from '../../src/budget.mjs';
import {modelConfig} from '../../src/config.mjs';
import {fold, initialState} from '../../src/fold.mjs';
import {createPairModels} from '../../src/models.mjs';
import {openPartner} from '../../src/partner.mjs';
import {probeModel} from '../../src/probe.mjs';
import {ROLE_TOOLS} from '../../src/tools.mjs';
import {detectTriggers} from '../../src/triggers.mjs';
import {createWatcher} from '../../src/watcher.mjs';

const model = process.env.PAIR_LIVE_ANTHROPIC_MODEL;
const skip = process.env.ANTHROPIC_API_KEY && model ? false : 'set ANTHROPIC_API_KEY and PAIR_LIVE_ANTHROPIC_MODEL to test the Anthropic path';

const failure = at => ({kind: 'command_end', pane: 'w1:p2', cmd: 'npm test', exit: 1, at,
  output: 'not ok 1 - reconnect waits up to 30 s\n  expected: 30000\n  actual: 5000\n  at test/ws.test.mjs:6'});

describe('the Anthropic path', {skip}, () => {
  const entry = {api: 'anthropic', model, apiKeyEnv: 'ANTHROPIC_API_KEY'};
  const config = {models: {watcher: modelConfig('watcher', entry), partner: modelConfig('partner', entry)}};

  test('the cloud model answers as Watcher and as Partner', {timeout: 120_000}, async t => {
    const pairModels = createPairModels(config);
    for (const role of ['watcher', 'partner']) {
      const probe = await probeModel(pairModels.models, pairModels[role]);
      t.diagnostic(`${role} probe: ${probe.ok ? `${probe.ms} ms` : probe.error}`);
      assert.equal(probe.ok, true, probe.error);
    }
    const now = 200_000;
    const state = [failure(100_000), failure(190_000)].reduce(fold, initialState({root: '/project', goal: 'reconnect waits 30 s after sleep'}));
    const [trigger] = detectTriggers(state, now);
    const score = await createWatcher({models: pairModels.models, model: pairModels.watcher, now: () => now})(trigger, state);
    t.diagnostic(`${trigger.kind} scored ${score.value}`);
    assert.ok(score.value >= BUDGETS.normal.bar, `score ${score.value}`);

    const partner = await openPartner({
      storage: new MemoryStorage(), models: pairModels.models, model: pairModels.partner,
      hands: {...Object.fromEntries(ROLE_TOOLS.navigator.map(name => [name, async () => 'done'])), roleOf: () => 'navigator'},
    });
    const answer = await partner.ask(await partner.createConversation(), '[user] The test wants 30000 and gets 5000. In one sentence: which number is wrong, the test\'s or the code\'s, if the goal is a 30 s wait?');
    await partner.close();
    t.diagnostic(`answer: ${answer}`);
    assert.match(answer, /5000|5 s|code/i);
  });
});
