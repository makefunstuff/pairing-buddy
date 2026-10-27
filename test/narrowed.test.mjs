// Tests on save that ran only what a save affects: what failed before and did not run stays failing until a whole
// run, which a passing narrowed run asks for, says whether it still fails at all (a test renamed, a test deleted).
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {PairSession} from '../src/session.mjs';
import {scratch} from './temp.mjs';

/** go test -json lines for `tests`: [package dir, test name, 'pass' or 'fail']. */
const goJson = tests => tests.flatMap(([dir, name, action]) => [
  {Action: 'run', Package: `example.com/shop/${dir}`, Test: name},
  ...(action === 'fail' ? [{Action: 'output', Package: `example.com/shop/${dir}`, Test: name, Output: `    ${dir}_test.go:6: ${name} is off\n`}] : []),
  {Action: action, Package: `example.com/shop/${dir}`, Test: name},
]).map(event => JSON.stringify(event)).join('\n');

function goSession() {
  const root = scratch('pair-narrowed-');
  const write = (path, text) => { mkdirSync(join(root, path, '..'), {recursive: true}); writeFileSync(join(root, path), text); };
  write('go.mod', 'module example.com/shop\n');
  write('cart/cart.go', 'package cart\n');
  write('cart/cart_test.go', 'package cart\n\nimport "testing"\n\nfunc TestTotal(t *testing.T) {\n}\n');
  write('tax/tax_test.go', 'package tax\n\nimport "testing"\n\nfunc TestRate(t *testing.T) {\n}\n');
  const outputs = {}; // command -> its go test -json output
  const ran = [];
  const pane = {
    close: async () => {},
    run: async line => {
      const command = /&& \((.*)\) >/.exec(line)[1];
      ran.push(command);
      writeFileSync(/> '([^']+)' 2>&1$/.exec(line)[1], outputs[command]);
      return {exit: outputs[command].includes('"Action":"fail"') ? 1 : 0, output: '', timedOut: false, cancelled: false};
    },
  };
  const sent = [];
  const pair = new PairSession({
    record: {id: 1, root, conversation_id: 7, goal: 'totals', level: 'normal'},
    store: {addMessage() {}, addAction: () => 1, updateAction() {}, setRole() {}, lastRemark: () => null, showRemark() {}, addRemark: () => 1, dropRemark() {}},
    partner: {thinkingOf: () => 'off', ask: async () => 'SILENT', setRole: async () => {}},
    score: async () => ({value: 0, reason: ''}),
    typingPauseMs: 2000,
    testOnSave: {command: 'go test -json ./...', outputFile: join(root, 'run.out')},
    notify: (to, message) => { sent.push({to, ...message}); return 1; },
    requestEditor: async () => null,
  });
  pair.scout = pane;
  const ended = () => sent.filter(message => message.type === 'tests' && message.state !== 'run');
  const settle = async count => { for (let i = 0; i < 200 && ended().length < count; i++) await new Promise(resolve => setTimeout(resolve, 5)); };
  return {pair, root, write, outputs, ran, ended, settle};
}

const statusOf = message => [message.state, message.label, message.text];
const signsOf = message => message.results.map(test => `${test.ok ? '✓' : '✗'}${test.name}@${test.line}`).sort();

test('a failing test renamed and fixed: the narrowed run asks for a whole run, which clears it and its old sign', async () => {
  const {pair, root, write, outputs, ran, ended, settle} = goSession();
  outputs['go test -json ./...'] = goJson([['cart', 'TestTotal', 'fail'], ['tax', 'TestRate', 'pass']]);
  pair.receive({kind: 'save', file: join(root, 'cart/cart.go')});
  await settle(1);
  assert.deepEqual(statusOf(ended()[0]), ['fail', 'go test ./...', '1 failing · TestTotal']);

  write('cart/cart_test.go', 'package cart\n\nimport "testing"\n\nfunc TestCartTotal(t *testing.T) {\n}\n');
  outputs['go test -json ./cart'] = goJson([['cart', 'TestCartTotal', 'pass']]);
  outputs['go test -json ./...'] = goJson([['cart', 'TestCartTotal', 'pass'], ['tax', 'TestRate', 'pass']]);
  pair.receive({kind: 'save', file: join(root, 'cart/cart_test.go')});
  await settle(3);
  assert.deepEqual(ran, ['go test -json ./...', 'go test -json ./cart', 'go test -json ./...']);
  const [, narrowed, whole] = ended();
  assert.deepEqual(statusOf(narrowed), ['fail', 'go test ./cart', '1 still failing · TestTotal'], 'until the whole run says');
  assert.deepEqual(signsOf(narrowed), ['✓TestCartTotal@5', '✓TestRate@5'], 'the renamed test\'s file has only its new sign');
  assert.deepEqual(statusOf(whole), ['pass', 'go test ./...', '2 tests, 2 packages']);
  assert.deepEqual(pair.state.savedRunFailed, []);
});

test('a failing test deleted: gone after the whole run; a test failing elsewhere still fails after it', async () => {
  const {pair, root, write, outputs, ran, ended, settle} = goSession();
  outputs['go test -json ./...'] = goJson([['cart', 'TestTotal', 'fail'], ['tax', 'TestRate', 'fail']]);
  pair.receive({kind: 'save', file: join(root, 'cart/cart.go')});
  await settle(1);
  write('cart/cart_test.go', 'package cart\n');
  outputs['go test -json ./cart'] = JSON.stringify({Action: 'skip', Package: 'example.com/shop/cart'}); // [no test files]
  outputs['go test -json ./...'] = goJson([['tax', 'TestRate', 'fail']]);
  pair.receive({kind: 'save', file: join(root, 'cart/cart_test.go')});
  await settle(3);
  assert.deepEqual(ran, ['go test -json ./...', 'go test -json ./cart', 'go test -json ./...']);
  assert.deepEqual(statusOf(ended()[2]), ['fail', 'go test ./...', '1 failing · TestRate']);
  assert.deepEqual(signsOf(ended()[2]), ['✗TestRate@5']);
  assert.deepEqual(pair.state.savedRunFailed, ['TestRate']);
});
