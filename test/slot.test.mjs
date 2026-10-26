// The slot of a server both roles share: the Watcher waits while the Partner works, and the user's turns go first.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ModelSlot} from '../src/slot.mjs';

/** A call that runs until `finish(value)`. */
function pending() {
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  return {done, finish: value => finish(value)};
}

test('on one server the Watcher waits while a Partner turn works, and scores again after it', async () => {
  const slot = new ModelSlot({exclusive: true});
  const answer = pending();
  const turn = slot.turn({conversation: 1, asked: true, cancel() {}}, () => answer.done);
  assert.equal(slot.busy(), true);
  let asked = false;
  assert.equal(await slot.watch(async () => { asked = true; return {value: 9}; }), null);
  assert.equal(asked, false, 'the model is not asked at all');
  answer.finish('done');
  assert.equal(await turn, 'done');
  assert.deepEqual(await slot.watch(async () => ({value: 9})), {value: 9});
  assert.equal(slot.snapshot().scores, 1, 'only calls that ran are timed');
});

test('with a server for each role nothing waits, and a question cancels nothing of the other server', async () => {
  const slot = new ModelSlot({exclusive: false});
  const remark = pending();
  let cancelled = false;
  slot.turn({conversation: 1, asked: false, cancel() { cancelled = true; }}, () => remark.done);
  assert.deepEqual(await slot.watch(async () => ({value: 2})), {value: 2});
  await slot.turn({conversation: 2, asked: true, cancel() {}}, async () => 'answer');
  assert.equal(cancelled, false);
  remark.finish();
});

test('a question cancels the Watcher calls and the remarks at work, each once, and never another question', async () => {
  const slot = new ModelSlot({exclusive: true});
  let signal;
  const score = slot.watch(seen => { signal = seen; return new Promise(resolve => seen.addEventListener('abort', () => resolve({value: 0, error: 'aborted'}))); });
  const cancels = [];
  const remark = pending();
  slot.turn({conversation: 1, asked: false, cancel: () => { cancels.push('remark'); remark.finish(null); }}, () => remark.done);
  assert.equal(signal.aborted, false, 'a remark waits for nothing and cancels nothing');

  const question = pending();
  const asked = slot.turn({conversation: 2, asked: true, cancel: () => cancels.push('question')}, () => question.done);
  assert.equal(signal.aborted, true);
  assert.equal(await score, null, 'a cancelled score is no score, and no failure');
  await slot.turn({conversation: 3, asked: true, cancel() {}}, async () => 'answer');
  await slot.cancel(1);
  assert.deepEqual(cancels, ['remark'], 'the remark once, the question never');
  question.finish('answer');
  assert.equal(await asked, 'answer');
  assert.deepEqual(slot.snapshot().cancelled, {scores: 1, remarks: 1});
});

test('a session cancels its own remark through the slot, and a conversation with no remark at work is left alone', async () => {
  const slot = new ModelSlot({exclusive: false});
  const remark = pending();
  let cancelled = 0;
  const turn = slot.turn({conversation: 7, asked: false, cancel: async () => { cancelled += 1; remark.finish(null); }}, () => remark.done);
  await slot.cancel(8);
  assert.equal(cancelled, 0);
  await slot.cancel(7);
  assert.equal(cancelled, 1);
  assert.equal(await turn, null);
  assert.equal(slot.busy(), false);
});
