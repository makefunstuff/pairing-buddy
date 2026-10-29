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
import {runChat, startChatPane} from '../src/chat.mjs';
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
function editor(socket, dir, {selection = null, place = null} = {}) {
  const nvim = client(socket, {type: 'hello', role: 'editor', cwd: dir, buffers: true});
  const answer = message => {
    if (message.type === 'read') return {text: null};
    if (message.type === 'gen_place') return place; // where /gen here puts its code: the cursor
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
    assert.match(t.text(), /^ +── \d\d:\d\d ──\n pair  What are we doing this session\?/m, 'Pair asks it, as pair, not as a note, under the time');
    assert.match(t.text(), /Pair · your pair in the second chair/);
    assert.match(t.text(), /▗▛▀▀▀▀▜▖  Pair · your pair/, "Pair's head beside its name");
    assert.match(t.text(), /^   \?       every key$/m);
    assert.match(t.text(), /› the session's goal, or "later"/, 'the input says what it waits for');
    assert.match(t.text(), /^── pair · pair-pane-\w+ ─+ navigator · normal ──$/m, 'the header in the top rule: the project, the role, the level');
    assert.equal(t.text().split('\n')[1].trim(), '', 'no second rule under it');
    await t.type('make the queue lease right\r');
    assert.match(t.text(), /^ you   make the queue lease right/m, 'what you sent shows before the daemon answers');
    assert.equal(t.text().match(/── \d\d:\d\d ──/g).length, 1, 'the time once, not on each turn');
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
    await t.shows('└ read queue.go 3-5');
    await t.shows('The lease ends too early:');
    const frame = t.text();
    assert.match(frame, /• ttl is the budget/, 'a list, its code without backticks');
    assert.match(frame, /│ ttl: cfg\.Budget \+ cfg\.AttemptTimeout/, 'a code block, behind its bar');
    assert.match(frame, /── ◉ watching ─+ Faux Model · \d+\.\ds/, 'idle again, with the model and how long it took, in the rule');
  } finally {
    await t.close();
  }
});

