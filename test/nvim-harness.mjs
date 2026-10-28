// The daemon with scripted models, a fake herdr and a headless Neovim with the plugin, for the tests that drive
// the plugin end to end (nvim.test.mjs, gen-nvim.test.mjs).
import {execFile, execFileSync, spawn} from 'node:child_process';
import {mkdirSync, realpathSync, writeFileSync} from 'node:fs';
import {connect} from 'node:net';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createModels, fauxProvider} from '@earendil-works/pi-ai';
import {parseConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {readMessages, sendMessage} from '../src/protocol.mjs';
import {fakeHerdr} from './fake-herdr.mjs';
import {bashWithoutCores} from './no-core.mjs';
import {scratch, socketDir} from './temp.mjs';

export const REPO = fileURLToPath(new URL('..', import.meta.url));
export const hasNvim = (() => { try { execFileSync('nvim', ['--version']); return true; } catch { return false; } })();
export const answers = async () => ({ok: true}); // the scripted models are not probed
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function until(check, what, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}${check.last ? `: ${await check.last()}` : ''}`);
}

/** Runs a command line in `cwd` with bash, as Pair's pane would (without core dumps): its output and exit code. */
export const runIn = cwd => command => new Promise(resolve => {
  execFile(...bashWithoutCores(command), {cwd}, (error, stdout, stderr) => resolve({output: stdout + stderr, exit: error ? error.code ?? 1 : 0}));
});

/**
 * The daemon with scripted models, a fake herdr, a headless Neovim with the plugin editing a.js and running
 * `:Pair start <goal>`, and a chat client. With `testOnSave`, saving runs that command in the project, for real,
 * in the fake herdr's pane; with `runs`, Pair's pane runs commands for real without it. With `thinks`, the
 * Partner's model can think. `voice` is the config's. `knownKeys`
 * (labels such as M-j) are the keys the plugin remembers you have used, which show without their first-use hints.
 * `setup` is more of the plugin's options, as Lua table fields. `stop()` ends them all.
 */
export async function pairInNvim(goal, {testOnSave, runs = false, thinks = false, voice, rtp = [], knownKeys = [], setup = ''} = {}) {
  const project = realpathSync(scratch('pair-nvim-'));
  writeFileSync(join(project, 'a.js'), 'const x = 1\nconst y = 2\nconst z = 3\n');
  const dataDir = scratch('pair-data-');
  const config = parseConfig({
    dataDir,
    socket: join(dataDir, 'pair.sock'),
    testOnSave: testOnSave ? {[project]: testOnSave} : undefined,
    voice,
    agents: false, // never the real board of the machine running the tests
    models: {watcher: {api: 'openai', baseUrl: 'http://unused', model: 'w'}, partner: {api: 'openai', baseUrl: 'http://unused', model: 'p'}},
  });
  const watcher = fauxProvider({provider: 'faux-watcher'});
  const partner = fauxProvider({provider: 'faux-partner', models: [{id: 'p', reasoning: thinks}]});
  const models = createModels();
  models.setProvider(watcher.provider);
  models.setProvider(partner.provider);
  const pairModels = {models, watcher: watcher.getModel(), partner: partner.getModel()};
  let daemon = await startDaemon(config, {pairModels, probe: answers, log: () => {}});
  const herdrSocket = join(dataDir, 'herdr.sock');
  const herdr = await fakeHerdr(herdrSocket, {commands: testOnSave || runs ? runIn(project) : {}});

  const server = join(socketDir(), 'nvim.sock'); // short: socket paths max out near 100 bytes
  // Its own state directory, where the plugin keeps the keys you have used (lua/pair/hints.lua).
  const state = scratch('pair-state-');
  if (knownKeys.length) {
    mkdirSync(join(state, 'nvim', 'pair'), {recursive: true});
    writeFileSync(join(state, 'nvim', 'pair', 'keys.json'), JSON.stringify(Object.fromEntries(knownKeys.map(key => [key, true]))));
  }
  const nvim = spawn('nvim', [
    '--headless', '--clean', '--listen', server,
    '--cmd', `set rtp+=${[REPO, ...rtp].join(',')}`,
    '-c', `lua require('pair').setup({socket = '${config.socket}', debounce_ms = 100${setup ? `, ${setup}` : ''}})`,
    '-c', `cd ${project}`,
    '-c', 'edit a.js',
    '-c', `Pair start ${goal}`,
  ], {stdio: 'ignore', env: {...process.env, XDG_STATE_HOME: state, TMPDIR: scratch('pair-nvim-tmp-')}}); // its tempname() dir stays when killed
  const remote = expr => execFileSync('nvim', ['--server', server, '--remote-expr', expr], {encoding: 'utf8'}).trim();
  const keys = text => execFileSync('nvim', ['--server', server, '--remote-send', text]);

  const chat = connect(config.socket);
  const messages = [];
  readMessages(chat, message => messages.push(message));
  chat.on('connect', () => sendMessage(chat, {type: 'hello', role: 'chat', cwd: project, herdr: {socket: herdrSocket, workspace: 'w1', pane: 'w1:p2'}}));
  await until(() => { try { return remote('1'); } catch { return false; } }, 'nvim to listen');
  await until(() => messages.some(message => message.text === `Goal: ${goal}`), 'the goal from :Pair start');

  return {
    project, dataDir, state, watcher, partner, messages, remote, keys,
    send: message => sendMessage(chat, message),
    lines: () => JSON.parse(remote('json_encode(getline(1, "$"))')),
    status: () => remote('luaeval("require(\'pair\').status()")'),
    /** Stops the daemon, waits `downMs`, and starts a new one that probes the models with `probe`. */
    async restartDaemon({downMs = 0, probe = answers} = {}) {
      await daemon.close();
      await sleep(downMs);
      daemon = await startDaemon(config, {pairModels, probe, log: () => {}});
    },
    async stop() {
      chat.destroy();
      nvim.kill();
      await daemon.close();
      await herdr.close();
    },
  };
}

