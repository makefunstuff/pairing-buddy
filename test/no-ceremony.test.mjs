// No ceremony: the goal comes from the board task or the branch, and sessions end by themselves.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmodSync, realpathSync, writeFileSync} from 'node:fs';
import {connect} from 'node:net';
import {basename, join} from 'node:path';
import {test} from 'node:test';
import {createModels, fauxAssistantMessage, fauxProvider, fauxText} from '@earendil-works/pi-ai';
import {parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {readMessages, sendMessage} from '../src/protocol.mjs';
import {PairSession} from '../src/session.mjs';
import {openStore} from '../src/store.mjs';
import {scratch} from './temp.mjs';

const answers = async () => ({ok: true});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function client(socketPath, hello) {
  const socket = connect(socketPath);
  const received = [];
  readMessages(socket, message => received.push(message));
  socket.on('connect', () => sendMessage(socket, hello));
  return {
    received,
    send: message => sendMessage(socket, message),
    async next(match, timeoutMs = 5000) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const found = received.find(match);
        if (found) return found;
        await sleep(20);
      }
      throw new Error(`no such message; got ${JSON.stringify(received.map(message => message.text ?? message.type))}`);
    },
    close: () => socket.destroy(),
  };
}

/** A git repo on branch `work/7-faster-hash`, and a board command that knows its task 7 and another repo's. */
function project() {
  const root = realpathSync(scratch('probe-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=dev', '-c', 'user.email=dev@example.com', ...args], {cwd: root});
  git('init', '-q', '-b', 'work/7-faster-hash');
  writeFileSync(join(root, 'probe.c'), 'int probe(int n) { return n * 31; }\n');
  git('add', '-A');
  git('commit', '-qm', 'probe: first hash');
  const tasks = [
    {id: 'elsewhere/7', state: 'working', title: 'Not this one', msg: ''},
    {id: `${basename(root)}/7`, state: 'working', title: 'Faster hash', msg: 'trying fibonacci'},
  ];
  const board = join(scratch('board-'), 'board');
  writeFileSync(board, `#!/bin/sh\necho '${JSON.stringify(tasks)}'\n`);
  chmodSync(board, 0o755);
  return {root, board};
}

async function daemonFor(board, options = {}) {
  const dataDir = scratch('pair-data-');
  const config = parseConfig({
    dataDir, socket: join(dataDir, 'pair.sock'), board, agents: false,
    models: {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'w'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'p'}},
  });
  const watcher = fauxProvider({provider: 'faux-watcher'});
  const partner = fauxProvider({provider: 'faux-partner'});
  const models = createModels();
  models.setProvider(watcher.provider);
  models.setProvider(partner.provider);
  const pairModels = {models, watcher: watcher.getModel(), partner: partner.getModel()};
  watcher.setResponses(Array.from({length: 20}, () => fauxAssistantMessage([fauxText('0')])));
  const daemon = await startDaemon(config, {pairModels, probe: answers, log: () => {}, ...options});
  return {config, partner, daemon, dataDir};
}

test('a session takes the goal of its board task, matched by repo and number, and the card shows what goes', {timeout: 20_000}, async () => {
  const {root, board} = project();
  const {config, daemon} = await daemonFor(board);
  const editor = client(config.socket, {type: 'hello', role: 'editor', cwd: root});
  const chat = client(config.socket, {type: 'hello', role: 'chat', cwd: root});
  try {
    const welcome = await chat.next(message => message.type === 'welcome');
    assert.equal(welcome.goal, 'Faster hash', 'not "Not this one", the other repo\'s task 7');
    await chat.next(message => message.text === `Goal, from the board task ${basename(root)}/7: Faster hash`);
    assert.ok(!chat.received.some(message => /What are we doing/.test(message.text ?? '')), 'nothing is asked');

    editor.send({type: 'context'});
    const card = await editor.next(message => message.type === 'context');
    assert.equal(card.goal, 'Faster hash');
    assert.deepEqual(card.sections.map(section => section.source), ['board', 'git', 'terminal', 'editor']);
    assert.equal(card.sections[0].rows[0].text, `${basename(root)}/7 · Faster hash`);
    assert.match(card.sections[1].rows.find(row => row.label === 'last').text, /^[0-9a-f]{7} probe: first hash$/);

    editor.send({type: 'hide', source: 'board', hidden: true});
    await editor.next(message => message.type === 'context' && message.sections[0].hidden);
  } finally {
    editor.close();
    chat.close();
    await daemon.close();
  }
});

