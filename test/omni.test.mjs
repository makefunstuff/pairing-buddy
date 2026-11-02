// Voice's LFM3-Omni without the model: a fake helper in Node stands in for Python, a fake Hugging Face serves small
// files, and the player is a shell command. The real model is in test/live/omni.test.mjs, opt-in.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {connect} from 'node:net';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {createModels, fauxProvider} from '@earendil-works/pi-ai';
import {parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {voiceCheck} from '../src/doctor.mjs';
import {initialState} from '../src/fold.mjs';
import {Listener} from '../src/listen.mjs';
import {downloadOmni, gb, installVoiceRuntime, languageName, OMNI, omniDir, OmniVoice, omniMissing, omniReady, removeOmni, VOICE_LOCK, voiceWheelsOf} from '../src/omni.mjs';
import {readMessages, sendMessage} from '../src/protocol.mjs';
import {omniMissingWhy, RATE, saidFiles, sentencesOf, speakOmni, transcribe, voiceConfig, wavPlayerOf} from '../src/voice.mjs';
import {scratch} from './temp.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, what, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** A stand-in for Python running the helper: `-I helper.py DIR THREADS CACHE` runs `script` with Node instead. */
function fakePython(script) {
  const dir = scratch('omni-python-');
  writeFileSync(join(dir, 'helper.mjs'), script);
  const python = join(dir, 'python');
  writeFileSync(python, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'helper.mjs')}" "$@"\n`);
  chmodSync(python, 0o755);
  return python;
}

/** LFM3-Omni's files as if downloaded and checked: small files, with the checksums the download notes beside them. */
function fakeOmniFiles(dataDir) {
  for (const file of OMNI.files) {
    const path = join(omniDir(dataDir), file.file);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, 'x');
    const stat = statSync(path);
    writeFileSync(`${path}.sha256`, JSON.stringify({sha256: file.sha256, size: stat.size, mtimeMs: stat.mtimeMs, revision: OMNI.revision}));
  }
}

// A helper that hears every recording as its byte count and the language, and speaks each text as a WAV of its text.
const HELPER = `
  import {createInterface} from 'node:readline';
  import {appendFileSync} from 'node:fs';
  const [dir, threads, cache] = process.argv.slice(4); // after -I and the helper's path
  const say = message => console.log(JSON.stringify(message));
  say({ready: true, runtime: '0.19.0', litert: '2.3.0'});
  const cancelled = new Set();
  createInterface({input: process.stdin}).on('line', async line => {
    const request = JSON.parse(line);
    if (process.env.OMNI_LOG) appendFileSync(process.env.OMNI_LOG, line + '\\n');
    if (request.op === 'cancel') return cancelled.add(request.id);
    if (request.op === 'hear') return say({id: request.id, text: ' heard ' + Buffer.from(request.pcm, 'base64').length + ' bytes in ' + request.language + ' (' + threads + ' threads, ' + cache.split('/').at(-1) + ')', ms: 10});
    for (const [part, text] of request.texts.entries()) {
      await new Promise(resolve => setTimeout(resolve, 60));
      if (cancelled.has(request.id)) return say({id: request.id, done: true, cancelled: true});
      say({id: request.id, part, wav: Buffer.from(text).toString('base64'), seconds: 1, ms: 60});
    }
    say({id: request.id, done: true});
  });
`;

test('LFM3-Omni\'s pinned files: one revision, 4.0 GB, the runner with them; languages by name', () => {
  assert.equal(OMNI.files.length, 11);
  assert.ok(OMNI.files.every(file => file.revision === OMNI.revision && /^[0-9a-f]{64}$/.test(file.sha256)));
  assert.equal(gb(OMNI.bytes), '4.0 GB');
  assert.ok(OMNI.files.some(file => file.file === 'runner/speech.py'), 'the runner is pinned like the weights');
  assert.equal(languageName('en'), 'English');
  assert.equal(languageName('Swahili'), 'Swahili');
  assert.equal(languageName('auto'), 'English', 'it needs the language named');
});

