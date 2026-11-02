// Voice's local model: LFM3-Omni-2B on LiteRT, the model and runtime lfm-pixel uses for dictation, read-aloud and Talk
// (LFMP-8). It hears push-to-talk and reads answers aloud, offline, on the CPU. Its files (4.0 GB) come once, when the
// user says so (`:Pair voice on`), at a pinned revision, each kept only if its SHA-256 matches, and so do its Python
// packages, by their hashes, into search by meaning's venv (runtime.mjs); nothing else reaches the network. A Python
// helper (src/omni-helper.py) runs it in that venv, started on first use and stopped once idle, which gives its memory
// back.
import {execFile, spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {mkdir, mkdtemp, rm, statfs} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {downloadFile, downloadModel, fileReady, meaningDir, pythonOf, RUNTIME} from './embedder.mjs';
import {venvPython} from './runtime.mjs';
import {readMessages} from './protocol.mjs';

const REPO = 'litert-community/LFM3-Omni-2B-LiteRT';
const REVISION = 'a287b6e6e2535de6a4b48b50e5a5a5b9b82632cc';

// The files hearing and speech need, of that revision: the model, its tokenizer, the speech graphs (without the
// depth_frame2 and one-frame codec variants the runner can do without) and the runner that drives them.
const FILES = [
  ['LFM3-Omni-2B_int8.litertlm', 3_226_750_192, '959617973a7ddcb3d887fa0d9891d79556a266490d5c432b02a18ffcac3124ed'],
  ['tokenizer.json', 17_908_634, '41927bd314d17d7d7fadb44e10cd0919f7b71528d7741596d8cbd15c6945ec44'],
  ['speech/LFM3-Omni-2B_depth_step_f32.tflite', 434_852_308, '9e61c47319d8907a60aebeac9605b9b4df3ea3aadb232b708897263d4ef07a21'],
  ['speech/LFM3-Omni-2B_frame_embed_f32.tflite', 198_281_972, '71b68529124ef770a495554ea6928f42a66c8c0f2756df2452b15b22bdbc707d'],
  ['speech/LFM3-Omni-2B_codec_decoder_f12_f32.tflite', 152_370_912, '7134523fb54c2fd9b31697373b37e1a5bd1669c3a432ab7896a8a7d070f38ed3'],
  ['speech/codec_window_f32.npy', 5_248, 'e83a39f565c8edd9d516989d4998631bac2d257734ea11166a407959440591b6'],
  ['runner/bundle_sections.json', 2_919, '93832d50f1fa84c5c9acd79496a0b3080062c139271021a0958685af29df7d5b'],
  ['runner/contract.json', 8_362, '6ea3753fae712eb6426f5d81b0605cc25a2ea360b9dfb5d3cd4c6260257e3746'],
  ['runner/lm_graph.py', 12_045, 'bd1b72e555dc5931211e6a89a6e2103ded1d82c26fc1add6f6e325affd71c94f'],
  ['runner/prompt.py', 2_967, '9955fb59c468d625d925d894776f288255728ab0d324c5e4a2a843ed4f074df8'],
  ['runner/speech.py', 18_072, 'd069f5e372d6237ef9725dc4e703a9c4c1937bb441504ed785b421693bcd760f'],
].map(([file, bytes, sha256]) => ({repo: REPO, revision: REVISION, file, bytes, sha256}));

export const OMNI = {
  name: 'LFM3-Omni-2B (int8)',
  repo: REPO,
  revision: REVISION,
  files: FILES,
  bytes: FILES.reduce((sum, file) => sum + file.bytes, 0),
};
// What the helper imports, next to search by meaning's litert-lm-api: LiteRT for the speech graphs (with ml-dtypes,
// the one dependency it imports), and the runner's numpy and tokenizers. voice-runtime.txt pins each wheel's SHA-256.
export const OMNI_PACKAGES = [RUNTIME, 'ai-edge-litert==2.3.0', 'numpy==2.5.4', 'ml-dtypes==0.6.0', 'tokenizers==0.23.3'];
export const VOICE_LOCK = fileURLToPath(new URL('./voice-runtime.txt', import.meta.url));
const VOICE_WHEELS = JSON.parse(readFileSync(new URL('./voice-wheels.json', import.meta.url), 'utf8')); // {"linux x64 314": [{url, bytes, sha256}]}
export const CACHE_BYTES = 4_200_000_000; // XNNPACK's packed weights, written on the first use of hearing and speech
export const gb = bytes => `${(bytes / 1e9).toFixed(1)} GB`;

const HELPER = fileURLToPath(new URL('./omni-helper.py', import.meta.url));
export const THREADS = 4;
const IDLE_MS = 3 * 60_000; // the helper holds 0.8 to 3.6 GB of its own; it goes once voice was not used for this long
const START_MS = 30_000;
const HEAR_MS = 90_000; // a first hearing also packs the weights (about 10 s); past this the helper is stuck
const PART_MS = 180_000; // one sentence of speech, the first also packing the speech graphs' weights

/** Where voice keeps LFM3-Omni's files, as in its repository, and (in cache/) XNNPACK's packed weights. */
export const omniDir = dataDir => join(dataDir, 'voice', 'lfm3-omni');
export const cacheDir = dataDir => join(omniDir(dataDir), `cache-${REVISION.slice(0, 8)}`);

/** Whether every file is in `dataDir` as downloaded and checked (see embedder.mjs's fileReady). */
export const omniReady = dataDir => FILES.every(file => fileReady(join(omniDir(dataDir), file.file), file));

/** The bytes still to download. */
export const omniMissing = dataDir => FILES.filter(file => !fileReady(join(omniDir(dataDir), file.file), file)).reduce((sum, file) => sum + file.bytes, 0);

/**
 * Downloads the files not yet here, one after the other, each from the pinned revision and kept only if its SHA-256
 * matches (embedder.mjs's downloadModel). `progress(bytes, total)` hears how far it got; `signal` stops it. Refuses
 * to start when the disk lacks room for the files and the packed weights. `files` are for tests.
 */
export async function downloadOmni(dataDir, {fetch = globalThis.fetch, progress = () => {}, signal = null, free = freeBytes, files = FILES} = {}) {
  const todo = files.filter(file => !fileReady(join(omniDir(dataDir), file.file), file));
  const total = todo.reduce((sum, file) => sum + file.bytes, 0);
  const room = await free(dataDir);
  if (room !== null && room < total + CACHE_BYTES) {
    throw new Error(`${gb(room)} free in ${dataDir}, and LFM3-Omni needs ${gb(total + CACHE_BYTES)} (${gb(total)} of files, ${gb(CACHE_BYTES)} of packed weights)`);
  }
  let done = 0;
  for (const file of todo) {
    await downloadModel(dataDir, {fetch, signal, model: file, path: join(omniDir(dataDir), file.file), progress: bytes => progress(done + bytes, total)});
    done += file.bytes;
  }
  return total;
}

async function freeBytes(dataDir) {
  try {
    const stat = await statfs(dataDir);
    return stat.bavail * stat.bsize;
  } catch {
    return null;
  }
}

/** Takes LFM3-Omni's files and packed weights out of `dataDir`. */
export async function removeOmni(dataDir) {
  await rm(omniDir(dataDir), {recursive: true, force: true});
}

// What the model is told to hear, by the config's language code: "Perform ASR in English."
const LANGUAGES = {
  en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish',
  ru: 'Russian', uk: 'Ukrainian', ar: 'Arabic', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', hi: 'Hindi', tr: 'Turkish',
};
// LFM3-Omni needs the language named: told only "Perform ASR.", it heard German as English words. `auto` is English.
export const languageName = code => (code === 'auto' ? 'English' : LANGUAGES[code] ?? code);

/**
 * The helper, started when voice first needs it. One request at a time, in order. `hear(pcm, {language, signal})`
 * resolves with the words; `speak(texts, {voice, onPart})` makes speech of each text in turn, giving each part's WAV to
 * `onPart(wav)` as it is ready, and returns `{done, stop}`: `stop()` drops it at its next frame.
 */
export class OmniVoice {
  /** `python` is a path, or a function that finds one each time the helper starts. */
  constructor({python, dataDir, threads = THREADS, idleMs = IDLE_MS, log = () => {}, helper = HELPER}) {
    Object.assign(this, {python, dataDir, threads, idleMs, log, helper});
    this.child = null;
    this.runtime = null; // what the helper said when it was ready
    this.queue = [];
    this.running = null;
    this.nextId = 0;
    this.idleTimer = null;
    this.heard = {ms: 0, audioMs: 0}; // for `pair doctor`: how long hearing took, against how much speech
    this.spoke = {ms: 0, audioMs: 0};
  }

  hear(pcm, {language = 'en', signal = null} = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const job = {
        message: {op: 'hear', pcm: pcm.toString('base64'), language: languageName(language)},
        timeoutMs: HEAR_MS,
        resolve, reject,
        answer: message => {
          this.heard.ms += message.ms;
          this.heard.audioMs += pcm.length / 2 / 16;
          job.resolve(message.text);
          return true;
        },
      };
      const abort = () => this.drop(job, signal.reason);
      signal?.addEventListener('abort', abort, {once: true});
      const settle = done => value => { signal?.removeEventListener('abort', abort); done(value); };
      Object.assign(job, {resolve: settle(resolve), reject: settle(reject)});
      this.add(job);
    });
  }

  speak(texts, {voice = 'female', language = 'en', onPart = () => {}} = {}) {
    let job;
    const done = new Promise((resolve, reject) => {
      job = {
        message: {op: 'speak', texts, voice, language: languageName(language)},
        timeoutMs: PART_MS,
        resolve, reject,
        answer: message => {
          if (message.wav) {
            this.spoke.ms += message.ms;
            this.spoke.audioMs += message.seconds * 1000;
            if (!job.stopped) onPart(Buffer.from(message.wav, 'base64'));
            return false; // more to come
          }
          resolve({cancelled: Boolean(message.cancelled)});
          return true;
        },
      };
      this.add(job);
    });
    return {done, stop: () => this.drop(job, null)};
  }

  add(job) {
    this.queue.push(job);
    this.next();
  }

  /** Drops `job`: still waiting, it is never sent; under way, the helper is told to stop it (speech, at its next frame). */
  drop(job, reason) {
    if (job.stopped) return;
    job.stopped = true;
    if (this.queue.includes(job)) {
      this.queue = this.queue.filter(each => each !== job);
      this.idle(); // nothing else waiting: the helper goes in time, started or not
      return reason ? job.reject(reason) : job.resolve({cancelled: true});
    }
    if (this.running === job && this.child) this.child.stdin.write(`${JSON.stringify({id: job.id, op: 'cancel'})}\n`);
    if (reason) job.reject(reason); // hearing: the caller goes on; the helper's answer is dropped when it comes
  }

  next() {
    if (this.running || !this.queue.length) return;
    clearTimeout(this.idleTimer);
    if (!this.child) return this.start();
    if (!this.runtime) return; // still starting: ready sends the first request
    const job = this.queue.shift();
    job.id = ++this.nextId;
    this.running = job;
    this.arm(job);
    this.child.stdin.write(`${JSON.stringify({id: job.id, ...job.message})}\n`);
  }

  /** A request (or a part of speech) that takes longer than its time means the helper is stuck. */
  arm(job) {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => this.fail(new Error(`LFM3-Omni took over ${job.timeoutMs / 1000} s`)), job.timeoutMs);
  }

  start() {
    const python = typeof this.python === 'function' ? this.python() : this.python;
    const child = spawn(python, ['-I', this.helper, omniDir(this.dataDir), String(this.threads), cacheDir(this.dataDir)], {stdio: ['pipe', 'pipe', 'pipe']});
    this.child = child;
    let stderr = '';
    const startTimer = setTimeout(() => this.fail(new Error('the voice helper did not start within 30 s')), START_MS);
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.stdin.on('error', () => {});
    child.on('error', error => {
      clearTimeout(startTimer);
      this.fail(new Error(error.code === 'ENOENT' ? `${python} is not there` : error.message));
    });
    child.on('exit', code => {
      clearTimeout(startTimer);
      if (this.child !== child) return;
      const why = stderr.trim().split('\n').filter(line => !/^(INFO|WARNING|└)/.test(line)).at(-1);
      this.fail(new Error(`the voice helper stopped (exit ${code})${why ? `: ${why}` : ''}`));
    });
    readMessages(child.stdout, message => {
      if (this.child !== child) return;
      if (message.fatal) {
        clearTimeout(startTimer);
        const missing = message.fatal.match(/No module named '([\w.]+)'|PackageNotFoundError: (?:No package metadata was found for )?([\w-]+)/);
        return this.fail(new Error(missing ? `${python} has no ${missing[1] ?? missing[2]}` : message.fatal));
      }
      if (message.ready) {
        clearTimeout(startTimer);
        this.runtime = {runtime: message.runtime, litert: message.litert};
        this.log(`voice helper ready: LiteRT-LM ${message.runtime}, LiteRT ${message.litert}`);
        this.next();
        return this.idle(); // what it was started for may have been dropped meanwhile
      }
      const job = this.running;
      if (!job || message.id !== job.id) return;
      if (message.error) {
        this.finish(job);
        job.reject(new Error(message.error)); // a promise settled already (a dropped hearing) stays as it was
        return this.next();
      }
      this.arm(job);
      if (job.answer(message)) {
        this.finish(job);
        this.next();
      }
    });
  }

  finish(job) {
    clearTimeout(job.timer);
    this.running = null;
    this.idle();
  }

  /** Once nothing waits, the helper goes after `idleMs`: its memory is back until the next recording. */
  idle() {
    clearTimeout(this.idleTimer);
    if (this.running || this.queue.length) return;
    this.idleTimer = setTimeout(() => this.stopHelper(), this.idleMs);
    this.idleTimer.unref?.();
  }

  /** The helper went or could not start: every request waiting hears why, and the next one starts it again. */
  fail(error) {
    const jobs = [...(this.running ? [this.running] : []), ...this.queue];
    if (this.running) clearTimeout(this.running.timer);
    this.running = null;
    this.queue = [];
    this.stopHelper();
    this.log(`voice helper: ${error.message}`);
    for (const job of jobs) job.reject(error);
  }

  stopHelper() {
    clearTimeout(this.idleTimer);
    const {child} = this;
    this.child = null;
    this.runtime = null;
    if (child && child.exitCode === null) {
      child.stdin.end();
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000).unref();
    }
  }

  /** Seconds of work per second of speech heard and spoken, or null before the first. */
  get rates() {
    const rate = ({ms, audioMs}) => (audioMs ? ms / audioMs : null);
    return {hear: rate(this.heard), speak: rate(this.spoke)};
  }

  close() {
    this.fail(new Error('the daemon stops'));
  }
}

