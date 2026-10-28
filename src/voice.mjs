// Voice: the microphone while you hold the listen key, whisper.cpp on the CPU (or an OpenRouter transcription model)
// for the words, and an optional speech command (or an OpenRouter voice) for an answer that comes while you are away.
// With whisper.cpp and a local speech command nothing leaves the machine; with OpenRouter, the recording or the
// spoken answer does, and only while voice is on.
import {execFile, spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {unlink, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {delimiter, join} from 'node:path';
import {apiKeyOf} from './config.mjs';

export const RATE = 16_000; // whisper.cpp takes 16 kHz mono
const CHUNK_BYTES = RATE / 10 * 2; // a tenth of a second of 16-bit samples: one step of the level meter
const SILENT_DB = -50; // a recording that never gets louder than this is no speech (and whisper would make some up)
const MIN_MS = 300;
const KILL_MS = 1000; // a recorder still running this long after it was told to stop is killed
const OPENROUTER_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_TIMEOUT_MS = 30_000;
const KEY_FIELDS = ['auth', 'apiKey', 'apiKeyFile', 'apiKeyEnv'];

// Recorders that write raw 16-bit little-endian mono at 16 kHz to stdout, in the order they are tried.
const RECORDERS = [
  ['pw-record', '--raw', '--rate', String(RATE), '--channels', '1', '--format', 's16', '-'],
  ['parec', '--raw', '--format=s16le', `--rate=${RATE}`, '--channels=1'],
  ['arecord', '-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(RATE), '-c', '1'],
];

// Players that play an MP3 (or WAV) from stdin, for OpenRouter's voice, in the order they are tried.
const PLAYERS = [
  ['mpv', '--really-quiet', '--no-video', '--no-terminal', '-'],
  ['ffplay', '-nodisp', '-autoexit', '-loglevel', 'quiet', '-'],
];

const expand = path => path.replace(/^~(?=\/|$)/, homedir());
const onPath = name => (process.env.PATH ?? '').split(delimiter).some(dir => existsSync(join(dir, name)));

/**
 * The config's `voice`: null (voice is off) or `{model, whisper, threads, language, record, speak, play, maxSeconds,
 * openrouter}`. `record`, `speak` and `play` are shell commands; without `record`, the first recorder found on PATH is
 * used. `openrouter` is null, or where OpenRouter hears (`hear`, a transcription model) and speaks (`speak`, a voice):
 * see openrouterConfig.
 */
export function voiceConfig(raw) {
  if (raw === undefined || raw === null || raw === false) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config: voice must be an object (see docs/voice.md)');
  const openrouter = openrouterConfig(raw.openrouter);
  if (!openrouter?.hear && (typeof raw.model !== 'string' || !raw.model)) {
    throw new Error('config: voice.model must be the path of a whisper.cpp model, like ggml-base.en.bin, or voice.openrouter.hear an OpenRouter transcription model');
  }
  if (openrouter?.hear && raw.model !== undefined) throw new Error('config: voice takes one of model (whisper.cpp) and openrouter.hear');
  if (openrouter?.speak && raw.speak !== undefined) throw new Error('config: voice takes one of speak (a command) and openrouter.speak');
  for (const field of ['model', 'whisper', 'language', 'record', 'speak', 'play']) {
    if (raw[field] !== undefined && (typeof raw[field] !== 'string' || !raw[field].trim())) throw new Error(`config: voice.${field} must be a string`);
  }
  return {
    whisper: expand(raw.whisper ?? 'whisper-cli'),
    threads: raw.threads ?? 4,
    language: raw.language ?? 'en',
    record: raw.record ?? null,
    speak: raw.speak ?? null,
    play: raw.play ?? null,
    maxSeconds: raw.maxSeconds ?? 60,
    model: raw.model === undefined ? null : expand(raw.model),
    openrouter,
  };
}

/**
 * `voice.openrouter`: null, or `{hear, speak: {model, voice, format, speed}, baseUrl, timeoutMs}` with the key in one of
 * `auth`, `apiKey`, `apiKeyFile` and `apiKeyEnv`, as in a model entry. `hear` is a transcription model's id, like
 * openai/whisper-large-v3-turbo; `speak` a speech model and one of its voices. Either may be left out.
 */
function openrouterConfig(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config: voice.openrouter must be an object (see docs/voice.md)');
  const keys = KEY_FIELDS.filter(field => raw[field] !== undefined);
  if (keys.length > 1) throw new Error(`config: voice.openrouter takes one of ${keys.join(', ')}`);
  if (!keys.length) throw new Error('config: voice.openrouter needs its key: "apiKeyFile", "apiKeyEnv", "auth" (a key stored by `pair auth login openrouter`) or "apiKey"');
  if (typeof raw[keys[0]] !== 'string' || !raw[keys[0]]) throw new Error(`config: voice.openrouter.${keys[0]} must be a string`);
  if (raw.hear !== undefined && (typeof raw.hear !== 'string' || !raw.hear.trim())) throw new Error('config: voice.openrouter.hear must be the id of an OpenRouter transcription model, like openai/whisper-large-v3-turbo');
  let speak = null;
  if (raw.speak !== undefined) {
    const entry = raw.speak;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('config: voice.openrouter.speak must be {"model": ..., "voice": ...}');
    for (const field of ['model', 'voice']) {
      if (typeof entry[field] !== 'string' || !entry[field].trim()) throw new Error(`config: voice.openrouter.speak.${field} is missing: an OpenRouter speech model and one of its voices`);
    }
    if (entry.format !== undefined && !['mp3', 'wav'].includes(entry.format)) throw new Error('config: voice.openrouter.speak.format must be "mp3" or "wav"');
    if (entry.speed !== undefined && !(typeof entry.speed === 'number' && entry.speed > 0)) throw new Error('config: voice.openrouter.speak.speed must be a number, like 1.2');
    speak = {model: entry.model, voice: entry.voice, format: entry.format ?? 'mp3', ...(entry.speed === undefined ? {} : {speed: entry.speed})};
  }
  if (raw.hear === undefined && !speak) throw new Error('config: voice.openrouter needs "hear" (a transcription model), "speak" (a voice), or both');
  const timeoutMs = raw.timeoutMs ?? OPENROUTER_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !(timeoutMs > 0)) throw new Error('config: voice.openrouter.timeoutMs must be a number of milliseconds');
  if (raw.baseUrl !== undefined && (typeof raw.baseUrl !== 'string' || !/^https?:\/\//.test(raw.baseUrl))) throw new Error('config: voice.openrouter.baseUrl must be a URL');
  return {
    [keys[0]]: raw[keys[0]],
    hear: raw.hear ?? null,
    speak,
    baseUrl: (raw.baseUrl ?? OPENROUTER_URL).replace(/\/$/, ''),
    timeoutMs,
  };
}

/** The recorder to use: `[command, ...args]`, the configured one run by sh, or null when none is found. */
export function recorderOf(voice, found = onPath) {
  if (voice.record) return ['sh', '-c', voice.record];
  return RECORDERS.find(([name]) => found(name)) ?? null;
}

/** The player for OpenRouter's voice: the configured one run by sh, else the first one found on PATH, else null. */
export function playerOf(voice, found = onPath) {
  if (voice.play) return ['sh', '-c', voice.play];
  return PLAYERS.find(([name]) => found(name)) ?? null;
}

/** Whether answers are read aloud when you are away: a speech command or an OpenRouter voice is set. */
export const speaks = voice => Boolean(voice.speak || voice.openrouter?.speak);

/** How loud `pcm` (16-bit samples) is, in dB below full scale; -Infinity for silence. */
export function loudness(pcm) {
  const samples = Math.floor(pcm.length / 2);
  if (!samples) return -Infinity;
  let sum = 0;
  for (let i = 0; i < samples; i++) sum += pcm.readInt16LE(i * 2) ** 2;
  return 20 * Math.log10(Math.sqrt(sum / samples) / 32768);
}

/** A meter level from 0 to 1 for a loudness in dB: -60 dB and below is 0, -10 dB and above is 1. */
export const meterLevel = db => Math.max(0, Math.min(1, (db + 60) / 50));

/** `pcm` as a WAV file's bytes. */
export function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Stops `child` and whatever it started: it runs in its own process group (spawned `detached`), since a configured
 * command may be a pipeline, and all of it stops with it. A part that lingers is killed.
 */
function stopGroup(child) {
  const signal = name => { try { process.kill(-child.pid, name); } catch {} }; // gone already, or never started
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), KILL_MS).unref();
}

/**
 * One recording, from `start` until `stop()`, which resolves with its audio (16-bit PCM) or rejects when the recorder
 * could not record. `onLevel(level)` gets the meter level of each tenth of a second.
 */
export class Recording {
  constructor(recorder, {onLevel = () => {}} = {}) {
    this.chunks = [];
    this.pending = Buffer.alloc(0);
    this.error = null;
    this.peakDb = -Infinity;
    const [command, ...args] = recorder;
    this.child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    let stderr = '';
    this.child.stderr.on('data', data => { stderr = (stderr + data).slice(-500); });
    this.child.on('error', error => { this.error = error.message; });
    this.closed = new Promise(resolve => this.child.on('close', code => {
      if (code && !this.stopping && !this.bytes) this.error ??= stderr.trim().split('\n').at(-1) || `${command} exited with ${code}`;
      resolve();
    }));
    this.child.stdout.on('data', data => {
      this.chunks.push(data);
      this.pending = Buffer.concat([this.pending, data]);
      while (this.pending.length >= CHUNK_BYTES) {
        const db = loudness(this.pending.subarray(0, CHUNK_BYTES));
        this.peakDb = Math.max(this.peakDb, db);
        onLevel(meterLevel(db));
        this.pending = this.pending.subarray(CHUNK_BYTES);
      }
    });
  }

  get bytes() { return this.chunks.reduce((sum, chunk) => sum + chunk.length, 0); }

  /** How long it has recorded, in ms. */
  get ms() { return this.bytes / 2 / RATE * 1000; }

  async stop() {
    this.end();
    await this.closed;
    if (this.error && !this.bytes) throw new Error(this.error);
    return Buffer.concat(this.chunks);
  }

  /** Whether it holds anything worth transcribing: long enough, and loud enough somewhere. */
  get speech() { return this.ms >= MIN_MS && this.peakDb > SILENT_DB; }

  /** Stops the recorder; what it recorded until then stays. */
  end() {
    this.stopping = true;
    stopGroup(this.child);
  }
}

// What whisper writes for a recording without words.
const NO_WORDS = /^(\s*[[(][^\])]*[\])]\s*)*$/;

