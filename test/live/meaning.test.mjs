// Search by meaning with the real model: EmbeddingGemma 2 on LiteRT-LM, local, no keys. Set PAIR_LIVE_MEANING=1 to
// run it; it downloads the model (165 MB, pinned, SHA-256 checked) into PAIR_LIVE_MEANING_DATA, or a temp folder
// without it, and needs litert-lm-api in PAIR_LIVE_MEANING_PYTHON (else a venv there, else python3). It indexes a
// small project and asks it questions worded unlike its code, and prints how long a chunk and a search took.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {pairSearch} from '../../src/search.mjs';
import {scratch} from '../temp.mjs';

const skip = process.env.PAIR_LIVE_MEANING ? false : 'set PAIR_LIVE_MEANING=1 to run search by meaning with the real model';

const FILES = {
  'src/backoff.js': 'export function nextDelay(attempt, base = 250) {\n  const jitter = Math.random() * base\n  return Math.min(30_000, base * 2 ** attempt + jitter)\n}\n',
  'src/cart.js': 'export function total(cart) {\n  return cart.items.reduce((sum, item) => sum + item.cents * item.quantity, 0)\n}\n',
  'src/session.js': 'export function expired(session, now = Date.now()) {\n  return now - session.lastSeenAt > 30 * 60_000\n}\n',
  'src/slug.js': "export const slug = title => title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')\n",
  'src/csv.js': "export function rows(text) {\n  return text.trim().split('\\n').map(line => line.split(',').map(cell => cell.trim()))\n}\n",
  'src/avatar.js': "export function initials(name) {\n  return name.split(/\\s+/).filter(Boolean).map(word => word[0].toUpperCase()).slice(0, 2).join('')\n}\n",
};
const QUESTIONS = [
  ['how long to wait before trying the request again', 'src/backoff.js'],
  ['what does the customer owe for everything in the basket', 'src/cart.js'],
  ['log the user out when they have been away too long', 'src/session.js'],
  ['turn a blog post heading into something safe for a URL', 'src/slug.js'],
  ['read a spreadsheet export into a table', 'src/csv.js'],
  ['two letters to show when someone has no profile picture', 'src/avatar.js'],
];

test('EmbeddingGemma 2 finds code from questions worded unlike it', {skip, timeout: 600_000}, async () => {
  const root = realpathSync(scratch('meaning-live-'));
  mkdirSync(join(root, 'src'));
  for (const [file, text] of Object.entries(FILES)) writeFileSync(join(root, file), text);
  execFileSync('git', ['init', '-q'], {cwd: root});
  const dataDir = process.env.PAIR_LIVE_MEANING_DATA ?? scratch('meaning-live-data-');
    const {meaning} = pairSearch({config: {dataDir, meaning: process.env.PAIR_LIVE_MEANING_PYTHON ? {python: process.env.PAIR_LIVE_MEANING_PYTHON} : {}}, log: line => console.log(line)});
  try {
    meaning.open(root); // the project has a session
    await meaning.turnOn();
    const started = Date.now();
    await meaning.indexes.get(root).ready;
    const built = () => !meaning.working && meaning.indexes.get(root).pending().length === 0;
    while (!built() && !meaning.problem && Date.now() - started < 120_000) await new Promise(resolve => setTimeout(resolve, 200));
    assert.ok(!meaning.problem, meaning.problem ?? '');
    console.log(`indexed ${meaning.indexes.get(root).progress().chunks} chunks in ${Date.now() - started} ms · ${Math.round(meaning.embedder.msPerText)} ms a chunk`);
    let top1 = 0;
    for (const [question, file] of QUESTIONS) {
      const started = Date.now();
      const {results} = await meaning.search(root, question);
      const rank = results.findIndex(result => result.file === file) + 1;
      console.log(`${rank ? `#${rank}` : 'missed'}  ${Date.now() - started} ms  "${question}" → ${results[0]?.file} (${results[0]?.meaning})`);
      if (rank === 1) top1 += 1;
      assert.ok(rank >= 1 && rank <= 3, `${file} in the first three for "${question}"`);
    }
    console.log(`first for ${top1} of ${QUESTIONS.length} questions`);
  } finally {
    await meaning.close();
  }
});
