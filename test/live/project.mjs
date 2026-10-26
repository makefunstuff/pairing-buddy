// The scratch project the live Scout and Driver tests work in, and a local bash standing in for Pair's pane.
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export const FILES = {
  'package.json': '{"type": "module", "scripts": {"test": "node --test"}}\n',
  'src/ws.mjs': 'export const RECONNECT_TIMEOUT_MS = 5000;\n\nexport const backoff = attempt => Math.min(1000 * 2 ** attempt, RECONNECT_TIMEOUT_MS);\n',
  'src/config.mjs': 'import {RECONNECT_TIMEOUT_MS} from \'./ws.mjs\';\n\nexport const config = {reconnectTimeoutMs: RECONNECT_TIMEOUT_MS, retries: 5};\n',
  'test/ws.test.mjs': `import assert from 'node:assert/strict';
import {test} from 'node:test';
import {backoff, RECONNECT_TIMEOUT_MS} from '../src/ws.mjs';

test('reconnect waits up to 30 s after sleep', () => {
  assert.equal(RECONNECT_TIMEOUT_MS, 30000);
});

test('backoff doubles', () => {
  assert.equal(backoff(1), 2000);
});
`,
};

/** A git repository with a failing test: the code waits 5 s, the test wants 30 s. */
export function project() {
  const root = mkdtempSync(join(tmpdir(), 'pair-scout-'));
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(join(root, file, '..'), {recursive: true});
    writeFileSync(join(root, file), text);
  }
  const git = (...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {cwd: root, encoding: 'utf8'});
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'start');
  return {root, commits: () => git('rev-list', '--count', 'HEAD').trim()};
}

/** Pair's pane, played by a local bash: it runs what the session lets through and records it. */
export function localPane(root) {
  const ran = [];
  // Without this, node --test in the project thinks it runs inside this test file and skips its tests.
  const {NODE_TEST_CONTEXT, ...env} = process.env;
  return {ran, open: async () => {}, close: async () => {}, run: async command => {
    ran.push(command);
    try {
      return {exit: 0, output: execFileSync('bash', ['-c', `${command} 2>&1`], {cwd: root, env, encoding: 'utf8', timeout: 60_000}).trimEnd(), timedOut: false};
    } catch (error) {
      return {exit: error.status ?? 1, output: String(error.stdout ?? '').trimEnd(), timedOut: false};
    }
  }};
}
