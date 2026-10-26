#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// pair: the daemon, the chat pane, setup and checks, and the shell hook in one command.
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, openSync, realpathSync} from 'node:fs';
import {connect} from 'node:net';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {authStates, login, logout, providerModels} from '../src/auth.mjs';
import {runChat} from '../src/chat.mjs';
import {authPath, configPath, createConfig, defaultSocketPath, loadConfig, rolesText, sameModel} from '../src/config.mjs';
import {deviceId, fileCredentialStore} from '../src/credentials.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {doctor, tilde} from '../src/doctor.mjs';
import {herdrRequest} from '../src/herdr.mjs';
import {terminalInteraction} from '../src/prompt.mjs';
import {requestDaemon, sendMessage} from '../src/protocol.mjs';
import {installService, removeService, systemctl, UNIT, unitPath} from '../src/service.mjs';
import {shellHook} from '../src/shell-hook.mjs';
import {statsReport} from '../src/stats.mjs';
import {openStore} from '../src/store.mjs';
import {WINDOW_MS} from '../src/tuning.mjs';

const SCRIPT = realpathSync(fileURLToPath(import.meta.url));

const USAGE = `usage:
  pair              open the chat pane next to this one (in herdr), starting the daemon if needed
  pair chat         run the chat pane here
  pair setup        create the config if there is none, install and start the daemon as a systemd user service
  pair doctor       check the daemon, Neovim, herdr and the models, and say what is wrong
  pair auth login PROVIDER    log in with a subscription or store an API key (also \`pair login PROVIDER\`)
  pair auth logout PROVIDER   remove that login or key (also \`pair logout PROVIDER\`)
  pair auth list              every provider and whether a login or key is set (never the secrets)
  pair auth models PROVIDER   the models a provider offers, for a model entry's "model"
  pair stats [--days N]   remarks per hour, useful vs dismissed, per trigger, and the tuning (default: 7 days)
  pair uninstall    stop and remove the service (the config and data stay)
  pair daemon       run the daemon in the foreground
  pair shell-hook bash|zsh|fish   print the shell hook that reports exit codes
  pair report --exit N --cmd TEXT   (used by the shell hook)`;

const ONE_MODEL = 'The Watcher asks it for one number without thinking, the Partner thinks; on its server the Watcher waits while the Partner works.';
const TWO_MODELS = 'On a server that holds one model at a time, give both roles one model instead: "model" in the config (see docs/config.md, "One model").';
const LAZY_SPEC = `  {
    'makefunstuff/pairing-buddy',
    main = 'pair',
    lazy = false,
    opts = {auto_connect = true},
  },`;

const SYMBOLS = {ok: '\x1b[32m✓\x1b[0m', warn: '\x1b[33m!\x1b[0m', fail: '\x1b[31m✗\x1b[0m'};

const reachable = socketPath => new Promise(resolve => {
  const socket = connect(socketPath);
  socket.on('connect', () => { socket.end(); resolve(true); });
  socket.on('error', () => resolve(false));
});

async function waitFor(check, tries = 50) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

/** Starts the daemon if it is not running: through systemd once `pair setup` installed it, else in the background. */
async function ensureDaemon(config) {
  if (await reachable(config.socket)) return;
  if (existsSync(unitPath())) {
    await systemctl('start', UNIT);
    if (await waitFor(() => reachable(config.socket))) return;
    throw new Error(`The service did not start; see \`journalctl --user -u ${UNIT} -n 20\``);
  }
  mkdirSync(config.dataDir, {recursive: true, mode: 0o700});
  const log = openSync(join(config.dataDir, 'daemon.log'), 'a');
  spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, 'daemon'], {detached: true, stdio: ['ignore', log, log]}).unref();
  if (!(await waitFor(() => reachable(config.socket)))) throw new Error(`The daemon did not start; see ${join(config.dataDir, 'daemon.log')}`);
}

/** Writes the example config on the first run, and says so. */
function firstRunConfig() {
  if (createConfig()) console.error(`pair: created ${tilde(configPath())} from the example; set your models there, then run \`pair doctor\``);
}

