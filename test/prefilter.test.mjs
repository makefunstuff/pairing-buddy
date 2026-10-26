import assert from 'node:assert/strict';
import {test} from 'node:test';
import {prefilter} from '../src/prefilter.mjs';

const failure = (cmd, exit) => ({kind: 'failed_command', key: 'k', detail: '', command: {cmd, exit}});

test('a search that finds nothing, or a command the user stopped, is not a failure worth a remark', () => {
  for (const cmd of ['grep -rn SLEEP src', 'rg backoff', 'git diff --exit-code', 'diff a b', 'test -f x']) {
    assert.equal(prefilter(failure(cmd, 1))?.value, 0, cmd);
  }
  assert.match(prefilter(failure('npm test', 130)).reason, /stopped by the user/);
  assert.equal(prefilter(failure('grep -rn x src', 2)), null, 'exit 2 of grep is an error');
  assert.equal(prefilter(failure('npm test', 1)), null);
  assert.equal(prefilter({...failure('rg x', 1), kind: 'stall'})?.value, 0, 'also for a stall after it');
});

test('drift always goes to the Watcher: a word of the path says nothing of what the file does', () => {
  for (const file of ['src/billing/ranking.ts', 'src/search/ranking.ts', 'src/power/sleepWatch.ts']) {
    assert.equal(prefilter({kind: 'drift', key: 'd', detail: '', file}), null, file);
  }
});
