// Sets the stage for one capture in a scratch directory: the sample project at the scene's starting point, the
// fake model server, the herdr stand-in, the real daemon (`pair daemon`, as the service runs it) with a config
// that points at them, and a chat client, as the chat pane would be. Writes `ready` when Neovim may start.
// usage: node stage.mjs <scene> <scratch dir under /tmp/paircap.*>
import {execFileSync, spawn} from 'node:child_process';
import {cpSync, existsSync, openSync, writeFileSync} from 'node:fs';
import {connect} from 'node:net';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readMessages, sendMessage} from '../../src/protocol.mjs';
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

// The project (hookd, unless the scene names another), committed as it is when the scene starts; a Go project's
// packages built, so the first test run is quick.
const project = join(dir, scene.project ?? 'hookd');
cpSync(join(HERE, scene.project ?? 'hookd'), project, {recursive: true});
scene.setup?.(project);
const git = (...args) => execFileSync('git', ['-c', 'user.name=dev', '-c', 'user.email=dev@example.com', ...args], {cwd: project});
git('init', '-q');
git('add', '-A');
git('commit', '-qm', 'hookd');
if (scene.branch) git('checkout', '-qb', scene.branch);
if (existsSync(join(project, 'go.mod'))) execFileSync('go', ['test', '-count=1', '-run', '^$', './...'], {cwd: project, stdio: 'ignore'});

const models = await startModelServer(scene, {log});
const herdrSocket = join(dir, 'herdr.sock');
const herdr = await standInHerdr(herdrSocket, {cwd: project, nvim: join(dir, 'nvim.sock'), log});

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

const socket = join(dir, 'pair.sock');
const model = id => ({api: 'openai', baseUrl: models.baseUrl, model: id, contextWindow: 65536});
writeFileSync(join(dir, 'config.json'), JSON.stringify({
  dataDir: join(dir, 'data'),
  socket,
  typingPauseMs: 900,
  keepWarm: false,
  ...(scene.testOnSave ? {testOnSave: {[project]: scene.testOnSave}} : {}),
  ...voice(),
  board: scene.board ? join(HERE, 'board.mjs') : null, // the stand-in board, or none: not yours
  models: {watcher: model('watcher'), partner: model('partner')},
}, null, 2));
const out = openSync(join(dir, 'daemon.log'), 'a');
const daemon = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', PAIR, 'daemon'], {
  env: {...process.env, PAIR_CONFIG: join(dir, 'config.json')}, stdio: ['ignore', out, out],
});
while (!existsSync(socket)) await sleep(50);

const chat = connect(socket);
readMessages(chat, message => { if (message.type === 'message') log(`chat: ${message.sender}: ${message.text}`); });
await new Promise(resolve => chat.on('connect', resolve));
sendMessage(chat, {type: 'hello', role: 'chat', cwd: project, herdr: {socket: herdrSocket, workspace: 'w1', pane: 'w1:p2'}});
if (scene.goal) sendMessage(chat, {type: 'goal', text: scene.goal}); // else the session takes the board task's

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
writeFileSync(join(dir, 'ready'), '');
log(`ready: ${name}`);
