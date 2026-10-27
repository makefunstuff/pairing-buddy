// Voiceover: one MP3 per line of voice in script.mjs (both cuts), through OpenRouter's speech endpoint.
// The key is read at run time from $OPENROUTER_KEY_FILE (default /tmp/openrouter.key) and never printed.
// Usage: node tts.mjs [line-or-scene-id ...]   (writes audio/<line id>.mp3; existing files are kept unless named,
// and a file is made again when its line's words changed: audio/said.json keeps what each file says)
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {allLines} from './script.mjs';

const MODEL = 'elevenlabs/eleven-v4';
const VOICE = 'daniel'; // steady and unhurried: the slowest of the voices tried, so the screen can keep up
// How the voice should say words it would otherwise spell out or misread; the script keeps the real names.
const SAY = [[/\bherdr\b/g, 'herder'], [/\bsystemd\b/g, 'system D'], [/\bNeovim\b/g, 'Neo-vim'], [/\bnpm\b/g, 'N P M'], [/\band u\./g, 'and U.'], [/\bu\b(?= undoes| takes)/g, 'U']];
const spoken = text => SAY.reduce((said, [word, sound]) => said.replace(word, sound), text);
const here = new URL('.', import.meta.url).pathname;
const key = readFileSync(process.env.OPENROUTER_KEY_FILE ?? '/tmp/openrouter.key', 'utf8').trim();
const only = process.argv.slice(2);
mkdirSync(`${here}audio`, {recursive: true});
const ledger = existsSync(`${here}audio/said.json`) ? JSON.parse(readFileSync(`${here}audio/said.json`, 'utf8')) : {};

for (const scene of allLines()) {
  const out = `${here}audio/${scene.id}.mp3`;
  const named = only.some(id => scene.id === id || scene.id.startsWith(`${id}-`));
  if (only.length ? !named : existsSync(out) && ledger[scene.id] === scene.text) continue;
  const response = await fetch('https://openrouter.ai/api/v1/audio/speech', {
    method: 'POST',
    headers: {authorization: `Bearer ${key}`, 'content-type': 'application/json'},
    body: JSON.stringify({model: MODEL, voice: VOICE, input: spoken(scene.text), response_format: 'mp3'}),
  });
  if (!response.ok) throw new Error(`${scene.id}: ${response.status} ${await response.text()}`);
  writeFileSync(out, Buffer.from(await response.arrayBuffer()));
  ledger[scene.id] = scene.text;
  writeFileSync(`${here}audio/said.json`, `${JSON.stringify(ledger, null, 1)}\n`);
  console.log(`audio/${scene.id}.mp3`);
}
