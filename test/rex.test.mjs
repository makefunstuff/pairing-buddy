// Tests of Rex as a backend (src/rex.mjs, src/rex-ws.mjs): the source of panes, the pane host, the chat opener, the
// status probe and the WebSocket client, against a stand-in for Rex's control API (test/fake-rex.mjs). No model.
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {test} from 'node:test';
import {PaneWatch, Panes} from '../src/pane-watch.mjs';
import {blockOf, openRexChat, PREFIX, RexClient, RexPaneHost, RexPanes, rexOf, rexPane, rexStatus} from '../src/rex.mjs';
import {connectWebSocket} from '../src/rex-ws.mjs';
import {fakeRex, listenWebSocket, login, SESSION, shell} from './fake-rex.mjs';
import {socketDir} from './temp.mjs';

/** Resolves once `check()` is true; fails the test after three seconds. */
async function until(check, what) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const running = (name, pid = 900) => ({pid, user_id: 502, user: 'u', name, path: `/usr/bin/${name}`, argv0: name, cwd: '/'});

/** A fake Rex on a socket of its own, closed when test `t` ends. */
async function rexWith(t, options) {
  const socketPath = join(socketDir('pair-rex-'), 'rex.sock');
  const rex = await fakeRex(socketPath, options);
  t.after(() => rex.close());
  return {rex, socketPath};
}

/** RexPanes on a fake Rex, started with a counting `look`; stopped when test `t` ends. */
async function panesOn(t, options) {
  const {rex, socketPath} = await rexWith(t, options);
  const panes = new RexPanes({socketPath, session: SESSION});
  const seen = {looks: 0, failures: []};
  panes.start(() => seen.looks++, () => { throw new Error('Rex never says a pane scrolled'); }, error => seen.failures.push(error));
  t.after(() => panes.stop());
  await until(() => seen.looks === 1, 'the first look, on attach');
  return {rex, panes, seen, socketPath};
}

test('rexOf: the socket path, session and block of a Rex terminal; null unless all three are set', () => {
  const env = {REX_SERVER: 'unix:///Users/me/Library/Application%20Support/rex/server.sock', REX_SESSION: 'session:1', REX_BLOCK: 'block:2'};
  assert.deepEqual(rexOf(env), {server: '/Users/me/Library/Application Support/rex/server.sock', session: 'session:1', block: 'block:2'});
  for (const missing of Object.keys(env)) assert.equal(rexOf({...env, [missing]: undefined}), null, missing);
  assert.equal(rexOf({}), null);
  assert.equal(rexOf({...env, REX_SERVER: 'tcp://host:1234'}), null, 'only a local server has a socket path');
});

test('ids are namespaced, and the block comes back out of one', () => {
  assert.equal(rexPane('block:01a1'), 'rex:block:01a1');
  assert.equal(blockOf('rex:block:01a1'), 'block:01a1');
  assert.equal(PREFIX, 'rex:');
});

test('list: the terminals in the session\'s windows, namespaced, the focused one marked; a detached block is not there', async t => {
  const {panes, rex} = await panesOn(t, {blocks: ['block:b1', {id: 'block:b2', detached: true}, 'block:b3', {id: 'block:viewer', flavor: 'com.example.viewer'}], focused: 'block:b3'});
  assert.equal(panes.owns('rex:block:b1'), true);
  assert.equal(panes.owns('nvim:5:3'), false);
  assert.deepEqual(await panes.list(), [
    {pane: 'rex:block:b1', focused: false, scrolled: false, weight: 1},
    {pane: 'rex:block:b3', focused: true, scrolled: false, weight: 1},
  ]);
  rex.focus('block:b1');
  assert.deepEqual((await panes.list()).map(pane => pane.focused), [true, false]);
  assert.equal(panes.canType('rex:block:b1'), true);
});

test('look: on attach, and on blocks coming and going, the window changing, a newer view and a process, title or directory change', async t => {
  const {rex, seen} = await panesOn(t);
  const next = async (what, push) => {
    const before = seen.looks;
    push();
    await until(() => seen.looks === before + 1, what);
    await sleep(50);
    assert.equal(seen.looks, before + 1, `${what}: once`);
  };
  await next('block_created', () => rex.event('block_created', {block_id: 'block:x'}));
  await next('block_closed', () => rex.event('block_closed', {block_id: 'block:x'}));
  await next('active_window_changed', () => rex.event('active_window_changed', {window_id: 'window:w2'}));
  await next('a newer view', () => rex.viewChanged(10));
  for (const name of ['process_changed', 'title_changed', 'pwd_changed']) {
    await next(name, () => rex.blockEvent('block:b1', name, name === 'process_changed' ? {generation: 50, foreground: shell(100), ancestors: [login]} : {}));
  }
  const before = seen.looks;
  rex.viewChanged(10); // the same revision again, and an older one: changes already seen
  rex.viewChanged(3);
  rex.blockEvent('block:b1', 'size_changed', {columns: 80, rows: 24});
  rex.event('client_connected', {});
  await sleep(150);
  assert.equal(seen.looks, before, 'nothing that cannot change the panes looks again');
});

test('a dropped connection is a failure, and the next attach looks again', async t => {
  const {rex, seen} = await panesOn(t);
  rex.drop();
  await until(() => seen.failures.length === 1, 'the failure');
  assert.equal(seen.failures[0].code, 'closed');
  await until(() => seen.looks === 2 && rex.clients === 1, 'the look after re-attaching'); // after RETRY_MS
});

