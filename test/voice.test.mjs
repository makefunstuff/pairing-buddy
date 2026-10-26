// Push-to-talk without a microphone: a recorder that plays a tone, and whisper replaced by a script or a function.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {connect} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';
import {createModels, fauxProvider} from '@earendil-works/pi-ai';
import {parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {sendMessage} from '../src/protocol.mjs';
import {initialState} from '../src/fold.mjs';
import {voiceCheck} from '../src/doctor.mjs';
import {Listener} from '../src/listen.mjs';
import {cleanTranscript, loudness, meterLevel, RATE, recorderOf, Recording, speak, speakable, transcribe, voiceConfig, wav, whisperPrompt} from '../src/voice.mjs';

// Every scratch directory a test makes goes when the tests end.
const dirs = [];
const scratch = prefix => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
after(() => { for (const dir of dirs) rmSync(dir, {recursive: true, force: true}); });
/** Whether a process whose command line has `marker` runs. */
const running = marker => { try { execFileSync('pgrep', ['-f', marker]); return true; } catch { return false; } };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A shell command that writes `seconds` of a 440 Hz tone (or silence) as raw 16 kHz PCM, paced in real time. */
const toneCommand = (seconds, {amplitude = 8000} = {}) => `node -e '
  const chunk = ${RATE / 10}; let n = 0;
  const timer = setInterval(() => {
    const out = Buffer.alloc(chunk * 2);
    for (let i = 0; i < chunk; i++) out.writeInt16LE(Math.round(${amplitude} * Math.sin(2 * Math.PI * 440 * (n * chunk + i) / ${RATE})), i * 2);
    process.stdout.write(out);
    if (++n >= ${seconds * 10}) clearInterval(timer);
  }, 100);'`;

test('voice config: off without one; a model is needed; paths expand and defaults fill in', () => {
  assert.equal(voiceConfig(undefined), null);
  assert.throws(() => voiceConfig({}), /voice\.model/);
  assert.throws(() => voiceConfig({model: 'm.bin', speak: 3}), /voice\.speak must be a string/);
  const voice = voiceConfig({model: '~/models/ggml-base.en.bin'});
  assert.match(voice.model, /^\/.*\/models\/ggml-base\.en\.bin$/);
  assert.deepEqual({...voice, model: undefined}, {whisper: 'whisper-cli', threads: 4, language: 'en', record: null, speak: null, maxSeconds: 60, model: undefined});
});

test('the recorder: the configured command, else the first one on PATH, else none', () => {
  assert.deepEqual(recorderOf({record: 'cat x.raw'}), ['sh', '-c', 'cat x.raw']);
  assert.equal(recorderOf({record: null}, name => name === 'arecord')[0], 'arecord');
  assert.equal(recorderOf({record: null}, name => name !== 'arecord')[0], 'pw-record');
  assert.equal(recorderOf({record: null}, () => false), null);
});

test('loudness, the meter and the WAV header', () => {
  const silence = Buffer.alloc(3200);
  assert.equal(loudness(silence), -Infinity);
  assert.equal(meterLevel(-Infinity), 0);
  const loud = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i++) loud.writeInt16LE(i % 2 ? 16000 : -16000, i * 2);
  assert.ok(Math.abs(loudness(loud) - -6.2) < 0.1);
  assert.equal(meterLevel(-6), 1);
  assert.equal(meterLevel(-35), 0.5);
  const file = wav(loud);
  assert.equal(file.length, 44 + 3200);
  assert.equal(file.toString('ascii', 0, 4), 'RIFF');
  assert.equal(file.readUInt32LE(24), 16000);
  assert.equal(file.readUInt32LE(40), 3200);
});

test('whisper\'s text: one line, without its tags; a recording without words is empty', () => {
  assert.equal(cleanTranscript(' Why does attempt 5\n give up?\n'), 'Why does attempt 5 give up?');
  assert.equal(cleanTranscript(' [BLANK_AUDIO]\n'), '');
  assert.equal(cleanTranscript(' (silence) '), '');
  assert.equal(cleanTranscript('[MUSIC] run the tests'), 'run the tests');
});

