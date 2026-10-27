// The music bed, chiptune to match the video's old-console look: one instrumental track from Google's Lyria 3 through OpenRouter, streamed and saved as
// audio/music.mp3 (the take again and again, crossfaded, for as long as the tutorial). The key is read at run time from $OPENROUTER_KEY_FILE (default /tmp/openrouter.key).
// Usage: node music.mjs
import {execFileSync} from 'node:child_process';
import {readFileSync, renameSync, writeFileSync} from 'node:fs';

const here = new URL('.', import.meta.url).pathname;
const key = readFileSync(process.env.OPENROUTER_KEY_FILE ?? '/tmp/openrouter.key', 'utf8').trim();
const PROMPT = 'Instrumental only, no vocals. A calm 8-bit chiptune bed for a software tutorial with a voiceover, in the '
  + 'style of an old game console: soft square and triangle waves, gentle slow arpeggios at 85 BPM, a quiet noise-channel '
  + 'hi-hat. Sparse and steady, no drops, no lead melody that competes with speech. Gentle changes every minute or so; '
  + 'it should loop smoothly end to start.';

const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {authorization: `Bearer ${key}`, 'content-type': 'application/json'},
  body: JSON.stringify({model: 'google/lyria-3-pro-preview', modalities: ['text', 'audio'], stream: true, messages: [{role: 'user', content: PROMPT}]}),
});
if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
const chunks = [];
let format = 'mp3';
let buffer = '';
for await (const part of response.body.pipeThrough(new TextDecoderStream())) {
  buffer += part;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const audio = JSON.parse(line.slice(6)).choices?.[0]?.delta?.audio;
    if (audio?.data) chunks.push(Buffer.from(audio.data, 'base64'));
    if (audio?.format) format = audio.format;
  }
}
if (!chunks.length) throw new Error('no audio in the answer');
// Lyria's takes run about three minutes: the film's bed is the take five times (about fifteen minutes), each joined
// to the next with an 8 s crossfade.
const take = `${here}audio/take.${format}`;
writeFileSync(take, Buffer.concat(chunks));
const TIMES = 5;
const fades = Array.from({length: TIMES - 1}, (_, i) => `${i ? `[m${i}]` : '[0]'}[${i + 1}]acrossfade=d=8:c1=tri:c2=tri${i === TIMES - 2 ? '' : `[m${i + 1}]`}`).join(';');
execFileSync('ffmpeg', ['-v', 'error', '-y', ...Array.from({length: TIMES}, () => ['-i', take]).flat(), '-filter_complex', fades, '-b:a', '96k', `${here}audio/music.tmp.mp3`]);
renameSync(`${here}audio/music.tmp.mp3`, `${here}audio/music.mp3`);
execFileSync('rm', [take]);
console.log('audio/music.mp3');
