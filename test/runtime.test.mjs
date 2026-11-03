// Search by meaning's runtime, installed by `:Pair find on` (runtime.mjs): the first Python 3.10+ that can make a venv,
// the venv in Pair's data folder, the wheel downloaded by its SHA-256 with its progress, pip with no index and the lock
// file's hashes, the note that Pair made the venv,
// and what goes wrong said in one line with what to do, leaving nothing half made. `:Pair find off` deletes only the
// venv Pair made. Meaning's turnOn and turnOff around it (Pair's provider, search.mjs), and the lock file itself. A fake Python stands in for the
// user's (fake-python.mjs): no real Python, pip or network.
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {pythonOf, RUNTIME} from '../src/embedder.mjs';
import {pairSearch} from '../src/search.mjs';
import {findPython, LOCK, madeByPair, pythons, Runtime, venvPath, venvPython, WHEELS} from '../src/runtime.mjs';
import {fakeEmbedder, fakeModel} from './fake-embedder.mjs';
import {fakePython, fakeWheel} from './fake-python.mjs';
import {scratch} from './temp.mjs';

const missing = () => join(scratch('no-python-'), 'python3');
const runtimeIn = (dataDir, python, options = {}) => new Runtime({dataDir, python: () => pythonOf({}, dataDir), candidates: [python], ...fakeWheel(), ...options});

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

test('findPython prefers a Python voice\'s packages fit, else the first that fits LiteRT-LM', async () => {
  const system = fakePython({version: '3.11'});
  const newer = fakePython({version: '3.12'});
  const bare = fakePython({version: '3.13', venv: false});
  assert.deepEqual(await findPython([system, bare, newer], ['3.12', '3.13', '3.14']), {python: newer, version: '3.12'}, 'python3.12 beside a system python3 3.11');
  assert.deepEqual(await findPython([system], ['3.12', '3.13', '3.14']), {python: system, version: '3.11'}, 'none preferred: the first that fits, as before');
  assert.deepEqual(await findPython([system, newer]), {python: system, version: '3.11'}, 'no preference: python3 first, as before');
});

test('install: a venv in Pair\'s data folder, the wheel downloaded by its hash with its progress, pip with no index by the lock file\'s hashes, and a note that Pair made it', async () => {
  const dataDir = scratch('runtime-data-');
  const served = fakeWheel({bytes: 3 << 20});
  const runtime = runtimeIn(dataDir, fakePython({version: '3.12'}), served);
  assert.equal(new Runtime({dataDir, platform: 'linux', arch: 'x64'}).bytes, WHEELS['linux x64'].bytes);
  assert.match((await runtime.check()).problem, /python3 is not there|has no litert-lm-api/, 'nothing yet');
  const heard = [];
  const done = await runtime.install({progress: (bytes, total) => heard.push([bytes, total])});
  assert.deepEqual(done, {python: venvPython(dataDir), version: '0.19.0', pythonVersion: '3.12', made: true});
  assert.equal(venvPath(dataDir), join(dataDir, 'meaning', 'venv'));
  const pip = JSON.parse(readFileSync(join(venvPath(dataDir), 'pip.json'), 'utf8'));
  for (const flag of ['--no-index', '--require-hashes', '--no-deps', '--only-binary=:all:', '--no-input']) assert.ok(pip.args.includes(flag), flag);
  assert.deepEqual(pip.args.slice(-2), ['-r', LOCK]);
  assert.deepEqual(pip.wheels, ['litert_lm_api-0.19.0-py3-none-manylinux_2_27_x86_64.whl'], 'pip gets the downloaded wheel, and only it');
  assert.deepEqual(served.fetched, [served.wheel.url]);
  assert.ok(!readdirSync(join(dataDir, 'meaning')).some(name => name.startsWith('wheel-')), 'the downloaded wheel is not kept');
  assert.equal(pip.noInput, '1');
  assert.deepEqual(heard.at(-1), [3 << 20, 3 << 20]);
  assert.deepEqual(heard.map(([bytes]) => bytes), [1 << 20, 2 << 20, 3 << 20], 'told as it comes, whatever pip\'s version');
  assert.equal(madeByPair(dataDir).runtime, RUNTIME);
  assert.equal(madeByPair(dataDir).pythonVersion, '3.12');
  assert.deepEqual(await runtime.check(), {version: '0.19.0'}, 'the helper\'s Python has it now');
  assert.equal(pythonOf({}, dataDir), venvPython(dataDir));
  mkdirSync(join(dataDir, 'meaning', 'wheel-left'));
  assert.equal(await runtime.remove(), true);
  assert.ok(!existsSync(venvPath(dataDir)), 'Pair\'s venv goes');
  assert.ok(!existsSync(join(dataDir, 'meaning', 'wheel-left')), 'and a wheel a daemon that died left');
  assert.equal(madeByPair(dataDir), null, 'and its note');
});

