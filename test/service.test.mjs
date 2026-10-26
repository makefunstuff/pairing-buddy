// The systemd user unit that `pair setup` installs.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {unitFile} from '../src/service.mjs';

test('the unit starts the daemon at login and restarts it when it fails', () => {
  const unit = unitFile({node: '/opt/node/bin/node', script: '/opt/pair/bin/pair.mjs'});
  assert.match(unit, /^ExecStart=\/opt\/node\/bin\/node --disable-warning=ExperimentalWarning \/opt\/pair\/bin\/pair\.mjs daemon$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.doesNotMatch(unit, /Environment=/);
});

test('paths with spaces are quoted and a custom config path is passed on', () => {
  const unit = unitFile({node: '/my tools/node', script: '/opt/pair/bin/pair.mjs', env: {PAIR_CONFIG: '/home/u/My Configs/pair.json'}});
  assert.match(unit, /^ExecStart="\/my tools\/node" /m);
  assert.match(unit, /^Environment="PAIR_CONFIG=\/home\/u\/My Configs\/pair\.json"$/m);
});