/**
 * Whether `python` has the helper's packages at their pinned versions: {version} (LiteRT-LM's) or {problem}, "… has
 * no ai-edge-litert" or "… has numpy 2.1.0, not 2.5.4".
 */
export function omniRuntimeOf(python) {
  const pins = Object.fromEntries(OMNI_PACKAGES.map(spec => spec.split('==')));
  const probe = `import importlib.metadata as m\nfor p, v in ${JSON.stringify(Object.entries(pins))}:\n    try: have = m.version(p)\n    except m.PackageNotFoundError: print("missing", p); raise SystemExit(3)\n    if have != v: print("version", p, have, v); raise SystemExit(3)\nprint(m.version("litert-lm-api"))`;
  return new Promise(resolve => execFile(python, ['-I', '-c', probe], {timeout: 20_000}, (error, stdout, stderr) => {
    if (!error) return resolve({version: stdout.trim()});
    if (error.code === 'ENOENT') return resolve({problem: `${python} is not there`});
    const missing = stdout.match(/missing (\S+)/);
    const other = stdout.match(/version (\S+) (\S+) (\S+)/);
    resolve({problem: missing ? `${python} has no ${missing[1]}` : other ? `${python} has ${other[1]} ${other[2]}, not ${other[3]}` : (stderr.trim().split('\n').at(-1) || error.message)});
  }));
}

