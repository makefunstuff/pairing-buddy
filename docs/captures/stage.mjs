// Sets the stage for one capture in a scratch directory: the scene's sample project at its starting point, the
// fake model server, the herdr stand-in, the real daemon (`pair daemon`, as the service runs it) with a config
// that points at them, and a chat client, as the chat pane would be. Writes `ready` when Neovim may start.
// usage: node stage.mjs <scene> <scratch dir under /tmp/paircap.*>
import {execFileSync, spawn} from 'node:child_process';
import {chmodSync, cpSync, existsSync, mkdirSync, openSync, utimesSync, writeFileSync} from 'node:fs';
import {connect} from 'node:net';
import {basename, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readMessages, sendMessage} from '../../src/protocol.mjs';
import {openStore} from '../../src/store.mjs';
import {standInHerdr} from './herdr.mjs';
import {startModelServer} from './model.mjs';
import {scenes} from './scenes.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PAIR = fileURLToPath(new URL('../../bin/pair.mjs', import.meta.url));
const [name, dir] = process.argv.slice(2);
const scene = scenes[name];
if (!scene) throw new Error(`no scene ${name}; there are: ${Object.keys(scenes).join(', ')}`);
if (!/^\/tmp\/paircap\.[^/]+$/.test(dir ?? '')) throw new Error('the stage needs a scratch directory /tmp/paircap.*'); // short socket paths, and nothing of yours

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = line => console.error(`${new Date().toISOString().slice(11, 23)} ${line}`);

// The project (hookd, unless the scene names another), committed as it is when the scene starts; built with the
// scene's `build`, or a Go project's packages, so the first run is quick.
const source = join(HERE, scene.project ?? 'hookd');
const project = join(dir, basename(source));
cpSync(source, project, {recursive: true});
scene.setup?.(project);
const git = (...args) => execFileSync('git', ['-c', 'user.name=dev', '-c', 'user.email=dev@example.com', ...args], {cwd: project});
git('init', '-q');
git('add', '-A');
git('commit', '-qm', 'hookd');
if (scene.branch) git('checkout', '-qb', scene.branch);
if (scene.build) execFileSync(scene.build[0], scene.build.slice(1), {cwd: project, stdio: 'ignore'});
else if (existsSync(join(project, 'go.mod'))) execFileSync('go', ['test', '-count=1', '-run', '^$', './...'], {cwd: project, stdio: 'ignore'});

// The scene's other agents: a stand-in board (its command prints the list; its task files say where each task's
// agent runs) and herdr's agents. Scenes without them read no board at all, never yours.
const board = join(dir, 'board');
const showBoard = tasks => writeFileSync(join(board, 'list.json'), JSON.stringify(tasks));
if (scene.agents) {
  mkdirSync(board);
  writeFileSync(join(board, 'herdr-projects'), `#!/bin/sh\ncat '${join(board, 'list.json')}'\n`);
  chmodSync(join(board, 'herdr-projects'), 0o755);
  for (const [id, file] of Object.entries(scene.agents.files)) {
    mkdirSync(join(board, 'tasks', id), {recursive: true});
    writeFileSync(join(board, 'tasks', id, 'task.json'), JSON.stringify(file));
  }
  showBoard(scene.agents.tasks);
}

const models = await startModelServer(scene, {log});
const herdrSocket = join(dir, 'herdr.sock');
const herdr = await standInHerdr(herdrSocket, {cwd: project, nvim: join(dir, 'nvim.sock'), agents: scene.agents?.herdr ?? [], log});

// The microphone of a scene with a question: its words, said by espeak-ng, played in real time while the key is
// held. whisper.cpp hears them for real: CAP_WHISPER_MODEL is its model, CAP_WHISPER its binary (else whisper-cli).
function voice() {
  if (!scene.question) return {};
  if (!process.env.CAP_WHISPER_MODEL) throw new Error(`the ${name} scene needs CAP_WHISPER_MODEL, a whisper.cpp model`);
  const question = join(dir, 'question.wav');
  execFileSync('sh', ['-c', 'espeak-ng -v en-us+m3 -s 135 --stdout "$1" > "$2"', 'sh', scene.question, question]);
  const record = `ffmpeg -loglevel error -re -i ${question} -f s16le -ar 16000 -ac 1 -`;
  return {voice: {model: process.env.CAP_WHISPER_MODEL, whisper: process.env.CAP_WHISPER ?? 'whisper-cli', record}};
}