test('a wide pane: the words end by column 80, code runs on, and what the turn took sits right of its answer', {timeout: 20_000}, async () => {
  const t = await setUp({width: 120});
  try {
    await t.shows('What are we doing');
    await t.type('later\r');
    await t.shows('No goal then.');
    const long = 'The lease ends too early because ttl is only the budget and the last attempt can start at the very end of it.';
    const code = 'return &Queue{ttl: cfg.Budget + cfg.AttemptTimeout, owner: job.Owner, started: time.Now(), budget: cfg.Budget}';
    t.partner.setResponses([fauxAssistantMessage([fauxText(`${long}\n\n\`\`\`go\n${code}\n\`\`\``)])]);
    await t.type('why twice?\r');
    await t.shows(/ \d\d:\d\d · \d+\.\ds · [\d.k]+ tok$/m);
    const lines = t.text().split('\n');
    const first = lines.find(line => line.startsWith(' pair  The lease ends'));
    assert.match(first, /^ pair  The lease ends .{40,73}? +\d\d:\d\d · \d+\.\ds · [\d.k]+ tok$/, 'the meta in the margin of the answer it describes');
    const words = lines.filter(line => /^ {7}\S/.test(line) && !line.includes('│'));
    assert.ok(words.length && words.every(line => line.trimEnd().length <= 80), 'every line of words ends by column 80');
    assert.ok(lines.some(line => line.includes(`│ ${code}`)), 'the code block uses the width of the pane');
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
    await t.shows(/── ▖ thinking ─/, 'thinking, with no counter in its first 3s');
    assert.match(t.text(), /^ Esc stop · /m, 'the key is in the footer');
    assert.doesNotMatch(t.text(), /thinking.*Esc/, 'the status names no keys');
    await t.shows('This answer');
    assert.match(t.text(), /▍/, 'the cursor of an answer still coming');
    await t.shows(/── ▖ writing( \d+s)? ─/, 'writing, once the words arrive');
    await t.type('\x1b');
    await t.shows('Stopped. Ask again, or ask something else.');
    await t.shows('◉ watching');
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
    assert.match(t.text(), /✎ suggested change · queue\.go:4\n +past the last attempt\n +│ - return &Queue\{ttl: cfg\.Budget\}\n +│ \+ return &Queue\{ttl: cfg\.Budget \+ cfg\.AttemptTimeout\}/);
    await t.type('\x1b[1;3A'); // Alt-↑: That is all.
    await t.type('\x1b[1;3A'); // the suggestion
    assert.match(t.text(), /▌pair  ✎ suggested change/);
    assert.match(t.text(), /c copy · a apply · j jump · Esc back +\d\d:\d\d$/, 'the keys on it, and its time on the right');
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

test('a narrow pane keeps the gutter, drops the goal from the header and shortens the keys; a tiny one says it is too small', {timeout: 20_000}, async () => {
  const t = await setUp({width: 40, height: 20});
  try {
    await t.shows('What are we doing');
    await t.type('later\r');
    await t.shows(/^ you   later$/m);
    assert.match(t.text(), /^── pair · pair-pane-\w+ ─+ nav ──$/m, 'no goal, and the role short');
    assert.match(t.text(), /^ \/ cmds · @ files · Alt-↑ pick · \? keys$/m);
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
    daemon.send({type: 'confirm', id: 7, text: 'May I run `go test ./internal/queue -run TestLease -count=1` in my pane (go test runs code)?', command: 'go test ./internal/queue -run TestLease -count=1'});
    await shows(/pair  May I run this in my pane \(go test runs code\)\?\n +│ go test \.\/internal\/queue -run TestLease -count=1/);
    const frame = text();
    assert.doesNotMatch(frame, /Goal: make/, 'the goal only once, in the header');
    assert.match(frame, /── \? waiting for your answer ─+ qwen3 ──\ny\/N › or type an answer\n y allow · n decline · Esc decline$/);
    assert.equal(frame.match(/decline/g).length, 2, 'the answer keys once, in the footer');
    pane.key('logs');
    await sleep(50);
    pane.key('\x1b');
    for (let i = 0; i < 100 && !daemon.got.some(m => m.type === 'confirm'); i++) await sleep(20);
    assert.deepEqual(daemon.got.find(m => m.type === 'confirm'), {type: 'confirm', id: 7, ok: false, text: 'n'});
    await shows(/you declined/);
    assert.match(text(), /^› Ask Pair anything/m, 'what was typed is dropped, not sent later as a question');
    daemon.send({type: 'activity', state: 'idle'});
    const ticks = 'ls `pwd`/build && rm -rf out';
    daemon.send({type: 'confirm', id: 8, text: `May I run \`${ticks}\` in my pane (it runs a command substitution)?`, command: ticks});
    await shows(/May I run this in my pane \(it runs a command substitution\)\?\n +│ ls `pwd`\/build && rm -rf out/);
  } finally {
    pane.close();
    await daemon.close();
  }
});

test('a goal set elsewhere while Pair\'s question for it is open answers it on screen; one you typed is not said again', {timeout: 20_000}, async () => {
  const dir = realpathSync(scratch('pair-pane-'));
  const daemon = await standIn(dir, {});
  const pane = startChatPane(daemon.socket, {input: new PassThrough(), output: {isTTY: false, write: () => {}, on: () => {}}, size: () => ({width: 90, height: 16}), cwd: dir, env: {}, exit: () => {}});
  const text = () => pane.frame().join('\n');
  const shows = async pattern => {
    for (let i = 0; i < 200 && !pattern.test(text()); i++) await sleep(25);
    assert.match(text(), pattern);
  };
  try {
    await shows(/── pair · pair-pane-\w+ ─/);
    daemon.send({type: 'message', sender: 'pair', text: 'What are we doing this session? Type the goal here, or "later".', at: Date.now(), meta: {greeting: true, goal: 'ask'}});
    daemon.send({type: 'goal', goal: 'retries reach the budget'});
    daemon.send({type: 'message', sender: 'system', text: 'Goal: retries reach the budget', at: Date.now(), meta: {goal: 'set'}});
    await shows(/What are we doing this session\?[\s\S]*·· +Goal: retries reach the budget/);
    daemon.send({type: 'message', sender: 'pair', text: 'What are we doing this session? Type the goal here, or "later".', at: Date.now(), meta: {greeting: true, goal: 'ask'}});
    daemon.send({type: 'message', sender: 'user', text: 'make the lease right', at: Date.now(), history: true});
    daemon.send({type: 'message', sender: 'system', text: 'Goal: make the lease right', at: Date.now(), meta: {goal: 'set'}});
    await shows(/you +make the lease right/);
    await sleep(100);
    assert.doesNotMatch(text(), /Goal: make the lease right/, 'you typed it: the header has it');
  } finally {
    pane.close();
    await daemon.close();
  }
});

/** The pane on a stand-in daemon, `width` by `height`: its frame as text, and a wait for what it shows. */
async function standInPane(width = 90, height = 20, welcome = {}) {
  const dir = realpathSync(scratch('pair-pane-'));
  const daemon = await standIn(dir, welcome);
  const pane = startChatPane(daemon.socket, {input: new PassThrough(), output: {isTTY: false, write: () => {}, on: () => {}}, size: () => ({width, height}), cwd: dir, env: {}, exit: () => {}});
  const text = () => pane.frame().join('\n');
  const shows = async pattern => {
    for (let i = 0; i < 200 && !pattern.test(text()); i++) await sleep(25);
    assert.match(text(), pattern);
  };
  const type = async keys => {
    pane.key(keys);
    await sleep(40);
  };
  const sent = async type => {
    for (let i = 0; i < 100 && !daemon.got.some(m => m.type === type); i++) await sleep(20);
    return daemon.got.filter(m => m.type === type).at(-1);
  };
  await shows(/── pair · pair-pane-\w+ ─/);
  return {dir, daemon, pane, text, shows, type, sent, close: async () => { pane.close(); await daemon.close(); }};
}

const REMARK = {
  type: 'message', sender: 'pair', text: 'internal/queue/lease.go:18 suggestion: the lease ends before the last attempt does\n\treturn &Lease{ttl: cfg.Budget + cfg.AttemptTimeout}',
  meta: {remark: 5, trigger: 'regression', place: {file: 'internal/queue/lease.go', line: 18}, suggestion: {action: 9, old: ['\treturn &Lease{ttl: cfg.Budget}'], new: ['\treturn &Lease{ttl: cfg.Budget + cfg.AttemptTimeout}']}},
};

test('a remark\'s action line: a question that starts with a, j, + or - is typed; Alt-↑ picks the remark, and then its keys act', {timeout: 20_000}, async () => {
  const t = await standInPane();
  try {
    t.daemon.send({...REMARK, at: Date.now()});
    await t.shows(/│ \+ return &Lease\{ttl: cfg\.Budget \+ cfg\.AttemptTimeout\}\n {7}\+ useful {2}- noise {2}a apply {2}j jump {2}· Alt-↑ first\n/);
    for (const question of ['are you sure?', 'just why?', '-v flag?', '+1 on that']) {
      await t.type(question);
      assert.match(t.text(), new RegExp(`^› ${question.replace(/[?+]/g, '\\$&')}$`, 'm'), `${question}: typed whole`);
      await t.type('\x15'); // Ctrl-U
    }
    assert.deepEqual(t.daemon.got.filter(m => ['accept', 'go', 'feedback'].includes(m.type)), [], 'nothing taken, no jump, no verdict');
    assert.doesNotMatch(t.text(), /✗ noise|✓ useful/);

    t.daemon.send({type: 'message', sender: 'system', text: 'tests on save: 1 failed', at: Date.now()});
    await t.shows(/tests on save/);
    await t.type('\x1b[1;3A'); // Alt-↑: the remark, not the note after it
    await t.shows(/^▌ +\+ useful {2}- noise {2}a apply {2}j jump$/m);
    assert.match(t.text(), /c copy · a apply · j jump · \+\/- rate/);
    await t.type('a');
    assert.deepEqual(await t.sent('accept'), {type: 'accept', action: 9}, 'picked: a takes its suggestion');
    await t.type('j');
    assert.deepEqual(await t.sent('go'), {type: 'go', file: 'internal/queue/lease.go', line: 18}, 'j goes to its line');
    await t.type('+');
    assert.deepEqual(await t.sent('feedback'), {type: 'feedback', useful: true, remark: 5});
    await t.shows(/regression · internal\/queue\/lease\.go:18 {2}✓ useful/);
    assert.doesNotMatch(t.text(), /\+ useful {2}-/, 'rated: the line goes');

    t.daemon.send({...REMARK, at: Date.now(), meta: {...REMARK.meta, remark: 6}});
    await t.shows(/a apply {2}j jump {2}· Alt-↑ first/);
    t.daemon.send({type: 'message', sender: 'pair', text: 'And another thing.', at: Date.now()});
    await t.shows(/And another thing\./);
    assert.doesNotMatch(t.text(), /a apply/, 'Pair spoke since: the line goes');
    await t.type('\x1b'); // back to typing
    await t.type('\x1b[1;3A');
    assert.match(t.text(), /^▌pair +And another thing\./m, 'and Alt-↑ picks the newest message again');
  } finally {
    await t.close();
  }
});

test('find counts a phrase as one match, also over a code span', {timeout: 20_000}, async () => {
  const t = await standInPane(80, 24);
  try {
    t.daemon.send({type: 'message', sender: 'pair', text: 'Run `pair doctor` to check the provider you set.', at: Date.now()});
    await t.shows(/provider you set/);
    for (const query of ['run pair', 'provider you set']) {
      await t.type(`\x06${query}`);
      await t.shows(/find: .* {2}1 of 1 · in 1 message$/m);
      await t.type('\x1b');
    }
  } finally {
    await t.close();
  }
});

test('find steps through the matches, not the messages, says how many messages they are in, and opens a fold to show one', {timeout: 20_000}, async () => {
  const t = await standInPane(80, 24);
  try {
    const long = [...Array.from({length: 20}, (_, i) => `${i + 1}. step ${i + 1}`), 'the lease ends here'].join('\n');
    t.daemon.send({type: 'message', sender: 'pair', text: long, at: Date.now()});
    t.daemon.send({type: 'message', sender: 'pair', text: 'the lease, and the lease again', at: Date.now()});
    await t.shows(/the lease again/);
    await t.type('\x06lease'); // Ctrl-F
    await t.shows(/^ find: lease {2}3 of 3 · in 2 messages$/m);
    assert.match(t.text(), /^ ↑↓ older\/newer · Enter keep · Esc close$/m);
    assert.equal(t.pane.state.found, 1, 'on the newest match: the second in the last message');
    await t.type('\x1b[A');
    await t.shows(/2 of 3 · in 2 messages/);
    assert.equal(t.pane.state.selected, t.pane.state.entries.length - 1, 'up: the other match of the same message');
    assert.equal(t.pane.state.found, 0);
    await t.type('\x1b[A');
    await t.shows(/1 of 3 · in 2 messages/);
    assert.match(t.text(), /▌ +the lease ends here/, 'the folded message opens to show the match');
    await t.type('\x1b[B');
    await t.shows(/2 of 3/);
    await t.type('\x1b');
    await t.shows(/^› Ask Pair anything/m);
  } finally {
    await t.close();
  }
});

test('a folded message, picked, offers Enter in the footer at every width', {timeout: 20_000}, async () => {
  for (const width of [44, 80, 120]) {
    const t = await standInPane(width, 24);
    try {
      t.daemon.send({type: 'message', sender: 'pair', text: Array.from({length: 30}, (_, i) => `line ${i + 1}`).join('\n'), at: Date.now()});
      await t.shows(/more lines|more ·/);
      await t.type('\x1b[1;3A'); // Alt-↑
      await t.shows(/Enter (unfold|unf)/);
      await t.type('\r');
      await t.shows(/Enter fold/);
    } finally {
      await t.close();
    }
  }
});

test('the command menu shows seven of them and how many more; ↓ goes on past the seventh; Enter inserts a file', {timeout: 20_000}, async () => {
  const t = await standInPane(80, 24);
  try {
    await t.type('/');
    await t.shows(/╶─ commands · 7 of \d+ · type to narrow ─/);
    await t.shows(/^ {3}↓ \d+ more$/m);
    assert.match(t.text(), /^ ▸ \/goal +<text> +set the session goal$/m);
    for (let i = 0; i < 8; i++) await t.type('\x1b[B');
    assert.match(t.text(), /^ ▸ \/drive! /m, 'the eighth, chosen, in sight');
    assert.match(t.text(), /^ {3}↑ 2 more · ↓ \d+ more$/m);
    await t.type('\x15/qu');
    await t.shows(/╶─ commands ─+\n ▸ \/quiet/);
    assert.doesNotMatch(t.text(), /type to narrow/, 'all of them shown: no count');
  } finally {
    await t.close();
  }
});

test('reconnecting: the status counts the time away and the attempts, what you type is kept and not sent', {timeout: 20_000}, async () => {
  const t = await standInPane(90, 16);
  try {
    t.daemon.send({type: 'message', sender: 'pair', text: 'Hello.', at: Date.now()});
    await t.shows(/Hello\./);
    await t.daemon.close();
    await t.shows(/── ! the pair daemon went away · reconnecting ─/, 'a yellow !, not ⚠; no counter yet');
    await t.shows(/reconnecting \ds · attempt [1-9]/);
    assert.match(t.text(), /^› what you type is kept; Enter sends once it is back$/m);
    assert.match(t.text(), /^ Ctrl-D close · \? keys$/m);
    await t.type('still here?\r');
    assert.match(t.text(), /^› still here\?/m, 'kept');
    assert.match(t.text(), /Not sent: the daemon is not back yet/, 'said for a moment, in the footer');
    assert.doesNotMatch(t.text(), /^ ! /m, 'not an error in the conversation');
  } finally {
    t.pane.close();
  }
});

test('calm motion: a remark that comes while an answer streams waits under it, and the status says so; nothing above moves', {timeout: 20_000}, async () => {
  const t = await standInPane(80, 30);
  try {
    t.daemon.send({type: 'message', sender: 'user', text: 'why does the lease end early?', at: Date.now(), history: true});
    t.daemon.send({type: 'activity', state: 'thinking', since: Date.now()});
    t.daemon.send({type: 'partial', text: 'The lease ends too early: ttl is only'});
    await t.shows(/pair  The lease ends too early: ttl is only ▍/);
    const before = t.text().split('\n');
    const above = before.slice(0, before.findIndex(line => line.includes('The lease ends too early')) + 1);
    t.daemon.send({...REMARK, at: Date.now()});
    await t.shows(/── ▖ writing · 1 remark below ─/);
    t.daemon.send({type: 'agents', item: {id: 21}, text: '#21 needs you'});
    await t.shows(/── ▖ writing · 1 remark and 1 note below ─/);
    const during = t.text().split('\n');
    assert.deepEqual(during.slice(0, above.length), above, 'the lines over the answer stay where they were');
    assert.doesNotMatch(t.text(), /regression/, 'the remark waits');
    t.daemon.send({type: 'partial', text: 'The lease ends too early: ttl is only the budget, but the last attempt can start at its very end.'});
    await t.shows(/at its very end\. ▍/);
    assert.doesNotMatch(t.text(), /regression/, 'still waiting while the words come');
    t.daemon.send({type: 'message', sender: 'pair', text: 'The lease ends too early: ttl is only the budget, but the last attempt can start at its very end.', at: Date.now()});
    t.daemon.send({type: 'activity', state: 'idle'});
    await t.shows(/watch +regression · internal\/queue\/lease\.go:18/);
    const after = t.text();
    assert.ok(after.indexOf('at its very end.') < after.indexOf('regression'), 'the remark under the answer, not over it');
    assert.ok(after.indexOf('regression') < after.indexOf('#21 needs you'), 'what waited, in the order it came');
    assert.doesNotMatch(after, /below/, 'nothing waits any more');
  } finally {
    await t.close();
  }
});

test('the role in the header in its colour; the Driver that keeps the wheel says so', {timeout: 20_000}, async () => {
  const dir = realpathSync(scratch('pair-pane-'));
  const daemon = await standIn(dir, {role: 'driver', keep: true});
  const written = [];
  const pane = startChatPane(daemon.socket, {input: new PassThrough(), output: {isTTY: true, write: data => written.push(data), on: () => {}}, size: () => ({width: 80, height: 20}), cwd: dir, env: {}, exit: () => {}});
  const text = () => pane.frame().join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  try {
    for (let i = 0; i < 200 && !/driver · keeps the wheel/.test(text()); i++) await sleep(25);
    assert.match(text(), /^── pair · pair-pane-\w+ ─+ driver · keeps the wheel ──$/m);
    assert.match(text(), /── ◆ Pair drives · any key in Neovim takes it back ─/);
    assert.match(pane.frame()[0], /\x1b\[31m\x1b\[1mdriver/, 'the Driver in red');
    daemon.send({type: 'role', role: 'scout'});
    for (let i = 0; i < 200 && !/scout · normal/.test(text()); i++) await sleep(25);
    assert.match(text(), /─ scout · normal ──$/m);
    assert.match(pane.frame()[0], /\x1b\[32m\x1b\[1mscout/, 'Scout in green');
  } finally {
    pane.close();
    await daemon.close();
  }
});

test('the plain pane (--plain): the role in its prompt in its colour, and └ for the tools', {timeout: 20_000}, async () => {
  const dir = realpathSync(scratch('pair-pane-'));
  const daemon = await standIn(dir, {role: 'scout'});
  const input = new PassThrough();
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 80;
  let out = '';
  output.on('data', data => { out += data; });
  let closed = null;
  runChat(daemon.socket, {plain: true, input, output, cwd: dir, env: {}, exit: code => { closed = code; }});
  const shows = async pattern => {
    for (let i = 0; i < 200 && !pattern.test(out); i++) await sleep(25);
    assert.match(out, pattern);
  };
  try {
    await shows(/\x1b\[32m\x1b\[1mscout\x1b\[0m › /);
    daemon.send({type: 'tool', tool: 'read', what: 'queue.go 1-5'});
    await shows(/└ read queue\.go 1-5/);
    assert.doesNotMatch(out, /⎿/);
    // What /gen made: gen, in magenta, and how to take it under it, for there are no keys here.
    daemon.send({type: 'gen_card', gen: 4, action: 9, shape: 'file', state: 'ready', of: 1, taken: 0, left: 1, keys: {k: 'keep one'}});
    daemon.send({type: 'message', sender: 'pair', text: 'gen #4 · file · 1 new file to review: db/x.sql +2', at: Date.now(), meta: {gen: 4, hint: 'In Neovim, :w in one writes it to its path.'}});
    await shows(/\x1b\[35;1mgen\x1b\[0m #4 · file · 1 new file to review: db\/x\.sql \+2\n {4}In Neovim, :w in one writes it to its path\./);
    daemon.send({type: 'confirm', id: 3, gen: 5, text: 'gen #5 · new files: "migration". Shape?', hint: 'y: file · here, scaffold, try · n cancels'});
    await shows(/gen\x1b\[0m #5 · new files: "migration"\. Shape\? \[y: file · here, scaffold, try · n\s+cancels\]/);
  } finally {
    input.end();
    await daemon.close();
    for (let i = 0; i < 40 && closed === null; i++) await sleep(25);
  }
});

test('/gen in the pane: the shapes after /gen, the gen card with its keys, its request in the status; k, Enter, d twice and u on it', {timeout: 30_000}, async () => {
  const t = await setUp({width: 80, height: 34});
  const nvim = editor(t.socket, t.dir, {place: {file: join(t.dir, 'queue.go'), line: 1}});
  try {
    await t.shows('What are we doing');
    await t.type('later\r');
    await t.shows('No goal then.');
    // /gen and a space: its shapes first, then what else it does.
    await t.type('/gen ');
    assert.match(t.text(), /commands · 7 of 8 · type to narrow/);
    assert.match(t.text(), / ▸ \/gen here +<what> +ask Pair for code at your cursor/);
    assert.match(t.text(), /\/gen file +<what> +new files/);
    await t.type('h\t');
    assert.match(t.text(), /› \/gen here $/m, 'Tab completes the shape, ready for the request');
    t.partner.setResponses([
      fauxAssistantMessage([fauxToolCall('propose', {file: 'queue.go', line: 1, insert: true, text: '\n// Budget is how long a lease lasts.', note: 'a comment'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage([fauxText('A comment on the budget.')]),
    ]);
    await t.type('a comment on the budget\r');
    await t.shows(/^ gen   #1 · here · 2 lines at queue\.go:1: A comment on the budget\.$/m);
    assert.match(t.text(), /│ \+ \/\/ Budget is how long a lease lasts\./, 'the code as a diff');
    assert.match(t.text(), /^ {7}k keep   Enter open   d drop   u undo   · Alt-↑ picks$/m, 'its keys, as an action line');
    await t.shows(/── ◉ watching · gen #1: ready in Neovim ─/);
    // Picked: the footer has its keys. k takes it in Neovim, as Alt-y does there.
    await t.type('\x1b[1;3A');
    assert.match(t.text(), /▌gen   #1 · here/);
    assert.match(t.text(), /c copy · k keep · Enter open · d drop · u undo · j jump · Esc back/);
    await t.type('k');
    await nvim.next(message => message.type === 'accept');
    // Enter: Neovim goes to its place.
    await t.type('\r');
    const go = await nvim.next(message => message.type === 'go');
    assert.deepEqual({file: go.file, line: go.line}, {file: join(t.dir, 'queue.go'), line: 1});
    // d once only says what a second d does; the second drops it.
    await t.type('d');
    assert.match(t.text(), /d again drops what is left of gen #1/);
    await t.type('d');
    await t.shows('gen #1: its code dropped.');
    await nvim.next(message => message.type === 'gen_drop' && message.gen === 1);
    await t.shows(/── ◉ watching ─+ Faux Model/);
    assert.doesNotMatch(t.text(), /gen #1: ready/, 'nothing left to take');
  } finally {
    nvim.stop();
    await t.close();
  }
});

test('the plain pane: what /gen made is the gen speaker\'s, with how to take it under it', {timeout: 20_000}, async () => {
  const {genText} = await import('../src/chat.mjs');
  assert.equal(genText('gen #7 · scaffold · 9 files'), '#7 · scaffold · 9 files');
  assert.equal(genText('Undid gen #7'), 'Undid gen #7', 'only its start');
  const {formatMessage} = await import('../src/chat-style.mjs');
  assert.equal(formatMessage('gen', '#7 · scaffold', {color: false}), 'gen #7 · scaffold');
  assert.match(formatMessage('gen', '#7', {color: true}), /^\x1b\[35;1mgen\x1b\[0m #7$/, 'magenta');
});

test('a scaffold\'s card: k puts /keep on the line with its files to pick, Enter keeps one; d twice deletes the copy; u undoes; at work, the status says so', {timeout: 20_000}, async () => {
  const t = await standInPane(90, 24);
  try {
    const card = {type: 'gen_card', gen: 7, action: 31, shape: 'scaffold', state: 'ready', since: Date.now(), of: 3, taken: 0, left: 3, keys: {k: 'keep one', enter: 'open the list', d: 'drop all', u: 'undo'}, files: ['internal/admin/orders.go', 'internal/admin/orders_test.go', 'cmd/shop/main.go']};
    t.daemon.send({type: 'message', sender: 'user', text: '/gen scaffold an admin page', at: Date.now()});
    t.daemon.send(card);
    t.daemon.send({type: 'message', sender: 'pair', text: 'gen #7 · scaffold · 3 files, 1 of yours changed · 2m 41s', at: Date.now(), meta: {gen: 7, hint: 'In Neovim, :Pair gen list keeps them one at a time (k).'}});
    await t.shows(/^ gen   #7 · scaffold · 3 files, 1 of yours changed · 2m 41s\n +\n {7}k keep one   Enter open the list   d drop all   u undo   · Alt-↑ picks$/m);
    assert.doesNotMatch(t.text(), /In Neovim, :Pair gen list/, 'the keys say it');
    assert.match(t.text(), /── ◉ watching · gen #7: 0 of 3 kept ─/);
    await t.type('\x1b[1;3A'); // Alt-↑ picks the card first
    await t.type('k');
    assert.match(t.text(), /╶─ gen #7 · files to keep ─+\n ▸ internal\/admin\/orders\.go *\n {3}internal\/admin\/orders_test\.go *\n {3}cmd\/shop\/main\.go/);
    assert.match(t.text(), /› \/keep $/m);
    await t.type('main');
    assert.match(t.text(), / ▸ cmd\/shop\/main\.go/, 'typing narrows it');
    await t.type('\r');
    assert.deepEqual(await t.sent('keep'), {type: 'keep', path: 'cmd/shop/main.go'});
    // Kept one: the card says so, in the status too.
    t.daemon.send({...card, taken: 1, left: 2, files: card.files.slice(0, 2)});
    await t.shows(/gen #7: 1 of 3 kept/);
    await t.type('\x1b[1;3A');
    await t.type('\r');
    assert.deepEqual(await t.sent('gen_open'), {type: 'gen_open', action: 31});
    await t.type('d'); // the card is still picked
    assert.match(t.text(), /d again drops gen #7's copy, and what you did not keep of it/);
    assert.equal(t.daemon.got.some(m => m.type === 'gen_drop_all'), false, 'not yet');
    await t.type('d');
    assert.deepEqual(await t.sent('gen_drop_all'), {type: 'gen_drop_all', action: 31});
    await t.type('u');
    assert.deepEqual(await t.sent('undo'), {type: 'undo', action: 31});
    // Another request at work: its number and how long, in magenta, and the one waiting its turn.
    t.daemon.send({type: 'gen_card', gen: 8, action: 32, shape: 'file', state: 'generating', since: Date.now() - 5000, of: 0, taken: 0, left: 0, keys: {}});
    t.daemon.send({type: 'gen_card', gen: 9, action: null, shape: 'here', state: 'queued', since: Date.now(), of: 0, taken: 0, left: 0, keys: {}});
    await t.shows(/── [▖▘▝▗] gen #8 generating [5-9]s · gen #9 waits ─/);
  } finally {
    await t.close();
  }
});