/** The wheels voice's packages need for `pythonVersion` ("3.14") on this machine, or null when PyPI has none. */
export const voiceWheelsOf = (pythonVersion, platform = process.platform, arch = process.arch) => VOICE_WHEELS[`${platform} ${arch} ${pythonVersion.replace('.', '')}`] ?? null;

const run = (file, args, options = {}) => new Promise(resolve => execFile(file, args, {timeout: 20_000, ...options}, (error, stdout, stderr) => resolve({error, stdout, stderr})));

/** What to run when Pair may not install voice's packages itself: into the config's meaning.python, by their hashes. */
export const omniInstall = python => `${python} -m pip install --require-hashes --no-deps --only-binary=:all: -r ${VOICE_LOCK} (or leave meaning.python out, and :Pair voice on installs them)`;

/**
 * `:Pair voice on`'s packages, in search by meaning's venv (runtime.mjs, PAIR-8), the one Python both helpers run:
 * LiteRT-LM first if the venv lacks it (`runtime.install()`, which makes the venv), then voice's four wheels for that
 * Python and machine, each downloaded from PyPI by the SHA-256 in voice-runtime.txt, and pip with no index, every hash
 * required, no other package. With the config's meaning.python, Pair installs nothing there: it says what to run.
 * `progress(bytes, total)` hears the downloads; `signal` stops it. Resolves {python, version, bytes, wheels} or null
 * when everything was there. `check` and `wheelsOf` are for tests.
 */
