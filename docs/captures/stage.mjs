// Sets the stage for one capture in a scratch directory: the scene's sample project at its starting point, the
// fake model server, the herdr stand-in, the real daemon (`pair daemon`, as the service runs it) with a config
// that points at them, and a chat client, as the chat pane would be. Writes `ready` when Neovim may start.
// usage: node stage.mjs <scene> <scratch dir under /tmp/paircap.*>
import {execFileSync, spawn} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, openSync, readFileSync, symlinkSync, utimesSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {connect} from 'node:net';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readMessages, sendMessage} from '../../src/protocol.mjs';
import {openStore} from '../../src/store.mjs';
import {standInHerdr} from './herdr.mjs';
import {startModelServer} from './model.mjs';
import {scenes} from './scenes.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PAIR = fileURLToPath(new URL('../../bin/pair.mjs', import.meta.url));
const [name, dir] = process.argv.slice(2);
// A tutorial scene (t-*, tapes at 1920x1080 for the video) is set up as the scene it is named after, unless it has
// its own, and runs without herdr: one Neovim with the chat (:Pair chat) and your terminal in it, all on screen.
const tutorial = /^t-/.test(name ?? '');
const own = scenes[name] ?? (tutorial ? scenes[name.slice(2)] : undefined);
if (!own) throw new Error(`no scene ${name}; there are: ${Object.keys(scenes).join(', ')}`);
const scene = tutorial ? {...own, noHerdr: true} : own;
if (!/^\/tmp\/paircap\.[^/]+$/.test(dir ?? '')) throw new Error('the stage needs a scratch directory /tmp/paircap.*'); // short socket paths, and nothing of yours

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = line => console.error(`${new Date().toISOString().slice(11, 23)} ${line}`);

// The project (hookd, unless the scene names another), committed as it is when the scene starts; built with the
// scene's `build`, or a Go project's packages, so the first run is quick. A scene of the blank page starts in a folder
// of its own with no git yet: empty, or with what its setup puts there.
const source = join(HERE, scene.project ?? 'hookd');
const project = join(dir, scene.blank ?? basename(source));
if (scene.blank) {
  mkdirSync(project);
  scene.setup?.(project);
} else {
  cpSync(source, project, {recursive: true});
  scene.setup?.(project);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=dev', '-c', 'user.email=dev@example.com', ...args], {cwd: project});
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'hookd');
  if (scene.branch) git('checkout', '-qb', scene.branch);
  if (scene.build) execFileSync(scene.build[0], scene.build.slice(1), {cwd: project, stdio: 'ignore'});
  else if (existsSync(join(project, 'go.mod'))) execFileSync('go', ['test', '-count=1', '-run', '^$', './...'], {cwd: project, stdio: 'ignore'});
}

// The scene's other agents: a stand-in board (board.mjs, answering from a state file: the project's space and its
// tasks, each on a branch in a worktree of its own) and herdr's agents, `worktree:<n>` in their cwd being task n's.
// Scenes without them read no board at all, never yours.
const board = join(dir, 'board');
// A task's `work` (file -> its text, or a function of the text it had) is committed on its branch, as its agent would
// have; a task with `noWorktree` is the branch the scene itself is on.
const key = scene.agents?.key ?? scene.agents?.tasks[0]?.id.split('-')[0] ?? 'HSH';
// A task the scene changes later replaces the one of its id; a task the board added since (a /gen board pick) stays.
const showBoard = tasks => {
  const file = join(board, 'state.json');
  const added = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).tasks.filter(task => !tasks.some(each => each.id === task.id)) : [];
  writeFileSync(file, JSON.stringify({spaces: [{name: basename(project), key, path: project}], tasks: [...tasks, ...added]}));
};
const worktreeOf = n => join(dir, 'work', `${basename(project)}-${n}`);
if (scene.agents) {
  mkdirSync(board);
  for (const task of scene.agents.tasks.filter(each => !each.noWorktree)) {
    const tree = worktreeOf(task.id.split('-')[1]);
    execFileSync('git', ['worktree', 'add', '-q', '-b', task.branch, tree], {cwd: project, stdio: 'ignore'});
    if (!task.work) continue;
    for (const [file, text] of Object.entries(task.work)) {
      mkdirSync(dirname(join(tree, file)), {recursive: true});
      writeFileSync(join(tree, file), typeof text === 'function' ? text(readFileSync(join(tree, file), 'utf8')) : text);
    }
    execFileSync('git', ['add', '-A'], {cwd: tree});
    execFileSync('git', ['-c', 'user.name=agent', '-c', 'user.email=agent@example.com', 'commit', '-qm', task.title], {cwd: tree});
  }
  for (const agent of scene.agents.herdr) agent.cwd = agent.cwd.replace(/^worktree:(\d+)$/, (_, n) => worktreeOf(n));
  showBoard(scene.agents.tasks);
}