// Yesterday's session, for the morning pick-up: ended at 17:40 the day before, with its debrief and where to pick up.
// The project's files are older, so the failing test keeps its signs.
const dataDir = join(dir, 'data');
mkdirSync(dataDir, {recursive: true});
if (scene.yesterday) {
  const ended = new Date(Date.now() - 86_400_000).setHours(17, 40, 0, 0);
  const {note, first, tests} = scene.yesterday(project);
  const store = openStore(join(dataDir, 'sessions.sqlite'));
  const {id} = store.createSession({root: project, conversationId: 'yesterday', goal: scene.goal, level: 'normal', at: ended - 3 * 3_600_000});
  store.endSession(id, note, ended, {first, tests});
  store.close();
  const before = new Date(ended - 3_600_000);
  for (const file of tests.results.flatMap(test => [test.file, test.failure?.file]).filter(Boolean)) utimesSync(file, before, before);
}

// The daemon's clock shows `scene.clock` o'clock, as the debrief's heading and the pick-up read it.
function zone(hour) {
  if (hour === undefined) return process.env.TZ;
  const offset = ((hour - new Date().getUTCHours() + 36) % 24) - 12; // -12..11
  return offset === 0 ? 'UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
}

const socket = join(dir, 'pair.sock');
const model = id => ({api: 'openai', baseUrl: models.baseUrl, model: id, contextWindow: 65536});
writeFileSync(join(dir, 'config.json'), JSON.stringify({
  dataDir,
  socket,
  typingPauseMs: 900,
  keepWarm: false,
  ...(scene.testOnSave ? {testOnSave: {[project]: scene.testOnSave}} : {}),
  ...voice(),
  // the stand-in board, or none: not yours
  board: scene.board ? join(HERE, 'board.mjs') : scene.agents ? join(board, 'herdr-projects') : null,
  agents: Boolean(scene.agents),
  models: {watcher: model('watcher'), partner: model('partner')},
}, null, 2));
const out = openSync(join(dir, 'daemon.log'), 'a');
const daemon = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', PAIR, 'daemon'], {
  env: {...process.env, PAIR_CONFIG: join(dir, 'config.json'), HERDR_PROJECTS_DATA_DIR: board, TZ: zone(scene.clock)}, stdio: ['ignore', out, out],
});
while (!existsSync(socket)) await sleep(50);

const chat = connect(socket);
readMessages(chat, message => { if (message.type === 'message') log(`chat: ${message.sender}: ${message.text}`); });
await new Promise(resolve => chat.on('connect', resolve));
sendMessage(chat, {type: 'hello', role: 'chat', cwd: project, herdr: {socket: herdrSocket, workspace: 'w1', pane: 'w1:p2'}});
if (scene.goal) sendMessage(chat, {type: 'goal', text: scene.goal}); // else the session takes the board task's

// The day so far, for the debrief: its active time and the user's verdicts on Pair's remarks.
if (scene.today) {
  const store = openStore(join(dataDir, 'sessions.sqlite'));
  let session;
  while (!(session = store.activeSession(project))) await sleep(50);
  store.addSessionActive(session.id, scene.today.activeMs);
  for (const [trigger, verdict] of scene.today.remarks) store.rateRemark(store.addRemark({sessionId: session.id, trigger, score: 7, at: Date.now()}), verdict);
  store.close();
}

async function stop() {
  chat.destroy();
  daemon.kill('SIGTERM');
  await new Promise(resolve => daemon.once('exit', resolve));
  await herdr.close();
  await models.close();
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
// The other agents move on once you start typing in the file Neovim opened (buffer 1): the relay holds their news
// for your next breakpoint.
if (scene.agents?.later) {
  const changedtick = () => {
    try {
      return Number(execFileSync('nvim', ['--server', join(dir, 'nvim.sock'), '--remote-expr', 'getbufvar(1, "changedtick")'], {encoding: 'utf8'}));
    } catch {
      return null;
    }
  };
  (async () => {
    let first = null;
    while (first === null) { first = changedtick(); await sleep(200); }
    while (changedtick() === first) await sleep(100);
    scene.agents.later(herdr.agents, showBoard);
    log('the other agents moved on');
  })();
}

writeFileSync(join(dir, 'ready'), '');
log(`ready: ${name}`);