test('the helper hears, speaks a part at a time, stops speech when told, and goes once idle', async () => {
  const dataDir = scratch('omni-voice-');
  const log = join(dataDir, 'requests');
  process.env.OMNI_LOG = log;
  const omni = new OmniVoice({python: fakePython(HELPER), dataDir, threads: 3, idleMs: 100});
  try {
    assert.equal((await omni.hear(Buffer.alloc(RATE * 2), {language: 'de'})).trim(), 'heard 32000 bytes in German (3 threads, cache-a287b6e6)');
    const parts = [];
    const speech = omni.speak(['One.', 'Two.', 'Three.'], {voice: 'male', language: 'fr', onPart: wav => parts.push(wav.toString())});
    assert.deepEqual(await speech.done, {cancelled: false});
    assert.deepEqual(parts, ['One.', 'Two.', 'Three.']);
    assert.match(readFileSync(log, 'utf8'), /"voice":"male","language":"French"/);

    const cut = [];
    const stopped = omni.speak(['A.', 'B.', 'C.', 'D.'], {onPart: wav => cut.push(wav.toString())});
    await until(() => cut.length === 1, 'the first part');
    stopped.stop();
    assert.deepEqual(await stopped.done, {cancelled: true});
    assert.ok(cut.length < 4, 'the rest is not made');
    assert.match(readFileSync(log, 'utf8'), /"op":"cancel"/);

    const waiting = new AbortController();
    const first = omni.hear(Buffer.alloc(4));
    const dropped = omni.hear(Buffer.alloc(4), {signal: waiting.signal});
    waiting.abort(new Error('voice went off'));
    await assert.rejects(dropped, /voice went off/);
    await first;
    assert.ok(omni.rates.hear !== null && omni.rates.speak !== null);
    await until(() => !omni.child, 'the idle helper to stop');
  } finally {
    delete process.env.OMNI_LOG;
    omni.close();
  }

  const missing = new OmniVoice({python: fakePython(`console.log(JSON.stringify({fatal: "PackageNotFoundError: No package metadata was found for ai-edge-litert"}))`), dataDir});
  await assert.rejects(missing.hear(Buffer.alloc(4)), /has no ai-edge-litert/);
  const absent = new OmniVoice({python: join(scratch('omni-none-'), 'python3'), dataDir});
  await assert.rejects(absent.hear(Buffer.alloc(4)), /is not there/);
});

/** A fetch for a fake Hugging Face: each pinned path answers its `files[path]` bytes. */
const fakeHub = (files, asked = []) => async url => {
  asked.push(url);
  const path = decodeURIComponent(new URL(url).pathname.split('/resolve/')[1].split('/').slice(1).join('/'));
  if (!(path in files)) return new Response('no', {status: 404});
  return new Response(files[path]);
};

const pinned = (file, text) => ({repo: OMNI.repo, revision: OMNI.revision, file, bytes: text.length, sha256: createHash('sha256').update(text).digest('hex')});

test('the download: each file from the pinned revision, its SHA-256 checked; a wrong one is not kept; no room, no start', async () => {
  const dataDir = scratch('omni-download-');
  const files = [pinned('model.litertlm', 'weights'), pinned('runner/speech.py', 'print()')];
  const asked = [];
  const progress = [];
  const total = await downloadOmni(dataDir, {files, fetch: fakeHub({'model.litertlm': 'weights', 'runner/speech.py': 'print()'}, asked), free: async () => 1e12, progress: (bytes, of) => progress.push([bytes, of])});
  assert.equal(total, 14);
  assert.ok(asked.every(url => url.startsWith(`https://huggingface.co/${OMNI.repo}/resolve/${OMNI.revision}/`)), 'the pinned revision');
  assert.equal(readFileSync(join(omniDir(dataDir), 'runner/speech.py'), 'utf8'), 'print()');
  assert.deepEqual(progress.at(-1), [14, 14]);
  asked.length = 0;
  assert.equal(await downloadOmni(dataDir, {files, fetch: fakeHub({}, asked), free: async () => 1e12}), 0, 'what is here is not fetched again');
  assert.deepEqual(asked, []);

  const wrong = [pinned('tokenizer.json', 'the real one')];
  await assert.rejects(downloadOmni(dataDir, {files: wrong, fetch: fakeHub({'tokenizer.json': 'tampered'}), free: async () => 1e12}), /SHA-256 .* not kept/);
  assert.equal(existsSync(join(omniDir(dataDir), 'tokenizer.json')), false);
  await assert.rejects(downloadOmni(scratch('omni-full-'), {free: async () => 1e9}), /1\.0 GB free .* needs 8\.2 GB/);

  assert.equal(omniReady(dataDir), false);
  assert.equal(omniMissing(dataDir), OMNI.bytes, 'the real files are all still missing');
  fakeOmniFiles(dataDir);
  assert.equal(omniReady(dataDir), true);
  await removeOmni(dataDir);
  assert.equal(existsSync(omniDir(dataDir)), false);
});

