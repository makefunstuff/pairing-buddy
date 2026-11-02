// Search by meaning's runtime, installed by `:Pair find on` (runtime.mjs): the first Python 3.10+ that can make a venv,
// the venv in Pair's data folder, pip with the lock file's hashes and its progress, the note that Pair made the venv,
// and what goes wrong said in one line with what to do, leaving nothing half made. `:Pair find off` deletes only the
// venv Pair made. Meaning's turnOn and turnOff around it, and the lock file itself. A fake Python stands in for the
// user's (fake-python.mjs): no real Python, pip or network.
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {pythonOf, RUNTIME} from '../src/embedder.mjs';
import {Meaning} from '../src/meaning.mjs';
import {findPython, LOCK, madeByPair, Runtime, venvPath, venvPython, WHEELS} from '../src/runtime.mjs';
import {fakeEmbedder, fakeModel} from './fake-embedder.mjs';
import {fakePython} from './fake-python.mjs';
import {scratch} from './temp.mjs';

const missing = () => join(scratch('no-python-'), 'python3');
const runtimeIn = (dataDir, python, options = {}) => new Runtime({dataDir, python: () => pythonOf({}, dataDir), pythons: [python], platform: 'linux', arch: 'x64', ...options});

test('the lock file pins litert-lm-api by the SHA-256 of each wheel PyPI has, the one RUNTIME the helper needs', () => {
  const lock = readFileSync(LOCK, 'utf8');
  const lines = lock.split('\n').filter(line => line && !line.startsWith('#'));
  assert.equal(lines[0], `${RUNTIME} \\`);
  const hashes = lock.match(/--hash=sha256:[0-9a-f]{64}/g);
  assert.equal(hashes.length, 6, 'a wheel each for Linux x86-64 and ARM64, macOS ARM64, Windows and Android\'s two');
  assert.equal(new Set(hashes).size, 6);
  assert.deepEqual(Object.keys(WHEELS), ['linux x64', 'linux arm64', 'darwin arm64']);
});

test('findPython: the first 3.10 or later that can make a venv, else one line saying what to do', async () => {
  const old = fakePython({version: '3.9'});
  const bare = fakePython({version: '3.12', venv: false});
  const good = fakePython({version: '3.13'});
  assert.deepEqual(await findPython([missing(), old, good]), {python: good, version: '3.13'});
  assert.match((await findPython([missing()])).problem, /^LiteRT-LM needs Python 3\.10 or later, and there is no python3 on PATH: install one, or set "meaning": \{"python": …\} to a Python with litert-lm-api==0\.19\.0, or an "embedding" model$/);
  assert.match((await findPython([old])).problem, /^LiteRT-LM needs Python 3\.10 or later, and .*python3 is 3\.9: install a newer one/);
  assert.match((await findPython([old, bare])).problem, /python3 \(Python 3\.12\) cannot make a venv: install its venv module \(python3-venv on Debian and Ubuntu\)/, 'a 3.10+ without venv says more than an old one');
});

test('install: a venv in Pair\'s data folder, pip by the lock file\'s hashes and nothing else, its progress, and a note that Pair made it', async () => {
  const dataDir = scratch('runtime-data-');
  const runtime = runtimeIn(dataDir, fakePython({version: '3.12', bytes: 3 << 20}));
  assert.equal(runtime.bytes, WHEELS['linux x64']);
  assert.match((await runtime.check()).problem, /python3 is not there|has no litert-lm-api/, 'nothing yet');
  const heard = [];
  const done = await runtime.install({progress: (bytes, total) => heard.push([bytes, total])});
  assert.deepEqual(done, {python: venvPython(dataDir), version: '0.19.0', pythonVersion: '3.12', made: true});
  assert.equal(venvPath(dataDir), join(dataDir, 'meaning', 'venv'));
  const pip = JSON.parse(readFileSync(join(venvPath(dataDir), 'pip.json'), 'utf8'));
  for (const flag of ['--require-hashes', '--no-deps', '--only-binary=:all:', '--no-input']) assert.ok(pip.args.includes(flag), flag);
  assert.deepEqual(pip.args.slice(-2), ['-r', LOCK]);
  assert.ok(pip.args.includes('raw'), 'pip 24.1 or later prints its progress a line at a time');
  assert.equal(pip.noInput, '1');
  assert.deepEqual(heard.at(-1), [3 << 20, 3 << 20]);
  assert.ok(heard.length >= 3);
  assert.equal(madeByPair(dataDir).runtime, RUNTIME);
  assert.equal(madeByPair(dataDir).pythonVersion, '3.12');
  assert.deepEqual(await runtime.check(), {version: '0.19.0'}, 'the helper\'s Python has it now');
  assert.equal(pythonOf({}, dataDir), venvPython(dataDir));
  assert.equal(await runtime.remove(), true);
  assert.ok(!existsSync(venvPath(dataDir)), 'Pair\'s venv goes');

  const older = runtimeIn(scratch('runtime-data-'), fakePython({pip: '23.0.1'}));
  await older.install();
  assert.ok(!JSON.parse(readFileSync(join(venvPath(older.dataDir), 'pip.json'), 'utf8')).args.includes('raw'), 'an older pip gets no --progress-bar raw');
});