test('whisper is told the file and the goal, in a sentence', () => {
  assert.equal(whisperPrompt({file: 'src/retry.c', goal: 'retry with backoff'}), 'A programmer asks their pair a question about retry.c, working on: retry with backoff.');
  assert.equal(whisperPrompt({file: 'retry.c', goal: null}), 'A programmer asks their pair a question about retry.c.');
  assert.equal(whisperPrompt({file: null, goal: null}), '');
});

test('read aloud: short, plain, and file:line said as a line', () => {
  assert.equal(speakable('Attempt 5 lands at exactly 15, and `src/retry.c:42` gives up on `>=`. Use `>`. Then **run** the tests again, all of them.'),
    'Attempt 5 lands at exactly 15, and retry.c, line 42 gives up on >=. Use >. Then run the tests again, all of them.');
  const long = Array.from({length: 10}, (_, i) => `Sentence number ${i} says a fair amount of words.`).join(' ');
  assert.ok(speakable(long).length <= 240);
  assert.match(speakable(long), /\.$/, 'whole sentences');
  assert.equal(speakable('```c\nint x;\n```\nDone.'), 'Done.');
});

test('a recording: levels each tenth of a second, its audio, and whether it holds speech', async () => {
  const levels = [];
  const recording = new Recording(['sh', '-c', toneCommand(1)], {onLevel: level => levels.push(level)});
  await sleep(600);
  const pcm = await recording.stop();
  assert.ok(levels.length >= 4, `levels: ${levels.length}`);
  assert.ok(levels.every(level => level > 0.6), 'a loud tone');
  assert.ok(pcm.length >= 4 * RATE / 10 * 2);
  assert.ok(recording.speech);

  const quiet = new Recording(['sh', '-c', toneCommand(1, {amplitude: 0})]);
  await sleep(500);
  await quiet.stop();
  assert.equal(quiet.speech, false, 'silence is no speech');

  const broken = new Recording(['sh', '-c', 'echo "no such device" >&2; exit 1']);
  await sleep(100);
  await assert.rejects(broken.stop(), /no such device/);
  await assert.rejects(new Recording(['no-such-recorder']).stop(), /ENOENT/);

  // A pipeline stops as a whole: the stop does not wait for its last part.
  const pipeline = new Recording(['sh', '-c', `${toneCommand(30)} | cat`]);
  await sleep(300);
  const started = Date.now();
  await pipeline.stop();
  assert.ok(Date.now() - started < 500, 'stopped at once');
});

test('a recorder that fails says so while the key is still held', async () => {
  const {listening, sent, send} = listener();
  listening.recorder = ['sh', '-c', 'echo "Connection refused" >&2; exit 1'];
  listening.start(send);
  await sleep(200);
  assert.deepEqual(sent.at(-1), {type: 'heard', error: 'Connection refused'});
  await listening.stop(); // the key let go later: nothing more
  assert.equal(sent.filter(message => message.type === 'heard').length, 1);
});

test('transcribe runs whisper.cpp on the CPU with the prompt, from a WAV file it then removes', async () => {
  const dir = scratch('pair-voice-');
  const whisper = join(dir, 'whisper-cli');
  writeFileSync(whisper, `#!/bin/sh\nprintf '%s\\n' "$@" > ${dir}/args\nprintf ' Why does attempt 5\\n give up?\\n'\n`);
  chmodSync(whisper, 0o755);
  const text = await transcribe({whisper, model: 'm.bin', language: 'en', threads: 2}, Buffer.alloc(3200), {dir, prompt: 'About retry.c.'});
  assert.equal(text, 'Why does attempt 5 give up?');
  const args = readFileSync(join(dir, 'args'), 'utf8').split('\n');
  for (const flag of ['--no-gpu', '-nt', '-np']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('-m') + 1], 'm.bin');
  assert.equal(args[args.indexOf('--prompt') + 1], 'About retry.c.');
  assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.wav')), [], 'the WAV file is gone');
  await assert.rejects(transcribe({whisper: join(dir, 'none'), model: 'm', language: 'en', threads: 1}, Buffer.alloc(2), {dir}), /not found/);
});