test('a server that is not there fails and is tried again, until Rex is back', async t => {
  const socketPath = join(socketDir('pair-rex-'), 'rex.sock');
  const panes = new RexPanes({socketPath, session: SESSION});
  const seen = {looks: 0, failures: []};
  panes.start(() => seen.looks++, () => {}, error => seen.failures.push(error));
  t.after(() => panes.stop());
  await until(() => seen.failures.length === 1, 'the first failure');
  assert.equal(seen.looks, 0);
  const rex = await fakeRex(socketPath);
  t.after(() => rex.close());
  await until(() => seen.looks === 1, 'the look once Rex is up');
});

test('commandOf: null at the prompt, the command while one runs, an editor as nvim', async t => {
  const {rex, panes} = await panesOn(t, {blocks: ['block:b1', 'block:b2']});
  const pane = rexPane('block:b1');
  assert.equal(await panes.commandOf(pane), null);
  rex.process('block:b1', running('sleep'), [shell(100), login]);
  let command;
  await until(() => { panes.commandOf(pane).then(found => { command = found; }); return command === 'sleep'; }, 'sleep from the pushed process');
  const asked = rex.requests('com.superlogical.terminal.process').length;
  assert.equal(await panes.commandOf(pane), 'sleep');
  assert.equal(rex.requests('com.superlogical.terminal.process').length, asked, 'the pushed event is the cache: no request');
  rex.process('block:b1', running('nvim'), [shell(100), login]);
  await until(() => { panes.commandOf(pane).then(found => { command = found; }); return command === 'nvim'; }, 'nvim');
  rex.process('block:b1', shell(100), [login]);
  await until(() => { panes.commandOf(pane).then(found => { command = found; }); return command === null; }, 'the prompt again');
  // A terminal the watch heard nothing of is asked.
  rex.blocks.get('block:b2').process = {foreground: running('make'), ancestors: [shell(101), login]};
  assert.equal(await panes.commandOf(rexPane('block:b2')), 'make');
  // A shell started by a shell is a command, and the shell's script is part of its name.
  rex.blocks.get('block:b2').process = {foreground: {...shell(300), name: 'bash', script: '/tmp/build.sh'}, ancestors: [shell(101), login]};
  panes.processes.clear();
  assert.equal(await panes.commandOf(rexPane('block:b2')), 'bash /tmp/build.sh');
  // Without a script Rex shows the argument the shell was started with, unless that is only the shell's own name.
  for (const [argv0, label] of [['build.sh', 'bash build.sh'], ['bash', 'bash'], ['-bash', 'bash']]) {
    rex.blocks.get('block:b2').process = {foreground: {...shell(300), name: 'bash', argv0}, ancestors: [shell(101), login]};
    panes.processes.clear();
    assert.equal(await panes.commandOf(rexPane('block:b2')), label);
  }
});

test('commandOf: a process change that arrives while the query is out is not overwritten by its older answer', async t => {
  const {rex, panes} = await panesOn(t);
  const asked = Promise.withResolvers();
  const ask = panes.client.terminal.bind(panes.client);
  panes.client.terminal = (id, method, ...rest) => method === 'process' ? asked.promise : ask(id, method, ...rest);
  const pane = rexPane('block:b1');
  const answer = panes.commandOf(pane);
  rex.process('block:b1', running('nvim'), [shell(100), login]);
  await until(() => panes.processes.has('block:b1'), 'the pushed process');
  asked.resolve({foreground: shell(100), ancestors: [login]}); // the shell at its prompt, as it was when asked
  assert.equal(await answer, 'nvim');
  assert.equal(await panes.commandOf(pane), 'nvim');
});

test('paneOfShell: the pane whose shell has that pid, at the prompt and while a command runs', async t => {
  const {rex, panes} = await panesOn(t, {blocks: ['block:b1', 'block:b2']});
  assert.equal(panes.paneOfShell(100), null, 'nothing before the first list');
  await panes.list();
  assert.equal(panes.paneOfShell(100), 'rex:block:b1');
  assert.equal(panes.paneOfShell(101), 'rex:block:b2');
  assert.equal(panes.paneOfShell(1), null, 'login is not a shell');
  assert.equal(panes.paneOfShell(4242), null);
  rex.process('block:b1', running('sleep', 777), [shell(100), login]);
  await until(() => panes.processes.get('block:b1')?.foreground.name === 'sleep', 'the event');
  await panes.list();
  assert.equal(panes.paneOfShell(100), 'rex:block:b1', 'the shell is an ancestor now');
  assert.equal(panes.paneOfShell(777), null, 'the command is not a shell');
  rex.closed('block:b2');
  await panes.list();
  assert.equal(panes.paneOfShell(101), null);
});

test('paneOfShell: of several shells one inside the other, the one a command runs in, not the ones around it', async t => {
  const {rex, panes} = await panesOn(t);
  const bash = pid => ({...shell(pid), name: 'bash', argv0: 'bash'});
  // bash 301 runs a script, started from zsh 101, itself started from bash 51 under login.
  rex.blocks.get('block:b1').process = {foreground: bash(301), ancestors: [shell(101), bash(51), login]};
  panes.processes.clear();
  await panes.list();
  assert.equal(panes.paneOfShell(101), 'rex:block:b1');
  assert.equal(panes.paneOfShell(301), null);
  assert.equal(panes.paneOfShell(51), null);
  assert.equal(panes.paneOfShell(1), null);
});

test('list: a failed process request fails the list and keeps the shells of the last one; a block closed meanwhile is only skipped', async t => {
  const {rex, panes} = await panesOn(t, {blocks: ['block:b1', 'block:b2']});
  await panes.list();
  assert.equal(panes.paneOfShell(100), 'rex:block:b1');
  panes.processes.clear();
  rex.fail('com.superlogical.terminal.process', 'internal');
  await assert.rejects(panes.list(), {code: 'internal'});
  assert.equal(panes.paneOfShell(100), 'rex:block:b1', 'the last good inventory stays');
  rex.fail('com.superlogical.terminal.process', 'not_found');
  assert.equal((await panes.list()).length, 2, 'a block that is gone is not a failure');
  assert.equal(panes.paneOfShell(100), null);
});

