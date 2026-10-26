// Voice: the microphone while you hold the listen key, whisper.cpp on the CPU for the words, and an optional
// speech command for an answer that comes while you are away. Nothing leaves the machine.
import {execFile, spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {unlink, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {delimiter, join} from 'node:path';

export const RATE = 16_000; // whisper.cpp takes 16 kHz mono
const CHUNK_BYTES = RATE / 10 * 2; // a tenth of a second of 16-bit samples: one step of the level meter
const SILENT_DB = -50; // a recording that never gets louder than this is no speech (and whisper would make some up)
const MIN_MS = 300;
const KILL_MS = 1000; // a recorder still running this long after it was told to stop is killed

// Recorders that write raw 16-bit little-endian mono at 16 kHz to stdout, in the order they are tried.
const RECORDERS = [
  ['pw-record', '--raw', '--rate', String(RATE), '--channels', '1', '--format', 's16', '-'],
  ['parec', '--raw', '--format=s16le', `--rate=${RATE}`, '--channels=1'],
  ['arecord', '-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(RATE), '-c', '1'],
];

const expand = path => path.replace(/^~(?=\/|$)/, homedir());
const onPath = name => (process.env.PATH ?? '').split(delimiter).some(dir => existsSync(join(dir, name)));

/**
 * The config's `voice`: null (voice is off) or `{model, whisper, threads, language, record, speak, maxSeconds}`.
 * `record` and `speak` are shell commands; without `record`, the first recorder found on PATH is used.
 */
export function voiceConfig(raw) {
  if (raw === undefined || raw === null || raw === false) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config: voice must be an object (see docs/voice.md)');
  if (typeof raw.model !== 'string' || !raw.model) throw new Error('config: voice.model must be the path of a whisper.cpp model, like ggml-base.en.bin');
  for (const field of ['whisper', 'language', 'record', 'speak']) {
    if (raw[field] !== undefined && (typeof raw[field] !== 'string' || !raw[field].trim())) throw new Error(`config: voice.${field} must be a string`);
  }
  return {
    whisper: expand(raw.whisper ?? 'whisper-cli'),
    threads: raw.threads ?? 4,
    language: raw.language ?? 'en',
    record: raw.record ?? null,
    speak: raw.speak ?? null,
    maxSeconds: raw.maxSeconds ?? 60,
    model: expand(raw.model),
  };
}

/** The recorder to use: `[command, ...args]`, the configured one run by sh, or null when none is found. */
export function recorderOf(voice, found = onPath) {
  if (voice.record) return ['sh', '-c', voice.record];
  return RECORDERS.find(([name]) => found(name)) ?? null;
}

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
 * The words in `pcm`, by whisper.cpp on the CPU. `prompt` names what the user works on, so whisper hears its
 * words: file names and the goal. `dir` is where the WAV file is kept while whisper reads it.
 */
export async function transcribe(voice, pcm, {dir, prompt = ''}) {
  const file = join(dir, `heard-${process.pid}-${Date.now()}.wav`);
  await writeFile(file, wav(pcm), {mode: 0o600});
  const args = ['-m', voice.model, '-f', file, '-l', voice.language, '-t', String(voice.threads), '--no-gpu', '-nt', '-np'];
  if (prompt) args.push('--prompt', prompt);
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(voice.whisper, args, {timeout: 60_000, maxBuffer: 1 << 20}, (error, out, err) => {
        if (error) reject(new Error(error.code === 'ENOENT' ? `${voice.whisper} not found` : (err.trim().split('\n').at(-1) || error.message)));
        else resolve(out);
      });
    });
    return cleanTranscript(stdout);
  } finally {
    await unlink(file).catch(() => {});
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

/** Says `text` with the configured speech command (text on stdin); returns a function that stops it. */
export function speak(voice, text, {log = () => {}} = {}) {
  const child = spawn('sh', ['-c', voice.speak], {stdio: ['pipe', 'ignore', 'pipe'], detached: true}); // a pipeline stops as a whole
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-300); });
  child.on('error', error => log(`speaking failed: ${error.message}`));
  child.on('close', code => { if (code) log(`speaking failed: ${stderr.trim() || `exit ${code}`}`); });
  child.stdin.on('error', () => {});
  child.stdin.end(`${text}\n`);
  return () => stopGroup(child);
}