export async function installVoiceRuntime({dataDir, meaning = null, runtime, fetch = globalThis.fetch, progress = () => {}, signal = null, platform = process.platform, arch = process.arch, check = omniRuntimeOf, wheelsOf = voiceWheelsOf}) {
  const python = pythonOf(meaning, dataDir);
  if ((await check(python)).version) return null;
  if (meaning?.python) throw new Error(`${python} lacks voice's packages, and Pair installs nothing into meaning.python: ${omniInstall(python)}`);
  if (!(await runtime.check()).version) await runtime.install({signal, progress: (bytes, total) => progress(bytes, total)});
  const venv = venvPython(dataDir);
  const {stdout, error} = await run(venv, ['-I', '-c', 'import sys; print("%d.%d" % sys.version_info[:2])']);
  if (error) throw new Error(`${venv} does not run: ${error.message}`);
  const version = stdout.trim();
  const wheels = wheelsOf(version, platform, arch);
  if (!wheels) throw new Error(`voice's packages have wheels for Python 3.12 to 3.14 on Linux (x86-64, ARM64) and macOS on Apple silicon; the venv runs Python ${version} on ${platform} ${arch}: make it with a newer Python, or set "meaning": {"python": …}`);
  const total = wheels.reduce((sum, wheel) => sum + wheel.bytes, 0);
  await mkdir(meaningDir(dataDir), {recursive: true, mode: 0o700});
  const dir = await mkdtemp(join(meaningDir(dataDir), 'wheel-voice-'));
  try {
    let done = 0;
    for (const wheel of wheels) {
      await downloadFile(wheel.url, join(dir, wheel.url.split('/').at(-1)), {sha256: wheel.sha256, what: wheel.url.split('/').at(-1), fetch, signal, progress: bytes => progress(done + bytes, total)});
      done += wheel.bytes;
    }
    const args = ['-I', '-m', 'pip', 'install', '--no-index', '--find-links', dir, '--require-hashes', '--no-deps', '--only-binary=:all:', '--no-input', '--disable-pip-version-check', '-r', VOICE_LOCK];
    const pip = await run(venv, args, {timeout: 5 * 60_000, env: {...process.env, PIP_NO_INPUT: '1'}, ...(signal ? {signal} : {})});
    if (signal?.aborted) throw signal.reason;
    if (pip.error) {
      const said = pip.stderr.split('\n').map(line => line.trim()).filter(Boolean);
      throw new Error(`pip could not install voice's packages: ${(said.findLast(line => line.startsWith('ERROR:')) ?? said.at(-1) ?? pip.error.message).replace(/^ERROR:\s*/, '')}`);
    }
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
  const found = await check(venv);
  if (!found.version) throw new Error(`pip installed voice's packages, but ${found.problem}`);
  return {python: venv, version, bytes: total, wheels: wheels.map(wheel => wheel.url.split('/').at(-1))};
}
