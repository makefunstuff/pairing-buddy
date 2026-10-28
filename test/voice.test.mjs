// Push-to-talk without a microphone: a recorder that plays a tone, and whisper replaced by a script or a function.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmodSync, existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {connect} from 'node:net';
import {join} from 'node:path';
import {test} from 'node:test';
import {createModels, fauxProvider} from '@earendil-works/pi-ai';
import {parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {sendMessage} from '../src/protocol.mjs';
import {initialState} from '../src/fold.mjs';
import {voiceCheck} from '../src/doctor.mjs';
import {Listener} from '../src/listen.mjs';
import {keyVariables} from '../src/service-env.mjs';
import {cleanTranscript, loudness, meterLevel, playerOf, RATE, recorderOf, Recording, speak, speakable, speakOpenRouter, speaks, transcribe, voiceConfig, wav, whisperPrompt} from '../src/voice.mjs';
import {scratch} from './temp.mjs';

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
  assert.deepEqual({...voice, model: undefined}, {whisper: 'whisper-cli', threads: 4, language: 'en', record: null, speak: null, play: null, maxSeconds: 60, model: undefined, openrouter: null});
});

test('voice config with OpenRouter: one key, a model to hear with or a voice, and no second way to do either', () => {
  const key = {apiKeyFile: '~/openrouter.key'};
  const heard = voiceConfig({openrouter: {...key, hear: 'openai/whisper-large-v3-turbo'}});
  assert.equal(heard.model, null, 'no whisper.cpp model is needed');
  assert.deepEqual(heard.openrouter, {apiKeyFile: '~/openrouter.key', hear: 'openai/whisper-large-v3-turbo', speak: null, baseUrl: 'https://openrouter.ai/api/v1', timeoutMs: 30_000});
  assert.equal(speaks(heard), false);
  const spoken = voiceConfig({model: 'm.bin', openrouter: {...key, speak: {model: 'x-ai/grok-voice-tts-1.0', voice: 'eve'}, timeoutMs: 5000}});
  assert.deepEqual(spoken.openrouter.speak, {model: 'x-ai/grok-voice-tts-1.0', voice: 'eve', format: 'mp3'});
  assert.equal(spoken.openrouter.hear, null);
  assert.equal(speaks(spoken), true);
  assert.throws(() => voiceConfig({openrouter: {...key, speak: {model: 'x', voice: 'eve'}}}), /voice\.model/, 'whisper.cpp hears without hear');
  assert.throws(() => voiceConfig({openrouter: {hear: 'm'}}), /needs its key/);
  assert.throws(() => voiceConfig({openrouter: {...key, apiKeyEnv: 'K', hear: 'm'}}), /takes one of apiKeyFile, apiKeyEnv/);
  assert.throws(() => voiceConfig({model: 'm.bin', openrouter: key}), /needs "hear"/);
  assert.throws(() => voiceConfig({model: 'm.bin', openrouter: {...key, hear: 'm'}}), /one of model \(whisper\.cpp\) and openrouter\.hear/);
  assert.throws(() => voiceConfig({model: 'm.bin', speak: 'piper', openrouter: {...key, speak: {model: 'x', voice: 'v'}}}), /one of speak/);
  assert.throws(() => voiceConfig({model: 'm.bin', openrouter: {...key, speak: {model: 'x'}}}), /speak\.voice is missing/);
  assert.throws(() => voiceConfig({model: 'm.bin', openrouter: {...key, speak: {model: 'x', voice: 'v', format: 'ogg'}}}), /mp3/);
  assert.throws(() => voiceConfig({model: 'm.bin', openrouter: {...key, hear: 'm', timeoutMs: 0}}), /timeoutMs/);
  const config = parseConfig({
    models: {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'w'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'p'}},
    voice: {openrouter: {apiKeyEnv: 'OPENROUTER_API_KEY', hear: 'openai/whisper-large-v3-turbo'}},
  });
  assert.deepEqual(keyVariables(config), ['OPENROUTER_API_KEY'], '`pair setup` stores the key for the service');
});

