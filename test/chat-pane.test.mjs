// The full-screen chat pane against the real daemon, with a fake model and a stand-in Neovim: what you see as you
// type, ask, wait, pick a message and act on it. The pane runs in this process on a stream, and each test reads its
// frame as plain lines (no colours: the output is no terminal).
import assert from 'node:assert/strict';
import {realpathSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {test} from 'node:test';
import {createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall} from '@earendil-works/pi-ai';
import {MemoryStorage} from '@earendil-works/pi-durable';
import {startChatPane} from '../src/chat.mjs';
import {loadConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {openPartner} from '../src/partner.mjs';
import {readMessages, sendMessage} from '../src/protocol.mjs';
import {ROLE_TOOLS} from '../src/tools.mjs';
import {client} from './daemon-client.mjs';
import {scratch} from './temp.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const QUEUE = 'package queue\n\nfunc New(cfg Config) *Queue {\n\treturn &Queue{ttl: cfg.Budget}\n}\n';

/** A daemon on a fake model, a project with one file, and the pane on it, `width` by `height`. */
async function setUp({width = 70, height = 30, tokensPerSecond} = {}) {
  const dir = realpathSync(scratch('pair-pane-'));
  writeFileSync(join(dir, 'queue.go'), QUEUE);
  const path = join(dir, 'config.json');
  const entry = {api: 'openai', baseUrl: 'http://unused', model: 'm'};
  writeFileSync(path, JSON.stringify({dataDir: dir, socket: join(dir, 'pair.sock'), agents: false, models: {watcher: entry, partner: entry}}));
  const config = loadConfig(path);
  const partner = fauxProvider(tokensPerSecond ? {tokensPerSecond} : {});
  const models = createModels();
  models.setProvider(partner.provider);
  const daemon = await startDaemon(config, {pairModels: {models, watcher: partner.getModel(), partner: partner.getModel()}, probe: async () => ({ok: true}), log: () => {}});
  const input = new PassThrough();
  const written = [];
  const output = {isTTY: false, write: data => written.push(data), on: () => {}};
  let exited = null;
  const pane = startChatPane(config.socket, {dataDir: dir, input, output, size: () => ({width, height}), cwd: dir, env: {}, exit: code => { exited = code; }});
  const text = () => pane.frame().join('\n');
  const shows = async (pattern, what = String(pattern)) => {
    for (let i = 0; i < 200; i++) {
      if (typeof pattern === 'string' ? text().includes(pattern) : pattern.test(text())) return;
      await sleep(25);
    }
    assert.fail(`the pane never showed ${what}:\n${text()}`);
  };
  const type = async keys => {
    pane.key(keys);
    await sleep(30);
  };
  return {
    dir, partner, daemon, pane, text, shows, type, written, exited: () => exited, socket: config.socket,
    close: async () => { pane.close(); await daemon.close(); },
  };
}

/** A stand-in Neovim: it answers the daemon's requests and keeps what it was sent. */
function editor(socket, dir, {selection = null} = {}) {
  const nvim = client(socket, {type: 'hello', role: 'editor', cwd: dir, buffers: true});
  const answer = message => {
    if (message.type === 'read') return {text: null};
    if (message.type === 'buffers') return {buffers: []};
    if (message.type === 'selection') return selection;
    return {ok: true};
  };
  let answered = 0;
  const timer = setInterval(() => {
    for (const message of nvim.received.slice(answered)) {
      if (message.id !== undefined && message.type !== 'reply') nvim.send({type: 'reply', id: message.id, result: answer(message)});
    }
    answered = nvim.received.length;
  }, 10);
  nvim.stop = () => { clearInterval(timer); nvim.close(); };
  return nvim;
}

test('the empty pane says what Pair is and how to talk to it; the goal you type is on screen at once', {timeout: 20_000}, async () => {
  const t = await setUp();
  try {
    await t.shows('What are we doing this session?');
    assert.match(t.text(), /\d\d:\d\d pair  What are we doing this session\?/, 'Pair asks it, as pair, not as a note');
    assert.match(t.text(), /Pair · your pair in the second chair/);
    assert.match(t.text(), /\?      every key/);
    assert.match(t.text(), /› the session's goal, or "later"/, 'the input says what it waits for');
    assert.match(t.text(), /^── pair · pair-pane-\w+ ─+ navigator · normal ──$/m, 'the header in the top rule: the project, the role, the level');
    assert.equal(t.text().split('\n')[1].trim(), '', 'no second rule under it');
    await t.type('make the queue lease right\r');
    assert.match(t.text(), /\d\d:\d\d you   make the queue lease right/, 'what you sent shows before the daemon answers');
    await t.shows(/── pair · pair-pane-\w+ · make the queue … ── navigator/);
    await sleep(200);
    assert.doesNotMatch(t.text(), /Goal: make/, 'the goal is in the header, not said again');
    assert.doesNotMatch(t.text(), /every key/, 'the card goes once you talk');
  } finally {
    await t.close();
  }
});

test('a question: the tool lines, the answer in Markdown, and the model and time of the turn', {timeout: 20_000}, async () => {
  const t = await setUp();
  try {
    await t.shows('What are we doing');
    await t.type('later\r');
    await t.shows('No goal then.');
    t.partner.setResponses([
      fauxAssistantMessage([fauxToolCall('read', {file: 'queue.go', start_line: 3, end_line: 5})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('The lease ends **too early**:\n\n- `ttl` is the budget\n- the last attempt runs past it\n\n```go\nttl: cfg.Budget + cfg.AttemptTimeout\n```')]),
    ]);
    await t.type('why twice?\r');
    await t.shows('⎿ read queue.go 3-5');
    await t.shows('The lease ends too early:');
    const frame = t.text();
    assert.match(frame, /• ttl is the budget/, 'a list, its code without backticks');
    assert.match(frame, /│ ttl: cfg\.Budget \+ cfg\.AttemptTimeout/, 'a code block, behind its bar');
    assert.match(frame, /── ◇ watching ─+ Faux Model · \d+\.\ds/, 'idle again, with the model and how long it took, in the rule');
  } finally {
    await t.close();
  }
});

test('typing: / opens the commands, Tab completes, Up brings back what you sent, an unknown command stays to fix', {timeout: 20_000}, async () => {
  const t = await setUp();
  try {
    await t.shows('What are we doing');
    await t.type('/mu');
    assert.match(t.text(), /▸ \/mute +\[kind\] +no more remarks of this kind/);
    assert.match(t.text(), /↑↓ choose · Tab complete · Enter run · Esc close/);
    await t.type('\t');
    assert.match(t.text(), /› \/mute $/m, 'completed, with room for its kind');
    await t.type('\x15'); // Ctrl-U
    await t.type('/frobnicate\r');
    await t.shows('There is no /frobnicate');
    assert.match(t.text(), /› \/frobnicate/, 'still there, to fix');
    await t.type('\x15first line\x1b\rsecond line'); // Alt-Enter: a new line
    assert.match(t.text(), /› first line\n +second line/);
    await t.type('\x15\x15\x1b[A\x1b[A'); // two lines cleared, then Up: back up the first line, then the history
    await t.type('\x15');
    await t.type('\x1b[200~pasted\nlines\x1b[201~');
    assert.match(t.text(), /› pasted\n +lines/, 'a paste keeps its line breaks and does not send');
  } finally {
    await t.close();
  }
});

test('the header follows the talk level: /quiet, /level and Alt-L, which goes on from the level now', {timeout: 20_000}, async () => {
  const t = await setUp();
  const level = () => / navigator · (\w+) ──$/m.exec(t.text())?.[1];
  try {
    await t.shows('What are we doing');
    await t.type('later\r');
    await t.shows('No goal then.');
    await t.type('/quiet\r');
    await t.shows(/ navigator · quiet ──$/m);
    for (const next of ['normal', 'chatty', 'quiet', 'normal']) {
      await t.type('\x1bl'); // Alt-L
      await t.shows(new RegExp(` navigator · ${next} ──$`, 'm'), `the level ${next} after ${level()}`);
    }
    await t.type('/level chatty\r');
    await t.shows(/ navigator · chatty ──$/m);
  } finally {
    await t.close();
  }
});

test('? shows every key, any key closes it; Ctrl-C twice on an empty line closes the pane', {timeout: 20_000}, async () => {
  const t = await setUp();
  try {
    await t.shows('What are we doing');
    await t.type('?');
    assert.match(t.text(), / Keys\n/);
    assert.match(t.text(), /Alt-↑ Alt-↓  pick a message, then:/);
    await t.type('x');
    assert.doesNotMatch(t.text(), / Keys\n/);
    assert.doesNotMatch(t.text(), /› x/, 'the key that closed it is not typed');
    await t.type('\x03');
    assert.match(t.text(), /Ctrl-C again closes the pane/);
    await t.type('\x03');
    assert.equal(t.exited(), 0);
  } finally {
    await t.close();
  }
});

test('Esc stops an answer while it streams; what streamed goes, and the pane says it stopped', {timeout: 20_000}, async () => {
  const t = await setUp({tokensPerSecond: 8});
  try {
    await t.shows('What are we doing');
    await t.type('later\r');
    t.partner.setResponses([fauxAssistantMessage([fauxText('This answer takes a long time to come, word by word, so that there is time to stop it.')])]);
    await t.type('tell me slowly\r');
    await t.shows(/── ▖ thinking \d+s ─/);
    assert.match(t.text(), /^ Esc stop · /m, 'the key is in the footer');
    assert.doesNotMatch(t.text(), /thinking.*Esc/, 'the status names no keys');
    await t.shows('This answer');
    assert.match(t.text(), /▍/, 'the cursor of an answer still coming');
    await t.shows(/── ▖ writing \d+s ─/, 'writing, once the words arrive');
    await t.type('\x1b');
    await t.shows('Stopped. Ask again, or ask something else.');
    await t.shows('◇ watching');
    assert.doesNotMatch(t.text(), /▍/);
  } finally {
    await t.close();
  }
});

test('a suggestion: a diff; picked with Alt-↑, a takes it in Neovim and j goes there; @here asks about your selection', {timeout: 20_000}, async () => {
  const t = await setUp({width: 80});
  const nvim = editor(t.socket, t.dir, {selection: {file: join(t.dir, 'queue.go'), from: 3, to: 4}});
  try {
    await t.shows('What are we doing');
    await t.type('later\r');
    await t.shows('No goal then.');
    t.partner.setResponses([
      fauxAssistantMessage([fauxToolCall('suggest', {file: 'queue.go', line: 4, new_text: '\treturn &Queue{ttl: cfg.Budget + cfg.AttemptTimeout}', note: 'past the last attempt'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('That is all.')]),
    ]);
    await t.type('fix it?\r');
    await t.shows('That is all.');
    assert.match(t.text(), /✎ suggested change · queue\.go:4\n +past the last attempt\n +│- return &Queue\{ttl: cfg\.Budget\}\n +│\+ return &Queue\{ttl: cfg\.Budget \+ cfg\.AttemptTimeout\}/);
    await t.type('\x1b[1;3A'); // Alt-↑: That is all.
    await t.type('\x1b[1;3A'); // the suggestion
    assert.match(t.text(), /▌\d\d:\d\d pair  ✎ suggested change/);
    assert.match(t.text(), /c copy · a apply · j jump · Esc back/);
    await t.type('a');
    const accept = await nvim.next(message => message.type === 'accept');
    nvim.send({type: 'applied', action: accept.action, before: [QUEUE], after: [QUEUE]});
    await t.shows('✓ taken');
    await t.type('j');
    const go = await nvim.next(message => message.type === 'go');
    assert.deepEqual({file: go.file, line: go.line}, {file: join(t.dir, 'queue.go'), line: 4});
    await t.type('c');
    assert.ok(t.written.some(data => data.includes('\x1b]52;c;')), 'c copies through OSC 52');
    await t.type('\x1b');
    t.partner.setResponses([fauxAssistantMessage([fauxText('Those lines build the queue.')])]);
    await t.type('what is @here\r');
    await t.shows('what is @here (queue.go:3-4)');
    await t.shows('Those lines build the queue.');
  } finally {
    nvim.stop();
    await t.close();
  }
});

test('a narrow pane puts the name above the words; a tiny one says it is too small', {timeout: 20_000}, async () => {
  const t = await setUp({width: 40, height: 20});
  try {
    await t.shows('What are we doing');
    await t.type('later\r');
    await t.shows(/\d\d:\d\d you\n +later/);
  } finally {
    await t.close();
  }
  const tiny = await setUp({width: 20, height: 6});
  try {
    await tiny.shows('Pair: too small');
  } finally {
    await tiny.close();
  }
});

test('the Partner streams the answer\'s text and says what the turn used', async () => {
  const faux = fauxProvider({tokensPerSecond: 12});
  const models = createModels();
  models.setProvider(faux.provider);
  const hands = {...Object.fromEntries(ROLE_TOOLS.driver.map(name => [name, async () => 'ok'])), roleOf: () => 'navigator'};
  const partner = await openPartner({storage: new MemoryStorage(), models, model: faux.getModel(), hands});
  try {
    const id = await partner.createConversation();
    faux.setResponses([
      fauxAssistantMessage([fauxText('Looking.'), fauxToolCall('read', {file: 'a.go'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('The lease ends as attempt five starts, so a second worker takes it.')]),
    ]);
    const events = [];
    const answer = await partner.ask(id, '[user] why?', {onEvent: event => events.push(event)});
    assert.equal(answer, 'The lease ends as attempt five starts, so a second worker takes it.');
    const texts = events.filter(event => event.type === 'text').map(event => event.text);
    assert.ok(texts.length >= 2, `streamed in parts: ${JSON.stringify(texts)}`);
    assert.ok(texts.at(-1).startsWith('The lease ends'), 'the last message streams from its start');
    const usage = events.at(-1);
    assert.equal(usage.type, 'usage');
    assert.ok(usage.tokens > 0);
  } finally {
    await partner.close();
  }
});

test('a streamed answer never loses its start: each text streamed is the start of the answer, from its first word', async () => {
  const hands = {...Object.fromEntries(ROLE_TOOLS.driver.map(name => [name, async () => 'ok'])), roleOf: () => 'navigator'};
  const answers = [
    '# Heading\n\nThe lease ends **too early**, so a second worker takes the job.',
    'This answer is slow. This answer is slow on purpose, word by word.',
    'Short.',
  ];
  for (const tokensPerSecond of [40, 120, 400]) {
    const faux = fauxProvider({tokensPerSecond});
    const models = createModels();
    models.setProvider(faux.provider);
    const partner = await openPartner({storage: new MemoryStorage(), models, model: faux.getModel(), hands});
    try {
      const id = await partner.createConversation();
      for (const answer of answers) {
        faux.setResponses([fauxAssistantMessage([fauxText(answer)])]);
        const texts = [];
        assert.equal(await partner.ask(id, '[user] go', {onEvent: event => event.type === 'text' && texts.push(event.text)}), answer);
        assert.ok(texts.length > 0, `${tokensPerSecond} tok/s: something streamed for "${answer}"`);
        for (const text of texts) assert.ok(answer.startsWith(text), `${tokensPerSecond} tok/s: "${text}" is not the start of "${answer}"`);
      }
    } finally {
      await partner.close();
    }
  }
});

/** A stand-in daemon on a scratch socket: it welcomes the pane, and keeps what the pane sends. */
async function standIn(dir, welcome) {
  const socket = join(dir, 'stand-in.sock');
  const got = [];
  const clients = [];
  const server = createServer(client => {
    clients.push(client);
    readMessages(client, message => {
      got.push(message);
      if (message.type === 'hello') sendMessage(client, {type: 'welcome', root: dir, role: 'navigator', level: 'normal', model: 'qwen3', ...welcome});
    });
  });
  await new Promise(resolve => server.listen(socket, resolve));
  return {
    socket, got,
    send: message => clients.forEach(client => sendMessage(client, message)),
    close: () => new Promise(resolve => { clients.forEach(client => client.destroy()); server.close(resolve); }),
  };
}

test('Pair asks before it runs a command: its words in body text, the command behind a bar, the answer keys once; Esc declines', {timeout: 20_000}, async () => {
  const dir = realpathSync(scratch('pair-pane-'));
  const daemon = await standIn(dir, {goal: 'make the lease outlive the retry'});
  const input = new PassThrough();
  const pane = startChatPane(daemon.socket, {input, output: {isTTY: false, write: () => {}, on: () => {}}, size: () => ({width: 90, height: 16}), cwd: dir, env: {}, exit: () => {}});
  const text = () => pane.frame().join('\n');
  const shows = async pattern => {
    for (let i = 0; i < 200 && !pattern.test(text()); i++) await sleep(25);
    assert.match(text(), pattern);
  };
  try {
    await shows(/── pair · pair-pane-\w+ · make the lease outlive the retry ─+ navigator · normal ──/);
    daemon.send({type: 'message', sender: 'pair', text: 'Goal: make the lease outlive the retry', at: Date.now(), meta: {greeting: true, goal: 'set'}});
    daemon.send({type: 'activity', state: 'waiting'});
    daemon.send({type: 'confirm', id: 7, text: 'May I run `go test ./internal/queue -run TestLease -count=1` in my pane (go test runs code)?'});
    await shows(/pair  May I run this in my pane \(go test runs code\)\?\n +│ go test \.\/internal\/queue -run TestLease -count=1/);
    const frame = text();
    assert.doesNotMatch(frame, /Goal: make/, 'the goal only once, in the header');
    assert.match(frame, /── \? waiting for your answer ─+ qwen3 ──\ny\/N › or type an answer\n y allow · n decline · Esc decline$/);
    assert.equal(frame.match(/decline/g).length, 2, 'the answer keys once, in the footer');
    pane.key('\x1b');
    for (let i = 0; i < 100 && !daemon.got.some(m => m.type === 'confirm'); i++) await sleep(20);
    assert.deepEqual(daemon.got.find(m => m.type === 'confirm'), {type: 'confirm', id: 7, ok: false, text: 'n'});
    await shows(/you declined/);
  } finally {
    pane.close();
    await daemon.close();
  }
});
