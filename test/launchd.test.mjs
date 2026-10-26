// The launchd agent that `pair setup` installs on macOS, and which service manager runs the daemon where.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {agentFile, LABEL, launchd} from '../src/launchd.mjs';
import {serviceManager} from '../src/service.mjs';
import {systemd} from '../src/systemd.mjs';

test('the agent starts the daemon at login and again when it fails, not when it stops cleanly', () => {
  const agent = agentFile({node: '/opt/node/bin/node', script: '/opt/pair/bin/pair.mjs', log: '/Users/u/Library/Logs/pairing-buddy.log'});
  assert.match(agent, new RegExp(`<key>Label</key>\\s*<string>${LABEL.replaceAll('.', '\\.')}</string>`));
  assert.match(agent, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/node\/bin\/node<\/string>\s*<string>--disable-warning=ExperimentalWarning<\/string>\s*<string>\/opt\/pair\/bin\/pair\.mjs<\/string>\s*<string>daemon<\/string>\s*<\/array>/);
  assert.match(agent, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(agent, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
  assert.match(agent, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/u\/Library\/Logs\/pairing-buddy\.log<\/string>/);
  assert.doesNotMatch(agent, /EnvironmentVariables/);
});

test('the agent passes a custom config path on, and escapes what XML would misread', () => {
  const agent = agentFile({node: '/my tools/node', script: '/opt/a&b/pair.mjs', env: {PAIR_CONFIG: '/Users/u/<cfg>/pair.json'}, log: '/tmp/l'});
  assert.match(agent, /<string>\/my tools\/node<\/string>/);
  assert.match(agent, /<string>\/opt\/a&amp;b\/pair\.mjs<\/string>/);
  assert.match(agent, /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>PAIR_CONFIG<\/key>\s*<string>\/Users\/u\/&lt;cfg&gt;\/pair\.json<\/string>\s*<\/dict>/);
});

test('launchd on macOS, systemd on a Linux booted with it, else none: the supervisor', () => {
  assert.equal(serviceManager('darwin', false), launchd);
  assert.equal(serviceManager('linux', true), systemd);
  assert.equal(serviceManager('linux', false), null);
  assert.equal(serviceManager('freebsd', false), null);
});
