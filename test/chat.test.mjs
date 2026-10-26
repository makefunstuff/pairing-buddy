// The chat pane: what a typed line means, and the pane itself across a daemon restart.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {createModels, fauxAssistantMessage, fauxProvider, fauxText} from '@earendil-works/pi-ai';
import {allows, parseInput} from '../src/chat.mjs';
import {loadConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';

const BIN = fileURLToPath(new URL('../bin/pair.mjs', import.meta.url));

test('/scout and /navigate switch the role; other lines keep their meaning', () => {
  assert.deepEqual(parseInput('/scout'), {type: 'role', role: 'scout'});
  assert.deepEqual(parseInput('  /navigate '), {type: 'role', role: 'navigator'});
  assert.deepEqual(parseInput('/level chatty'), {type: 'level', level: 'chatty'});
  assert.deepEqual(parseInput('where else do we set that?'), {type: 'ask', text: 'where else do we set that?'});
  assert.deepEqual(parseInput('/drivel'), {local: 'help'});
});

test('/drive, "you take it" and "your turn" hand Pair the wheel; the words go along', () => {
  assert.deepEqual(parseInput('/drive'), {type: 'drive', text: ''});
  assert.deepEqual(parseInput('/drive set the timeout to 30 s'), {type: 'drive', text: 'set the timeout to 30 s'});
  assert.deepEqual(parseInput('You take it'), {type: 'drive', text: 'You take it'});
  assert.deepEqual(parseInput('you take it: set the timeout to 30 s'), {type: 'drive', text: 'you take it: set the timeout to 30 s'});
  assert.deepEqual(parseInput('your turn'), {type: 'drive', text: 'your turn'});
  assert.deepEqual(parseInput('can you take it from here?'), {type: 'ask', text: 'can you take it from here?'});
  assert.deepEqual(parseInput('your turnout logic is off'), {type: 'ask', text: 'your turnout logic is off'});
  assert.deepEqual(parseInput('Your turn.'), {type: 'drive', text: 'Your turn.'});
  assert.deepEqual(parseInput('you take it, rename the flag'), {type: 'drive', text: 'you take it, rename the flag'});
  assert.deepEqual(parseInput('your turn to explain: why does this fail?'), {type: 'ask', text: 'your turn to explain: why does this fail?'});
  assert.deepEqual(parseInput('you take it from here or should I?'), {type: 'ask', text: 'you take it from here or should I?'});
});

test('+ and /useful rate Pair\'s last remark useful, - and /noise not useful; a question with a + is still a question', () => {
  assert.deepEqual(parseInput(' + '), {type: 'feedback', useful: true});
  assert.deepEqual(parseInput('/useful'), {type: 'feedback', useful: true});
  assert.deepEqual(parseInput('-'), {type: 'feedback', useful: false});
  assert.deepEqual(parseInput('/noise'), {type: 'feedback', useful: false});
  assert.deepEqual(parseInput('+1 on that'), {type: 'ask', text: '+1 on that'});
  assert.deepEqual(parseInput('- why?'), {type: 'ask', text: '- why?'});
});

test('only y or yes allows a command', () => {
  for (const line of ['y', 'Y', 'yes', ' YES ']) assert.equal(allows(line), true, line);
  for (const line of ['', 'n', 'no', 'yes please', 'sure', 'yy']) assert.equal(allows(line), false, line);
});

test('the chat pane waits through a daemon restart and carries on, without showing the history twice', {timeout: 20_000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pair-chat-'));
  const path = join(dir, 'config.json');
  const entry = {api: 'openai', baseUrl: 'http://unused', model: 'm'};
  writeFileSync(path, JSON.stringify({dataDir: dir, socket: join(dir, 'pair.sock'), models: {watcher: entry, partner: entry}}));
  const config = loadConfig(path);
  const partner = fauxProvider();
  const models = createModels();
  models.setProvider(partner.provider);
  const start = () => startDaemon(config, {pairModels: {models, watcher: partner.getModel(), partner: partner.getModel()}, probe: async () => ({ok: true}), log: () => {}});
  let daemon = await start();
  const chat = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, 'chat'], {
    cwd: dir,
    env: {...process.env, PAIR_CONFIG: path, XDG_CONFIG_HOME: dir, HERDR_SOCKET_PATH: ''},
  });
  let out = '';
  chat.stdout.on('data', data => { out += data; });
  const shown = async (text, count = 1) => {
    for (let i = 0; i < 100 && out.split(text).length - 1 < count; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(out.split(text).length - 1, count, `"${text}" shown ${count} times in:\n${out}`);
  };
  try {
    await shown('What are we doing this session?');
    chat.stdin.write('make the cart total right\n');
    await shown('Goal: make the cart total right');

    await daemon.close();
    await shown('the pair daemon went away; reconnecting…');
    daemon = await start();
    await shown('reconnected');
    partner.setResponses([fauxAssistantMessage([fauxText('Look at cart.js.')])]);
    chat.stdin.write('where do I start?\n');
    await shown('Look at cart.js.');
    await shown('Goal: make the cart total right', 1);
  } finally {
    chat.kill();
    await daemon.close();
  }
});
