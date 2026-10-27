// The chat pane: what a typed line means, and the pane itself across a daemon restart.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {createModels, fauxAssistantMessage, fauxProvider, fauxText} from '@earendil-works/pi-ai';
import {allows, parseInput, remarkLines} from '../src/chat.mjs';
import {formatMessage, trueColor} from '../src/chat-style.mjs';
import {loadConfig} from '../src/config.mjs';
import {openStore} from '../src/store.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {scratch} from './temp.mjs';

const BIN = fileURLToPath(new URL('../bin/pair.mjs', import.meta.url));

test('/scout and /navigate switch the role, /today lists what Pair did; other lines keep their meaning', () => {
  assert.deepEqual(parseInput('/scout'), {type: 'role', role: 'scout'});
  assert.deepEqual(parseInput('  /navigate '), {type: 'role', role: 'navigator'});
  assert.deepEqual(parseInput('/level chatty'), {type: 'level', level: 'chatty'});
  assert.deepEqual(parseInput('/first lease past the last attempt, in queue.go:18'), {type: 'first', text: 'lease past the last attempt, in queue.go:18'});
  assert.deepEqual(parseInput('where else do we set that?'), {type: 'ask', text: 'where else do we set that?'});
  assert.deepEqual(parseInput('/drivel'), {local: 'help'});
  assert.deepEqual(parseInput('/today'), {type: 'today'});
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

test('/remarks lists the last remarks; +2, - 3 and /noise 2 rate one of them by its number', () => {
  assert.deepEqual(parseInput('/remarks'), {type: 'remarks'});
  assert.deepEqual(parseInput('+2'), {type: 'feedback', useful: true, number: 2});
  assert.deepEqual(parseInput('- 3'), {type: 'feedback', useful: false, number: 3});
  assert.deepEqual(parseInput('/noise 2'), {type: 'feedback', useful: false, number: 2});
  assert.deepEqual(parseInput('/useful 1'), {type: 'feedback', useful: true, number: 1});
  assert.deepEqual(parseInput('-10'), {type: 'ask', text: '-10'});
  const now = new Date(2026, 9, 27, 15, 0).getTime();
  assert.deepEqual(remarkLines([
    {id: 9, trigger: 'drift', at: new Date(2026, 9, 27, 14, 5).getTime(), text: 'docs/ is off the goal.', outcome: 'waiting'},
    {id: 7, trigger: 'failed_command', at: new Date(2026, 9, 26, 9, 30).getTime(), text: null, outcome: 'dismissed'},
  ], now), [
    '1  14:05  drift           docs/ is off the goal.  (waiting)',
    '2  10-26 09:30  failed_command  (its words were not kept)  (noise)',
    '+2 or -2 rates the second last, and so on',
  ]);
  assert.deepEqual(remarkLines([], now), ['Pair has made no remark here yet.']);
});

test('only y or yes allows a command', () => {
  for (const line of ['y', 'Y', 'yes', ' YES ']) assert.equal(allows(line), true, line);
  for (const line of ['', 'n', 'no', 'yes please', 'sure', 'yy']) assert.equal(allows(line), false, line);
});

test('Pair\'s name and its code show in the editor\'s accent, in true colour; before the editor sends it, in cyan', () => {
  const teal = trueColor('#7fd1b9');
  assert.equal(teal, '\x1b[38;2;127;209;185m');
  assert.equal(formatMessage('pair', 'Look at `queue.c:18`.', {accent: '#7fd1b9'}), `${teal}pair\x1b[0m Look at ${teal}queue.c:18\x1b[0m.`);
  assert.equal(formatMessage('pair', 'Hi.'), '\x1b[36mpair\x1b[0m Hi.');
  assert.equal(formatMessage('user', 'why `x`?', {accent: '#7fd1b9'}), '\x1b[2myou\x1b[0m why `x`?', 'what you typed, as you typed it');
  assert.equal(formatMessage('system', '`make` passes again.', {color: false}), '·· `make` passes again.', 'without colours, the backticks mark the code');
  assert.equal(formatMessage('pair', 'Is `make test` ok?  Two spaces.', {accent: '#7fd1b9'}), `${teal}pair\x1b[0m Is ${teal}make test\x1b[0m ok?  Two spaces.`, 'spaces as written');
});

test('a long message wraps under its words, not under the name; an indented line is code and stays as it is', () => {
  const text = 'The lease in `queue.c:18` ends as attempt five starts.\nqueue.c:18 suggestion: renew it\n    lease->until = now + ttl;';
  assert.equal(formatMessage('pair', text, {color: false, width: 40}), [
    'pair The lease in `queue.c:18` ends as',
    '     attempt five starts.',
    '     queue.c:18 suggestion: renew it',
    '         lease->until = now + ttl;',
  ].join('\n'));
});

test('the chat pane waits through a daemon restart and carries on, without showing the history twice', {timeout: 20_000}, async () => {
  const dir = scratch('pair-chat-');
  const path = join(dir, 'config.json');
  const entry = {api: 'openai', baseUrl: 'http://unused', model: 'm'};
  writeFileSync(path, JSON.stringify({dataDir: dir, socket: join(dir, 'pair.sock'), agents: false, models: {watcher: entry, partner: entry}}));
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

test('from the chat pane, an older remark is rated from /remarks, and + still rates the last one after a daemon restart', {timeout: 20_000}, async () => {
  const dir = realpathSync(scratch('pair-chat-'));
  const path = join(dir, 'config.json');
  const entry = {api: 'openai', baseUrl: 'http://unused', model: 'm'};
  writeFileSync(path, JSON.stringify({dataDir: dir, socket: join(dir, 'pair.sock'), agents: false, models: {watcher: entry, partner: entry}}));
  const config = loadConfig(path);
  const partner = fauxProvider();
  const models = createModels();
  models.setProvider(partner.provider);
  const start = () => startDaemon(config, {pairModels: {models, watcher: partner.getModel(), partner: partner.getModel()}, probe: async () => ({ok: true}), log: () => {}});
  let daemon = await start();
  const chat = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, 'chat'], {
    cwd: dir,
    env: {...process.env, PAIR_CONFIG: path, XDG_CONFIG_HOME: dir, HERDR_SOCKET_PATH: '', NO_COLOR: '1'},
  });
  let out = '';
  chat.stdout.on('data', data => { out += data; });
  const shown = async (text, count = 1) => {
    for (let i = 0; i < 100 && out.split(text).length - 1 < count; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(out.split(text).length - 1, count, `"${text}" shown ${count} times in:\n${out}`);
  };
  const store = openStore(join(dir, 'sessions.sqlite'));
  const verdicts = () => store.remarks(0).map(remark => remark.verdict);
  try {
    await shown('What are we doing this session?');
    // Two remarks Pair made in this session and showed, with what it said in each.
    const {id: sessionId} = store.activeSession(dir);
    for (const [trigger, words] of [['failed_command', 'The retry count is off by one.'], ['drift', 'docs/ is off the goal.']]) {
      const remark = store.addRemark({sessionId, trigger, score: 8, at: Date.now()});
      store.addAction({sessionId, at: Date.now(), kind: 'said', text: words, data: {remark}});
      store.showRemark(remark);
    }
    chat.stdin.write('/remarks\n');
    await shown('·· 2  ');
    assert.match(out, /·· 1  \d\d:\d\d  drift           docs\/ is off the goal\.  \(waiting\)/);
    assert.match(out, /·· 2  \d\d:\d\d  failed_command  The retry count is off by one\.  \(waiting\)/);
    chat.stdin.write('-2\n');
    await shown('Noted: not useful (remark 2).');
    assert.deepEqual(verdicts(), [null, 'dismissed']);

    await daemon.close();
    await shown('the pair daemon went away; reconnecting…');
    daemon = await start();
    await shown('reconnected');
    chat.stdin.write('+\n');
    await shown('Noted: useful.');
    assert.deepEqual(verdicts(), ['useful', 'dismissed'], 'the last remark of the session, restored from the store');
  } finally {
    store.close();
    chat.kill();
    await daemon.close();
  }
});
