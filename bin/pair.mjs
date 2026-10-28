#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// pair: the daemon, the chat pane, setup and checks, and the shell hook in one command.
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, openSync, realpathSync} from 'node:fs';
import {connect} from 'node:net';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {authStates, login, logout, providerDecisionModels, providerModels} from '../src/auth.mjs';
import {runChat} from '../src/chat.mjs';
import {authPath, configPath, createConfig, defaultSocketPath, loadConfig, oneAtATime, rolesText, sameModel, serviceEnvPath} from '../src/config.mjs';
import {loadSizedConfig} from '../src/context-window.mjs';
import {deviceId, fileCredentialStore} from '../src/credentials.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {doctor, nvimHasPlugin, tilde} from '../src/doctor.mjs';
import {gitRoot} from '../src/git.mjs';
import {herdrRequest} from '../src/herdr.mjs';
import {terminalInteraction} from '../src/prompt.mjs';
import {requestDaemon, sendMessage} from '../src/protocol.mjs';
import {keyVariables, storeServiceEnv} from '../src/service-env.mjs';
import {serviceManager} from '../src/service.mjs';
import {sessionRootOf} from '../src/session-root.mjs';
import {shellHook} from '../src/shell-hook.mjs';
import {statsReport} from '../src/stats.mjs';
import {supervise} from '../src/supervise.mjs';
import {openStore} from '../src/store.mjs';
import {probeThinkingSettings} from '../src/thinking-probe.mjs';
import {WINDOW_MS} from '../src/tuning.mjs';

const SCRIPT = realpathSync(fileURLToPath(import.meta.url));
const SERVICE = serviceManager();

const USAGE = `usage:
  pair              open the chat pane next to this one (in herdr), starting the daemon if needed
  pair chat [--plain]   run the chat pane here (--plain: line by line, not full-screen)
  pair setup        create the config if there is none, install and start the daemon as a service (systemd, launchd)
  pair doctor       check the daemon, Neovim, herdr and the models, and say what is wrong
  pair doctor --thinking   find the thinking settings the Partner's OpenAI-compatible server takes (asks it a dozen times)
  pair auth login PROVIDER    log in with a subscription or store an API key (also \`pair login PROVIDER\`)
  pair auth logout PROVIDER   remove that login or key (also \`pair logout PROVIDER\`)
  pair auth list              every provider and whether a login or key is set (never the secrets)
  pair auth models PROVIDER   the models a provider offers, for a model entry's "model"
  pair stats [--days N]   remarks per hour, useful vs dismissed, per trigger, the tuning, and how the decision model did (default: 7 days)
  pair stats --project [DIR]   the same for one project: the one DIR (default: this folder) belongs to
  pair uninstall    stop and remove the service (the config and data stay)
  pair daemon       run the daemon in the foreground
  pair supervise    run the daemon in the foreground, restarted when it fails (what \`pair\` starts without a service)
  pair shell-hook bash|zsh|fish   print the shell hook that reports commands, exit codes and (zsh) typing
  pair report --start|--exit N|--ready [--cmd TEXT] [--shell PID] ...   (used by the shell hook)`;

const ONE_MODEL = 'The Watcher asks it for one number without thinking, the Partner thinks';
const ONE_SERVER = '; on its server the Watcher waits while the Partner works.';
const ONE_PROVIDER = '; the provider answers both at once.';
const TWO_MODELS = 'On a server that holds one model at a time, give both roles one model instead: "model" in the config (see docs/models.md, "One model").';
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

/**
 * Starts the daemon if it is not running: as the service once `pair setup` installed it, else in the background under
 * the supervisor, which restarts it when it fails.
 */
async function ensureDaemon(config) {
  if (await reachable(config.socket)) return;
  if (SERVICE?.installed()) {
    await SERVICE.start();
    if (await waitFor(() => reachable(config.socket))) return;
    throw new Error(`The service did not start; see \`${SERVICE.logs}\``);
  }
  mkdirSync(config.dataDir, {recursive: true, mode: 0o700});
  const log = openSync(join(config.dataDir, 'daemon.log'), 'a');
  spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, 'supervise'], {detached: true, stdio: ['ignore', log, log]}).unref();
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
The daemon reads logins as it needs them, and takes a change to the config as you save it.`);
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
A key from an environment variable ("apiKeyEnv") reaches the service once \`pair setup\` stores it in ${tilde(serviceEnvPath())}.`);
}

