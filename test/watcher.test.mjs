import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createModels, fauxAssistantMessage, fauxProvider, fauxText} from '@earendil-works/pi-ai';
import {initialState} from '../src/fold.mjs';
import {createWatcher, parseScore} from '../src/watcher.mjs';

test('parseScore reads the JSON answer, also when wrapped in prose or a code fence', () => {
  assert.deepEqual(parseScore('{"score": 8, "reason": "same error twice"}'), {value: 8, reason: 'same error twice'});
  assert.deepEqual(parseScore('Sure!\n```json\n{"score":3,"reason":"noise"}\n```'), {value: 3, reason: 'noise'});
  assert.deepEqual(parseScore('{"score": "7"}'), {value: 7, reason: ''});
});

test('parseScore reads the bare number the Watcher is asked for, also with a word around it', () => {
  assert.deepEqual(parseScore('7'), {value: 7, reason: ''});
  assert.deepEqual(parseScore(' 8\n'), {value: 8, reason: ''});
  assert.equal(parseScore('Score: 3.').value, 3);
  assert.equal(parseScore('10/10').value, 10);
});

test('parseScore clamps to 0..10 and falls back to a bare "score: N"', () => {
  assert.equal(parseScore('{"score": 42}').value, 10);
  assert.equal(parseScore('{"score": -1}').value, 0);
  assert.deepEqual(parseScore('Score: 6'), {value: 6, reason: ''});
  assert.equal(parseScore('I would not interrupt.'), null);
});

test('a Watcher that answers nonsense or fails scores 0', async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const score = createWatcher({models, model: faux.getModel()});
  const trigger = {kind: 'stall', detail: 'nothing for 90 s'};

  faux.setResponses([fauxAssistantMessage([fauxText('9')])]);
  assert.deepEqual(await score(trigger, initialState()), {value: 9, reason: ''});

  faux.setResponses([fauxAssistantMessage([fauxText('hmm, hard to say')])]);
  assert.equal((await score(trigger, initialState())).value, 0);

  faux.setResponses([]); // the faux provider then answers with an error
  const failed = await score(trigger, initialState());
  assert.equal(failed.value, 0);
  assert.match(failed.reason, /watcher failed/);
});

test('the Watcher asks for a short answer, a drift question of its own, and the model chooseModel picks', async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const seen = [];
  faux.setResponses(Array(3).fill(null).map(() => (context, options) => {
    seen.push({prompt: context.messages.at(-1).content, maxTokens: options.maxTokens});
    return fauxAssistantMessage([fauxText('4')]);
  }));
  let chosen = 0;
  const score = createWatcher({models, model: faux.getModel(), chooseModel: async () => { chosen += 1; return faux.getModel(); }, now: () => 5000});
  await score({kind: 'stall', detail: 'nothing for 90 s'}, initialState());
  await score({kind: 'drift', detail: 'now edits src/billing.mjs'}, initialState({goal: 'fix reconnect'}));
  assert.ok(seen[0].maxTokens <= 8);
  assert.doesNotMatch(seen[0].prompt, /unrelated/);
  assert.match(seen[1].prompt, /src\/billing\.mjs\nScore how clearly this file is unrelated to the goal "fix reconnect"/);
  assert.equal(chosen, 2);

  assert.equal(score.lastCallAt, 5000);
  assert.deepEqual(await score.warm(), {ok: true});
  assert.equal(seen[2].maxTokens, 1, 'a warm-up asks for one token');
  faux.setResponses([]);
  assert.equal((await score.warm()).ok, false);
});
