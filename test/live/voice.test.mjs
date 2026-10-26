// Push-to-talk end to end with real parts: a spoken question (espeak-ng plays the microphone), whisper.cpp on the
// CPU, and the stack's model answering through the daemon. Needs PAIR_LIVE_WHISPER_MODEL (a ggml model, for example
// ggml-base.en.bin), whisper-cli on PATH or in PAIR_LIVE_WHISPER, espeak-ng and ffmpeg. It prints what whisper heard,
// how long each step took, and the answer.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, test} from 'node:test';
import {parseConfig} from '../../src/config.mjs';
import {startDaemon} from '../../src/daemon.mjs';
import {client} from '../daemon-client.mjs';
import {liveStacks, SKIP_REASON} from './stacks.mjs';

const has = command => { try { execFileSync('sh', ['-c', `command -v ${command}`]); return true; } catch { return false; } };
const model = process.env.PAIR_LIVE_WHISPER_MODEL;
const skip = !liveStacks().length ? SKIP_REASON
  : !model ? 'set PAIR_LIVE_WHISPER_MODEL to a whisper.cpp model'
  : !(has('espeak-ng') && has('ffmpeg')) ? 'needs espeak-ng and ffmpeg to play the microphone'
  : false;

const RETRY_C = `#include <stdbool.h>

#define MAX_ATTEMPTS 5

/* Waits 1, 2, 4, 8 s between attempts, and gives up once the next wait would pass budget_s. */
bool should_retry(int attempt, int elapsed_s, int budget_s) {
    int wait_s = 1 << (attempt - 1);
    if (attempt > MAX_ATTEMPTS) return false;
    if (elapsed_s + wait_s >= budget_s) return false;
    return true;
}
`;
// espeak-ng is no human voice: whisper hears this one well enough ("force attempt" at worst), and the model still understands it.
const QUESTION = 'Why does the fourth attempt give up, when the budget is fifteen seconds?';

describe('push-to-talk with whisper.cpp and a real model', {skip}, () => {
  for (const stack of liveStacks()) {
    test(`${stack.name}: a spoken question is heard and answered under the line`, {timeout: 300_000}, async t => {
      const root = mkdtempSync(join(tmpdir(), 'pair-live-voice-'));
      writeFileSync(join(root, 'retry.c'), RETRY_C);
      const dataDir = mkdtempSync(join(tmpdir(), 'pair-live-voice-data-'));
      // The question as a microphone would give it: raw 16 kHz mono, in real time.
      const record = `espeak-ng -v en-us -s 140 --stdout "${QUESTION}" | ffmpeg -loglevel error -re -i - -f s16le -ar 16000 -ac 1 -`;
      const config = parseConfig({
        dataDir, socket: join(dataDir, 'pair.sock'), keepWarm: false, ...stack.raw,
        voice: {model, whisper: process.env.PAIR_LIVE_WHISPER ?? 'whisper-cli', record},
      });
      const daemon = await startDaemon(config, {log: line => t.diagnostic(`daemon: ${line}`)});
      const editor = client(config.socket, {type: 'hello', role: 'editor', cwd: root});
      try {
        await editor.next(message => message.type === 'welcome');
        editor.send({type: 'goal', text: 'retries use the whole budget'});
        editor.send({type: 'event', event: {kind: 'enter', file: join(root, 'retry.c')}});
        editor.send({type: 'event', event: {kind: 'cursor', file: join(root, 'retry.c'), line: 9, col: 4}});
        const started = Date.now();
        editor.send({type: 'listen', action: 'start'});
        await new Promise(resolve => setTimeout(resolve, 4500)); // the question takes about 3.5 s to say
        const released = Date.now();
        editor.send({type: 'listen', action: 'stop'});
        const heard = await editor.next(message => message.type === 'heard' && message.text !== undefined);
        const heardMs = Date.now() - released;
        const answer = await editor.next(message => message.type === 'answer');
        const levels = editor.received.filter(message => message.type === 'listening').map(message => message.level);
        t.diagnostic(`meter: ${levels.length} levels, loudest ${Math.max(...levels).toFixed(2)}, over ${((released - started) / 1000).toFixed(1)} s`);
        t.diagnostic(`heard ${heardMs} ms after letting go: "${heard.text}"`);
        t.diagnostic(`answered ${((Date.now() - released) / 1000).toFixed(1)} s after letting go: ${answer.text.replace(/\n/g, ' ')}`);
        assert.match(heard.text, /attempt give up,? when the budget is (15|fifteen) seconds/i);
        assert.ok(heardMs < 5000, 'whisper on the CPU hears a short phrase in a few seconds at most, also on a busy machine');
        // Pair may say it in the words under the line, or in the note of the line it points at.
        const points = editor.received.filter(message => message.type === 'point');
        for (const point of points) t.diagnostic(`pointed at retry.c:${point.line}: ${point.note}`);
        const said = [answer.text, ...points.map(point => point.note)].join('\n');
        assert.match(said, />=|\b8\b|eight|16/, 'Pair finds the comparison, or the wait that tips it over');
      } finally {
        editor.close();
        await daemon.close();
      }
    });
  }
});