test('read: the last lines, unwrapped, without the blank rows below the prompt; send: the exact text, no Enter', async t => {
  const {rex, panes} = await panesOn(t);
  const pane = rexPane('block:b1');
  rex.blocks.get('block:b1').lines = ['one', 'two', 'a line the terminal wrapped but Rex joins', '$ npm test'];
  assert.equal(await panes.read(pane, 2), 'a line the terminal wrapped but Rex joins\n$ npm test');
  assert.equal(await panes.read(pane, 100), 'one\ntwo\na line the terminal wrapped but Rex joins\n$ npm test');
  assert.deepEqual(rex.requests('com.superlogical.terminal.format').at(-1).args, {format: 'text', trim: true, unwrap: true, max_bytes: 65536});
  assert.equal(await panes.read(pane, 0), '', 'no lines is none, not all');
  await panes.send(pane, 'npm test');
  await panes.send(pane, 'git status');
  assert.deepEqual(rex.typed, [['block:b1', 'npm test'], ['block:b1', 'git status']]);
});

test('read: the tail of a scrollback larger than a control message', async t => {
  const {rex, panes} = await panesOn(t);
  const pane = rexPane('block:b1');
  const lines = Array.from({length: 40000}, (_, i) => `line ${i} of the build output, long enough to fill a megabyte`);
  lines.push('$ make');
  rex.blocks.get('block:b1').lines = lines;
  assert.ok(lines.join('\n').length > 1048576, 'more than Rex sends in one message');
  assert.equal(await panes.read(pane, 3), 'line 39998 of the build output, long enough to fill a megabyte\nline 39999 of the build output, long enough to fill a megabyte\n$ make');
  assert.equal((await panes.read(pane, 1000)).split('\n').length, 1000);
});

test('read: the requested number of complete lines, however long they are', async t => {
  const {rex, panes} = await panesOn(t);
  const pane = rexPane('block:b1');
  const show = lines => { rex.blocks.get('block:b1').lines = lines; };
  const ordinary = Array.from({length: 1200}, (_, i) => `line ${i} `.padEnd(95, 'x'));
  show([...ordinary, '$ ']);
  const thousand = (await panes.read(pane, 1000)).split('\n');
  assert.equal(thousand.length, 1000);
  assert.equal(thousand[0], ordinary[201], 'the first of them is whole');
  assert.equal(thousand.at(-1), '$', 'the prompt, trailing space trimmed');
  show(['$ ls', 'y'.repeat(70000)]);
  assert.equal(await panes.read(pane, 1), 'y'.repeat(70000), 'one line larger than the window asked for at once');
  assert.equal(await panes.read(pane, 2), `$ ls\n${'y'.repeat(70000)}`);
  // 'head\n' + a + '\n' + b + '\n' is 65541 bytes with the three newlines the fake adds: the last 65536 start just after the first newline.
  show(['head', 'a'.repeat(32767), 'b'.repeat(32765)]);
  assert.equal(await panes.read(pane, 2), `${'a'.repeat(32767)}\n${'b'.repeat(32765)}`, 'a line that starts exactly at the window is not dropped');
  assert.equal(await panes.read(pane, 3), `head\n${'a'.repeat(32767)}\n${'b'.repeat(32765)}`);
});

test('the fake cuts output on a budget of JSON-encoded bytes, between characters', async t => {
  const {rex, socketPath} = await rexWith(t);
  const client = new RexClient({socketPath, session: SESSION});
  await client.connect();
  t.after(() => client.stop());
  rex.blocks.get('block:b1').lines = ['\u00e9\u00e9"']; // two characters of 2 bytes, then a quote
  const whole = Buffer.from('\u00e9\u00e9"\n\n\n');
  const first = await client.terminal('block:b1', 'format', {max_bytes: 3});
  assert.deepEqual({content: first.content, total: first.total, eof: first.eof}, {content: '\u00e9', total: whole.length, eof: false});
  const parts = [first.content];
  for (let at = Buffer.byteLength(first.content); at < whole.length;) {
    const part = await client.terminal('block:b1', 'blob_read', {id: first.id, offset: at, max_bytes: 3});
    assert.ok(part.data !== '' && Buffer.byteLength(JSON.stringify(part.data)) - 2 <= 3, 'within the budget of encoded bytes');
    assert.ok(!part.data.includes('\ufffd'), 'no character cut in two');
    parts.push(part.data);
    at += Buffer.byteLength(part.data);
  }
  assert.equal(parts.join(''), whole.toString());
});

