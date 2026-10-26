// The music bed: one instrumental track from Google's Lyria 3 through OpenRouter, streamed and saved as
// audio/music.<format>. The key is read at run time from $OPENROUTER_KEY_FILE (default /tmp/openrouter.key).
// Usage: node music.mjs
import {readFileSync, writeFileSync} from 'node:fs';

const here = new URL('.', import.meta.url).pathname;
const key = readFileSync(process.env.OPENROUTER_KEY_FILE ?? '/tmp/openrouter.key', 'utf8').trim();
const PROMPT = 'Instrumental only, no vocals. A calm, focused electronic bed for a software tutorial with a voiceover: '
  + 'soft felt piano, warm analog pad, a gentle brushed beat at 90 BPM. Sparse and steady, no drops, no lead melody '
  + 'that competes with speech. About three minutes long, ending on a soft resolving fade.';

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
writeFileSync(`${here}audio/music.${format}`, Buffer.concat(chunks));
console.log(`audio/music.${format}`);
