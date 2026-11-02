// Search by meaning's runtime: LiteRT-LM's Python package, which the embedder's helper imports. `:Pair find on` installs
// it, unless a Python that has it is already there: a venv in Pair's data folder (<dataDir>/meaning/venv), made with
// the user's Python 3.10 or later, and pip installs the one pinned wheel into it by its SHA-256 (meaning-runtime.txt,
// --require-hashes), so nothing else comes from PyPI and nothing goes outside that folder. A note in the venv says
// Pair made it: `:Pair find off` deletes only such a venv, never one the user made, nor the config's meaning.python.
import {execFile, spawn} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {mkdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {meaningDir, RUNTIME, runtimeOf} from './embedder.mjs';

export const LOCK = fileURLToPath(new URL('./meaning-runtime.txt', import.meta.url));
export const RUNTIME_VERSION = RUNTIME.split('==')[1];
// The wheel PyPI has for each platform LiteRT-LM supports, by its size: what `:Pair find on` says it downloads.
export const WHEELS = {'linux x64': 33_186_371, 'linux arm64': 32_194_513, 'darwin arm64': 17_222_369};
const PYTHONS = ['python3', 'python3.14', 'python3.13', 'python3.12', 'python3.11', 'python3.10'];
const PROBE = 'import sys\nprint("%d.%d" % sys.version_info[:2])\ntry:\n    import ensurepip, venv\n    print("venv")\nexcept ImportError:\n    print("no venv")';
const PROBE_MS = 20_000;
const INSTALL_MS = 15 * 60_000; // pip with a slow network; past this it is stuck
const ELSE = `or set "meaning": {"python": …} to a Python with ${RUNTIME}, or an "embedding" model`;

export const venvPath = dataDir => join(meaningDir(dataDir), 'venv');
export const venvPython = dataDir => join(venvPath(dataDir), 'bin', 'python');
const madePath = dataDir => join(venvPath(dataDir), 'pair-made.json');

/** What Pair noted when it made the venv in `dataDir` ({runtime, python, pythonVersion, installedAt}), or null. */
export function madeByPair(dataDir) {
  try {
    return JSON.parse(readFileSync(madePath(dataDir), 'utf8'));
  } catch {
    return null;
  }
}

/** The size of LiteRT-LM's wheel for this machine, or null when it has none. */
export const wheelBytes = (platform = process.platform, arch = process.arch) => WHEELS[`${platform} ${arch}`] ?? null;

const run = (file, args, options = {}) => new Promise(resolve => execFile(file, args, {timeout: PROBE_MS, ...options}, (error, stdout, stderr) => resolve({error, stdout, stderr})));

/** The first of `pythons` that is 3.10 or later and can make a venv: `{python, version}`, or `{problem}` saying what to do. */
export async function findPython(pythons = PYTHONS) {
  let seen = null;
  for (const python of pythons) {
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
  if (/No matching distribution|from versions: none/.test(said)) return `pip found no ${RUNTIME} wheel for this machine (Linux needs glibc 2.27 or later): ${ELSE}`;
  if (/hash/i.test(said)) return `pip refused ${RUNTIME}: its SHA-256 is not the pinned one (${said})`;
  return `pip could not install ${RUNTIME}: ${said}`;
};

/**
 * `:Pair find on`'s runtime, for Meaning: `check()` says whether `python()` (meaning.python, else the venv, else
 * python3) has LiteRT-LM, `install()` makes the venv and installs it, `remove()` deletes the venv if Pair made it.
 * `lock` is the pip requirements file, every line pinned by its hashes.
 */
export class Runtime {
  constructor({dataDir, python, lock = LOCK, pythons = PYTHONS, platform = process.platform, arch = process.arch, log = () => {}}) {
    Object.assign(this, {dataDir, python, lock, pythons, log});
    this.bytes = wheelBytes(platform, arch);
    this.platform = `${platform} ${arch}`;
  }

  /** `{version}` when the Python the helper runs has LiteRT-LM, else `{problem}`. */
  check() { return runtimeOf(this.python()); }

  /**
   * Installs LiteRT-LM into the venv in Pair's data folder: made with the first Python 3.10+ (or the venv the user
   * made there, kept as theirs), then pip with the lock file. `progress(bytes, total)` hears pip's download; `signal`
   * stops it, and a venv Pair made is deleted again whenever the install fails. Resolves `{python, version, pythonVersion}`.
   */
  async install({progress = () => {}, signal = null} = {}) {
    if (!this.bytes) throw new Error(`LiteRT-LM has no wheel for ${this.platform} (it has Linux x86-64 and ARM64, and macOS on Apple silicon): set an "embedding" model instead`);
    const venv = venvPath(this.dataDir);
    const python = venvPython(this.dataDir);
    if (madeByPair(this.dataDir)) await rm(venv, {recursive: true, force: true}); // Pair's, and broken: made again
    const made = !existsSync(venv);
    let base = null;
    let pythonVersion = null;
    try {
      if (made) {
        const found = await findPython(this.pythons);
        if (found.problem) throw new Error(found.problem);
        ({python: base, version: pythonVersion} = found);
        await mkdir(meaningDir(this.dataDir), {recursive: true, mode: 0o700});
        const {error, stderr} = await run(found.python, ['-I', '-m', 'venv', venv], {timeout: 120_000, ...(signal ? {signal} : {})});
        if (signal?.aborted) throw signal.reason;
        if (error) throw new Error(`${found.python} could not make a venv in ${venv}: ${stderr.trim().split('\n').at(-1) || error.message}`);
        writeFileSync(madePath(this.dataDir), JSON.stringify({runtime: RUNTIME, python: found.python, pythonVersion, installing: true}), {mode: 0o600});
      }
      await this.pip(python, {progress, signal});
      const found = await runtimeOf(python);
      if (found.version !== RUNTIME_VERSION) throw new Error(`pip installed ${RUNTIME}, but ${found.problem ?? `${python} has ${found.version}`}`);
      if (made) writeFileSync(madePath(this.dataDir), JSON.stringify({runtime: RUNTIME, python: base, pythonVersion, installedAt: new Date().toISOString()}), {mode: 0o600});
      return {python, version: found.version, pythonVersion, made};
    } catch (error) {
      if (made) await rm(venv, {recursive: true, force: true});
      throw signal?.aborted ? signal.reason : error;
    }
  }

  /** pip in the venv: the lock file's one wheel, by its hash, and no other package; its download told as it goes. */
  async pip(python, {progress, signal}) {
    const {stdout: about} = await run(python, ['-I', '-m', 'pip', '--version']);
    const [major, minor] = (about.match(/^pip (\d+)\.(\d+)/) ?? []).slice(1).map(Number);
    const raw = major > 24 || (major === 24 && minor >= 1); // pip 24.1 has --progress-bar raw: one line a step
    const args = ['-I', '-m', 'pip', 'install', '--require-hashes', '--no-deps', '--only-binary=:all:', '--no-input', '--disable-pip-version-check', ...(raw ? ['--progress-bar', 'raw'] : []), '-r', this.lock];
    await new Promise((resolve, reject) => {
      const child = spawn(python, args, {stdio: ['ignore', 'pipe', 'pipe'], ...(signal ? {signal} : {}), timeout: INSTALL_MS, env: {...process.env, PIP_NO_INPUT: '1'}});
      let stderr = '';
      let rest = '';
      child.stdout.on('data', chunk => {
        const lines = (rest + chunk).split('\n');
        rest = lines.pop();
        for (const line of lines) {
          const step = line.match(/^Progress (\d+) of (\d+)/);
          if (step) progress(Number(step[1]), Number(step[2]));
        }
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      child.on('error', error => reject(error.name === 'AbortError' ? signal.reason : error));
      child.on('close', code => {
        if (code === 0) return resolve();
        reject(new Error(code === null ? `pip took over ${INSTALL_MS / 60_000} min to install ${RUNTIME}` : pipProblem(stderr, code)));
      });
    });
  }

  /** `:Pair find off`: the venv goes if Pair made it. Resolves true when it did. */
  async remove() {
    if (!madeByPair(this.dataDir)) return false;
    await rm(venvPath(this.dataDir), {recursive: true, force: true});
    return true;
  }
}