const credentials = () => fileCredentialStore(authPath());

/** `pair auth login ID`: the provider's own login flow in this terminal, then how to use it in the config. */
async function authLogin(id) {
  if (!id) throw new Error('name the provider: `pair auth login PROVIDER` (`pair auth list` lists them)');
  const interaction = terminalInteraction();
  let how;
  try {
    how = await login({id, credentials: credentials(), interaction, getDeviceId: () => deviceId(join(dirname(authPath()), 'device-id'))});
  } finally {
    interaction.close();
  }
  console.log(how === 'key'
    ? `Stored the key as "${id}" in ${tilde(authPath())}. Use it in a model entry with an "api" and a "baseUrl": "auth": "${id}"`
    : `${how === 'oauth' ? `Logged in to ${id}` : `Stored the API key of ${id}`} in ${tilde(authPath())}. Use it in a model entry: {"provider": "${id}", "model": "…"}; \`pair auth models ${id}\` lists the models.
The daemon reads logins as it needs them; after a change to the config: systemctl --user restart ${UNIT}`);
}

async function authLogout(id) {
  if (!id) throw new Error('name the provider: `pair auth logout PROVIDER`');
  console.log(await logout({id, credentials: credentials()}) ? `Logged out of ${id}.` : `No login or key stored for ${id}.`);
}

async function authList() {
  const rows = await authStates({credentials: credentials()});
  const width = Math.max(...rows.map(row => row.id.length));
  for (const row of rows) console.log(`${row.set ? SYMBOLS.ok : ' '} ${row.id.padEnd(width)}  ${row.state}`);
  console.log(`\nLogins and keys: ${tilde(authPath())}. Log in with \`pair auth login PROVIDER\`.
A key from an environment variable reaches the service only if the service has it too: \`systemctl --user edit ${UNIT}\`.`);
}

async function auth([action, id]) {
  if (action === 'login') return authLogin(id);
  if (action === 'logout') return authLogout(id);
  if (action === 'list' || action === undefined) return authList();
  if (action === 'models') {
    if (!id) throw new Error('name the provider: `pair auth models PROVIDER`');
    return console.log(providerModels(id).join('\n'));
  }
  throw new Error(`\`pair auth ${action}\`: the actions are login, logout, list and models`);
}

/** In a terminal, `pair setup` offers to log in to a provider; Enter skips it. */
async function offerLogin() {
  if (!process.stdin.isTTY) return;
  const interaction = terminalInteraction();
  let id;
  try {
    id = await interaction.prompt({type: 'text', message: `Log in to a model provider now? Its id (for example anthropic, openai, github-copilot, openrouter; \`pair auth list\` lists all), a name of your own to store your server's key, or Enter to skip:`});
  } finally {
    interaction.close();
  }
  if (id) await authLogin(id);
}

async function setup() {
  firstRunConfig();
  await offerLogin();
  const config = loadConfig();
  // A daemon started by `pair` before the service existed holds the data directory: hand it over to systemd.
  const running = await requestDaemon(config.socket, {type: 'status'}).catch(() => null);
  const service = await systemctl('is-active', UNIT);
  if (running && !service.ok) {
    process.kill(running.pid, 'SIGTERM');
    await waitFor(async () => !(await reachable(config.socket)));
  }
  const env = Object.fromEntries(['PAIR_CONFIG', 'PAIR_AUTH'].filter(name => process.env[name]).map(name => [name, process.env[name]]));
  await installService({node: process.execPath, script: SCRIPT, env});
  if (!(await waitFor(() => reachable(config.socket)))) throw new Error(`The service did not start; see \`journalctl --user -u ${UNIT} -n 20\``);
  console.log(`The daemon runs as ${UNIT}: it starts at login and restarts when it fails.
Config: ${tilde(configPath())} (after a change: systemctl --user restart ${UNIT})
Models: ${rolesText(config.models)}. ${sameModel(config.models.watcher, config.models.partner) ? ONE_MODEL : TWO_MODELS}

Next:
  1. Add the Neovim plugin with lazy.nvim:
${LAZY_SPEC}
  2. Optional, for exit codes: eval "$(pair shell-hook bash)" in your shell's rc file (or zsh; fish: pair shell-hook fish | source)
  3. Run \`pair doctor\` to check everything, then \`pair\` in a herdr pane next to Neovim.`);
}