test('install fails in one line and leaves no venv: no wheel, no Python, pip refusing, or turned off meanwhile', async () => {
  const dataDir = scratch('runtime-data-');
  await assert.rejects(runtimeIn(dataDir, fakePython(), {platform: 'darwin', arch: 'x64'}).install(), /^Error: LiteRT-LM has no wheel for darwin x64 \(it has Linux x86-64 and ARM64, and macOS on Apple silicon\): set an "embedding" model instead$/);
  await assert.rejects(runtimeIn(dataDir, missing()).install(), /needs Python 3\.10 or later, and there is no python3 on PATH/);
  assert.ok(!existsSync(venvPath(dataDir)));
  await assert.rejects(runtimeIn(dataDir, fakePython({pipError: 'ERROR: THESE PACKAGES DO NOT MATCH THE HASHES FROM THE REQUIREMENTS FILE.'})).install(), /^Error: pip refused litert-lm-api==0\.19\.0: its SHA-256 is not the pinned one/);
  assert.ok(!existsSync(venvPath(dataDir)), 'a venv Pair made is deleted when pip fails');
  await assert.rejects(runtimeIn(dataDir, fakePython({pipError: 'ERROR: No matching distribution found for litert-lm-api==0.19.0'})).install(), /pip found no litert-lm-api==0\.19\.0 wheel for this machine \(Linux needs glibc 2\.27 or later\)/);
  const abort = new AbortController();
  const hung = runtimeIn(dataDir, fakePython({pipHangs: true})).install({signal: abort.signal});
  const end = Date.now() + 5000;
  while (!existsSync(join(venvPath(dataDir), 'pip.json')) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  abort.abort(new Error('search by meaning was turned off'));
  await assert.rejects(hung, /turned off/);
  assert.ok(!existsSync(venvPath(dataDir)), 'stopped, it leaves nothing');
});

test('a venv the user made in Pair\'s data folder is used and kept: pip fills it, and off leaves it', async () => {
  const dataDir = scratch('runtime-data-');
  const runtime = runtimeIn(dataDir, fakePython());
  // The venv as the old docs said to make it, still without litert-lm-api: a venv without Pair's note.
  await runtimeIn(dataDir, fakePython()).install();
  rmSync(join(venvPath(dataDir), 'pair-made.json'));
  rmSync(join(venvPath(dataDir), 'installed'));
  assert.equal(madeByPair(dataDir), null);
  const done = await runtime.install();
  assert.equal(done.made, false);
  assert.equal(madeByPair(dataDir), null, 'still the user\'s');
  assert.equal(await runtime.remove(), false);
  assert.ok(existsSync(venvPython(dataDir)), 'off never deletes it');
});

test('turnOn installs LiteRT-LM before the model, says so in its state, and turnOff deletes Pair\'s venv but never meaning.python', async () => {
  const dataDir = scratch('meaning-data-');
  fakeModel(dataDir); // the model is here already: only the runtime is missing
  const runtime = runtimeIn(dataDir, fakePython({bytes: 2 << 20}));
  const meaning = new Meaning({dataDir, embedder: fakeEmbedder(), runtime});
  try {
    assert.deepEqual(await meaning.needs(), {runtime: {bytes: WHEELS['linux x64']}, model: false});
    const states = [];
    const done = await meaning.turnOn({progress: how => states.push([how.phase, meaning.state, meaning.snapshot().installing])});
    assert.equal(done.runtime.made, true);
    assert.equal(done.model, false);
    assert.deepEqual(states[0], ['runtime', 'installing', 0]);
    assert.deepEqual(states.at(-1), ['runtime', 'installing', 2 << 20]);
    assert.equal(meaning.state, 'on');
    assert.deepEqual(await meaning.needs(), {runtime: null, model: false}, 'on again installs nothing');
    assert.deepEqual(await meaning.turnOn(), {runtime: null, model: false});
    assert.deepEqual(await meaning.turnOff(), {venv: true});
    assert.ok(!existsSync(venvPath(dataDir)));
  } finally {
    await meaning.close();
  }

  const failing = new Meaning({dataDir, embedder: fakeEmbedder(), runtime: runtimeIn(dataDir, missing()), fetch: async () => { throw new Error('no network in the tests'); }});
  try {
    await assert.rejects(failing.turnOn(), /needs Python 3\.10 or later/);
    assert.equal(failing.state, 'off', 'it stays off, with the words');
    assert.equal(failing.downloading, null);
  } finally {
    await failing.close();
  }

  const own = scratch('own-python-');
  const python = join(own, 'bin', 'python');
  mkdirSync(join(own, 'bin'));
  writeFileSync(python, '');
  const config = {python};
  const withOwn = new Meaning({dataDir, config, embedder: fakeEmbedder(), runtime: new Runtime({dataDir, python: () => pythonOf(config, dataDir), pythons: [missing()]})});
  try {
    fakeModel(dataDir);
    assert.deepEqual(await withOwn.needs(), {runtime: null, model: false}, 'the config\'s Python wins: nothing to install');
    assert.deepEqual(await withOwn.turnOn(), {runtime: null, model: false});
    await withOwn.turnOff();
    assert.ok(existsSync(python), 'and it is never deleted');
  } finally {
    await withOwn.close();
  }
});