test('install fails in one line and leaves no venv: no wheel, no Python, pip refusing, or turned off meanwhile', async () => {
  const dataDir = scratch('runtime-data-');
  await assert.rejects(runtimeIn(dataDir, fakePython(), {wheel: undefined, platform: 'darwin', arch: 'x64'}).install(), /^Error: LiteRT-LM has no wheel for darwin x64 \(it has Linux x86-64 and ARM64, and macOS on Apple silicon\): set an "embedding" model instead$/);
  await assert.rejects(runtimeIn(dataDir, missing()).install(), /needs Python 3\.10 or later, and there is no python3 on PATH/);
  assert.ok(!existsSync(venvPath(dataDir)));
  await assert.rejects(runtimeIn(dataDir, fakePython({pipError: 'ERROR: THESE PACKAGES DO NOT MATCH THE HASHES FROM THE REQUIREMENTS FILE.'})).install(), /^Error: pip refused litert-lm-api==0\.19\.0: its SHA-256 is not the pinned one/);
  assert.ok(!existsSync(venvPath(dataDir)), 'a venv Pair made is deleted when pip fails');
  await assert.rejects(runtimeIn(dataDir, fakePython({pipError: 'ERROR: litert_lm_api-0.19.0-py3-none-manylinux_2_27_x86_64.whl is not a supported wheel on this platform.'})).install(), /pip says LiteRT-LM's wheel does not fit this machine \(it needs glibc 2\.27 or later, or macOS 12\): set/);
  await assert.rejects(runtimeIn(dataDir, fakePython(), fakeWheel({fail: 'ENOTFOUND'})).install(), /^Error: files\.pythonhosted\.org could not be reached for litert-lm-api==0\.19\.0 \(ENOTFOUND\): check the network, or its proxy$/, 'offline is said as offline');
  const bad = fakeWheel();
  await assert.rejects(runtimeIn(dataDir, fakePython(), {...bad, wheel: {...bad.wheel, sha256: '0'.repeat(64)}}).install(), /SHA-256 is [0-9a-f]{64}, not the pinned 0{64}: not kept/);
  assert.ok(!existsSync(venvPath(dataDir)) && madeByPair(dataDir) === null, 'a venv Pair made is deleted when the download fails');
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
  rmSync(join(dataDir, 'meaning', 'venv-made-by-pair.json'));
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
  const runtime = runtimeIn(dataDir, fakePython(), fakeWheel({bytes: 2 << 20}));
  const {meaning} = pairSearch({config: {dataDir, meaning: {}}, with: {embedder: fakeEmbedder(), runtime}});
  try {
    assert.deepEqual(await meaning.needs(), {runtime: {bytes: 2 << 20}, model: false});
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

  const {meaning: failing, gemma} = pairSearch({config: {dataDir, meaning: {}}, with: {embedder: fakeEmbedder(), runtime: runtimeIn(dataDir, missing()), fetch: async () => { throw new Error('no network in the tests'); }}});
  try {
    await assert.rejects(failing.turnOn(), /needs Python 3\.10 or later/);
    assert.equal(failing.state, 'off', 'it stays off, with the words');
    assert.equal(gemma.downloading, null);
  } finally {
    await failing.close();
  }

  const own = scratch('own-python-');
  const python = join(own, 'bin', 'python');
  mkdirSync(join(own, 'bin'));
  writeFileSync(python, '');
  const config = {python};
  const {meaning: withOwn} = pairSearch({config: {dataDir, meaning: config}, with: {embedder: fakeEmbedder(), runtime: new Runtime({dataDir, python: () => pythonOf(config, dataDir), candidates: [missing()]})}});
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

test('an older LiteRT-LM is installed again; off deletes Pair\'s venv with an "embedding" model too; Pythons PATH may lack are tried', async () => {
  const dataDir = scratch('meaning-data-');
  fakeModel(dataDir);
  const runtime = runtimeIn(dataDir, fakePython());
  const older = {...runtime, bytes: runtime.bytes, check: async () => ({version: '0.18.1'})};
  const {meaning} = pairSearch({config: {dataDir, meaning: {}}, with: {embedder: fakeEmbedder(), runtime: older}});
  assert.deepEqual(await meaning.needs(), {runtime: {bytes: runtime.bytes}, model: false}, 'not the pinned version: installed again');
  await meaning.close();

  await runtime.install();
  const {meaning: withModel, turnOff} = pairSearch({config: {dataDir, meaning: {}, embedding: {api: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'm'}}, with: {embedder: fakeEmbedder(), runtime}});
  assert.deepEqual(await withModel.needs(), {runtime: null, model: false}, 'nothing to install for an "embedding" model');
  assert.deepEqual(await turnOff(), {venv: true}, 'but the venv Pair made before goes');
  assert.ok(!existsSync(venvPath(dataDir)));
  await withModel.close();

  const tried = pythons('/home/u');
  assert.equal(tried[0], 'python3');
  for (const place of ['/opt/homebrew/bin/python3', '/usr/local/bin/python3.12', '/home/u/.pyenv/shims/python3', '/home/u/.local/bin/python3']) assert.ok(tried.includes(place), place);
});