/** whisper.cpp's text, on one line, without its "[BLANK_AUDIO]" and "(silence)" tags. */
export function cleanTranscript(text) {
  const line = text.replace(/\s+/g, ' ').trim();
  return NO_WORDS.test(line) ? '' : line.replace(/\s*\[[A-Z_ ]+\]\s*/g, ' ').trim();
}

/**
 * The words in `pcm`: by OpenRouter's transcription model when `voice.openrouter.hear` names one, else by whisper.cpp
 * on the CPU. `prompt` names what the user works on, so whisper hears its words: file names and the goal. `dir` is
 * where the WAV file is kept while whisper reads it. `signal` stops a request to OpenRouter.
 */
export async function transcribe(voice, pcm, {dir, prompt = '', signal} = {}) {
  if (voice.openrouter?.hear) return transcribeOpenRouter(voice, pcm, {signal});
  const file = join(dir, `heard-${process.pid}-${Date.now()}.wav`);
  await writeFile(file, wav(pcm), {mode: 0o600});
  const args = ['-m', voice.model, '-f', file, '-l', voice.language, '-t', String(voice.threads), '--no-gpu', '-nt', '-np'];
  if (prompt) args.push('--prompt', prompt);
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(voice.whisper, args, {timeout: 60_000, maxBuffer: 1 << 20, signal}, (error, out, err) => {
        if (error) reject(new Error(error.code === 'ENOENT' ? `${voice.whisper} not found` : (err.trim().split('\n').at(-1) || error.message)));
        else resolve(out);
      });
    });
    return cleanTranscript(stdout);
  } finally {
    await unlink(file).catch(() => {});
  }
}