test('the fake reads a blob as the real Rex does: strays become one U+FFFD each, the budget is in encoded bytes', async t => {
  const {rex, socketPath} = await rexWith(t);
  const client = new RexClient({socketPath, session: SESSION});
  await client.connect();
  t.after(() => client.stop());
  rex.blocks.get('block:b1').lines = ['\u20ac'.repeat(2000), 'end']; // E2 82 AC, 2000 times, then "\nend\n\n\n"
  const {id, total} = await client.terminal('block:b1', 'format', {max_bytes: 99});
  assert.equal(total, 6000 + 1 + 3 + 3);
  const read = async (offset, max_bytes) => (await client.terminal('block:b1', 'blob_read', {id, offset, max_bytes})).data;
  const euro = '\u20ac';
  const stray = '\ufffd';
  // [offset, max_bytes, data] as measured on Rex 0.0.1793645657 (API rev 10), with offsets from the start of a character
  const measured = [
    [99, 12, euro.repeat(4)],
    [100, 12, stray.repeat(2) + euro.repeat(3)],
    [101, 12, stray + euro.repeat(3)],
    [100, 1, stray],
    [100, 2, stray.repeat(2)],
    [100, 3, stray.repeat(2)],
    [99, 7, euro.repeat(2)],
    [99, 8, euro.repeat(2)],
    [99, 1, euro], // a reply holds at least one character, and a genuine U+FFFD is no different from a euro sign
  ];
  for (const [offset, max, data] of measured) assert.equal(await read(offset, max), data, `offset ${offset}, max_bytes ${max}`);
  const reply = await client.terminal('block:b1', 'blob_read', {id, offset: 99, max_bytes: 12});
  assert.equal(reply.eof, false);
  // 20 000 lines of ten source bytes, as measured live: a newline costs 2 encoded bytes, so a reply is short of its budget
  rex.blocks.get('block:b1').lines = Array.from({length: 20000}, () => 'x'.repeat(9));
  const lined = await client.terminal('block:b1', 'format', {max_bytes: 1000});
  assert.equal(Buffer.byteLength(lined.content), 909);
  assert.equal(lined.total, 200002, 'the fake adds three newlines to the 199999 bytes of lines');
  for (const [max, source] of [[100, 91], [110, 100], [65536, 59579]]) {
    const part = await client.terminal('block:b1', 'blob_read', {id: lined.id, offset: 0, max_bytes: max});
    assert.equal(Buffer.byteLength(part.data), source, `max_bytes ${max}`);
  }
  rex.blocks.get('block:b1').lines = ['"a"\\"b"'.repeat(40)]; // quotes and backslashes cost 2 as well
  const quoted = await client.terminal('block:b1', 'format', {max_bytes: 10});
  assert.equal(quoted.content, '"a"\\"b"'.repeat(40).slice(0, 6), 'six characters weigh ten encoded bytes: the quotes and backslash cost two each');
  assert.equal((await client.terminal('block:b1', 'blob_read', {id, offset: 6000, max_bytes: 12})).eof, true);
});

test('read: a tail of multibyte lines gathered from several blob replies', async t => {
  const {rex, panes} = await panesOn(t);
  const lines = Array.from({length: 4000}, (_, i) => `${i} \u00e9\u00e8\u4e16\u754c\ud83d\ude00 ${'z'.repeat(i % 7)}`);
  rex.blocks.get('block:b1').lines = lines;
  const read = await panes.read(rexPane('block:b1'), 3000);
  assert.deepEqual(read.split('\n'), lines.slice(-3000));
  assert.ok(rex.requests('com.superlogical.terminal.blob_read').length > 1, 'more than one reply');
});

test('read: the window of the last 65536 bytes begins inside a character', async t => {
  const {rex, panes} = await panesOn(t);
  const pane = rexPane('block:b1');
  // 4000 lines of 31 bytes (3 for each of ten characters, one newline); a last line of `pad` bytes and the three
  // newlines the fake adds move the window: pad 0 puts its first byte on the second byte of a character, pad 1 on the third.
  for (const pad of [0, 1]) {
    const lines = [...Array.from({length: 4000}, () => '\u4e16'.repeat(10)), 'x'.repeat(pad)];
    rex.blocks.get('block:b1').lines = lines;
    const text = Buffer.from(`${lines.join('\n')}\n\n\n`);
    assert.equal(text[text.length - 65536] & 0xc0, 0x80, `pad ${pad}: the window starts on a continuation byte`);
    const whole = lines.join('\n').replace(/\s+$/, '').split('\n');
    for (const count of [1, 50, 2500]) { // 2500 lines need a second window backward
      const read = await panes.read(pane, count);
      assert.ok(!read.includes('\ufffd'), `pad ${pad}, ${count} lines: no replacement character`);
      assert.deepEqual(read.split('\n'), whole.slice(-count), `pad ${pad}, ${count} lines`);
    }
  }
});

/**
 * Lines whose last 65536 bytes (the window `read` starts from) begin `skip` bytes after the start of `run`, a line:
 * the lines after `run` are filler of 20 bytes each, sized to make it so, then `tail`. With `windows` 2 it is the
 * second window backward that starts there.
 */
function windowAt(run, skip, tail, windows = 1) {
  const bytes = lines => Buffer.byteLength(`${lines.join('\n')}\n\n\n`);
  const needed = 65536 * windows + skip - Buffer.byteLength(run) - 1 - bytes(tail);
  assert.ok(needed >= 0);
  const filler = Array.from({length: Math.floor(needed / 20)}, () => 'f'.repeat(19));
  if (needed % 20) filler.push('f'.repeat(needed % 20 - 1));
  const before = Array.from({length: 300}, (_, i) => `before ${i}`); // the lines of a second window backward
  const lines = [...before, run, ...filler, ...tail];
  const start = Buffer.byteLength(`${[...before, ''].join('\n')}`); // where `run` begins
  assert.equal(Buffer.byteLength(`${lines.join('\n')}\n\n\n`) - 65536 * windows, start + skip, 'the window begins where the test says');
  return lines;
}

const linesOf = lines => lines.join('\n').replace(/\s+$/, '').split('\n');

