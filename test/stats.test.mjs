import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {statsReport} from '../src/stats.mjs';
import {openStore} from '../src/store.mjs';

const BIN = fileURLToPath(new URL('../bin/pair.mjs', import.meta.url));
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = 1000 * HOUR;

const remark = (trigger, verdict, hoursAgo) => ({trigger, verdict, at: NOW - hoursAgo * HOUR});
const REMARKS = [
  remark('failed_command', 'useful', 1), remark('failed_command', 'useful', 2), remark('failed_command', 'dismissed', 3),
  ...[4, 5, 6, 7, 8].map(hoursAgo => remark('drift', 'dismissed', hoursAgo)),
  remark('stall', null, 9),
  {trigger: 'stall', verdict: null, at: NOW - MIN}, // too young to count as ignored
];

test('the stats view shows remarks per hour, kept vs dismissed per trigger, and the tuned bars and budget', () => {
  const lines = statsReport({remarks: REMARKS, activeMs: 5 * HOUR, now: NOW, days: 7, level: 'normal', autoTune: true});
  assert.equal(lines[0], 'Last 7 days, all projects: 5.0 h of active pairing, 10 unasked remarks (2.0 per hour)');
  assert.equal(lines[1], 'useful 2 · dismissed 6 · ignored 1 · waiting 1 · kept 22%');
  assert.deepEqual(lines.slice(3, 9), [
    'trigger              remarks  per hour  useful  dismissed  ignored  kept     bar',
    'failed_command             3       0.6       2          1        0   67%       6',
    'repeated_error             0       0.0       0          0        0     -       6',
    'new_code_diagnostic        0       0.0       0          0        0     -       6',
    'stall                      2       0.4       0          0        1    0%       6',
    'drift                      5       1.0       0          5        0    0%  8 (+2)',
  ]);
  assert.equal(lines.at(-2), 'Budget at level normal: at most 6 remarks per hour, 3 min apart (the level\'s default: 6, 3 min)');
});

test('without autoTune the stats show the level\'s own bars', () => {
  const lines = statsReport({remarks: REMARKS, activeMs: 0, now: NOW, days: 7, level: 'quiet', autoTune: false});
  assert.match(lines[0], /0\.0 h of active pairing, 10 unasked remarks \(- per hour\)/, 'no rate over too little time');
  assert.match(lines.find(line => line.startsWith('drift')), / 8$/);
  assert.match(lines.at(-1), /Tuning is off/);
  const chatty = statsReport({remarks: [], activeMs: 0, now: NOW, days: 7, level: 'chatty', autoTune: true});
  assert.equal(chatty.at(-2), 'Budget at level chatty: at most 15 remarks per hour, 1 min 30 s apart (the level\'s default: 15, 1 min 30 s)');
});

test('`pair stats` reads the data directory, also while no daemon runs, and counts active time when it happened', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pair-stats-'));
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({dataDir: dir, models: {watcher: {api: 'openai', baseUrl: 'http://x/v1', model: 'w'}, partner: {api: 'openai', baseUrl: 'http://x/v1', model: 'p'}}}));
  const run = args => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, 'stats', ...args], {encoding: 'utf8', env: {...process.env, PAIR_CONFIG: config}});
  assert.match(run([]), /No sessions yet/);

  // A session left open for ten days (the usual case: it lasts until /end), used ten days ago and today.
  const store = openStore(join(dir, 'sessions.sqlite'));
  const now = Date.now();
  const session = store.createSession({root: '/project', conversationId: 'c', level: 'normal', at: now - 10 * 24 * HOUR});
  store.addActive(now - 10 * 24 * HOUR + HOUR, HOUR);
  store.addActive(now, 2 * HOUR);
  store.rateRemark(store.addRemark({sessionId: session.id, trigger: 'stall', score: 8, at: now - HOUR}), 'useful');
  store.addRemark({sessionId: session.id, trigger: 'stall', score: 7, at: now - 10 * 24 * HOUR + HOUR}); // outside 7 days
  store.close();
  const shown = run(['--days', '7']);
  assert.match(shown, /^Last 7 days, all projects: 2\.0 h of active pairing, 1 unasked remark \(0\.5 per hour\)$/m);
  assert.match(shown, /^stall +1 +0\.5 +1 +0 +0 +100% +6$/m);
  assert.match(run(['--days', '1']), /^Last 1 day, all projects: 2\.0 h of active pairing, 1 unasked remark \(0\.5 per hour\)$/m);
  assert.match(run(['--days', '30']), /3\.0 h of active pairing, 2 unasked remarks/);
});