async function uninstall() {
  await removeService();
  console.log(`Removed ${UNIT}. The config (${tilde(configPath())}) and the data directory are kept.`);
}

async function runDoctor() {
  let failed = false;
  for await (const check of doctor()) {
    console.log(`${SYMBOLS[check.level]} ${check.name.padEnd(8)} ${check.text}`);
    failed ||= check.level === 'fail';
  }
  process.exitCode = failed ? 1 : 0;
}

function stats(args) {
  const {values} = parseArgs({args, options: {days: {type: 'string', default: '7'}}});
  const days = Number(values.days);
  if (!(days > 0)) throw new Error('--days takes a number of days');
  const config = loadConfig();
  const path = join(config.dataDir, 'sessions.sqlite');
  if (!existsSync(path)) return console.log('No sessions yet: start one with `pair`.');
  const store = openStore(path);
  const now = Date.now();
  const window = days * 24 * 60 * 60_000;
  try {
    // Tuning looks at its own window, which may be longer than the one shown.
    const remarks = store.remarks(now - Math.max(window, WINDOW_MS));
    const activeMs = store.activeMs(now - window);
    console.log(statsReport({remarks, activeMs, now, days, level: config.level, autoTune: config.autoTune}).join('\n'));
  } finally {
    store.close();
  }
}

async function daemon(config) {
  const running = await startDaemon(config);
  const stop = async () => { await running.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function openChatPane(config) {
  await ensureDaemon(config);
  if (!process.env.HERDR_ENV) return runChat(config.socket);
  const env = Object.fromEntries(['PAIR_CONFIG', 'PAIR_SOCKET', 'PAIR_AUTH'].filter(name => process.env[name]).map(name => [name, process.env[name]]));
  const {pane} = await herdrRequest(process.env.HERDR_SOCKET_PATH, 'pane.split', {
    target_pane_id: process.env.HERDR_PANE_ID, direction: 'right', ratio: 0.7, cwd: process.cwd(), env, focus: false,
  });
  await herdrRequest(process.env.HERDR_SOCKET_PATH, 'pane.send_text', {pane_id: pane.pane_id, text: `${SCRIPT} chat\r`});
}

// Runs after every shell command, so it stays silent: no config or no daemon means nothing to report.
function report(args) {
  const {values} = parseArgs({args, options: {exit: {type: 'string'}, cmd: {type: 'string'}}});
  let socketPath;
  try { socketPath = loadConfig().socket; } catch { socketPath = defaultSocketPath(); }
  const socket = connect(socketPath);
  socket.on('error', () => {});
  socket.on('connect', () => {
    sendMessage(socket, {type: 'command', cwd: process.cwd(), pane: process.env.HERDR_PANE_ID ?? null, cmd: values.cmd ?? '', exit: Number(values.exit)});
    socket.end();
  });
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'shell-hook') {
    process.stdout.write(shellHook(args[0], process.argv[1]));
  } else if (command === 'report') {
    report(args);
  } else if (command === 'setup') {
    await setup();
  } else if (command === 'uninstall') {
    await uninstall();
  } else if (command === 'auth') {
    await auth(args);
  } else if (command === 'login' || command === 'logout') {
    await auth([command, ...args]);
  } else if (command === 'doctor') {
    await runDoctor();
  } else if (command === 'stats') {
    stats(args);
  } else if ([undefined, 'chat', 'daemon'].includes(command)) {
    firstRunConfig();
    const config = loadConfig();
    if (command === undefined) await openChatPane(config);
    else if (command === 'chat') { await ensureDaemon(config); runChat(config.socket); }
    else await daemon(config);
  } else {
    console.log(USAGE);
    process.exitCode = command === 'help' || command === '--help' ? 0 : 2;
  }
} catch (error) {
  console.error(`pair: ${error.message}`);
  process.exitCode = 1;
}