test('read: a genuine U+FFFD exactly at the start of the window is text, not a stray byte', async t => {
  const {rex, panes} = await panesOn(t);
  const pane = rexPane('block:b1');
  const prompt = ['$']; // alone: the first window starts on the U+FFFD, the prompt is in it
  const lines = windowAt('\ufffdrrrrrr', 0, prompt);
  rex.blocks.get('block:b1').lines = lines;
  assert.equal(await panes.read(pane, 1), '$');
  for (const count of [3, lines.length - 300 + 5]) assert.deepEqual((await panes.read(pane, count)).split('\n'), linesOf(lines).slice(-count), `${count} lines`);
  // and the U+FFFD that starts the second window backward, whose end is the first one's start
  const deep = windowAt('\ufffdrrrrrr', 0, [...Array.from({length: 3000}, () => 'x'.repeat(19)), '$'], 2);
  rex.blocks.get('block:b1').lines = deep;
  for (const count of [1, 3001, 3300, deep.length - 300 + 5]) assert.deepEqual((await panes.read(pane, count)).split('\n'), linesOf(deep).slice(-count), `deep, ${count} lines`);
});

test('read: a window starting 1 to 8 bytes into a run of genuine U+FFFD', async t => {
  const {rex, panes} = await panesOn(t);
  const pane = rexPane('block:b1');
  for (let skip = 1; skip <= 8; skip++) {
    const lines = windowAt('\ufffd'.repeat(20), skip, ['$ ls', '$']);
    rex.blocks.get('block:b1').lines = lines;
    for (const count of [1, 1200, lines.length - 300 + 5]) { // the last reaches back past the run
      assert.deepEqual((await panes.read(pane, count)).split('\n'), linesOf(lines).slice(-count), `skip ${skip}, ${count} lines`);
    }
  }
});

test('read: a binary dump of about 45 % U+FFFD, then a command and a prompt, in 24 layouts', async t => {
  const {rex, panes} = await panesOn(t);
  const pane = rexPane('block:b1');
  let seed = 12345;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let layout = 0; layout < 24; layout++) {
    let dump = '';
    while (Buffer.byteLength(dump) < 90000 + Math.floor(random() * 3000)) {
      dump += random() < 0.02 ? '\n' : random() < 0.45 ? '\ufffd' : String.fromCharCode(33 + Math.floor(random() * 90));
    }
    const lines = [...dump.split('\n').map(line => line || '.'), '$ ls -l', 'a.out  b.c', '$'];
    rex.blocks.get('block:b1').lines = lines;
    for (const count of [1, 50]) {
      assert.deepEqual((await panes.read(pane, count)).split('\n'), linesOf(lines).slice(-count), `layout ${layout}, ${count} lines`);
    }
  }
});

test('a request that fails rejects with Rex\'s error code, and one never answered times out', async t => {
  const {rex, socketPath} = await rexWith(t);
  const client = new RexClient({socketPath, session: SESSION});
  await client.connect();
  t.after(() => client.stop());
  await assert.rejects(client.call('block.close', {block_id: 'block:nope'}), {code: 'not_found'});
  rex.fail('session.view', 'internal');
  await assert.rejects(client.call('session.view'), {code: 'internal'});
  rex.hang('session.list_blocks');
  await assert.rejects(client.call('session.list_blocks', {}, {timeoutMs: 100}), {code: 'timeout'});
  client.stop();
  await assert.rejects(client.call('session.view'), {code: 'not_connected'});
  const wrong = new RexClient({socketPath, session: 'session:other'});
  await assert.rejects(wrong.connect(), {code: 'session_not_found'});
});

test('RexPaneHost: opens a pane below the chat, finds it again after a restart, types into it and closes it', async t => {
  const {rex, socketPath} = await rexWith(t, {blocks: ['block:chat', 'block:user']});
  const host = () => new RexPaneHost({socketPath, session: SESSION, besidePane: rexPane('block:chat'), root: '/work/project'});
  const first = host();
  assert.equal(first.key, `rex:${SESSION}`);
  assert.deepEqual(first.hidden, [socketPath]);
  assert.equal(await first.find(), null);
  const pane = await first.open({cwd: '/work/project', line: 'exec bash -i'});
  assert.match(pane, /^rex:block:/);
  assert.deepEqual(rex.requests('session.new_split'), [{
    session_id: SESSION, anchor_id: 'block:chat', direction: 'vertical', side: 'after', ratio: 0.5, focus: false,
    layout: {block: {flavor: 'com.superlogical.terminal.shell', label: 'pair scout', options: {cwd: '/work/project', shell: 'none', command: ['sh', '-c', 'exec bash -i']}}},
  }]);
  assert.equal(await first.has(pane), true);
  assert.equal(await first.has('rex:block:nope'), false);
  assert.equal(await host().find(), pane, 'a new daemon finds it by its label');
  await first.send(pane, '\x15ls\r');
  assert.deepEqual(rex.typed, [[blockOf(pane), '\x15ls\r']]);
  await first.close(pane);
  assert.deepEqual(rex.requests('block.close'), [{session_id: SESSION, block_id: blockOf(pane)}]);
  assert.equal(await first.has(pane), false);
  assert.equal(await host().find(), null);
  await until(() => rex.clients === 0, 'every request of a host to close its connection');
});

test('the fake refuses a split the real Rex refuses, with the status it gives', async t => {
  const {socketPath} = await rexWith(t, {blocks: ['block:a', {id: 'block:gone', detached: true}]});
  const client = new RexClient({socketPath, session: SESSION});
  await client.connect();
  t.after(() => client.stop());
  const split = (anchor_id, options = {}) => client.call('session.new_split', {anchor_id, direction: 'vertical', side: 'after', layout: {block: {flavor: 'com.superlogical.terminal.shell'}}, ...options});
  await assert.rejects(split('block:gone'), {code: 'not_found'}, 'a detached anchor is in no window');
  await assert.rejects(split('block:a', {direction: 'diagonal'}), {code: 'bad_request'});
  await assert.rejects(split('block:a', {side: 'left'}), {code: 'bad_request'});
  await assert.rejects(split('block:nope'), {code: 'not_found'});
  await split('block:a');
});

