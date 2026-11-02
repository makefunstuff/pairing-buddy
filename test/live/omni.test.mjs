// Voice with the real LFM3-Omni-2B on LiteRT, local, no keys. Set PAIR_LIVE_OMNI=1 to run it; it downloads the model
// (4.0 GB, pinned, SHA-256 checked) into PAIR_LIVE_OMNI_DATA, or a temp folder without it, and needs the helper's
// packages (litert-lm-api, ai-edge-litert, numpy, tokenizers) in PAIR_LIVE_OMNI_PYTHON (else search by meaning's venv
// there, else python3). It hears spoken coding questions (espeak-ng, as the push-to-talk tape speaks them), the docs
// video's narration (a neural voice) and the model card's one human recording, then reads an answer aloud and hears it
// back. It prints the word error rate, the time per second of speech and the helper's memory.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {downloadModel, pythonOf} from '../../src/embedder.mjs';
import {downloadOmni, gb, OMNI, OmniVoice, omniMissing} from '../../src/omni.mjs';
import {RATE, saidFiles, sentencesOf, speakable} from '../../src/voice.mjs';
import {scratch} from '../temp.mjs';

const has = command => { try { execFileSync('sh', ['-c', `command -v ${command}`]); return true; } catch { return false; } };
const skip = !process.env.PAIR_LIVE_OMNI ? 'set PAIR_LIVE_OMNI=1 to run voice with the real LFM3-Omni (a 4.0 GB download)'
  : !(has('espeak-ng') && has('ffmpeg')) ? 'needs espeak-ng and ffmpeg' : false;

// Spoken as the push-to-talk tape speaks: espeak-ng, at its usual rate.
const QUESTIONS = [
  'Why does the fourth attempt give up, when the budget is fifteen seconds?',
  'What does should retry return when the elapsed time passes the budget?',
  'Where is the connection pool closed after the request fails?',
  'Can this loop run past the end of the array when the list is empty?',
  'Why is the test for the parser red after I renamed the token type?',
];
const NARRATION = ['voice-1', 'tests-1', 'scout-1', 'intro-1', 'notes-1']; // docs/video/audio, said as said.json writes
const HUMAN = { // the model card's fixture A1: 19 s of a 1986 address, public domain, at the pinned revision
  file: 'fixtures/media/A1.wav', sha256: '88965f28811088dd3b9c3b85293dd4b20841e29737ac5751c1c3fba27a3cf4c0',
};
const ANSWER = 'The fourth attempt waits eight seconds, and seven have gone by, so fifteen is reached. See `retry.c:9`: the check should be greater than, not greater or equal.';

// Numbers count as said, in figures or in words ("15 seconds" is "fifteen seconds").
const ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const spelled = n => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);
const words = text => text.toLowerCase().replace(/\b\d{1,2}\b/g, n => spelled(Number(n))).replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);

/** Word error rate of `heard` against `said`: edits over the words said. */
function wer(said, heard) {
  const ref = words(said);
  const hyp = words(heard);
  let prev = [...Array(hyp.length + 1).keys()];
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ref[i - 1] !== hyp[j - 1]));
    prev = cur;
  }
  return prev[hyp.length] / ref.length;
}

/** Any audio file (or espeak-ng's speech of `text`) as 16 kHz mono 16-bit PCM. */
const pcmOf = input => execFileSync('ffmpeg', ['-loglevel', 'error', '-i', input, '-f', 's16le', '-ar', String(RATE), '-ac', '1', '-'], {maxBuffer: 1 << 26});
function spoken(text, dir, n) {
  const file = join(dir, `q${n}.wav`);
  execFileSync('espeak-ng', ['-v', 'en-us', '-w', file, text]);
  return pcmOf(file);
}

function memoryOf(pid) {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const mb = field => Math.round(Number(status.match(new RegExp(`${field}:\\s+(\\d+)`))[1]) / 1024);
  return {peak: mb('VmHWM'), own: mb('RssAnon'), mapped: mb('RssFile') + mb('RssShmem')};
}

const seconds = ms => `${(ms / 1000).toFixed(2)} s`;