/** A Listener on a session state, a tone for a microphone and `heard` for whisper; `sent` collects its messages. */
function listener({heard = 'why does it give up?', speakCommand = null, seconds = 2, answer = 'Attempt 5 gives up at `retry.c:42`.'} = {}) {
  const session = {state: {...initialState({goal: 'retries'}), file: 'retry.c'}};
  const sent = [];
  const asked = [];
  const spoken = [];
  const prompts = [];
  const listening = new Listener({
    voice: voiceConfig({model: 'm.bin', record: toneCommand(seconds), speak: speakCommand ?? undefined}),
    session,
    dir: scratch('pair-listen-'),
    ask: async (text, selection) => { asked.push([text, selection]); return answer; },
    transcribeWith: async (voice, pcm, {prompt}) => { prompts.push(prompt); return heard; },
    speakWith: (voice, text) => { spoken.push(text); return () => spoken.push('(stopped)'); },
  });
  return {listening, session, sent, asked, spoken, prompts, send: message => sent.push(message)};
}

test('hold, speak, let go: the meter moves, the words come back, Pair is asked, and the answer goes to the editor', async () => {
  const {listening, sent, asked, spoken, prompts, send} = listener();
  listening.start(send, {file: '/p/retry.c', from: 3, to: 4});
  await sleep(500);
  await listening.stop();
  const levels = sent.filter(message => message.type === 'listening');
  assert.ok(levels.length >= 3 && levels.slice(1).every(message => message.level > 0.5), 'the meter');
  assert.deepEqual(sent.filter(message => message.type !== 'listening'), [
    {type: 'heard', state: 'hearing'},
    {type: 'heard', text: 'why does it give up?'},
    {type: 'answer', text: 'Attempt 5 gives up at `retry.c:42`.', pointed: false},
  ]);
  assert.deepEqual(asked, [['why does it give up?', {file: '/p/retry.c', from: 3, to: 4}]], 'asked about the selection');
  assert.deepEqual(prompts, ['A programmer asks their pair a question about retry.c, working on: retries.']);
  assert.deepEqual(spoken, [], 'at the editor: nothing is read aloud');
});

test('away from the editor, the answer is read aloud, short; coming back stops it', async () => {
  const {listening, spoken, send} = listener({speakCommand: 'cat >/dev/null'});
  listening.start(send);
  await sleep(400);
  listening.focus(false); // you look at the browser while Pair thinks
  await listening.stop();
  assert.deepEqual(spoken, ['Attempt 5 gives up at retry.c, line 42.']);
  listening.focus(true);
  assert.deepEqual(spoken.at(-1), '(stopped)');
});

test('herdr showing another workspace counts as away; without a speech command nothing is said', async () => {
  const away = listener({speakCommand: 'cat >/dev/null'});
  away.session.state.focus = {target: 'elsewhere'};
  away.listening.start(away.send);
  await sleep(400);
  await away.listening.stop();
  assert.equal(away.spoken.length, 1);

  const mute = listener();
  mute.listening.focus(false);
  mute.listening.start(mute.send);
  await sleep(400);
  await mute.listening.stop();
  assert.deepEqual(mute.spoken, []);
});

test('nothing said, nothing heard, or a cancel: Pair is not asked', async () => {
  const silent = listener({heard: ''});
  silent.listening.start(silent.send);
  await sleep(400);
  await silent.listening.stop();
  assert.deepEqual(silent.sent.at(-1), {type: 'heard', text: ''});
  assert.deepEqual(silent.asked, []);

  const tooShort = listener();
  tooShort.listening.start(tooShort.send);
  await tooShort.listening.stop(); // a key bounce: no speech in that time
  assert.deepEqual(tooShort.sent.filter(message => message.type === 'heard'), [{type: 'heard', text: ''}]);

  const cancelled = listener();
  cancelled.listening.start(cancelled.send);
  await sleep(300);
  cancelled.listening.cancel();
  await cancelled.listening.stop();
  assert.deepEqual(cancelled.sent.filter(message => message.type !== 'listening'), []);
  assert.deepEqual(cancelled.asked, []);
});

test('a recording stops by itself after maxSeconds; no recorder says what to install', async () => {
  const {listening, sent, send} = listener();
  listening.voice = {...listening.voice, maxSeconds: 0.5};
  listening.start(send);
  await sleep(1200);
  assert.ok(sent.some(message => message.type === 'answer'), 'stopped, heard and asked without a stop');

  const none = listener();
  none.listening.recorder = null;
  none.listening.start(none.send);
  assert.match(none.sent[0].error, /no recorder found/);
});

