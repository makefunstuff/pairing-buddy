// What Pair's panel in the Herdr window does with the daemon's messages and its buttons (herdr/pair/model.js): the
// same rules as the terminal's chat pane, with a button where the terminal has a key.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ChatModel, confirmChoices} from '../herdr/pair/model.js';

const ROOT = '/home/me/shop';

function welcomed() {
  const sent = [];
  const model = new ChatModel({send: message => { sent.push(message); return true; }, now: () => 1000});
  model.receive({type: 'welcome', root: ROOT, goal: null, plan: null, level: 'normal', role: 'navigator', models: {watcher: null, partner: null}, model: 'big', watcher: 'small', muted: []});
  return {model, sent};
}

const remark = (id, text, meta = {}) => ({type: 'message', sender: 'pair', text, at: 1, meta: {remark: id, trigger: 'repeat_failure', ...meta}});

test('the header: the project, the role, the level and both models from the welcome', () => {
  const {model} = welcomed();
  assert.deepEqual({project: model.header.project, role: model.header.role, level: model.header.level, partner: model.model, watcher: model.watcherModel, up: model.connection},
    {project: 'shop', role: 'navigator', level: 'normal', partner: 'big', watcher: 'small', up: 'up'});
  model.receive({type: 'role', role: 'driver', keep: true});
  model.receive({type: 'level', level: 'quiet'});
  model.receive({type: 'index_progress', phase: 'embedding', done: 3, total: 12});
  assert.deepEqual([model.header.role, model.header.keep, model.header.level, model.index.done], ['driver', true, 'quiet', 3]);
});

test('a remark is a card: news for a toast once, then Useful, Noise, Dismiss, Accept and Jump send what the keys send', () => {
  const {model, sent} = welcomed();
  const news = model.receive(remark(7, 'Same failure twice: the total skips the discount.'));
  assert.equal(news.remark.text, 'Same failure twice: the total skips the discount.');
  const suggestion = {action: 3, old: ['a'], new: ['b']};
  assert.equal(model.receive(remark(7, 'cart.js:12 suggestion: apply it', {suggestion, place: {file: 'cart.js', line: 12}})), null, 'its second entry is no new remark');
  const i = model.entries.length - 1;
  const keys = model.remarkKeys(i);
  assert.equal(keys.apply.meta.suggestion.action, 3);
  assert.deepEqual(keys.jump.meta.place, {file: 'cart.js', line: 12});
  model.accept(keys.apply);
  model.jump(keys.jump);
  model.rate(model.entries[i], true);
  assert.deepEqual(sent, [{type: 'accept', action: 3}, {type: 'go', file: 'cart.js', line: 12}, {type: 'feedback', useful: true, remark: 7}]);
  assert.deepEqual(model.remarkGroup(7).map(entry => entry.verdict), ['useful', 'useful']);
  model.rate(model.entries[i], false);
  assert.equal(model.entries[i].verdict, 'noise');
  model.receive(remark(8, 'Another one.'));
  model.dismiss(model.entries.at(-1));
  assert.deepEqual(sent.at(-1), {type: 'seen', remark: 8}, 'dismissed: seen, neither useful nor noise');
  assert.equal(model.entries.at(-1).dismissed, true);
  model.receive({type: 'applied', action: 3});
  assert.equal(model.entries[i].applied, true);
  assert.equal(model.remarkKeys(i).apply, null, 'taken: no more Accept');
  assert.equal(model.receive({...remark(9, 'From the history.'), history: true}), null, 'the history a reconnect shows raises no toast');
});

test('Pair\'s questions are cards: their answers as buttons, from the hint; typed words answer too', () => {
  assert.deepEqual(confirmChoices({}).choices.map(choice => choice.label), ['Yes', 'No']);
  const board = confirmChoices({hint: 'y add only (its agent waits for your go) · d add and delegate · p delegate, plan first · r delegate, research only · c copy the command · n nothing'});
  assert.deepEqual(board.choices.map(choice => [choice.text, choice.label]), [
    ['y', 'add only (its agent waits for your go)'], ['d', 'add and delegate'], ['p', 'delegate, plan first'], ['r', 'delegate, research only'], ['c', 'copy the command'], ['n', 'nothing'],
  ]);
  const shape = confirmChoices({hint: 'y: scaffold · file, try · n cancels'});
  assert.deepEqual(shape.choices.map(choice => choice.text), ['y', 'file', 'try', 'n']);
  assert.equal(confirmChoices({hint: 'y keeps x · n leaves it to Pair · or your answer'}).free, true);

  const {model, sent} = welcomed();
  const news = model.receive({type: 'confirm', id: 4, text: 'May Pair type `npm test` in your pane?'});
  assert.equal(news.confirm.confirm, 4);
  assert.equal(model.asking, news.confirm);
  model.answer(news.confirm, {text: 'y'});
  assert.deepEqual(sent.at(-1), {type: 'confirm', id: 4, ok: true, text: 'y'});
  assert.equal(news.confirm.answer, true);
  assert.equal(model.answer(news.confirm, {text: 'n'}), false, 'answered once');

  model.receive({type: 'confirm', id: 5, text: 'Add it?', hint: 'y add only · d add and delegate · n nothing', keys: ['d'], gen: 3});
  assert.deepEqual(model.submit('d'), {sent: true}, 'a typed answer');
  assert.deepEqual(sent.at(-1), {type: 'confirm', id: 5, ok: false, text: 'd'});
  model.receive({type: 'confirm', id: 6, text: 'Run it?'});
  model.receive({type: 'confirmed', id: 6});
  assert.equal(model.entries.at(-1).answer, false, 'timed out: no');
  assert.equal(model.confirming, null);
  model.receive({type: 'confirm', id: 7, text: 'Run it?'});
  model.stop();
  assert.deepEqual(sent.at(-1), {type: 'confirm', id: 7, ok: false, text: 'n'}, 'Stop while Pair asks: no');
});