test('LFM3-Omni hears coding questions and reads an answer aloud, offline on the CPU', {skip, timeout: 3_600_000}, async () => {
  const dataDir = process.env.PAIR_LIVE_OMNI_DATA ?? scratch('omni-live-data-');
  if (omniMissing(dataDir)) {
    console.log(`downloading ${OMNI.name}: ${gb(omniMissing(dataDir))} from Hugging Face (${OMNI.repo}@${OMNI.revision.slice(0, 7)})`);
    await downloadOmni(dataDir);
  }
  const dir = scratch('omni-live-');
  const human = join(dir, 'A1.wav');
  await downloadModel(dir, {model: {repo: OMNI.repo, revision: OMNI.revision, file: HUMAN.file, sha256: HUMAN.sha256}, path: human});
  const fixtures = await (await fetch(`https://huggingface.co/${OMNI.repo}/resolve/${OMNI.revision}/fixtures/fixtures.json`)).json();
  const a1 = fixtures.fixtures.find(fixture => fixture.media?.some(media => media.name === 'A1.wav') && fixture.check?.kind === 'wer');
  const said = JSON.parse(readFileSync(new URL('../../docs/video/audio/said.json', import.meta.url), 'utf8'));
  const clips = [
    ...QUESTIONS.map((text, n) => ({kind: 'espeak-ng', text, pcm: spoken(text, dir, n)})),
    ...NARRATION.map(id => ({kind: 'narration', text: said[id], pcm: pcmOf(new URL(`../../docs/video/audio/${id}.mp3`, import.meta.url).pathname)})),
    ...(a1 ? [{kind: 'human', text: a1.check.reference, pcm: pcmOf(human)}] : []),
  ];

  const python = process.env.PAIR_LIVE_OMNI_PYTHON ?? pythonOf(null, dataDir);
  const omni = new OmniVoice({python, dataDir, log: line => console.log(line)});
  try {
    const firstStarted = Date.now();
    await omni.hear(clips[0].pcm);
    console.log(`first hearing (starts the helper; the very first also packs the weights): ${seconds(Date.now() - firstStarted)}`);
    const rows = [];
    for (const clip of clips) {
      const started = Date.now();
      const heard = (await omni.hear(clip.pcm)).trim();
      const ms = Date.now() - started;
      const audioMs = clip.pcm.length / 2 / RATE * 1000;
      rows.push({...clip, heard, ms, audioMs, wer: wer(clip.text, heard)});
      console.log(`${clip.kind.padEnd(9)} ${seconds(audioMs).padStart(8)} heard in ${seconds(ms)} (${(ms / audioMs).toFixed(2)} s/s), WER ${(100 * wer(clip.text, heard)).toFixed(0)}%: ${heard}`);
    }
    const hearMemory = memoryOf(omni.child.pid);
    for (const kind of ['espeak-ng', 'narration', 'human']) {
      const of = rows.filter(row => row.kind === kind);
      if (!of.length) continue;
      const errors = of.reduce((sum, row) => sum + row.wer * words(row.text).length, 0) / of.reduce((sum, row) => sum + words(row.text).length, 0);
      const rate = of.reduce((sum, row) => sum + row.ms, 0) / of.reduce((sum, row) => sum + row.audioMs, 0);
      console.log(`${kind}: ${of.length} clips, WER ${(100 * errors).toFixed(1)}%, ${rate.toFixed(2)} s per second of speech`);
      // espeak-ng is no human voice ("force attempt" is whisper's worst too, see test/live/voice.test.mjs)
      assert.ok(errors < (kind === 'espeak-ng' ? 0.25 : 0.1), `${kind}: WER ${errors}`);
    }

    const text = saidFiles(speakable(ANSWER)); // as speakOmni says it
    const parts = [];
    const speakStarted = Date.now();
    let firstPartMs = null;
    const speech = omni.speak(sentencesOf(text), {onPart: wav => { firstPartMs ??= Date.now() - speakStarted; parts.push(wav); }});
    await speech.done;
    const speakMs = Date.now() - speakStarted;
    const speakMemory = memoryOf(omni.child.pid);
    const back = Buffer.concat(parts.map((wav, n) => {
      const file = join(dir, `answer-${n}.wav`);
      execFileSync('sh', ['-c', `cat > ${file}`], {input: wav});
      return pcmOf(file);
    }));
    const backMs = back.length / 2 / RATE * 1000;
    const heardBack = (await omni.hear(back.subarray(0, Math.min(back.length, 30 * RATE * 2)))).trim();
    console.log(`read aloud: ${parts.length} parts, ${seconds(backMs)} of speech in ${seconds(speakMs)} (${(speakMs / backMs).toFixed(2)} s/s), first part after ${seconds(firstPartMs)}`);
    console.log(`  said: ${text}\n  heard back: ${heardBack} (WER ${(100 * wer(text, heardBack)).toFixed(0)}%)`);
    console.log(`memory: hearing ${hearMemory.own} MB of its own + ${hearMemory.mapped} MB mapped; with speech ${speakMemory.own} MB + ${speakMemory.mapped} MB mapped; peak ${speakMemory.peak} MB`);
    assert.ok(wer(text, heardBack) < 0.35, 'the speech says the answer');
  } finally {
    omni.close();
  }
});