test('pair doctor: voice off, no recorder, no model, a failing whisper, and one that works', async () => {
  const dir = scratch('pair-doctor-voice-');
  const model = join(dir, 'ggml-base.en.bin');
  writeFileSync(model, '');
  const whisper = join(dir, 'whisper-cli');
  writeFileSync(whisper, '#!/bin/sh\necho " [BLANK_AUDIO]"\n', {mode: 0o755});
  const broken = join(dir, 'broken-whisper');
  writeFileSync(broken, '#!/bin/sh\necho "failed to load model" >&2; exit 1\n', {mode: 0o755});
  const found = name => name === 'pw-record';
  const voice = fields => voiceConfig({model, whisper, ...fields});
  assert.match((await voiceCheck(null)).text, /^off/);
  assert.equal((await voiceCheck(voice(), () => false)).level, 'fail');
  assert.match((await voiceCheck(voice({model: join(dir, 'none.bin')}), found)).text, /no whisper\.cpp model/);
  assert.match((await voiceCheck(voice({whisper: broken}), found)).text, /whisper\.cpp fails: failed to load model/);
  assert.match((await voiceCheck(voice({speak: 'piper --model x'}), found)).text, /`piper` is not on PATH/);
  const good = await voiceCheck(voice({speak: 'pw-record'}), found);
  assert.equal(good.level, 'ok');
  assert.match(good.text, /^pw-record records, whisper\.cpp hears a second in \d\.\d s on the CPU, and `pw-record` reads answers aloud/);
});

test('an editor that goes away drops its recording: nothing is heard or asked', async () => {
  const {listening, sent, asked, send} = listener();
  const editor = {}, other = {};
  listening.start(send, null, editor);
  await sleep(300);
  listening.drop(other); // another Neovim closing changes nothing
  assert.ok(listening.recording);
  listening.drop(editor);
  assert.equal(listening.recording, null);
  await listening.stop();
  assert.deepEqual(asked, []);
  assert.deepEqual(sent.filter(message => message.type !== 'listening'), []);
});

test('coming back stops a spoken pipeline as a whole, the player too', async () => {
  const marker = `sleep 31.${process.pid}`;
  const hush = speak({speak: `cat | ${marker}`}, 'Line 9 uses >=.');
  await sleep(300);
  assert.ok(running(marker), 'the player plays');
  hush();
  await sleep(300);
  assert.equal(running(marker), false, 'and stops');
});

test('the daemon: Neovim quitting mid-recording closes the microphone at once, and whisper never runs', async () => {
  const dir = scratch('pair-drop-');
  const marker = `sleep 32.${process.pid}`;
  const whisper = join(dir, 'whisper-cli');
  writeFileSync(whisper, `#!/bin/sh\ntouch ${dir}/whisper-ran\necho " hello"\n`, {mode: 0o755});
  const config = parseConfig({
    dataDir: dir, socket: join(dir, 'pair.sock'), agents: false, // never the real board of the machine running the tests
    models: {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'w'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'p'}},
    voice: {model: 'unused.bin', whisper, record: `${toneCommand(30)} | (${marker}; cat)`, maxSeconds: 1},
  });
  const watcher = fauxProvider({provider: 'faux-w'});
  const partner = fauxProvider({provider: 'faux-p'});
  const models = createModels();
  models.setProvider(watcher.provider);
  models.setProvider(partner.provider);
  const daemon = await startDaemon(config, {pairModels: {models, watcher: watcher.getModel(), partner: partner.getModel()}, probe: async () => ({ok: true}), log: () => {}});
  try {
    const editor = connect(config.socket);
    await new Promise(resolve => editor.on('connect', resolve));
    sendMessage(editor, {type: 'hello', role: 'editor', cwd: dir});
    sendMessage(editor, {type: 'listen', action: 'start'});
    await sleep(500);
    assert.ok(running(marker), 'recording');
    editor.destroy(); // Neovim quits while a tap listens
    await sleep(400);
    assert.equal(running(marker), false, 'the recorder is gone');
    await sleep(1200); // past maxSeconds
    assert.equal(existsSync(join(dir, 'whisper-ran')), false, 'nothing was transcribed');
  } finally {
    await daemon.close();
  }
});