test('the fake gives each error code the status of Rex\'s documentation', async t => {
  const {rex, socketPath} = await rexWith(t);
  const expected = {not_found: 404, session_not_found: 404, method_not_found: 404, conflict: 409, bad_request: 400, refused: 403, too_large: 413, internal: 500, timeout: 504};
  const statuses = {};
  for (const code of Object.keys(expected)) {
    rex.fail('session.view', code);
    const seen = await connectWebSocket(socketPath, '/api/control', {
      subprotocol: 'rex.control.v1',
      onText: text => { const message = JSON.parse(text); if (message.error) statuses[code] = message.error.status; },
    });
    seen.sendText(JSON.stringify({type: 'hello'}));
    await sleep(20);
    seen.sendText(JSON.stringify({type: 'request', id: '1', method: 'session.attach', payload: {session_id: SESSION}}));
    seen.sendText(JSON.stringify({type: 'request', id: '2', method: 'session.view', payload: {session_id: SESSION}}));
    await until(() => statuses[code] !== undefined, `the ${code} response`);
    seen.close();
  }
  assert.deepEqual(statuses, expected);
});

test('RexPaneHost does not find a block labelled like its pane that is in no window', async t => {
  const {socketPath} = await rexWith(t, {blocks: ['block:chat', {id: 'block:old', label: 'pair scout', detached: true}]});
  assert.equal(await new RexPaneHost({socketPath, session: SESSION, besidePane: 'rex:block:chat', root: '/p'}).find(), null);
});

test('openRexChat: splits beside the terminal with the chat as the block\'s command, in the folder, with the overrides in env', async t => {
  const {rex, socketPath} = await rexWith(t, {blocks: ['block:here']});
  const server = {server: socketPath, session: SESSION, block: 'block:here'};
  const argv = [process.execPath, '/pair/bin/pair.mjs', 'chat'];
  assert.equal(await openRexChat(server, {argv, cwd: '/work/project', env: {PAIR_CONFIG: '/etc/pair.json', PAIR_SOCKET: '/run/pair.sock'}}), true);
  assert.deepEqual(rex.requests('session.new_split'), [{
    session_id: SESSION, anchor_id: 'block:here', direction: 'horizontal', side: 'after', ratio: 0.7, focus: false,
    layout: {block: {flavor: 'com.superlogical.terminal.shell', label: 'pair chat', options: {
      cwd: '/work/project', shell: 'none', command: ['env', 'PAIR_CONFIG=/etc/pair.json', 'PAIR_SOCKET=/run/pair.sock', ...argv],
    }}},
  }]);
  await openRexChat(server, {argv, cwd: '/work/project'});
  assert.deepEqual(rex.requests('session.new_split')[1].layout.block.options.command, ['env', ...argv]);
});

test('openRexChat is false, and the chat runs in place, when Rex refuses, the block is gone or Rex is not there', async t => {
  const {rex, socketPath} = await rexWith(t, {blocks: ['block:here']});
  const argv = ['node', 'pair.mjs', 'chat'];
  rex.fail('session.new_split', 'refused');
  assert.equal(await openRexChat({server: socketPath, session: SESSION, block: 'block:here'}, {argv, cwd: '/p'}), false);
  assert.equal(await openRexChat({server: socketPath, session: 'session:other', block: 'block:here'}, {argv, cwd: '/p'}), false);
  assert.equal(await openRexChat({server: join(socketDir('pair-rex-'), 'nobody.sock'), session: SESSION, block: 'block:here'}, {argv, cwd: '/p'}), false);
});

test('rexStatus: the server\'s version, the session\'s label and its terminals, and how long it took', async t => {
  const {socketPath} = await rexWith(t, {blocks: ['block:b1', 'block:b2', {id: 'block:b3', detached: true}]});
  const status = await rexStatus({server: socketPath, session: SESSION, block: 'block:b1'});
  assert.deepEqual({...status, ms: typeof status.ms}, {version: '9.9.9-fake', label: 'fake', terminals: 2, ms: 'number'});
  await assert.rejects(rexStatus({server: join(socketDir('pair-rex-'), 'nobody.sock'), session: SESSION, block: 'b'}), /ENOENT/);
});

test('PaneWatch over Rex: focus, and a command in the focused terminal with its output', async t => {
  const {rex, panes} = await panesOn(t, {blocks: ['block:b1', 'block:chat']});
  panes.stop(); // the watch starts its own
  const events = [];
  const watch = new PaneWatch({source: new Panes([panes]), chatPane: 'rex:block:chat', emit: event => events.push(event)});
  watch.start();
  t.after(() => watch.stop());
  const of = kind => events.filter(event => event.kind === kind);
  await until(() => of('focus').length === 1, 'the first focus');
  assert.deepEqual(of('focus')[0], {kind: 'focus', target: 'terminal', pane: 'rex:block:b1', scrolled: false});
  rex.focus('block:chat');
  await until(() => of('focus').length === 2, 'focus on the chat');
  assert.equal(of('focus')[1].target, 'chat');
  rex.focus('block:b1');
  await until(() => of('focus').length === 3, 'focus back');

  const user = rex.blocks.get('block:b1');
  user.lines = ['old', '$ make test'];
  await sleep(700); // the first look at the prompt
  rex.process('block:b1', running('make'), [shell(100), login]);
  await sleep(700); // seen running
  user.lines.push('cc a.c', 'FAIL a', '$');
  rex.process('block:b1', shell(100), [login]);
  await until(() => of('command_end').length === 1, 'the end of make');
  assert.deepEqual(of('command_end')[0], {kind: 'command_end', pane: 'rex:block:b1', cmd: 'make', exit: null, output: 'cc a.c\nFAIL a'});

  await watch.type('rex:block:b1', 'git status');
  assert.deepEqual(rex.typed, [['block:b1', 'git status']]);
  await assert.rejects(watch.type('rex:block:chat', 'git status'), Error);
  assert.deepEqual(rex.typed, [['block:b1', 'git status']], 'nothing typed into the chat');
  assert.equal(of('typing').length, 0);
});

