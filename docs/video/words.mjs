// Word timings for the captions: each voiceover file is transcribed with word timestamps (ElevenLabs Scribe,
// through OpenRouter), and each word of script.mjs takes the time of the word it matches, so the captions
// show the script's spelling ("Neovim", "npm") at the time the voice says it. Writes words.json; a line whose
// words are there already, for the same text, is not sent again.
// The key is read at run time from $OPENROUTER_KEY_FILE (default /tmp/openrouter.key) and never printed.
// Usage: node words.mjs
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {allLines} from './script.mjs';

const here = new URL('.', import.meta.url).pathname;
const key = readFileSync(process.env.OPENROUTER_KEY_FILE ?? '/tmp/openrouter.key', 'utf8').trim();
const scenes = allLines();
const norm = word => word.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Pairs script words with heard words by their longest common subsequence; the rest are spread between. */
function align(script, heard) {
  const a = script.map(norm);
  const b = heard.map(word => norm(word.word));
  const lcs = Array.from({length: a.length + 1}, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const times = new Array(a.length).fill(null);
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) times[i++] = [heard[j].start, heard[j++].end];
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  // A script word the voice said differently ("npm" heard as "N P M") gets the gap between its neighbours.
  for (let i = 0; i < times.length; i++) {
    if (times[i]) continue;
    let k = i;
    while (k < times.length && !times[k]) k++;
    const from = times[i - 1]?.[1] ?? heard[0]?.start ?? 0;
    const to = times[k]?.[0] ?? heard.at(-1)?.end ?? from + 0.4 * (k - i);
    const step = (to - from) / (k - i);
    for (let m = i; m < k; m++) times[m] = [from + step * (m - i), from + step * (m - i + 1)];
  }
  return script.map((text, i) => ({text, start: Math.round(times[i][0] * 100) / 100, end: Math.round(times[i][1] * 100) / 100}));
}

const old = existsSync(`${here}words.json`) ? JSON.parse(readFileSync(`${here}words.json`, 'utf8')) : {};
const out = {};
for (const scene of scenes) {
  if (old[scene.id]?.map(word => word.text).join(' ') === scene.text.split(/\s+/).join(' ')) { out[scene.id] = old[scene.id]; continue; }
  const form = new FormData();
  form.set('model', 'elevenlabs/scribe-v2');
  form.set('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.set('file', new Blob([readFileSync(`${here}audio/${scene.id}.mp3`)], {type: 'audio/mpeg'}), `${scene.id}.mp3`);
  const response = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {method: 'POST', headers: {authorization: `Bearer ${key}`}, body: form});
  if (!response.ok) throw new Error(`${scene.id}: ${response.status} ${await response.text()}`);
  const {text, words} = await response.json();
  out[scene.id] = align(scene.text.split(/\s+/), words.filter(word => /\w/.test(word.word)));
  console.log(`${scene.id.padEnd(10)} heard: ${text}`);
}
writeFileSync(`${here}words.json`, `${JSON.stringify(out, null, 0).replace(/\],"/g, '],\n"')}\n`);