/** The words in `pcm`, by OpenRouter's transcription model `voice.openrouter.hear`. */
export async function transcribeOpenRouter(voice, pcm, {signal} = {}) {
  const {openrouter} = voice;
  const body = {model: openrouter.hear, language: voice.language, input_audio: {data: wav(pcm).toString('base64'), format: 'wav'}};
  const reply = await openrouterRequest(openrouter, '/audio/transcriptions', body, {signal, read: response => response.json()});
  if (typeof reply?.text !== 'string') throw new Error(`OpenRouter's ${openrouter.hear} sent no transcript`);
  return cleanTranscript(reply.text);
}

// What OpenRouter's status codes mean for the one who set the key.
const STATUS_HINTS = {
  401: 'the key is not valid',
  402: 'the account is out of credits',
  403: 'the key may not use this model',
  404: 'no such model',
  408: 'the request timed out',
  413: 'the recording is too long',
  429: 'too many requests: try again in a moment',
  502: 'the model\'s provider failed',
  503: 'no provider serves the model now',
  504: 'the model\'s provider did not answer in time',
  524: 'the model\'s provider did not answer in time',
  529: 'the model\'s provider is overloaded',
};

/** The API key of `voice.openrouter`, or an error that says what is missing. */
function openrouterKey(openrouter) {
  let key;
  try { key = apiKeyOf(openrouter); } catch (error) {
    throw new Error(`no OpenRouter key: ${error.code === 'ENOENT' ? `no file ${openrouter.apiKeyFile}` : error.message}`);
  }
  if (!key) {
    const where = openrouter.apiKeyEnv ? `$${openrouter.apiKeyEnv} is not set` : openrouter.auth ? `no API key stored as "${openrouter.auth}": run \`pair auth login ${openrouter.auth}\` and choose the API key` : `${openrouter.apiKeyFile ?? 'the key'} is empty`;
    throw new Error(`no OpenRouter key: ${where}`);
  }
  return key;
}