test('PaneWatch over Rex: a hook\'s shell pid finds its terminal, whatever block its environment names', async t => {
  const {panes} = await panesOn(t, {blocks: ['block:b1', 'block:b2']});
  panes.stop();
  const events = [];
  const watch = new PaneWatch({source: new Panes([panes]), emit: event => events.push(event)});
  watch.start();
  t.after(() => watch.stop());
  await until(() => events.length > 0, 'the first look');
  assert.equal(await watch.paneOf({shell: 101, pane: 'rex:block:b1'}), 'rex:block:b2');
  assert.equal(await watch.paneOf({shell: 4242, pane: 'rex:block:b1'}), 'rex:block:b1');
});

test('rex-ws: a frame beyond 65535 bytes round-trips as text and as binary', async t => {
  const socketPath = join(socketDir('pair-rex-'), 'ws.sock');
  const server = await listenWebSocket(socketPath, ws => {
    ws.onText = text => ws.sendText(text);
    ws.onBinary = data => ws.sendBinary(data);
  });
  t.after(() => server.close());
  const got = {texts: [], binaries: []};
  const client = await connectWebSocket(socketPath, '/', {onText: text => got.texts.push(text), onBinary: data => got.binaries.push(data)});
  const text = 'é'.repeat(70_000) + 'end';
  const binary = Buffer.alloc(200_000, 0xab);
  binary[123_456] = 1;
  client.sendText(text);
  client.sendText('short');
  client.sendBinary(binary);
  await until(() => got.texts.length === 2 && got.binaries.length === 1, 'the echoes');
  assert.equal(got.texts[0], text);
  assert.equal(got.texts[1], 'short');
  assert.ok(got.binaries[0].equals(binary));
  client.close();
});

test('rex-ws: a message the server sent in fragments arrives whole, and a ping is answered with the same bytes in a pong', async t => {
  const socketPath = join(socketDir('pair-rex-'), 'ws.sock');
  const pongs = [];
  let served;
  const server = await listenWebSocket(socketPath, ws => {
    ws.onPong = data => pongs.push(data.toString());
    served = ws;
  }, {fragment: 7});
  t.after(() => server.close());
  const texts = [];
  await connectWebSocket(socketPath, '/', {onText: text => texts.push(text)});
  await until(() => served, 'the connection');
  served.sendText('in many small fragments, one message');
  served.ping('are you there');
  await until(() => texts.length === 1 && pongs.length === 1, 'the message and the pong');
  assert.deepEqual(texts, ['in many small fragments, one message']);
  assert.deepEqual(pongs, ['are you there']);
});

test('rex-ws: the server\'s close code reaches onClose, a drop is 1006, and our own close is seen by the server', async t => {
  const socketPath = join(socketDir('pair-rex-'), 'ws.sock');
  const served = [];
  const server = await listenWebSocket(socketPath, ws => served.push(ws));
  t.after(() => server.close());
  const closes = [];
  await connectWebSocket(socketPath, '/', {onClose: (code, reason) => closes.push(['server', code, reason])});
  await until(() => served.length === 1, 'a connection');
  served[0].close(4001);
  await until(() => closes.length === 1, 'the close');
  assert.deepEqual(closes, [['server', 4001, '']]);

  await connectWebSocket(socketPath, '/', {onClose: code => closes.push(['drop', code])});
  await until(() => served.length === 2, 'another connection');
  served[1].socket.destroy();
  await until(() => closes.length === 2, 'the drop');
  assert.deepEqual(closes[1], ['drop', 1006]);

  const mine = await connectWebSocket(socketPath, '/', {onClose: code => closes.push(['ours', code])});
  await until(() => served.length === 3, 'a third connection');
  const seenByServer = new Promise(resolve => { served[2].onClose = resolve; });
  mine.close(1000);
  assert.equal(await seenByServer, 1000);
  await until(() => closes.length === 3, 'our close');
  assert.deepEqual(closes[2], ['ours', 1000]);
});

test('rex-ws: an upgrade the server refuses rejects, and so does a server that is not there', async t => {
  const socketPath = join(socketDir('pair-rex-'), 'ws.sock');
  const server = await listenWebSocket(socketPath, () => {}, {subprotocol: 'rex.control.v1'});
  t.after(() => server.close());
  await assert.rejects(connectWebSocket(socketPath, '/', {subprotocol: 'other.v1'}), Error);
  await assert.rejects(connectWebSocket(join(socketDir('pair-rex-'), 'nobody.sock'), '/', {}), /ENOENT/);
});

test('read: ordinary lines, whose newlines make every reply short of its budget', async t => {
  const {rex, panes} = await panesOn(t);
  const pane = rexPane('block:b1');
  const lines = Array.from({length: 5000}, (_, i) => `line ${i} of the build output`.padEnd(40, '.'));
  rex.blocks.get('block:b1').lines = lines;
  const text = Buffer.from(`${lines.join('\n')}\n\n\n`);
  assert.ok(text.length > 2 * 65536, 'more than two windows');
  assert.ok(text[text.length - 65536] < 0x80, 'the window starts on an ASCII byte');
  for (const count of [1, 50, 2000]) assert.deepEqual((await panes.read(pane, count)).split('\n'), lines.slice(-count), `${count} lines`);
  // the short-part path inside read(): one window took at least 2 parts of 65536, because each newline is two encoded bytes
  const before = rex.requests('com.superlogical.terminal.blob_read').length;
  assert.equal(await panes.read(pane, 1), lines.at(-1));
  const parts = rex.requests('com.superlogical.terminal.blob_read').slice(before).filter(request => request.args.max_bytes === 65536);
  assert.ok(parts.length >= 2, `${parts.length} parts of 65536 for one window`);
});

