// The probe `pair doctor` and the daemon's health check send, against real models: it answers, and the
// Watcher answers fast enough to score every candidate remark.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {probeModel} from '../../src/probe.mjs';
import {liveStacks, SKIP_REASON} from './stacks.mjs';

const stacks = liveStacks();

describe('probe', {skip: stacks.length ? false : SKIP_REASON}, () => {
  for (const stack of stacks) {
    test(`${stack.name}: both models answer the probe; the Watcher within 3 s`, {timeout: 60_000}, async () => {
      const watcher = await probeModel(stack.models, stack.watcher);
      assert.equal(watcher.ok, true, watcher.error);
      assert.ok(watcher.ms < 3000, `the Watcher took ${watcher.ms} ms`);
      const partner = await probeModel(stack.models, stack.partner);
      assert.equal(partner.ok, true, partner.error);
    });
  }
});