test('without its files, LFM3-Omni says how to get them, before you speak; with them, it hears', async () => {
  const dataDir = scratch('omni-hear-');
  const omni = {dataDir, hear: async (pcm, {language}) => `  hello in ${language} \n`};
  assert.match(omniMissingWhy(omni), /:Pair voice on downloads it \(4\.0 GB from Hugging Face, once\)/);
  const voice = voiceConfig({});
  await assert.rejects(transcribe(voice, Buffer.alloc(4), {omni}), /not downloaded/);
  const sent = [];
  const listening = new Listener({voice, session: {state: initialState({}), message: () => {}}, dir: scratch('omni-listen-'), recorder: ['true'], ask: async () => '', omni});
  listening.start(message => sent.push(message));
  assert.match(sent[0].error, /LFM3-Omni is not downloaded/);
  assert.equal(listening.recording, null, 'no microphone opens');
  fakeOmniFiles(dataDir);
  assert.equal(await transcribe(voice, Buffer.alloc(4), {omni}), 'hello in en');
});

test('read aloud by LFM3-Omni: sentences in parts, each played as it comes, in order; a stop stops both', async () => {
  assert.deepEqual(sentencesOf('Yes. It counts from one, so it stops early. See retry.c, line 42.'), ['Yes. It counts from one, so it stops early.', 'See retry.c, line 42.']);
  assert.deepEqual(sentencesOf('The fourth attempt waits eight seconds, and seven have gone by, so fifteen is reached. See retry.c.'), ['The fourth attempt waits eight seconds,', 'and seven have gone by, so fifteen is reached.', 'See retry.c.'], 'a long first sentence is cut, to be heard sooner');
  assert.equal(saidFiles('See retry.c, line 42, and src/omni.mjs.'), 'See retry dot c, line 42, and src/omni dot mjs.');
  assert.equal(wavPlayerOf({play: null}, name => name === 'aplay')[0], 'aplay');
  assert.equal(wavPlayerOf({play: null}, name => name === 'pw-play')[0], 'pw-play');
  const dataDir = scratch('omni-speak-');
  fakeOmniFiles(dataDir);
  const played = join(dataDir, 'played');
  let made;
  const omni = {
    dataDir,
    speak: (texts, {voice, onPart}) => {
      made = {texts, voice};
      const timers = texts.map((text, i) => setTimeout(() => onPart(Buffer.from(`${text}\n`)), 50 * (i + 1)));
      return {done: new Promise(() => {}), stop: () => timers.forEach(clearTimeout)};
    },
  };
  const voice = voiceConfig({omni: {voice: 'male'}});
  speakOmni(voice, 'One sentence that is long enough to stand. Two, also long enough to be a part.', {omni, player: ['sh', '-c', `cat >> ${played}`]});
  await until(() => existsSync(played) && readFileSync(played, 'utf8').split('\n').length === 3, 'both parts played');
  assert.equal(readFileSync(played, 'utf8'), 'One sentence that is long enough to stand.\nTwo, also long enough to be a part.\n');
  assert.equal(made.voice, 'male');

  const slow = join(dataDir, 'slow');
  const stop = speakOmni(voice, 'First part, long enough to be a part alone. Second part, never played at all.', {omni, player: ['sh', '-c', `cat >> ${slow}; sleep 5`]});
  await until(() => existsSync(slow), 'the first part');
  stop();
  await sleep(150);
  assert.equal(readFileSync(slow, 'utf8'), 'First part, long enough to be a part alone.\n');

  const broken = [];
  let stoppedSpeech = false;
  const three = {...omni, speak: (texts, options) => { const made = omni.speak(texts, options); return {...made, stop: () => { stoppedSpeech = true; made.stop(); }}; }};
  speakOmni(voice, 'A first part that is long enough. A second part that is long enough. A third one, long enough too.', {omni: three, player: ['sh', '-c', 'echo no audio server >&2; exit 1'], failed: why => broken.push(why)});
  await sleep(400);
  assert.deepEqual(broken, ['no audio server'], 'a failing player is said once');
  assert.ok(stoppedSpeech, 'and the rest is not made');
  const absent = [];
  speakOmni(voice, 'A first part that is long enough. A second part that is long enough.', {omni, player: [join(dataDir, 'no-player')], failed: why => absent.push(why)});
  await sleep(300);
  assert.equal(absent.length, 1);
  assert.match(absent[0], /not found/);

  const failed = [];
  speakOmni(voice, 'x', {omni: {dataDir: scratch('omni-none-')}, failed: why => failed.push(why)});
  speakOmni(voice, 'x', {omni, player: null, failed: why => failed.push(why)});
  assert.match(failed[0], /not downloaded/);
  assert.match(failed[1], /no player found/);
});

