// The credential store `pair auth` writes and the daemon reads: owner-only, and a token refreshed once however many
// processes need it at the same time.
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createModels, fauxProvider} from '@earendil-works/pi-ai';
import {fileCredentialStore, readableByOthers, readCredentials, storedKey} from '../src/credentials.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'pair-auth-'));

test('credentials are written owner-only, read back, listed without secrets and deleted', async () => {
  const path = join(scratch(), 'pairing-buddy', 'auth.json');
  const store = fileCredentialStore(path);
  assert.equal(await store.read('deepseek'), undefined, 'no file yet: nothing stored');
  await store.modify('deepseek', async () => ({type: 'api_key', key: 'sk-secret'}));
  await store.modify('anthropic', async () => ({type: 'oauth', access: 'a1', refresh: 'r1', expires: 1}));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(path, '..')).mode & 0o777, 0o700);
  assert.equal(readableByOthers(path), false);
  assert.deepEqual(await store.read('deepseek'), {type: 'api_key', key: 'sk-secret'});
  assert.equal(storedKey(path, 'deepseek'), 'sk-secret');
  assert.equal(storedKey(path, 'anthropic'), undefined, 'a login is not a key');
  const listed = await store.list();
  assert.deepEqual(listed, [{providerId: 'deepseek', type: 'api_key'}, {providerId: 'anthropic', type: 'oauth'}]);
  assert.doesNotMatch(JSON.stringify(listed), /secret|a1|r1/);
  await store.delete('deepseek');
  assert.deepEqual(Object.keys(readCredentials(path)), ['anthropic']);
});

test('a file others can read is noticed; a broken one says how to fix it', () => {
  const path = join(scratch(), 'auth.json');
  writeFileSync(path, '{', {mode: 0o644});
  assert.equal(readableByOthers(path), true);
  assert.throws(() => readCredentials(path), /not valid JSON: log in again with `pair auth login`/);
});

test('an expired token is refreshed once, under the lock, when two processes need it at once', async () => {
  const path = join(scratch(), 'auth.json');
  let refreshes = 0;
  const faux = fauxProvider();
  const provider = {...faux.provider, auth: {oauth: {
    name: 'Fake (subscription)',
    login: async () => assert.fail('not logged in here'),
    refresh: async credential => {
      refreshes++;
      await new Promise(resolve => setTimeout(resolve, 50)); // long enough for the other process to wait on the lock
      return {type: 'oauth', access: `${credential.access}+`, refresh: `${credential.refresh}+`, expires: Date.now() + 3_600_000};
    },
    toAuth: async credential => ({apiKey: credential.access}),
  }}};
  await fileCredentialStore(path).modify(provider.id, async () => ({type: 'oauth', access: 'old', refresh: 'r', expires: Date.now() - 1000}));
  // Two stores on one file, as the daemon and `pair doctor` have.
  const daemon = createModels({credentials: fileCredentialStore(path)});
  const doctor = createModels({credentials: fileCredentialStore(path)});
  daemon.setProvider(provider);
  doctor.setProvider(provider);
  const [first, second] = await Promise.all([daemon.getAuth(provider.id), doctor.getAuth(provider.id)]);
  assert.equal(refreshes, 1);
  assert.equal(first.auth.apiKey, 'old+');
  assert.equal(second.auth.apiKey, 'old+');
  assert.equal(readCredentials(path)[provider.id].refresh, 'r+', 'the rotated refresh token is kept');
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('a lock left by a process that died is taken over', async () => {
  const path = join(scratch(), 'auth.json');
  writeFileSync(`${path}.lock`, '');
  utimesSync(`${path}.lock`, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  await fileCredentialStore(path).modify('x', async () => ({type: 'api_key', key: 'k'}));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).x.key, 'k');
});
