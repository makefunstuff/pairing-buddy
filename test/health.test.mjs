// Model health: one notice per change, however many calls fail, and a probe that notices the model is back.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ModelHealth} from '../src/health.mjs';

test('a failing model is reported once, and once more when it answers again', () => {
  const changes = [];
  const health = new ModelHealth({probe: async () => ({ok: true}), onChange: (role, reason) => changes.push([role, reason])});
  health.report('partner');
  for (let i = 0; i < 5; i++) health.report('partner', `connect ECONNREFUSED (try ${i})`);
  assert.equal(health.ok(), false);
  assert.equal(health.ok('watcher'), true);
  assert.deepEqual(health.snapshot(), {watcher: null, partner: 'connect ECONNREFUSED (try 0)'});
  health.report('partner');
  health.report('partner');
  assert.deepEqual(changes, [['partner', 'connect ECONNREFUSED (try 0)'], ['partner', null]]);
});

test('the daemon probes every model at start, then only the ones that are down', async () => {
  let up = false;
  const probed = [];
  const health = new ModelHealth({
    intervalMs: 20,
    probe: async role => { probed.push(role); return role === 'watcher' || up ? {ok: true} : {ok: false, error: 'timeout'}; },
  });
  health.start();
  try {
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(health.ok('partner'), false);
    assert.deepEqual(probed.slice(0, 2), ['watcher', 'partner']);
    assert.deepEqual([...new Set(probed.slice(2))], ['partner'], 'only the model that is down is probed again');
    up = true;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(health.ok(), true);
  } finally {
    health.stop();
  }
});