/** A Listener with LFM3-Omni's voice; `spoken` collects what it reads aloud. */
function listener(voice) {
  const spoken = [];
  const listening = new Listener({
    voice: {...voiceConfig(voice), record: null},
    session: {state: initialState({}), message: () => {}},
    dir: scratch('omni-talk-'),
    recorder: ['sh', '-c', `node -e 'const b = Buffer.alloc(${RATE / 10 * 2}); for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(i % 2 ? 8000 : -8000, i * 2); const t = setInterval(() => process.stdout.write(b), 100); setTimeout(() => clearInterval(t), 3000)'`],
    ask: async () => 'The loop starts at `retry.c:42`. It counts one too few.',
    transcribeWith: async () => 'why does it stop early?',
    speakWith: (spokenVoice, text) => { spoken.push(text); return () => spoken.push('(stopped)'); },
  });
  return {listening, spoken};
}

test('talk: every answer to a spoken question is read aloud at the editor too; typing stops it; nothing unasked is said', async () => {
  const talk = listener({model: 'm.bin', speak: 'omni', talk: true});
  talk.listening.start(() => {});
  await sleep(400);
  await talk.listening.stop();
  assert.deepEqual(talk.spoken, ['The loop starts at retry.c, line 42. It counts one too few.'], 'at the editor');
  talk.listening.typed();
  assert.equal(talk.spoken.at(-1), '(stopped)', 'you type: it stops');

  const busy = listener({model: 'm.bin', speak: 'omni', talk: true});
  busy.listening.ask = async () => { busy.listening.typed({keys: true}); return 'An answer.'; };
  busy.listening.start(() => {});
  await sleep(400);
  await busy.listening.stop();
  assert.deepEqual(busy.spoken, [], 'you typed before the answer came: it is not read aloud');
  const late = listener({model: 'm.bin', speak: 'omni', talk: true});
  late.listening.ask = async () => { late.listening.typed(); return 'An answer.'; }; // an edit from before you asked, arriving late
  late.listening.start(() => {});
  await sleep(400);
  await late.listening.stop();
  assert.deepEqual(late.spoken, ['An answer.'], 'an edit sent late is no typing since');


  const plain = listener({model: 'm.bin', speak: 'omni'});
  plain.listening.start(() => {});
  await sleep(400);
  await plain.listening.stop();
  assert.deepEqual(plain.spoken, [], 'without talk, only when you are away');
});