test('read: lines of CJK text, of quotes and of backslashes', async t => {
  const {rex, panes} = await panesOn(t);
  const pane = rexPane('block:b1');
  const cjk = Array.from({length: 4000}, (_, i) => `${i} \u4e16\u754c\u4f60\u597d`);
  rex.blocks.get('block:b1').lines = cjk;
  for (const count of [1, 50, 3000]) assert.deepEqual((await panes.read(pane, count)).split('\n'), cjk.slice(-count), `cjk, ${count} lines`);
  const quoted = Array.from({length: 4000}, (_, i) => `say "${i}" \\ \\n \\"`);
  rex.blocks.get('block:b1').lines = quoted;
  for (const count of [1, 50, 3000]) assert.deepEqual((await panes.read(pane, count)).split('\n'), quoted.slice(-count), `quotes, ${count} lines`);
});

test('read: a window whose probe region is all genuine U+FFFD is read by doubling the probe', async t => {
  const {rex, panes} = await panesOn(t);
  const pane = rexPane('block:b1');
  // 1200 bytes of genuine U+FFFD at the window's start: the probes of 256, 512 and 1024 bytes see only U+FFFD
  const lines = windowAt('\ufffd'.repeat(400), 0, ['$ ls', '$']);
  rex.blocks.get('block:b1').lines = lines;
  const text = Buffer.from(`${lines.join('\n')}\n\n\n`);
  assert.deepEqual([...text.subarray(text.length - 65536, text.length - 65536 + 3)], [0xef, 0xbf, 0xbd], 'the window starts on a U+FFFD');
  for (const count of [1, 3]) assert.deepEqual((await panes.read(pane, count)).split('\n'), linesOf(lines).slice(-count), `${count} lines`);
  const probes = rex.requests('com.superlogical.terminal.blob_read').filter(request => request.args.max_bytes > 256 && request.args.max_bytes < 65536);
  assert.ok(probes.length > 0, 'the probe was doubled');
});

test('read: a window starting 1 or 2 bytes into a long run of genuine U+FFFD is read from a certain boundary, not from a stray', async t => {
  const {rex, panes} = await panesOn(t);
  const pane = rexPane('block:b1');
  for (const [skip, bytes] of [[1, [0xbf, 0xbd]], [2, [0xbd, 0xef]]]) {
    const lines = windowAt('\ufffd'.repeat(20000), skip, ['$ cat fw.bin', '$']);
    rex.blocks.get('block:b1').lines = lines;
    const text = Buffer.from(`${lines.join('\n')}\n\n\n`);
    assert.deepEqual([...text.subarray(text.length - 65536, text.length - 65536 + 2)], bytes, `the window starts ${skip} bytes into a U+FFFD`);
    assert.equal(await panes.read(pane, 1), '$', `skip ${skip}`);
    assert.deepEqual((await panes.read(pane, 3)).split('\n'), linesOf(lines).slice(-3), `skip ${skip}, 3 lines`);
  }
  // the reviewer's layout, the window in a run of 30000
  const dump = ['x'.repeat(100), '$ cat fw.bin', '\uFFFD'.repeat(30000) + 'END', '$'];
  rex.blocks.get('block:b1').lines = dump;
  const text = Buffer.from(`${dump.join('\n')}\n\n\n`);
  assert.deepEqual([...text.subarray(text.length - 65536, text.length - 65536 + 2)], [0xbf, 0xbd]);
  assert.equal(await panes.read(pane, 1), '$');
  assert.deepEqual((await panes.read(pane, 3)).split('\n'), ['$ cat fw.bin', dump[2], '$']);
});

test('read: a blob that is nothing but genuine U+FFFD from the window on is read from offset 0', async t => {
  // The fake ends every blob with newlines, so this blob, of nothing but U+FFFD, is served by a stand-in for Rex's blob_read
  const {panes} = await panesOn(t);
  const pane = rexPane('block:b1');
  const characters = 30000;
  const total = 3 * characters;
  const asked = [];
  panes.client.terminal = async (blockId, method, args) => {
    if (method === 'format') return {content: '\uFFFD'.repeat(10), eof: false, id: 7, total};
    assert.equal(method, 'blob_read');
    asked.push(args);
    // as measured: a stray byte is one U+FFFD costing 1, a whole U+FFFD costs 3 and is not cut by the budget
    let spent = 0, at = args.offset, data = '';
    for (; at < total && at % 3 !== 0 && spent < args.max_bytes; at++, spent++) data += '\uFFFD';
    for (; at < total && (data === '' || spent + 3 <= args.max_bytes); at += 3, spent += 3) data += '\uFFFD';
    return {id: 7, data, total, eof: at >= total};
  };
  assert.ok(total > 65536 && (total - 65536) % 3 !== 0, 'the window starts inside a U+FFFD');
  assert.equal(await panes.read(pane, 1), '\uFFFD'.repeat(characters));
  assert.ok(asked.some(request => request.offset === 0 && request.max_bytes === 65536), 'it read from the start of the blob');
  assert.ok(asked.length <= Math.log2(total / 256) + 4 + 4 + Math.ceil(total / 65536) * 2, 'a bounded number of requests');
});
