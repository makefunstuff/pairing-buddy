// `pair auth` with fake providers: logging in by subscription or key, a key for a server of your own, logging out,
// and the list that never shows a secret. And the terminal it asks in: a typed key is not echoed.
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {test} from 'node:test';
import {fauxProvider} from '@earendil-works/pi-ai';
import {authStates, credentialState, login, loginMethods, logout} from '../src/auth.mjs';
import {fileCredentialStore} from '../src/credentials.mjs';
import {terminalInteraction} from '../src/prompt.mjs';

const store = () => fileCredentialStore(join(mkdtempSync(join(tmpdir(), 'pair-auth-')), 'auth.json'));

/** A provider with a subscription login and an API key, as pi-ai's Anthropic has. */
function fakeProvider(id = 'fake') {
  const {provider} = fauxProvider();
  return {...provider, id, name: 'Fake', auth: {
    oauth: {
      name: 'Fake (Pro)', isSubscription: true,
      login: async interaction => {
        interaction.notify({type: 'auth_url', url: 'https://example.invalid/authorize'});
        return {type: 'oauth', access: 'access-secret', refresh: 'refresh-secret', expires: Date.now() + 3_600_000};
      },
      refresh: async credential => credential,
      toAuth: async credential => ({apiKey: credential.access}),
    },
    apiKey: {
      name: 'Fake API key',
      login: async interaction => ({type: 'api_key', key: await interaction.prompt({type: 'secret', message: 'Key:'})}),
      resolve: async ({credential}) => (credential?.key ? {auth: {apiKey: credential.key}, source: 'stored credential'} : undefined),
    },
  }};
}

/** An interaction that answers from `answers` in turn and records what it was asked and told. */
function scripted(...answers) {
  const asked = [];
  const told = [];
  return {asked, told, prompt: async prompt => { asked.push(prompt); return answers.shift(); }, notify: event => told.push(event)};
}

test('a provider with both offers its subscription first, then a key; each is stored', async () => {
  const provider = fakeProvider();
  const providers = new Map([[provider.id, provider]]);
  assert.deepEqual(loginMethods(provider).map(method => method.type), ['oauth', 'api_key']);
  const credentials = store();

  const bySubscription = scripted('oauth');
  assert.equal(await login({id: 'fake', credentials, interaction: bySubscription, providers}), 'oauth');
  assert.equal(bySubscription.asked[0].type, 'select');
  assert.equal(bySubscription.told[0].url, 'https://example.invalid/authorize');
  assert.equal((await credentials.read('fake')).access, 'access-secret');

  const byKey = scripted('api_key', 'sk-fake');
  assert.equal(await login({id: 'fake', credentials, interaction: byKey, providers}), 'api_key');
  assert.equal(byKey.asked[1].type, 'secret', 'the key is asked for as a secret');
  assert.deepEqual(await credentials.read('fake'), {type: 'api_key', key: 'sk-fake'}, 'one credential per provider: the key replaced the login');

  assert.equal(await logout({id: 'fake', credentials}), true);
  assert.equal(await credentials.read('fake'), undefined);
  assert.equal(await logout({id: 'fake', credentials}), false);
});

test('a name pi-ai does not know stores a key for your own server; a bad name or no key stores nothing', async () => {
  const credentials = store();
  const interaction = scripted('sk-mine');
  assert.equal(await login({id: 'my-server', credentials, interaction, providers: new Map()}), 'key');
  assert.equal(interaction.asked[0].type, 'secret');
  assert.deepEqual(await credentials.read('my-server'), {type: 'api_key', key: 'sk-mine'});
  await assert.rejects(login({id: 'My Server', credentials, interaction: scripted(), providers: new Map()}), /not a name to log in with/);
  await assert.rejects(login({id: 'pair-watcher', credentials, interaction: scripted(), providers: new Map()}), /not starting with pair-/);
  await assert.rejects(login({id: 'other', credentials, interaction: scripted(''), providers: new Map()}), /no key given/);
  assert.equal(await credentials.read('other'), undefined);
});

