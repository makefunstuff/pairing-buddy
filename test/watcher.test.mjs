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

  faux.setResponses([fauxAssistantMessage([fauxText('{"score": 9, "reason": "stuck"}')])]);
  assert.deepEqual(await score(trigger, initialState()), {value: 9, reason: 'stuck'});

  faux.setResponses([fauxAssistantMessage([fauxText('hmm, hard to say')])]);
  assert.equal((await score(trigger, initialState())).value, 0);

  faux.setResponses([]); // the faux provider then answers with an error
  const failed = await score(trigger, initialState());
  assert.equal(failed.value, 0);
  assert.match(failed.reason, /watcher failed/);
});