test('the box: questions, commands and the local ones, as the terminal\'s chat takes them', () => {
  const {model, sent} = welcomed();
  assert.deepEqual(model.submit('where is the total?'), {sent: true});
  assert.deepEqual(sent.at(-1), {type: 'ask', text: 'where is the total?'});
  assert.equal(model.entries.at(-1).pending, true);
  model.receive({type: 'message', sender: 'user', text: 'where is the total?', at: 2});
  assert.equal(model.entries.filter(entry => entry.kind === 'you').length, 1, 'the daemon\'s copy takes its place');
  model.submit('/level chatty');
  assert.deepEqual(sent.at(-1), {type: 'level', level: 'chatty'});
  assert.deepEqual(model.submit('/nope'), {keep: '/nope'});
  assert.equal(model.entries.at(-1).kind, 'error');
  assert.equal(model.submit('/help').local, 'help');
  assert.match(model.entries.at(-1).text, /\/goal/);
  model.receive({type: 'message', sender: 'pair', text: 'Look at cart.js.', at: 3});
  assert.deepEqual(model.submit('/copy'), {local: 'copy', text: 'Look at cart.js.'});
  model.receive({type: 'remarks', remarks: [{id: 11}, {id: 10}], text: '1  …'});
  model.submit('-2');
  assert.deepEqual(sent.at(-1), {type: 'feedback', useful: false, number: 2, remark: 10});
  model.followUp({meta: {remark: 10}, text: 'The discount.'});
  model.submit('why?');
  assert.deepEqual(sent.at(-1), {type: 'ask', text: 'why?', about: 10});
  model.cycleLevel();
  assert.deepEqual(sent.at(-1), {type: 'level', level: 'chatty'}, 'the next after normal, the level the header shows');
  model.setRole('driver');
  assert.deepEqual(sent.at(-1), {type: 'drive', text: ''});
  model.setRole('scout');
  assert.deepEqual(sent.at(-1), {type: 'role', role: 'scout'});
});

test('while the daemon is away, nothing is sent and the line stays in the box', () => {
  const {model, sent} = welcomed();
  model.lost();
  const count = sent.length;
  assert.deepEqual(model.submit('anyone there?'), {keep: 'anyone there?'});
  assert.equal(sent.length, count);
  assert.match(model.flash.text, /not back yet/);
});

test('an answer that streams keeps unasked news under it until it is done', () => {
  const {model} = welcomed();
  model.receive({type: 'partial', text: 'The total is computed in'});
  model.receive({type: 'message', sender: 'system', text: 'Tests on save: 1 failed', at: 2});
  assert.equal(model.held.length, 1);
  model.receive({type: 'message', sender: 'pair', text: 'The total is computed in cart.js.', at: 3});
  assert.deepEqual(model.entries.slice(-2).map(entry => entry.text), ['The total is computed in cart.js.', 'Tests on save: 1 failed']);
});

test('a gen card\'s buttons send what its keys send, and a relayed line\'s open its task', () => {
  const {model, sent} = welcomed();
  model.receive({type: 'gen_card', gen: 2, action: 9, shape: 'here', state: 'ready', keys: {k: 'take', enter: 'go there', d: 'drop', u: 'undo'}});
  model.receive({type: 'message', sender: 'pair', text: 'gen #2 · here: a guard', at: 1, meta: {gen: 2}});
  const card = model.entries.at(-1);
  assert.equal(card.kind, 'gen');
  model.cardAct(card, 'k');
  model.cardAct(card, 'enter');
  model.cardAct(card, 'u');
  assert.deepEqual(sent.slice(-3), [{type: 'accept', action: 9}, {type: 'gen_open', action: 9}, {type: 'undo', action: 9}]);
  const count = sent.length;
  model.cardAct(card, 'd');
  assert.equal(sent.length, count, 'one click on Drop rest drops nothing');
  assert.match(model.flash.text, /Click again to drop what is left of gen #2/);
  model.cardAct(card, 'd');
  assert.deepEqual(sent.at(-1), {type: 'gen_drop_all', action: 9}, 'the second does');
  model.receive({type: 'gen_card', gen: 3, action: 12, shape: 'scaffold', state: 'ready', keys: {k: 'keep one'}});
  model.receive({type: 'message', sender: 'pair', text: 'gen #3 · scaffold', at: 1, meta: {gen: 3}});
  assert.deepEqual(model.cardAct(model.entries.at(-1), 'k'), {keep: '/keep '});
  model.submit('/keep src/a.js');
  assert.deepEqual(sent.at(-1), {type: 'keep', path: 'src/a.js', gen: 3});
  model.receive({type: 'agents', text: 'PAIR-3 needs you', item: {key: 'task:PAIR-3', kind: 'task', id: 'PAIR-3', branch: 'b', where: '/w'}});
  model.relayAct(model.entries.at(-1), 'd');
  assert.deepEqual(sent.at(-1), {type: 'agent_link', key: 'task:PAIR-3', what: 'diff'});
});