test('the list says what is set, from where, and when a token expires, and shows no secret', async () => {
  const credentials = store();
  const now = new Date('2026-10-26T12:00:00').getTime();
  const providers = new Map(['loggedin', 'expired', 'keyed', 'unset'].map(id => [id, fakeProvider(id)]));
  await credentials.modify('loggedin', async () => ({type: 'oauth', access: 'access-secret', refresh: 'refresh-secret', expires: now + 90 * 60_000}));
  await credentials.modify('expired', async () => ({type: 'oauth', access: 'access-secret', refresh: 'refresh-secret', expires: now - 60_000}));
  await credentials.modify('keyed', async () => ({type: 'api_key', key: 'sk-secret'}));
  await credentials.modify('my-server', async () => ({type: 'api_key', key: 'sk-secret'}));
  const rows = Object.fromEntries((await authStates({credentials, providers, now})).map(row => [row.id, row]));
  assert.equal(rows.loggedin.state, 'logged in; the token renews itself (this one until 13:30) (Fake (Pro))');
  assert.match(rows.expired.state, /the token expired at 11:59 and renews on the next request/);
  assert.equal(rows.keyed.state, 'key stored');
  assert.equal(rows.unset.set, false);
  assert.equal(rows.unset.state, 'not set: subscription or API key');
  assert.equal(rows['my-server'].state, 'key stored, for "auth": "my-server"');
  assert.doesNotMatch(JSON.stringify(rows), /secret/);
  assert.equal(credentialState({type: 'api_key', key: 'sk-secret'}), 'key stored');
});

/** A terminal on in-memory streams: `type(text)` is the user typing, `shown()` all it showed. */
function fakeTerminal() {
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  let shown = '';
  output.on('data', chunk => { shown += chunk; });
  const opened = [];
  const interaction = terminalInteraction({input, output, openUrl: url => opened.push(url)});
  return {interaction, opened, type: text => setImmediate(() => input.write(text)), shown: () => shown};
}

test('in the terminal a typed key is not echoed, a choice is a number (Enter takes the first), and links open', async () => {
  const terminal = fakeTerminal();
  try {
    terminal.type('sk-typed-secret\r');
    assert.equal(await terminal.interaction.prompt({type: 'secret', message: 'API key:'}), 'sk-typed-secret');
    assert.doesNotMatch(terminal.shown(), /sk-typed-secret/);
    assert.match(terminal.shown(), /API key:/);

    terminal.type('2\r');
    const options = [{id: 'oauth', label: 'Subscription'}, {id: 'api_key', label: 'API key'}];
    assert.equal(await terminal.interaction.prompt({type: 'select', message: 'Log in with:', options}), 'api_key');
    terminal.type('\r');
    assert.equal(await terminal.interaction.prompt({type: 'select', message: 'Log in with:', options}), 'oauth');
    assert.match(terminal.shown(), /1\. Subscription\n {2}2\. API key/);

    terminal.type('typed code\r');
    assert.equal(await terminal.interaction.prompt({type: 'manual_code', message: 'Paste the code:'}), 'typed code');
    assert.match(terminal.shown(), /typed code/, 'a code is shown as it is typed');

    terminal.interaction.notify({type: 'auth_url', url: 'https://example.invalid/a', instructions: 'Sign in:'});
    terminal.interaction.notify({type: 'device_code', userCode: 'AB-12', verificationUri: 'https://example.invalid/device'});
    assert.match(terminal.shown(), /Sign in:\n {2}https:\/\/example\.invalid\/a\n/);
    assert.match(terminal.shown(), /enter the code AB-12/);
    assert.deepEqual(terminal.opened, ['https://example.invalid/a', 'https://example.invalid/device']);
  } finally {
    terminal.interaction.close();
  }
});

test('a pending question gives way when the login finishes in the browser', async () => {
  const terminal = fakeTerminal();
  try {
    const controller = new AbortController();
    const pending = terminal.interaction.prompt({type: 'manual_code', message: 'Paste the code:', signal: controller.signal});
    controller.abort();
    await assert.rejects(pending, {name: 'AbortError'});
  } finally {
    terminal.interaction.close();
  }
});