test('pair doctor with LFM3-Omni: not downloaded, no packages, and one that hears', async () => {
  const dataDir = scratch('omni-doctor-');
  const found = name => name === 'pw-record' || name === 'mpv';
  const has = async () => ({version: '0.19.0'});
  const lacks = async python => ({problem: `${python} has no ai-edge-litert`});
  const heard = async () => ({ms: 1234});
  const voice = voiceConfig({});
  const notYet = await voiceCheck(voice, found, {dataDir, python: '/venv/bin/python', runtime: lacks, hearSilence: heard});
  assert.equal(notYet.level, 'warn');
  assert.match(notYet.text, /:Pair voice on downloads LFM3-Omni-2B \(int8\) \(4\.0 GB from Hugging Face, once\); it also needs ai-edge-litert: :Pair voice on installs them \(from PyPI, SHA-256 pinned, into search by meaning's venv\)/);
  const own = await voiceCheck(voice, found, {dataDir, python: '/mine/python', meaning: {python: '/mine/python'}, runtime: lacks, hearSilence: heard});
  assert.match(own.text, /\/mine\/python -m pip install --require-hashes --no-deps --only-binary=:all: -r .*voice-runtime\.txt \(or leave meaning\.python out/, 'meaning.python is yours: the hashed line to run');
  fakeOmniFiles(dataDir);
  const noPackages = await voiceCheck(voice, found, {dataDir, python: '/venv/bin/python', runtime: lacks, hearSilence: heard});
  assert.equal(noPackages.level, 'fail');
  assert.match(noPackages.text, /is downloaded, but \/venv\/bin\/python has no ai-edge-litert/);
  const good = await voiceCheck(voiceConfig({talk: true}), found, {dataDir, python: '/venv/bin/python', runtime: has, hearSilence: heard});
  assert.equal(good.level, 'ok');
  assert.equal(good.text, `pw-record records, LFM3-Omni-2B (int8) (revision ${OMNI.revision.slice(0, 7)}, SHA-256 checked) on LiteRT-LM 0.19.0 in /venv/bin/python hears a second in 1.2 s on the CPU, and it reads answers aloud (female voice) through mpv after each spoken question`);
  const broken = await voiceCheck(voice, found, {dataDir, python: '/venv/bin/python', runtime: has, hearSilence: async () => ({problem: 'the voice helper stopped'})});
  assert.match(broken.text, /does not hear: the voice helper stopped/);
  const unused = await voiceCheck(null, found, {dataDir});
  assert.match(unused.text, /^off: .*; LFM3-Omni \(4\.0 GB\) is downloaded but not used: :Pair voice off deletes it/);
});

test('the daemon: :Pair voice on says what and how big first, downloads, and books it; :Pair voice off deletes it', async () => {
  const dir = scratch('omni-daemon-');
  const config = parseConfig({
    dataDir: dir, socket: join(dir, 'pair.sock'), agents: false, plan: false,
    models: {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'w'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'p'}},
    voice: {},
  });
  const watcher = fauxProvider({provider: 'faux-w'});
  const partner = fauxProvider({provider: 'faux-p'});
  const models = createModels();
  models.setProvider(watcher.provider);
  models.setProvider(partner.provider);
  const omni = {fail: () => {}, close: () => {}, dataDir: dir};
  const files = [pinned('LFM3-Omni-2B_int8.litertlm', 'weights')];
  const daemon = await startDaemon(config, {
    pairModels: {models, watcher: watcher.getModel(), partner: partner.getModel()}, probe: async () => ({ok: true}), log: () => {},
    omniWith: {voice: omni, files, fetch: fakeHub({'LFM3-Omni-2B_int8.litertlm': 'weights'}), free: async () => 1e12, runtime: async () => ({version: '0.19.0'})},
  });
  try {
    const editor = connect(config.socket);
    await new Promise(resolve => editor.on('connect', resolve));
    const got = [];
    readMessages(editor, message => got.push(message));
    sendMessage(editor, {type: 'hello', role: 'editor', cwd: dir});
    await until(() => got.length > 0, 'the session');
    sendMessage(editor, {type: 'voice_on'});
    await until(() => got.filter(message => message.type === 'voice_state').length >= 2, 'the download');
    const told = got.filter(message => message.type === 'voice_state').map(message => message.text);
    assert.match(told[0], /^Voice: installing LFM3-Omni-2B, 4\.0 GB from Hugging Face \(litert-community\/LFM3-Omni-2B-LiteRT, pinned, SHA-256 checked\), whose own speech loop \(Python, Apache-2\.0\) runs as you, once/);
    assert.match(told.at(-1), /^LFM3-Omni is here/);
    assert.equal(readFileSync(join(omniDir(dir), 'LFM3-Omni-2B_int8.litertlm'), 'utf8'), 'weights');
    sendMessage(editor, {type: 'today'});
    await until(() => got.some(message => message.type === 'ledger'), 'the ledger');
    const ledger = JSON.stringify(got.find(message => message.type === 'ledger'));
    assert.match(ledger, /LFM3-Omni-2B for voice \(4\.0 GB, revision a287b6e, SHA-256 checked\)/);

    sendMessage(editor, {type: 'voice_off'});
    await until(() => got.filter(message => message.type === 'voice_state').length >= told.length + 1, 'the delete');
    assert.equal(existsSync(omniDir(dir)), false);
    editor.destroy();
  } finally {
    await daemon.close();
  }
});

test(':Pair voice on installs voice\'s packages first, in search by meaning\'s venv, says how big, and books it', async () => {
  const dir = scratch('omni-packages-');
  const config = parseConfig({
    dataDir: dir, socket: join(dir, 'pair.sock'), agents: false, plan: false,
    models: {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'w'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'p'}},
    voice: {},
  });
  fakeOmniFiles(dir);
  const watcher = fauxProvider({provider: 'faux-w'});
  const partner = fauxProvider({provider: 'faux-p'});
  const models = createModels();
  models.setProvider(watcher.provider);
  models.setProvider(partner.provider);
  let has = false;
  const asked = [];
  const daemon = await startDaemon(config, {
    pairModels: {models, watcher: watcher.getModel(), partner: partner.getModel()}, probe: async () => ({ok: true}), log: () => {},
    omniWith: {
      voice: {fail: () => {}, close: () => {}, dataDir: dir},
      runtime: async () => (has ? {version: '0.19.0'} : {problem: 'python3 has no ai-edge-litert'}),
      wheels: () => [{bytes: 30e6}, {bytes: 12e6}],
      pythons: [probedPython(dir, '3.14')],
      pythonsOn: () => ['3.12', '3.13', '3.14'],
      litert: async () => false, // no venv yet: LiteRT-LM comes first
      install: async options => { asked.push(options); options.installedLiteRT({python: '/venv/bin/python', version: '0.19.0', pythonVersion: '3.14', made: true}); has = true; return {python: '/venv/bin/python', version: '3.14', bytes: 42e6, wheels: ['ai_edge_litert.whl', 'numpy.whl']}; },
    },
  });
  try {
    const editor = connect(config.socket);
    await new Promise(resolve => editor.on('connect', resolve));
    const got = [];
    readMessages(editor, message => got.push(message));
    sendMessage(editor, {type: 'hello', role: 'editor', cwd: dir});
    await until(() => got.length > 0, 'the session');
    sendMessage(editor, {type: 'voice_on'});
    await until(() => got.filter(message => message.type === 'voice_state').length >= 2, 'the install');
    const told = got.filter(message => message.type === 'voice_state').map(message => message.text);
    assert.match(told[0], /^Voice: installing LiteRT-LM 0\.19\.0 (\(\d+ MB from PyPI, SHA-256 pinned\) )?in a venv in Pair's data folder, as :Pair find on does, then voice's Python packages \(42 MB from PyPI, SHA-256 pinned\) into that venv, once; :Pair voice off/, 'LiteRT-LM and the venv are said too');
    assert.match(told.at(-1), /^LFM3-Omni is here: hold the listen key/);
    assert.ok(asked[0].runtime, 'through search by meaning\'s runtime (PAIR-8), which makes the venv');
    sendMessage(editor, {type: 'today'});
    await until(() => got.some(message => message.type === 'ledger'), 'the ledger');
    const ledger = JSON.stringify(got.find(message => message.type === 'ledger'));
    assert.match(ledger, /voice's Python packages \(42 MB, SHA-256 pinned\) in search by meaning's venv, Python 3\.14/);
    assert.match(ledger, /LiteRT-LM 0\.19\.0 for voice, in a venv Pair made with Python 3\.14/, 'and LiteRT-LM\'s install');
    editor.destroy();
  } finally {
    await daemon.close();
  }
});

/** A python that answers runtime.mjs's probe as Python `version`, with or without its venv module. */
function probedPython(dir, version, venv = true) {
  const python = join(dir, `python${version}${venv ? '' : '-novenv'}`);
  writeFileSync(python, `#!/bin/sh\nprintf '${version}\\n${venv ? 'venv' : 'no venv'}\\n'\n`);
  chmodSync(python, 0o755);
  return python;
}

/**
 * `:Pair voice on` with `pythons` for a new venv, or search by meaning's venv running Python `venv` (Pair's when
 * `made`, with LiteRT-LM when `litert`), LFM3-Omni's files when `model`: what it told, and what it installed.
 */
async function voiceOnWith(prefix, pythons, {venv = null, made = false, litert = false, model = true, pythonsOn} = {}) {
  const dir = scratch(prefix);
  if (venv) {
    const python = join(dir, 'meaning', 'venv', 'bin', 'python');
    mkdirSync(dirname(python), {recursive: true});
    writeFileSync(python, `#!/bin/sh\necho ${venv}\n`);
    chmodSync(python, 0o755);
    if (made) writeFileSync(join(dir, 'meaning', 'venv-made-by-pair.json'), JSON.stringify({pythonVersion: venv}));
  }
  const config = parseConfig({
    dataDir: dir, socket: join(dir, 'pair.sock'), agents: false, plan: false,
    models: {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'w'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'p'}},
    voice: {},
  });
  if (model) fakeOmniFiles(dir);
  const watcher = fauxProvider({provider: 'faux-w'});
  const partner = fauxProvider({provider: 'faux-p'});
  const models = createModels();
  models.setProvider(watcher.provider);
  models.setProvider(partner.provider);
  const asked = [];
  const daemon = await startDaemon(config, {
    pairModels: {models, watcher: watcher.getModel(), partner: partner.getModel()}, probe: async () => ({ok: true}), log: () => {},
    omniWith: {
      voice: {fail: () => {}, close: () => {}, dataDir: dir},
      runtime: async () => ({problem: 'python3 has no ai-edge-litert'}),
      pythons: pythons(dir),
      ...(pythonsOn ? {pythonsOn} : {}),
      litert: async () => litert,
      install: async () => { asked.push('install'); throw new Error('runtime.install() says what is missing'); },
    },
  });
  try {
    const editor = connect(config.socket);
    await new Promise(resolve => editor.on('connect', resolve));
    const got = [];
    readMessages(editor, message => got.push(message));
    sendMessage(editor, {type: 'hello', role: 'editor', cwd: dir});
    await until(() => got.length > 0, 'the session');
    sendMessage(editor, {type: 'voice_on'});
    await until(() => got.some(message => message.type === 'voice_state' && /not ready/.test(message.text)), 'the answer');
    editor.destroy();
    return {told: got.filter(message => message.type === 'voice_state').map(message => message.text), asked};
  } finally {
    await daemon.close();
  }
}

