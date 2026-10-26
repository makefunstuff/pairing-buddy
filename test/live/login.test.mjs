// A login made with `pair auth login`, against the real provider: with PAIR_LIVE_LOGIN="provider/model" (several
// separated by commas) and that provider's login or key in pairing-buddy's own store (`pair auth list` shows it), the
// model answers the probe as both roles, a subscription token renews, and the renewed one is stored and answers too.
// Skipped without either: a subscription login needs a browser, so no test makes one.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {authPath, parseConfig} from '../../src/config.mjs';
import {fileCredentialStore} from '../../src/credentials.mjs';
import {createPairModels} from '../../src/models.mjs';
import {probeModel} from '../../src/probe.mjs';

const credentials = fileCredentialStore(authPath());
const wanted = (process.env.PAIR_LIVE_LOGIN ?? '').split(',').filter(Boolean).map(pair => pair.split('/'));
const logins = [];
for (const [provider, ...model] of wanted) {
  if (await credentials.read(provider)) logins.push({provider, model: model.join('/')});
}
const skip = logins.length ? false : 'set PAIR_LIVE_LOGIN="provider/model" and log in with `pair auth login provider` to test a login';

describe('a login against its provider', {skip}, () => {
  for (const {provider, model} of logins) {
    test(`${provider}/${model}: answers as both roles; a subscription token renews and is kept`, {timeout: 120_000}, async t => {
      const entry = {provider, model};
      const pairModels = createPairModels(parseConfig({models: {watcher: entry, partner: entry}}), {credentials});
      for (const role of ['watcher', 'partner']) {
        const probe = await probeModel(pairModels.models, pairModels[role]);
        t.diagnostic(`${role} probe: ${probe.ok ? `${probe.ms} ms` : probe.error}`);
        assert.equal(probe.ok, true, probe.error);
      }
      const before = await credentials.read(provider);
      if (before.type !== 'oauth') return t.diagnostic('an API key: nothing to renew');
      // No token lasts a year: pi-ai renews it now, stores it, and then says the new one expires too soon.
      await pairModels.models.getAuth(provider, {minOAuthValidityMs: 365 * 24 * 3_600_000})
        .catch(error => assert.match(error.message, /expires too soon/));
      const after = await credentials.read(provider);
      assert.notEqual(after.access, before.access, 'a new token');
      assert.ok(after.expires > Date.now());
      const probe = await probeModel(pairModels.models, pairModels.watcher);
      assert.equal(probe.ok, true, probe.error);
    });
  }
});