/**
 * POSTs `body` to OpenRouter's `path` (GETs without one) and `read`s the response, within `openrouter.timeoutMs`.
 * A timeout, an unreachable server and an error reply each throw an error that says which, in plain words; `signal`
 * stops it without one (the caller stopped it).
 */
export async function openrouterRequest(openrouter, path, body, {signal, read = response => response.json(), timeoutMs = openrouter.timeoutMs} = {}) {
  const key = openrouterKey(openrouter);
  const timeout = AbortSignal.timeout(timeoutMs);
  const headers = {authorization: `Bearer ${key}`, 'x-title': 'pairing-buddy'};
  if (body) headers['content-type'] = 'application/json';
  try {
    const response = await fetch(`${openrouter.baseUrl}${path}`, {
      method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let message = '';
      try { message = JSON.parse(text).error?.message ?? ''; } catch { message = text.trim().slice(0, 200); }
      const hint = STATUS_HINTS[response.status];
      throw Object.assign(new Error(`OpenRouter answered ${response.status}${hint ? ` (${hint})` : ''}${message ? `: ${message}` : ''}`), {status: response.status});
    }
    return await read(response);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timeout.aborted) throw new Error(`OpenRouter did not answer in ${Number((timeoutMs / 1000).toFixed(1))} s (voice.openrouter.timeoutMs)`);
    if (error.status) throw error;
    if (error instanceof TypeError) throw new Error(`OpenRouter could not be reached: ${error.cause?.code ?? error.cause?.message ?? error.message}`);
    throw error;
  }
}

