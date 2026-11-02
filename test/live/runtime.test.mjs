// Search by meaning's runtime installed for real, as `:Pair find on` does it: set PAIR_LIVE_RUNTIME=1 to run it. Your
// python3 (3.10 or later) makes a venv in a temp data folder and pip installs litert-lm-api==0.19.0 from PyPI by the
// lock file's hashes (about 33 MB); then LiteRT-LM has to import, and `:Pair find off`'s remove deletes the venv.
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {test} from 'node:test';
import {pythonOf, runtimeOf} from '../../src/embedder.mjs';
import {madeByPair, Runtime, venvPath, venvPython} from '../../src/runtime.mjs';
import {scratch} from '../temp.mjs';

const skip = process.env.PAIR_LIVE_RUNTIME ? false : 'set PAIR_LIVE_RUNTIME=1 to install LiteRT-LM for real from PyPI';

test('LiteRT-LM installs into a venv of Pair\'s by its pinned hashes, imports, and goes again', {skip, timeout: 900_000}, async () => {
  const dataDir = scratch('runtime-live-');
  const runtime = new Runtime({dataDir, python: () => pythonOf({}, dataDir)});
  let last = 0;
  const started = Date.now();
  const done = await runtime.install({progress: (bytes, total) => {
    if (bytes - last < 8 << 20 && bytes !== total) return;
    last = bytes;
    console.log(`pip: ${Math.round(bytes / (1 << 20))} of ${Math.round(total / (1 << 20))} MiB`);
  }});
  console.log(`installed LiteRT-LM ${done.version} with Python ${done.pythonVersion} in ${Math.round((Date.now() - started) / 1000)} s: ${done.python}`);
  assert.equal(done.python, venvPython(dataDir));
  assert.deepEqual(await runtimeOf(venvPython(dataDir)), {version: '0.19.0'});
  assert.equal(madeByPair(dataDir).runtime, 'litert-lm-api==0.19.0');
  assert.equal(await runtime.remove(), true);
  assert.ok(!existsSync(venvPath(dataDir)));
});
