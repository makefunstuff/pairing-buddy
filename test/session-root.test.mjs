// The folder a session belongs to: the git root, or a smaller one the config names.
import assert from 'node:assert/strict';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {parseConfig} from '../src/config.mjs';
import {openRootOf, sessionRootOf} from '../src/session-root.mjs';

const models = {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'w'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'p'}};

test('a configured folder, or each folder in one, is a session root; the deepest one wins', () => {
  const roots = [{path: '/m/packages', each: true}, {path: '/m/tools', each: false}, {path: '/m/packages/api/v2', each: false}];
  assert.equal(sessionRootOf('/m/packages/api/src', roots), '/m/packages/api');
  assert.equal(sessionRootOf('/m/packages/web', roots), '/m/packages/web');
  assert.equal(sessionRootOf('/m/packages/api/v2/lib', roots), '/m/packages/api/v2');
  assert.equal(sessionRootOf('/m/tools/gen', roots), '/m/tools');
  assert.equal(sessionRootOf('/m/packages', roots), null, 'the folder of `/*` itself is none of them');
  assert.equal(sessionRootOf('/m/packages-old/x', roots), null, 'a folder is not a prefix of a name');
  assert.equal(sessionRootOf('/m', []), null);
});

test('of the open sessions, the deepest one containing a folder is its project', () => {
  assert.equal(openRootOf('/a/b/c', new Set(['/a', '/a/b', '/a/bc'])), '/a/b');
  assert.equal(openRootOf('/x', new Set(['/a'])), null);
});

test('sessionRoots in the config: folders with ~, `/*` for each folder in one; anything else is refused', () => {
  const {sessionRoots} = parseConfig({models, sessionRoots: ['~/no-such-mono/packages/*', '/no-such/tools']});
  assert.deepEqual(sessionRoots, [{path: join(homedir(), 'no-such-mono/packages'), each: true}, {path: '/no-such/tools', each: false}]);
  assert.deepEqual(parseConfig({models}).sessionRoots, []);
  assert.throws(() => parseConfig({models, sessionRoots: '/m'}), /sessionRoots must list folders/);
  assert.throws(() => parseConfig({models, sessionRoots: ['']}), /sessionRoots must list folders/);
});