test('the player for OpenRouter\'s voice: the configured command, else mpv or ffplay on PATH, else none', () => {
  assert.deepEqual(playerOf({play: 'pw-play -'}), ['sh', '-c', 'pw-play -']);
  assert.equal(playerOf({play: null}, name => name === 'ffplay')[0], 'ffplay');
  assert.equal(playerOf({play: null}, () => true)[0], 'mpv');
  assert.equal(playerOf({play: null}, () => false), null);
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
  const session = {state: {...initialState({goal: 'retries'}), file: 'retry.c'}, message: () => {}};
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

/**
 * A fake OpenRouter on localhost: `routes[path](request, body, response)` answers, else a 404. `requests` collects
 * `{method, path, headers, body}`. Never the real one.
 */
async function fakeOpenRouter(routes) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    const body = text ? JSON.parse(text) : null;
    requests.push({method: request.method, path: request.url, headers: request.headers, body});
    const route = routes[request.url.split('?')[0]];
    if (!route) return json(response, 404, {error: {code: 404, message: 'Not Found'}});
    route(request, body, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/api/v1`,
    requests,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}

const json = (response, status, value) => response.writeHead(status, {'content-type': 'application/json'}).end(JSON.stringify(value));

/** A voice config whose OpenRouter is `server`, with a fake key in a file. */
function openrouterVoice(server, openrouter, fields = {}) {
  const dir = scratch('pair-or-key-');
  const apiKeyFile = join(dir, 'openrouter.key');
  writeFileSync(apiKeyFile, 'sk-or-fake\n', {mode: 0o600});
  return voiceConfig({record: 'true', ...fields, openrouter: {apiKeyFile, baseUrl: server.url, ...openrouter}});
}

test('OpenRouter hears: the recording goes as a WAV with the model and language, and its text comes back clean', async () => {
  const server = await fakeOpenRouter({'/api/v1/audio/transcriptions': (request, body, response) => json(response, 200, {text: ' Why does attempt 5\n give up? [BLANK_AUDIO]', usage: {seconds: 2}})});
  try {
    const voice = openrouterVoice(server, {hear: 'openai/whisper-large-v3-turbo'});
    const pcm = Buffer.alloc(3200, 1);
    assert.equal(await transcribe(voice, pcm, {dir: scratch('pair-or-'), prompt: 'About retry.c.'}), 'Why does attempt 5 give up?');
    const [request] = server.requests;
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, 'Bearer sk-or-fake', 'the key from apiKeyFile');
    assert.equal(request.body.model, 'openai/whisper-large-v3-turbo');
    assert.equal(request.body.language, 'en');
    assert.equal(request.body.input_audio.format, 'wav');
    assert.deepEqual(Buffer.from(request.body.input_audio.data, 'base64'), wav(pcm));
  } finally {
    await server.close();
  }
});

test('OpenRouter\'s errors say what went wrong: a refused key, a timeout, no server, no key', async () => {
  const server = await fakeOpenRouter({
    '/api/v1/audio/transcriptions': (request, body, response) => (body.model === 'slow' ? null : json(response, 401, {error: {code: 401, message: 'User not found.'}})),
  });
  const dir = scratch('pair-or-');
  try {
    await assert.rejects(transcribe(openrouterVoice(server, {hear: 'm'}), Buffer.alloc(3200), {dir}), {message: 'OpenRouter answered 401 (the key is not valid): User not found.'});
    await assert.rejects(transcribe(openrouterVoice(server, {hear: 'slow', timeoutMs: 300}), Buffer.alloc(3200), {dir}), {message: 'OpenRouter did not answer in 0.3 s (voice.openrouter.timeoutMs)'});
    const gone = await fakeOpenRouter({});
    await gone.close();
    await assert.rejects(transcribe(openrouterVoice(gone, {hear: 'm'}), Buffer.alloc(3200), {dir}), /^Error: OpenRouter could not be reached: ECONNREFUSED/);
    const missing = voiceConfig({openrouter: {apiKeyFile: join(dir, 'none.key'), baseUrl: server.url, hear: 'm'}});
    await assert.rejects(transcribe(missing, Buffer.alloc(3200), {dir}), /^Error: no OpenRouter key: no file .*none\.key/);
    const unset = voiceConfig({openrouter: {apiKeyEnv: 'PAIR_TEST_UNSET_KEY', baseUrl: server.url, hear: 'm'}});
    await assert.rejects(transcribe(unset, Buffer.alloc(3200), {dir}), {message: 'no OpenRouter key: $PAIR_TEST_UNSET_KEY is not set'});
    assert.equal(server.requests.length, 2, 'nothing is sent without a key');
  } finally {
    await server.close();
  }
});

test('OpenRouter speaks: the short answer goes with the model and voice, and its audio goes to the player', async () => {
  const audio = Buffer.from('ID3 fake mp3 bytes');
  const server = await fakeOpenRouter({'/api/v1/audio/speech': (request, body, response) => response.writeHead(200, {'content-type': 'audio/mpeg'}).end(audio)});
  const dir = scratch('pair-or-play-');
  try {
    const voice = openrouterVoice(server, {speak: {model: 'x-ai/grok-voice-tts-1.0', voice: 'eve', speed: 1.2}}, {model: 'm.bin', play: `cat > ${dir}/played`});
    const failures = [];
    speak(voice, 'Attempt 5 gives up at retry.c, line 42.', {failed: why => failures.push(why)});
    await sleep(500);
    assert.deepEqual(readFileSync(join(dir, 'played')), audio, 'played what came');
    assert.deepEqual(server.requests[0].body, {model: 'x-ai/grok-voice-tts-1.0', input: 'Attempt 5 gives up at retry.c, line 42.', voice: 'eve', response_format: 'mp3', speed: 1.2});
    assert.deepEqual(failures, []);
  } finally {
    await server.close();
  }
});

test('OpenRouter\'s voice: a stop while the audio is on its way plays nothing; a failure or no player is reported', async () => {
  let answer = () => {};
  const server = await fakeOpenRouter({
    '/api/v1/audio/speech': (request, body, response) => {
      if (body.voice === 'broke') return json(response, 402, {error: {code: 402, message: 'Insufficient credits'}});
      answer = () => response.writeHead(200, {'content-type': 'audio/mpeg'}).end('mp3');
    },
  });
  const dir = scratch('pair-or-stop-');
  try {
    const failures = [];
    const failed = why => failures.push(why);
    const voice = openrouterVoice(server, {speak: {model: 'm', voice: 'eve'}}, {model: 'm.bin', play: `cat > ${dir}/played`});
    const hush = speak(voice, 'Line 9.', {failed});
    await sleep(200);
    hush(); // you came back before the audio did
    answer();
    await sleep(300);
    assert.equal(existsSync(join(dir, 'played')), false, 'nothing played');
    assert.deepEqual(failures, [], 'a stop is no failure');

    speak(openrouterVoice(server, {speak: {model: 'm', voice: 'broke'}}, {model: 'm.bin', play: 'cat >/dev/null'}), 'Line 9.', {failed});
    await sleep(300);
    assert.deepEqual(failures, ['OpenRouter answered 402 (the account is out of credits): Insufficient credits']);

    const before = server.requests.length;
    speakOpenRouter(openrouterVoice(server, {speak: {model: 'm', voice: 'eve'}}, {model: 'm.bin'}), 'Line 9.', {failed, player: null});
    assert.match(failures.at(-1), /no player found .*install mpv or ffmpeg/);
    assert.equal(server.requests.length, before, 'and nothing is sent');
  } finally {
    await server.close();
  }
});

test('the listener reports what failed in the chat: hearing, and reading the answer aloud', async () => {
  const messages = [];
  const session = {state: {...initialState({goal: 'retries'}), file: 'retry.c'}, message: (sender, text) => messages.push([sender, text])};
  const sent = [];
  const listening = new Listener({
    voice: voiceConfig({model: 'm.bin', record: toneCommand(2), speak: 'cat >/dev/null'}),
    session,
    dir: scratch('pair-listen-'),
    ask: async () => 'Attempt 5 gives up.',
    transcribeWith: async () => { throw new Error('OpenRouter did not answer in 30 s (voice.openrouter.timeoutMs)'); },
    speakWith: (voice, text, {failed}) => { failed('OpenRouter answered 402 (the account is out of credits)'); return () => {}; },
  });
  listening.start(message => sent.push(message));
  await sleep(400);
  await listening.stop();
  assert.deepEqual(sent.at(-1), {type: 'heard', error: 'OpenRouter did not answer in 30 s (voice.openrouter.timeoutMs)'}, 'the editor says so');
  assert.deepEqual(messages, [['system', 'Pair could not hear you: OpenRouter did not answer in 30 s (voice.openrouter.timeoutMs).']], 'and the chat');

  listening.transcribeWith = async () => 'why does it give up?';
  listening.focus(false);
  listening.start(message => sent.push(message));
  await sleep(400);
  await listening.stop();
  assert.deepEqual(messages.at(-1), ['system', 'Pair could not read its answer aloud: OpenRouter answered 402 (the account is out of credits).']);
});

test('voice going off while OpenRouter hears: the request stops, and nothing is shown or asked', async () => {
  const session = {state: initialState({}), message: () => assert.fail('nothing to report')};
  const sent = [];
  const asked = [];
  let signal;
  const listening = new Listener({
    voice: voiceConfig({model: 'm.bin', record: toneCommand(2)}),
    session,
    dir: scratch('pair-listen-'),
    ask: async text => { asked.push(text); return ''; },
    transcribeWith: (voice, pcm, options) => new Promise((resolve, reject) => {
      signal = options.signal;
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  listening.start(message => sent.push(message));
  await sleep(400);
  const stopping = listening.stop();
  await sleep(50);
  listening.close(); // the config's voice changed
  await stopping;
  assert.equal(signal.aborted, true);
  assert.deepEqual(sent.filter(message => message.type === 'heard'), [{type: 'heard', state: 'hearing'}]);
  assert.deepEqual(asked, []);
});

test('pair doctor with OpenRouter: a refused key, a model it does not have, no player, and a setup that works; no audio is sent', async () => {
  let keyStatus = 200;
  const server = await fakeOpenRouter({
    '/api/v1/key': (request, body, response) => json(response, keyStatus, keyStatus === 200 ? {data: {label: 'fake'}} : {error: {code: 401, message: 'User not found.'}}),
    '/api/v1/models': (request, body, response) => json(response, 200, {
      data: request.url.includes('transcription') ? [{id: 'openai/whisper-large-v3-turbo'}] : [{id: 'x-ai/grok-voice-tts-1.0'}],
    }),
  });
  try {
    const found = name => name === 'pw-record' || name === 'mpv';
    const good = {hear: 'openai/whisper-large-v3-turbo', speak: {model: 'x-ai/grok-voice-tts-1.0', voice: 'eve'}};
    const voice = (openrouter = good) => ({...openrouterVoice(server, openrouter), record: null});
    const works = await voiceCheck(voice(), found);
    assert.deepEqual(works, {level: 'ok', name: 'voice', text: 'pw-record records, OpenRouter\'s openai/whisper-large-v3-turbo hears, and OpenRouter\'s x-ai/grok-voice-tts-1.0 (eve) reads answers aloud through mpv when you are away'});
    assert.equal(server.requests.find(request => request.path === '/api/v1/key').headers.authorization, 'Bearer sk-or-fake');
    assert.ok(server.requests.every(request => request.method === 'GET'), 'only questions, no audio');

    const noPlayer = await voiceCheck(voice(), name => name === 'pw-record');
    assert.equal(noPlayer.level, 'warn');
    assert.match(noPlayer.text, /no player is found .*install mpv/);
    const unknown = await voiceCheck(voice({...good, hear: 'openai/whisper-9'}), found);
    assert.deepEqual([unknown.level, unknown.text.split(';')[0]], ['fail', 'voice.openrouter.hear: openai/whisper-9 is not one of OpenRouter\'s transcription models']);
    keyStatus = 401;
    const refused = await voiceCheck(voice(), found);
    assert.deepEqual([refused.level, refused.text], ['fail', 'OpenRouter: OpenRouter answered 401 (the key is not valid): User not found.']);
  } finally {
    await server.close();
  }
});