test('the last Neovim closing ends a used session with its note; an unused one ends without asking for a note', {timeout: 20_000}, async () => {
  const {root, board} = project();
  const {config, partner, daemon, dataDir} = await daemonFor(board, {aloneEndMs: 200});
  const ended = () => {
    const store = openStore(join(dataDir, 'sessions.sqlite'));
    try { return store.activeSession(root) === undefined; } finally { store.close(); }
  };
  try {
    let asked = 0;
    partner.setResponses([() => { asked++; return fauxAssistantMessage([fauxText('Goal: faster hash. Left: the worst case.')]); }]);
    const first = client(config.socket, {type: 'hello', role: 'editor', cwd: root});
    await first.next(message => message.type === 'welcome');
    first.send({type: 'event', event: {kind: 'edit', file: join(root, 'probe.c'), from: 1, to: 1, text: 'x'}});
    await sleep(100);
    first.close();
    for (let i = 0; i < 50 && !ended(); i++) await sleep(100);
    assert.ok(ended(), 'the session ended once its Neovim was gone');
    assert.equal(asked, 1, 'with a note');

    const second = client(config.socket, {type: 'hello', role: 'editor', cwd: root});
    await second.next(message => message.type === 'welcome');
    second.close();
    for (let i = 0; i < 50 && !ended(); i++) await sleep(100);
    assert.ok(ended());
    assert.equal(asked, 1, 'nothing happened in it: no note');
  } finally {
    await daemon.close();
  }
});

test('a session nobody used for the idle time ends by itself and says so', {timeout: 20_000}, async () => {
  const {root, board} = project();
  const {config, partner, daemon} = await daemonFor(board, {idleEndMs: 1500});
  const chat = client(config.socket, {type: 'hello', role: 'chat', cwd: root});
  try {
    partner.setResponses([fauxAssistantMessage([fauxText('Goal: faster hash.')])]);
    await chat.next(message => message.type === 'welcome');
    chat.send({type: 'event', event: {kind: 'typing'}});
    const ended = await chat.next(message => message.type === 'ended', 8000);
    assert.match(ended.why, /^nothing happened for/);
    await chat.next(message => /^(Day|Session)'s end: .+\nGoal: faster hash\.$/.test(message.text ?? ''));
  } finally {
    chat.close();
    await daemon.close();
  }
});

test('"later" to the goal question means no goal, and the next question is a question', async () => {
  const sent = [];
  const asked = [];
  const pair = new PairSession({
    record: {id: 1, root: '/project', conversation_id: 7, goal: null, level: 'normal'},
    store: {addMessage() {}, setGoal() {}, lastRemark: () => null},
    partner: {thinkingOf: () => 'off', ask: async (_id, input) => { asked.push(input); return 'Line 3.'; }},
    score: async () => ({value: 0}), typingPauseMs: 2000,
    notify: (_role, message) => sent.push(message), requestEditor: async () => null, now: () => 100_000,
  });
  await pair.ask('later');
  assert.equal(pair.state.goal, null);
  assert.equal(sent.at(-1).text, 'No goal then. Ask anything; /goal sets one.');
  await pair.ask('where does the probe loop?');
  assert.equal(asked.length, 1, 'answered, not taken as the goal');
  assert.ok(pair.idle(60_000, 100_000 + 60_000), 'used, then idle');
  assert.ok(!pair.idle(60_000, 100_000 + 59_000));
});
