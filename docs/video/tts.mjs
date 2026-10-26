// Voiceover: one MP3 per scene of narration.json, through OpenRouter's speech endpoint.
// The key is read at run time from $OPENROUTER_KEY_FILE (default /tmp/openrouter.key) and never printed.
// Usage: node tts.mjs [scene-id ...]   (writes audio/<id>.mp3; existing files are kept unless named)
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';

const MODEL = 'elevenlabs/eleven-v4';
const VOICE = 'daniel'; // steady and unhurried: the slowest of the voices tried, so the screen can keep up
// How the voice should say words it would otherwise spell out or misread; the script keeps the real names.
const SAY = [[/\bherdr\b/g, 'herder'], [/\bsystemd\b/g, 'system D'], [/\bNeovim\b/g, 'Neo-vim'], [/\bnpm\b/g, 'N P M'], [/\band u\./g, 'and U.']];
const spoken = text => SAY.reduce((said, [word, sound]) => said.replace(word, sound), text);
const here = new URL('.', import.meta.url).pathname;
const key = readFileSync(process.env.OPENROUTER_KEY_FILE ?? '/tmp/openrouter.key', 'utf8').trim();
const scenes = JSON.parse(readFileSync(`${here}narration.json`, 'utf8'));
const only = process.argv.slice(2);
mkdirSync(`${here}audio`, {recursive: true});

for (const scene of scenes) {
  const out = `${here}audio/${scene.id}.mp3`;
  if (only.length ? !only.includes(scene.id) : existsSync(out)) continue;
  const response = await fetch('https://openrouter.ai/api/v1/audio/speech', {
    method: 'POST',
    headers: {authorization: `Bearer ${key}`, 'content-type': 'application/json'},
    body: JSON.stringify({model: MODEL, voice: VOICE, input: spoken(scene.text), response_format: 'mp3'}),
  });
  if (!response.ok) throw new Error(`${scene.id}: ${response.status} ${await response.text()}`);
  writeFileSync(out, Buffer.from(await response.arrayBuffer()));
  console.log(`audio/${scene.id}.mp3`);
}