// CAP_MODEL=deepseek: a real model instead of the scripted one, for the tutorial video. Its key is read at run time
// from pi's auth.json and kept only in the scene's own auth.json (mode 600), where the daemon and `pair doctor` find
// it; it is never in an environment variable, so the shell VHS types into cannot print it.
const LIVE = process.env.CAP_MODEL === 'deepseek';
if (LIVE) {
  const {key} = JSON.parse(readFileSync(join(homedir(), '.pi/agent/auth.json'), 'utf8')).deepseek;
  // pi's key is the key itself, or "!command" that prints it
  const secret = key.startsWith('!') ? execFileSync('sh', ['-c', key.slice(1)], {encoding: 'utf8'}).trim() : key;
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({deepseek: {type: 'api_key', key: secret}}), {mode: 0o600});
}
const models = LIVE ? {close: async () => {}} : await startModelServer(scene, {log});
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
const live = {provider: 'deepseek', model: 'deepseek-flash'};
writeFileSync(join(dir, 'config.json'), JSON.stringify({
  dataDir,
  socket,
  typingPauseMs: 900,
  keepWarm: false,
  ...(scene.testOnSave ? {testOnSave: {[project]: scene.testOnSave}} : {}),
  ...voice(),
  // the stand-in board, or none: not yours. It is `shepherdr` on the daemon's PATH, so the commands Pair shows read as
  // the board's own.
  board: scene.board || scene.agents ? 'shepherdr' : null,
  agents: Boolean(scene.agents),
  ...(LIVE ? {model: live} : {models: {watcher: model('watcher'), partner: model('partner')}}),
}, null, 2));
const out = openSync(join(dir, 'daemon.log'), 'a');
mkdirSync(join(dir, 'bin'));
symlinkSync(join(HERE, 'board.mjs'), join(dir, 'bin', 'shepherdr'));
const daemon = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', PAIR, 'daemon'], {
  env: {...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, PAIR_CONFIG: join(dir, 'config.json'), ...(scene.agents ? {CAP_BOARD: join(board, 'state.json')} : {}), TZ: zone(scene.clock)}, stdio: ['ignore', out, out],
});
while (!existsSync(socket)) await sleep(50);

const chat = connect(socket);
readMessages(chat, message => {
  if (message.type === 'message') log(`chat: ${message.sender}: ${message.text}`);
  // A scene with `allow` answers Pair's questions in the chat with yes, as you would in the chat pane beside Neovim.
  if (scene.allow && message.type === 'confirm') sendMessage(chat, {type: 'confirm', id: message.id, ok: true});
});
await new Promise(resolve => chat.on('connect', resolve));
// Without herdr, the chat is the one you open in Neovim: this client only listens.
if (!scene.noHerdr) sendMessage(chat, {type: 'hello', role: 'chat', cwd: project, herdr: {socket: herdrSocket, workspace: 'w1', pane: 'w1:p2'}});
if (scene.goal && !scene.noHerdr) sendMessage(chat, {type: 'goal', text: scene.goal}); // else the session takes the board task's, or :Pair new sets it

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