async function auth([action, id]) {
  if (action === 'login') return authLogin(id);
  if (action === 'logout') return authLogout(id);
  if (action === 'list' || action === undefined) return authList();
  if (action === 'models') {
    if (!id) throw new Error('name the provider: `pair auth models PROVIDER`');
    const decisions = providerDecisionModels(id);
    const chat = providerModels(id);
    return console.log([...chat, ...(decisions.length ? [...(chat.length ? [''] : []), 'Decision models, for "decision":', ...decisions] : [])].join('\n'));
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

/** Stores the variables named by "apiKeyEnv" for the service, which does not get this shell's environment, and says so. */
function storeKeyVariables(config) {
  const {stored, missing} = storeServiceEnv(serviceEnvPath(), keyVariables(config), process.env);
  if (stored.length) console.log(`Stored ${stored.join(', ')} for the service in ${tilde(serviceEnvPath())}, readable by you only.`);
  if (missing.length) console.error(`pair: the config takes keys from ${missing.join(', ')}, which this shell does not set: set them and run \`pair setup\` again`);
}

/** Installs and starts the service, so it runs this install's code; says what it did. */
async function installService(config) {
  // A daemon started by `pair` before the service existed holds the data directory: hand it over to the service.
  const running = await requestDaemon(config.socket, {type: 'status'}).catch(() => null);
  if (running && !(await SERVICE.state()).active) {
    process.kill(running.pid, 'SIGTERM');
    await waitFor(async () => !(await reachable(config.socket)));
  }
  const env = Object.fromEntries(['PAIR_CONFIG', 'PAIR_AUTH'].filter(name => process.env[name]).map(name => [name, process.env[name]]));
  await SERVICE.install({node: process.execPath, script: SCRIPT, env});
  if (!(await waitFor(() => reachable(config.socket)))) throw new Error(`The service did not start; see \`${SERVICE.logs}\``);
  return `The daemon runs as ${SERVICE.name}: it starts at login and restarts when it fails.`;
}

/** Without systemd or launchd: starts the daemon under the supervisor, if it is not running; says what it does. */
async function withoutService(config) {
  await ensureDaemon(config);
  return 'No systemd or launchd here: `pair` starts the daemon under a supervisor that restarts it when it fails, but not at login (see docs/install.md).';
}

async function setup() {
  firstRunConfig();
  await offerLogin();
  const config = loadConfig();
  storeKeyVariables(config);
  console.log(`${SERVICE ? await installService(config) : await withoutService(config)}
Config: ${tilde(configPath())} (the daemon takes a change as you save it)
Models: ${rolesText(config.models)}.${modelsNote(config.models)}

Next:
  1. ${await nvimHasPlugin(process.env) === 'yes' ? 'The Neovim plugin: your Neovim config loads it already.' : `Add the Neovim plugin with lazy.nvim (other plugin managers: INSTALL.md):
${LAZY_SPEC}`}
  2. Optional, for exact commands and exit codes in your panes: eval "$(pair shell-hook bash)" in your shell's rc file (or zsh; fish: pair shell-hook fish | source)
  3. Run \`pair doctor\` to check everything, then open Neovim in a project: in herdr, run \`pair\` in a pane next to it for the chat; without herdr, \`:Pair chat\` in Neovim (or \`pair chat\` in any terminal).`);
}

/** What \`pair setup\` says about how the roles share their models. */
function modelsNote({watcher, partner}) {
  if (!sameModel(watcher, partner)) return watcher.provider ? '' : ` ${TWO_MODELS}`;
  return ` ${ONE_MODEL}${oneAtATime(watcher, partner) ? ONE_SERVER : ONE_PROVIDER}`;
}

async function uninstall() {
  if (!SERVICE?.installed()) return console.log('No service is installed.');
  await SERVICE.remove();
  console.log(`Removed ${SERVICE.name}. The config (${tilde(configPath())}) and the data directory are kept.`);
}

async function runDoctor(args) {
  const {values} = parseArgs({args, options: {thinking: {type: 'boolean'}}});
  let failed = false;
  const checks = values.thinking ? probeThinkingSettings(await loadSizedConfig()) : doctor();
  for await (const check of checks) {
    console.log(`${SYMBOLS[check.level]} ${check.name.padEnd(8)} ${check.text}`);
    failed ||= check.level === 'fail';
  }
  process.exitCode = failed ? 1 : 0;
}

async function stats(args) {
  const {values, positionals} = parseArgs({args, allowPositionals: true, options: {days: {type: 'string', default: '7'}, project: {type: 'boolean'}}});
  const days = Number(values.days);
  if (!(days > 0)) throw new Error('--days takes a number of days');
  if (positionals.length && !values.project) throw new Error('a folder goes with --project');
  const config = loadConfig();
  const path = join(config.dataDir, 'sessions.sqlite');
  if (!existsSync(path)) return console.log('No sessions yet: start one with `pair`.');
  const root = values.project ? await projectRoot(positionals[0] ?? process.cwd(), config) : null;
  const store = openStore(path);
  const now = Date.now();
  const window = days * 24 * 60 * 60_000;
  try {
    if (root && !store.knownRoot(root)) return console.log(`No sessions in ${root} yet.`);
    // Tuning looks at its own window, which may be longer than the one shown.
    const remarks = store.remarks(now - Math.max(window, WINDOW_MS));
    const activeMs = root ? store.projectActiveMs(root, now - window) : store.activeMs(now - window);
    const decisions = store.decisions(now - window); // what the decision model judged, if there is one
    console.log(statsReport({remarks, activeMs, now, days, level: config.level, autoTune: config.autoTune, root, decisions}).join('\n'));
  } finally {
    store.close();
  }
}

/** The project `dir` belongs to, as the daemon finds it: its session root in the config, else its git root, else itself. */
async function projectRoot(dir, config) {
  const real = realpathSync(dir);
  return sessionRootOf(real, config.sessionRoots) ?? (await gitRoot(real)) ?? real;
}

async function daemon(config) {
  const running = await startDaemon(config, {configFile: configPath()});
  const stop = async () => { await running.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/** `pair supervise`: the daemon in a child process, restarted when it fails, until it stops cleanly or is stopped. */
async function runSupervised() {
  const log = line => process.stderr.write(`${new Date().toTimeString().slice(0, 8)} supervisor: ${line}\n`);
  const supervisor = supervise({command: process.execPath, args: ['--disable-warning=ExperimentalWarning', SCRIPT, 'daemon'], log});
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => supervisor.stop());
  await supervisor.finished;
}

async function openChatPane(config) {
  await ensureDaemon(config);
  if (!process.env.HERDR_ENV) return runChat(config.socket, {dataDir: config.dataDir});
  const env = Object.fromEntries(['PAIR_CONFIG', 'PAIR_SOCKET', 'PAIR_AUTH'].filter(name => process.env[name]).map(name => [name, process.env[name]]));
  const {pane} = await herdrRequest(process.env.HERDR_SOCKET_PATH, 'pane.split', {
    target_pane_id: process.env.HERDR_PANE_ID, direction: 'right', ratio: 0.7, cwd: process.cwd(), env, focus: false,
  });
  await herdrRequest(process.env.HERDR_SOCKET_PATH, 'pane.send_text', {pane_id: pane.pane_id, text: `${SCRIPT} chat\r`});
}

// Runs before and after every shell command, so it stays silent: no config or no daemon means nothing to report.
function report(args) {
  const {values} = parseArgs({args, options: {
    exit: {type: 'string'}, cmd: {type: 'string'}, start: {type: 'boolean'}, ready: {type: 'boolean'}, keys: {type: 'boolean'},
    shell: {type: 'string'}, n: {type: 'string'},
  }});
  // The shell's pid names the terminal outside herdr: a Neovim :terminal's or a tmux pane's (src/pane-watch.mjs).
  const hook = {
    cwd: process.cwd(), pane: process.env.HERDR_PANE_ID ?? null, tmux: process.env.TMUX_PANE ?? null,
    shell: Number(values.shell) || null, keys: values.keys === true,
  };
  const message = values.ready ? {type: 'shell', ...hook}
    : {type: values.start ? 'command_start' : 'command', ...hook, n: Number(values.n ?? 0), cmd: values.cmd ?? '', ...(values.start ? {} : {exit: Number(values.exit)})};
  const socket = connect(socketPathOf());
  socket.on('error', () => {});
  socket.on('connect', () => {
    sendMessage(socket, message);
    socket.end();
  });
}

/** The daemon's socket, from the config when there is one. */
function socketPathOf() {
  try { return loadConfig().socket; } catch { return defaultSocketPath(); }
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'shell-hook') {
    process.stdout.write(shellHook(args[0], process.argv[1], {socket: socketPathOf()}));
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
    await runDoctor(args);
  } else if (command === 'supervise') {
    await runSupervised();
  } else if (command === 'stats') {
    await stats(args);
  } else if ([undefined, 'chat', 'daemon'].includes(command)) {
    firstRunConfig();
    const config = loadConfig();
    if (command === undefined) await openChatPane(config);
    else if (command === 'chat') { await ensureDaemon(config); runChat(config.socket, {dataDir: config.dataDir, plain: args.includes('--plain')}); }
    else await daemon(await loadSizedConfig()); // each model's window, from its server or catalog (see context-window.mjs)
  } else {
    console.log(USAGE);
    process.exitCode = command === 'help' || command === '--help' ? 0 : 2;
  }
} catch (error) {
  console.error(`pair: ${error.message}`);
  process.exitCode = 1;
}
