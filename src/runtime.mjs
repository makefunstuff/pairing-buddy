// Search by meaning's runtime: LiteRT-LM's Python package, which the embedder's helper imports. `:Pair find on` installs
// it, unless the Python the helper runs already has the pinned version: a venv in Pair's data folder
// (<dataDir>/meaning/venv), made with the user's Python 3.10 or later. Pair downloads the one wheel for this machine
// from PyPI itself, as it does the model (its SHA-256 checked, its progress told), and pip installs it from that file
// with no index: --require-hashes against meaning-runtime.txt, no other package, nothing built. Nothing goes outside
// that folder. A note next to the venv says Pair made it: `:Pair find off` deletes only such a venv, never one the
// user made, nor the config's meaning.python.
import {execFile, spawn} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {mkdir, mkdtemp, readdir, rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {downloadFile, meaningDir, RUNTIME, runtimeOf} from './embedder.mjs';

export const LOCK = fileURLToPath(new URL('./meaning-runtime.txt', import.meta.url));
export const RUNTIME_VERSION = RUNTIME.split('==')[1];
const FILES = 'https://files.pythonhosted.org/packages';
// The wheel PyPI has for each platform LiteRT-LM supports, as meaning-runtime.txt pins it.
export const WHEELS = {
  'linux x64': {
    url: `${FILES}/73/07/f2817c145fd04983607d830259e620700638a426ed7b9dda50722a737c90/litert_lm_api-0.19.0-py3-none-manylinux_2_27_x86_64.whl`,
    bytes: 33_186_371, sha256: 'c5a8a9538acffbd01530eab812424c0e96a2c193b4b16b8f8df630a8d346be76',
  },
  'linux arm64': {
    url: `${FILES}/6e/91/ce4712d1e97fb197433b687e1c900a4186e31d3d8442005d3e213f3b0e5c/litert_lm_api-0.19.0-py3-none-manylinux_2_27_aarch64.whl`,
    bytes: 32_194_513, sha256: '1dc24e9a335c61ecc27df887eb56d8bae455a16351ebc716e4398a7089ab84bc',
  },
  'darwin arm64': {
    url: `${FILES}/ce/a1/8686d7c8323d15680c9d3c0a950c6349c03390d4f2c69180095075a1587c/litert_lm_api-0.19.0-py3-none-macosx_12_0_arm64.whl`,
    bytes: 17_222_369, sha256: '6f2a517266fe4dcac451ce8f41c45c02ef08078a6589e5e0253197937e1f70a5',
  },
};
const NAMES = ['python3', 'python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10'];
// Where Pythons live that a daemon started by launchd or systemd may not have on its PATH: Homebrew, python.org's
// installer, pyenv, and pip's or uv's --user folder.
const PLACES = ['/opt/homebrew/bin', '/usr/local/bin', '/Library/Frameworks/Python.framework/Versions/Current/bin', '~/.pyenv/shims', '~/.local/bin'];
const PROBE = 'import sys\nprint("%d.%d" % sys.version_info[:2])\ntry:\n    import ensurepip, venv\n    print("venv")\nexcept ImportError:\n    print("no venv")';
const PROBE_MS = 20_000;
const INSTALL_MS = 5 * 60_000; // pip from a file it has; past this it is stuck
const ELSE = `or set "meaning": {"python": …} to a Python with ${RUNTIME}, or an "embedding" model`;

export const venvPath = dataDir => join(meaningDir(dataDir), 'venv');
export const venvPython = dataDir => join(venvPath(dataDir), 'bin', 'python');
// Next to the venv, not in it, and written before it is made: a venv half made when the daemon died is still Pair's.
const madePath = dataDir => join(meaningDir(dataDir), 'venv-made-by-pair.json');

/** The Pythons to try: each name on PATH, then in each place PATH may lack. */
export const pythons = (home = homedir()) => [...NAMES, ...PLACES.flatMap(place => NAMES.map(name => join(place.replace(/^~/, home), name)))];

/** What Pair noted when it made the venv in `dataDir` ({runtime, python, pythonVersion, installedAt}), or null. */
export function madeByPair(dataDir) {
  try {
    return JSON.parse(readFileSync(madePath(dataDir), 'utf8'));
  } catch {
    return null;
  }
}

/** LiteRT-LM's wheel for this machine (`{url, bytes, sha256}`), or null when it has none. */
export const wheelOf = (platform = process.platform, arch = process.arch) => WHEELS[`${platform} ${arch}`] ?? null;

const run = (file, args, options = {}) => new Promise(resolve => execFile(file, args, {timeout: PROBE_MS, ...options}, (error, stdout, stderr) => resolve({error, stdout, stderr})));

/** The first of `candidates` that is 3.10 or later and can make a venv: `{python, version}`, or `{problem}` saying what to do. */
export async function findPython(candidates = pythons()) {
  let seen = null;
  for (const python of candidates) {
    if (python.includes('/') && !existsSync(python)) continue;
    const {error, stdout} = await run(python, ['-I', '-c', PROBE]);
    if (error) continue;
    const [version, venv] = stdout.trim().split('\n');
    const [major, minor] = version.split('.').map(Number);
    const fits = major === 3 && minor >= 10;
    if (fits && venv === 'venv') return {python, version};
    if (!seen || (fits && !seen.fits)) seen = {python, version, fits};
  }
  if (!seen) return {problem: `LiteRT-LM needs Python 3.10 or later, and there is no python3 on PATH: install one, ${ELSE}`};
  if (!seen.fits) return {problem: `LiteRT-LM needs Python 3.10 or later, and ${seen.python} is ${seen.version}: install a newer one, ${ELSE}`};
  return {problem: `${seen.python} (Python ${seen.version}) cannot make a venv: install its venv module (python3-venv on Debian and Ubuntu), ${ELSE}`};
}

/** What went wrong in pip's words, in one line: its last ERROR, or its last line. */
const pipProblem = (stderr, code) => {
  const lines = stderr.split('\n').map(line => line.trim()).filter(Boolean);
  const said = lines.findLast(line => line.startsWith('ERROR:'))?.replace(/^ERROR:\s*/, '') ?? lines.at(-1) ?? `exit ${code}`;
  if (/is not a supported wheel on this platform|No matching distribution|from versions: none/.test(said)) return `pip says LiteRT-LM's wheel does not fit this machine (it needs glibc 2.27 or later, or macOS 12): set "meaning": {"python": …} to a Python with ${RUNTIME}, or an "embedding" model`;
  if (/hash/i.test(said)) return `pip refused ${RUNTIME}: its SHA-256 is not the pinned one (${said})`;
  return `pip could not install ${RUNTIME}: ${said.replace(/\.$/, '')}`;
};

/**
 * `:Pair find on`'s runtime, for Meaning: `check()` says whether `python()` (meaning.python, else the venv, else
 * python3) has LiteRT-LM, `install()` makes the venv and installs it, `remove()` deletes the venv if Pair made it.
 * `lock` is the pip requirements file, every line pinned by its hashes; `wheel` the file it downloads for it.
 */
export class Runtime {
  constructor({dataDir, python, lock = LOCK, wheel, candidates = pythons(), platform = process.platform, arch = process.arch, fetch = globalThis.fetch, log = () => {}}) {
    Object.assign(this, {dataDir, python, lock, candidates, fetch, log});
    this.wheel = wheel === undefined ? wheelOf(platform, arch) : wheel;
    this.bytes = this.wheel?.bytes ?? null;
    this.platform = `${platform} ${arch}`;
  }

  /** `{version}` when the Python the helper runs has LiteRT-LM, else `{problem}`. */
  check() { return runtimeOf(this.python()); }

  /**
   * Installs LiteRT-LM into the venv in Pair's data folder: made with the first Python 3.10+ (or the venv the user
   * made there, kept as theirs), then the wheel downloaded and pip with the lock file. `progress(bytes, total)` hears
   * the download; `signal` stops it, and a venv Pair made is deleted again whenever the install fails. Resolves
   * `{python, version, pythonVersion, made}`.
   */
  async install({progress = () => {}, signal = null} = {}) {
    if (!this.wheel) throw new Error(`LiteRT-LM has no wheel for ${this.platform} (it has Linux x86-64 and ARM64, and macOS on Apple silicon): set an "embedding" model instead`);
    const venv = venvPath(this.dataDir);
    const python = venvPython(this.dataDir);
    if (madeByPair(this.dataDir)) await rm(venv, {recursive: true, force: true}); // Pair's, and broken or old: made again
    const made = !existsSync(venv);
    await mkdir(meaningDir(this.dataDir), {recursive: true, mode: 0o700});
    const wheels = await mkdtemp(join(meaningDir(this.dataDir), 'wheel-'));
    let base = null;
    let pythonVersion = null;
    try {
      if (made) {
        const found = await findPython(this.candidates);
        if (found.problem) throw new Error(found.problem);
        ({python: base, version: pythonVersion} = found);
        writeFileSync(madePath(this.dataDir), JSON.stringify({runtime: RUNTIME, python: base, pythonVersion, installing: true}), {mode: 0o600});
        const {error, stderr} = await run(base, ['-I', '-m', 'venv', venv], {timeout: 120_000, ...(signal ? {signal} : {})});
        if (signal?.aborted) throw signal.reason;
        if (error) throw new Error(`${base} could not make a venv in ${venv}: ${stderr.trim().split('\n').at(-1) || error.message}`);
      }
      const file = join(wheels, this.wheel.url.split('/').at(-1));
      await downloadFile(this.wheel.url, file, {sha256: this.wheel.sha256, what: RUNTIME, fetch: this.fetch, signal, progress: bytes => progress(bytes, this.wheel.bytes)});
      await this.pip(python, wheels, signal);
      const found = await runtimeOf(python);
      if (found.version !== RUNTIME_VERSION) throw new Error(`pip installed ${RUNTIME}, but ${found.problem ?? `${python} has ${found.version}`}`);
      if (made) writeFileSync(madePath(this.dataDir), JSON.stringify({runtime: RUNTIME, python: base, pythonVersion, installedAt: new Date().toISOString()}), {mode: 0o600});
      return {python, version: found.version, pythonVersion, made};
    } catch (error) {
      if (made) {
        await rm(venv, {recursive: true, force: true});
        await rm(madePath(this.dataDir), {force: true});
      }
      throw signal?.aborted ? signal.reason : error;
    } finally {
      await rm(wheels, {recursive: true, force: true});
    }
  }

  /** pip in the venv: the lock file's one wheel, from the folder it was downloaded to, by its hash, and no other package. */
  pip(python, wheels, signal) {
    const args = ['-I', '-m', 'pip', 'install', '--no-index', '--find-links', wheels, '--require-hashes', '--no-deps', '--only-binary=:all:', '--no-input', '--disable-pip-version-check', '-r', this.lock];
    return new Promise((resolve, reject) => {
      const child = spawn(python, args, {stdio: ['ignore', 'ignore', 'pipe'], ...(signal ? {signal} : {}), timeout: INSTALL_MS, env: {...process.env, PIP_NO_INPUT: '1'}});
      let stderr = '';
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      child.on('error', error => reject(error.name === 'AbortError' ? signal.reason : error));
      child.on('close', code => {
        if (code === 0) return resolve();
        reject(new Error(code === null ? `pip took over ${INSTALL_MS / 60_000} min to install ${RUNTIME}` : pipProblem(stderr, code)));
      });
    });
  }

  /**
   * `:Pair find off`: the venv goes if Pair made it, and any wheel a daemon that died left. Resolves true when the venv
   * went. `keep` keeps the venv: voice's LFM3-Omni runs in it too (omni.mjs).
   */
  async remove({keep = false} = {}) {
    const left = await readdir(meaningDir(this.dataDir)).catch(() => []);
    for (const name of left.filter(name => name.startsWith('wheel-'))) await rm(join(meaningDir(this.dataDir), name), {recursive: true, force: true});
    if (!madeByPair(this.dataDir) || keep) return false;
    await rm(venvPath(this.dataDir), {recursive: true, force: true});
    await rm(madePath(this.dataDir), {force: true});
    return true;
  }
}