/** What whisper is told the user works on: a sentence works better than a list of words. */
export function whisperPrompt({file, goal}) {
  if (!file && !goal) return '';
  const about = file ? `about ${file.split('/').at(-1)}` : '';
  return `A programmer asks their pair a question ${about}${goal ? `${about ? ', ' : ''}working on: ${goal}` : ''}.`.replace(/ +/g, ' ').replace(' .', '.');
}

const SPOKEN_CHARS = 240;

/**
 * An answer as it is read aloud: short, without Markdown, and with `file.c:42` as "file.c, line 42". The chat and
 * the editor keep the whole answer.
 */
export function speakable(text) {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(?:[\w.-]+\/)*([\w.-]+\.\w+):(\d+)(?:-\d+)?/g, '$1, line $2')
    .replace(/^\s*(?:[-*>]|#+)\s+/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  let spoken = '';
  for (const sentence of plain.split(/(?<=[.!?])\s+/)) {
    if (spoken && spoken.length + 1 + sentence.length > SPOKEN_CHARS) break;
    spoken = spoken ? `${spoken} ${sentence}` : sentence;
  }
  return spoken.slice(0, SPOKEN_CHARS);
}

/**
 * Says `text` with OpenRouter's voice when `voice.openrouter.speak` names one, else with the configured speech command
 * (text on stdin); returns a function that stops it. `failed(why)` hears of a failure, not of a stop.
 */
export function speak(voice, text, {log = () => {}, failed = () => {}} = {}) {
  if (voice.openrouter?.speak) return speakOpenRouter(voice, text, {log, failed});
  const report = why => { log(`speaking failed: ${why}`); failed(why); };
  return play(['sh', '-c', voice.speak], `${text}\n`, report);
}

/**
 * Runs `command` with `input` on its stdin, in its own process group (a pipeline stops as a whole); returns a function
 * that stops it. `report(why)` hears when it fails.
 */
function play([command, ...args], input, report) {
  const child = spawn(command, args, {stdio: ['pipe', 'ignore', 'pipe'], detached: true});
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-300); });
  child.on('error', error => report(error.code === 'ENOENT' ? `${command} not found` : error.message));
  child.on('close', code => { if (code) report(stderr.trim().split('\n').at(-1) || `${command} exited with ${code}`); });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  return () => stopGroup(child);
}

/**
 * Says `text` with OpenRouter's speech model and voice, played by the player (see playerOf); returns a function that
 * stops it, whether the audio is still on its way or playing.
 */
export function speakOpenRouter(voice, text, {log = () => {}, failed = () => {}, player = playerOf(voice)} = {}) {
  const {openrouter} = voice;
  const {model, voice: name, format, speed} = openrouter.speak;
  const report = why => { log(`speaking failed: ${why}`); failed(why); };
  const stopped = new AbortController();
  let stopPlayer = null;
  if (!player) {
    report('no player found to play OpenRouter\'s voice: install mpv or ffmpeg (ffplay), or set voice.play');
    return () => {};
  }
  const body = {model, input: text, voice: name, response_format: format, ...(speed === undefined ? {} : {speed})};
  openrouterRequest(openrouter, '/audio/speech', body, {signal: stopped.signal, read: async response => Buffer.from(await response.arrayBuffer())})
    .then(audio => {
      if (stopped.signal.aborted) return;
      if (!audio.length) return report(`OpenRouter's ${model} sent no audio`);
      stopPlayer = play(player, audio, report);
    })
    .catch(error => { if (!stopped.signal.aborted) report(error.message); });
  return () => {
    stopped.abort();
    stopPlayer?.();
  };
}