test(':Pair voice on with a Python voice has no wheels for refuses before it downloads anything, naming that Python', async () => {
  const {told, asked} = await voiceOnWith('omni-nowheels-', dir => [probedPython(dir, '3.11')], {pythonsOn: () => ['3.12', '3.13', '3.14']});
  assert.equal(told.length, 1, 'no "installing" line first');
  assert.match(told[0], /^Voice is not ready: voice's packages have wheels for Python 3\.12 to 3\.14 here; the Python Pair would make its venv with is Python 3\.11\. Install Python 3\.12 or newer \(python3\.12 is enough\), then :Pair voice on again\. Nothing was downloaded\.$/);
  assert.deepEqual(asked, [], 'neither LiteRT-LM, the venv, the wheels nor the model');
});

test(':Pair voice on with a venv that stays says how to make it again, and that Pair did not make it', async () => {
  const end = /, then :Pair voice on again\. Nothing was downloaded\.$/;
  const theirs = await voiceOnWith('omni-theirs-', () => [], {venv: '3.11'});
  assert.match(theirs.told[0], /search by meaning's venv runs Python 3\.11\. Install Python 3\.12 or newer \(python3\.12 is enough\), then remove search by meaning's venv, which Pair did not make, then/);
  const kept = await voiceOnWith('omni-kept-', () => [], {venv: '3.11', made: true, litert: true});
  assert.match(kept.told[0], /runs Python 3\.11\. Install Python 3\.12 or newer \(python3\.12 is enough\), then :Pair voice off and :Pair find off, so Pair makes its venv again with it, then/, ':Pair find off keeps the venv while the model is here');
  const bare = await voiceOnWith('omni-bare-', () => [], {venv: '3.11', made: true, litert: true, model: false});
  assert.match(bare.told[0], /runs Python 3\.11\. Install Python 3\.12 or newer \(python3\.12 is enough\), then :Pair find off, so Pair makes its venv again with it, then/);
  for (const {told, asked} of [theirs, kept, bare]) {
    assert.match(told[0], end);
    assert.deepEqual(asked, []);
  }
});

test(':Pair voice on on a machine voice\'s packages have no wheels for says so before anything else', async () => {
  const {told, asked} = await voiceOnWith('omni-nomachine-', dir => [probedPython(dir, '3.13')], {pythonsOn: () => []});
  assert.match(told[0], /^Voice is not ready: voice's packages have no wheels for \S+ \S+, only Linux \(x86-64, ARM64\) and macOS on Apple silicon\. Nothing was downloaded\.$/);
  assert.deepEqual(asked, []);
});

test(':Pair voice on makes the venv with a Python voice\'s packages fit, also when python3 is older', async () => {
  const {asked} = await voiceOnWith('omni-newer-', dir => [probedPython(dir, '3.11'), probedPython(dir, '3.13')], {pythonsOn: () => ['3.12', '3.13', '3.14']});
  assert.deepEqual(asked, ['install'], 'not refused: python3.13 is there');
});

test(':Pair voice on with no Python that makes a venv leaves it to runtime.install(), which says what is missing', async () => {
  const {told, asked} = await voiceOnWith('omni-novenv-', dir => [probedPython(dir, '3.12', false)], {pythonsOn: () => ['3.12', '3.13', '3.14']});
  assert.deepEqual(asked, ['install'], 'not refused as a Python without wheels');
  assert.match(told.at(-1), /^Voice is not ready: runtime\.install\(\) says what is missing/);
});

test('voice\'s packages: LiteRT-LM first through the venv\'s installer, then the wheels by their hashes, pip with no index; never into meaning.python', async () => {
  const dataDir = scratch('omni-venv-');
  const venv = join(dataDir, 'meaning', 'venv', 'bin');
  mkdirSync(venv, {recursive: true});
  const pipLog = join(dataDir, 'pip');
  writeFileSync(join(venv, 'python'), `#!/bin/sh\ncase "$*" in *version_info*) echo 3.14;; *pip*) echo "$@" > ${pipLog};; esac\n`, {mode: 0o755});
  const wheel = text => ({url: `https://files.pythonhosted.org/packages/x/${text}.whl`, bytes: text.length, sha256: createHash('sha256').update(text).digest('hex')});
  let installed = false;
  let checks = 0;
  const runtime = {install: async () => { installed = true; return {python: join(venv, 'python'), version: '0.19.0', pythonVersion: '3.14', made: true}; }};
  const booked = [];
  const result = await installVoiceRuntime({
    dataDir, runtime, platform: 'linux', arch: 'x64', venvHas: async () => installed, installedLiteRT: litert => booked.push(litert), wheelsOf: version => (version === '3.14' ? ['litert', 'numpy'].map(wheel) : null),
    check: async () => (++checks > 1 ? {version: '0.19.0'} : {problem: 'no ai-edge-litert'}),
    fetch: async url => new Response(url.split('/').at(-1).replace('.whl', '')),
  }).catch(error => error);
  assert.ok(!(result instanceof Error), result?.message);
  assert.ok(installed, 'LiteRT-LM and the venv first');
  assert.equal(booked.length, 1, 'told as soon as it is there');
  assert.equal(result.version, '3.14');
  assert.deepEqual(result.wheels, ['litert.whl', 'numpy.whl'], 'each by its SHA-256');
  const pip = readFileSync(pipLog, 'utf8');
  for (const flag of ['--no-index', '--require-hashes', '--no-deps', '--only-binary=:all:', VOICE_LOCK]) assert.ok(pip.includes(flag), flag);

  await assert.rejects(installVoiceRuntime({dataDir, meaning: {python: '/mine/python'}, runtime, check: async () => ({problem: 'x'})}), /Pair installs nothing into meaning\.python: \/mine\/python -m pip install --require-hashes/);
  assert.equal(voiceWheelsOf('3.10', 'linux', 'x64'), null);
  assert.equal(voiceWheelsOf('3.14', 'darwin', 'arm64').length, 4);
});
