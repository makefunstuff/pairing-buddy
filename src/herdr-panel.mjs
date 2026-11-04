// Pair's chat as a native pane of the Herdr window (docs/herdr.md, "Pair's panel in the Herdr window"): the mod in
// herdr/pair/ draws it, and talks to the daemon over a loopback TCP port, since Herdr's mods have TCP but no Unix
// sockets. The port speaks the daemon's NDJSON as its socket does; its first message must carry the token that the
// file beside the socket holds (readable by you only), or the connection is closed. `pair setup` installs the mod into
// the Herdr window's mods folder, `pair` in a terminal the window shows opens it beside that terminal.
import {execFile} from 'node:child_process';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {homedir} from 'node:os';
import {delimiter, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {agentListLines} from './agent-relay.mjs';
import {ledgerText} from './ledger.mjs';
import {foundLines, remarkLines} from '../herdr/pair/commands.js';

export const MOD = 'pair'; // the mod's folder name in the Herdr window's mods
export const MOD_SOURCE = fileURLToPath(new URL('../herdr/pair/', import.meta.url));
const VERSION_FILE = '.pair-version'; // hidden: Herdr does not reload the mod for it
const INSTALLING = 'installing'; // in it while a first install is under way
const AUTH_MS = 5000; // a connection that has not given the token by then is closed
const AUTH_BYTES = 64 * 1024; // nor one that sends more than this before it
const APP_MS = 5000;
// Files Herdr writes into every mod folder, which an update leaves alone.
const HERDR_OWN = name => name === 'jsconfig.json' || name.endsWith('.d.ts') || name.startsWith('.');

/** The Herdr window's folder (`$HERDR_APP_HOME`, else ~/.config/herdr-app), where its mods are. */
export const appHome = (env = process.env) => env.HERDR_APP_HOME || join(env.HOME || homedir(), '.config', 'herdr-app');

/** The `herdr-app` command: on the PATH, else where the Herdr app puts it; null when there is none. */
export function appCommandOf(env = process.env) {
  const home = env.HOME || homedir();
  const onPath = (env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, 'herdr-app'));
  return [...onPath, join(home, '.local', 'bin', 'herdr-app'), join(home, '.local', 'share', 'herdr-app', 'herdr-app')].find(path => existsSync(path)) ?? null;
}

/** Whether the Herdr window is installed here: its command, or the folder it writes on every start. */
export const herdrAppInstalled = (env = process.env) => Boolean(appCommandOf(env)) || existsSync(join(appHome(env), 'AGENTS.md'));

/** Whether the daemon opens the panel's port: "herdrPanel" in the config, by default when the Herdr window is installed. */
export const panelWanted = (config, env = process.env) => (config.herdrPanel === 'auto' || config.herdrPanel === undefined ? herdrAppInstalled(env) : config.herdrPanel === true);

/** Whether only you can add, rename or remove files in folder `dir`: yours, and writable by nobody else. */
export function ownFolder(dir) {
  try {
    const stat = statSync(dir);
    return stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/**
 * The file that says the panel's port and token: beside the daemon's socket (`config.socket`) when only you can write
 * in its folder (the runtime folder, /run/user/<uid>), else in the data folder (`config.dataDir`), as with a socket in
 * /tmp, where another user could put a file of theirs in its place first.
 */
export const panelFile = ({socket, dataDir}) => (ownFolder(dirname(socket)) || !dataDir ? `${socket}.panel` : join(dataDir, 'herdr-panel.json'));

/** The panel's `{port, token, pid}` as the running daemon wrote it, or null. */
export function readPanelFile(config) {
  try {
    const found = JSON.parse(readFileSync(panelFile(config), 'utf8'));
    if (!Number.isInteger(found.port) || typeof found.token !== 'string') return null;
    if (Number.isInteger(found.pid)) process.kill(found.pid, 0); // a daemon that died left it: throws, so null
    return found;
  } catch {
    return null;
  }
}

/** Whether `given` is the panel's token, compared in constant time. */
export function tokenMatches(given, token) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The panel's port on 127.0.0.1 (a free one), and its file (see panelFile; `config` has the socket and data folder),
 * readable by you only, in a folder only you can write in: else it does not open. Each connection goes to
 * `accept(socket, token)`, which checks the token of its first message (see authenticate). Returns
 * `{port, token, file, close()}`; a port whose file could not be written is closed again.
 */
export async function startPanelListener({config, accept, host = '127.0.0.1'}) {
  const file = panelFile(config);
  if (!ownFolder(dirname(file))) throw new Error(`others can write in ${dirname(file)}, so the panel's token would not be yours only`);
  const token = randomBytes(24).toString('hex');
  const server = createServer(socket => accept(socket, token));
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, host, resolve));
  const {port} = server.address();
  try {
    const temp = `${file}.${randomBytes(6).toString('hex')}`; // a new file of its own: 'wx' refuses one already there
    writeFileSync(temp, `${JSON.stringify({port, token, pid: process.pid})}\n`, {mode: 0o600, flag: 'wx'});
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (error) {
    await new Promise(resolve => server.close(() => resolve()));
    throw error;
  }
  return {
    port, token, file,
    close() {
      // Only its own file: a daemon started since may have written its own there.
      if (readPanelFile(config)?.token === token) try { unlinkSync(file); } catch {}
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
}

/**
 * The gate of a panel connection: `check(message)` is given each message it reads, and says whether it goes on to
 * the daemon. The first must carry `token` (removed before it goes on); a wrong one, none within AUTH_MS, or more than
 * AUTH_BYTES before it, closes it.
 */
export function authenticate(socket, token, {authMs = AUTH_MS, authBytes = AUTH_BYTES} = {}) {
  let open = false;
  let read = 0;
  const timer = setTimeout(() => socket.destroy(), authMs);
  timer.unref?.();
  socket.on('close', () => clearTimeout(timer));
  // Nothing much is kept for a connection that has not given the token: a long first line is closed.
  socket.on('data', data => { if (!open && (read += data.length) > authBytes) socket.destroy(); });
  return message => {
    if (open) return true;
    if (!tokenMatches(message?.token, token)) {
      clearTimeout(timer);
      socket.destroy();
      return false;
    }
    open = true;
    clearTimeout(timer);
    delete message.token;
    return message.type !== 'auth'; // a message of its own only to give the token
  };
}

/**
 * What the daemon sends the panel, with the plain text of the notes the terminal's chat writes itself (the ledger,
 * a /find answer, the agents, the last remarks), so both say the same words.
 */
export function panelMessage(message) {
  if (message.type === 'ledger' && Array.isArray(message.rows)) return {...message, text: ledgerText(message).join('\n')};
  if (message.type === 'found' && message.id === undefined) return {...message, text: foundLines(message).join('\n')};
  if (message.type === 'agent_list') return {...message, text: agentListLines(message).join('\n')};
  if (message.type === 'remarks' && Array.isArray(message.remarks)) return {...message, text: remarkLines(message.remarks).join('\n')};
  return message;
}

// The mod in the Herdr window's mods folder.

/** The mod's folder in the Herdr window's home. */
export const modDir = (env = process.env) => join(appHome(env), 'mods', MOD);

/** The files of the mod, as this install has them: name -> contents. */
function modFiles(source = MOD_SOURCE) {
  return new Map(readdirSync(source).filter(name => !HERDR_OWN(name) && !name.endsWith('.test.js') && statSync(join(source, name)).isFile())
    .map(name => [name, readFileSync(join(source, name))]));
}

/**
 * Installs the mod, or updates it to this install's files: only a file that changed is written (each write reloads
 * the mod in a running window), and one this install no longer has goes. Returns 'installed', 'updated' or 'same'.
 * Throws for a folder of that name that holds a mod Pair did not install.
 */
export function installMod({env = process.env, version, source = MOD_SOURCE} = {}) {
  const dir = modDir(env);
  const had = existsSync(join(dir, 'main.js'));
  // A mod of that name Pair did not install is someone's own: it is left as it is.
  // Anything but what Herdr writes into every mod folder (hidden files count: a .git is someone's).
  const someones = existsSync(dir) && readdirSync(dir).some(name => name !== 'jsconfig.json' && !name.endsWith('.d.ts'));
  if (someones && !pairsMod(env)) throw new Error(`${dir} holds a mod Pair did not install; move it away, then run \`pair setup\` again`);
  mkdirSync(dir, {recursive: true});
  // A first install marks the folder Pair's before anything else, so one cut short is finished by the next `pair
  // setup`; the version itself is written last, so an install or update that fails says the version it had.
  if (!pairsMod(env)) writeFileSync(join(dir, VERSION_FILE), `${INSTALLING}\n`);
  const files = modFiles(source);
  let changed = false;
  for (const name of readdirSync(dir)) {
    if (HERDR_OWN(name) || files.has(name) || !statSync(join(dir, name)).isFile()) continue;
    rmSync(join(dir, name));
    changed = true;
  }
  for (const [name, contents] of files) {
    const path = join(dir, name);
    if (existsSync(path) && readFileSync(path).equals(contents)) continue;
    writeFileSync(path, contents);
    changed = true;
  }
  writeFileSync(join(dir, VERSION_FILE), `${version}\n`);
  return !had ? 'installed' : changed ? 'updated' : 'same';
}

/** The version of Pair that installed the mod, or null when it is not installed, not wholly yet, or not Pair's. */
export function installedModVersion(env = process.env) {
  try {
    const version = readFileSync(join(modDir(env), VERSION_FILE), 'utf8').trim();
    return version && version !== INSTALLING && existsSync(join(modDir(env), 'main.js')) ? version : null;
  } catch {
    return null;
  }
}

/** Whether the mods folder's `pair` is Pair's: it has the version file, even of an install cut short. */
const pairsMod = env => existsSync(join(modDir(env), VERSION_FILE));

/** Removes the mod that `pair setup` installed; true when there was one. A folder Pair did not write is left. */
export function removeMod(env = process.env) {
  if (!pairsMod(env)) return false;
  rmSync(modDir(env), {recursive: true, force: true});
  return true;
}

// `pair` in a terminal the window shows.

/** `herdr-app <args>` against the window the terminal's `env` picks; its JSON, or a rejection. */
export function appRun(command, args, env = process.env) {
  return new Promise((resolve, reject) => execFile(command, args, {env, timeout: APP_MS}, (error, stdout) => {
    let answer = null;
    try { answer = JSON.parse(stdout); } catch {}
    if (answer?.error) return reject(new Error(`herdr-app: ${answer.error}`));
    if (error) return reject(error);
    if (!answer) return reject(new Error(`herdr-app ${args[0]} said no JSON`));
    resolve(answer);
  }));
}

/** Where the window shows terminal `terminal`: `{space, tab, pane}`, or null when it does not. */
export async function shownAt(command, terminal, env = process.env) {
  const {spaces = []} = await appRun(command, ['ls'], env);
  for (const space of spaces) {
    for (const tab of space.tabs ?? []) {
      const found = (tab.terminals ?? []).find(each => each.terminal === terminal);
      if (found?.pane) return {space: space.id, tab: tab.id, pane: found.pane};
    }
  }
  return null;
}

/**
 * `pair` in herdr-core terminal `herdr.pane`: the panel opens beside it in the Herdr window, with what it needs as
 * its props (the project, this terminal, its space and tab, the core, the daemon's panel file, the terminal chat's history). False when it cannot
 * (no window, no mod, the window does not show this terminal, the daemon has no panel port): `pair` then opens the
 * chat in a terminal, as before.
 */
export async function openPanel(herdr, {cwd, config, history = null, env = process.env, command = appCommandOf(env), waitMs = 3000}) {
  if (herdr?.kind !== 'core' || !command || !installedModVersion(env) || !panelWanted(config, env)) return false;
  // A daemon `pair` just started writes the file a moment after its socket answers.
  for (const end = Date.now() + waitMs; !readPanelFile(config) && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 100));
  if (!readPanelFile(config)) return false;
  const here = await shownAt(command, herdr.pane, env).catch(() => null);
  if (!here) return false;
  const props = {cwd, terminal: herdr.pane, space: here.space, tab: here.tab, core: herdr.socket, session: herdr.session ?? null, panel: panelFile(config), ...(history ? {history} : {})};
  return appRun(command, ['do', 'pane.split', '--direction', 'right', '--pane', here.pane, '--mod', MOD, '--props', JSON.stringify(props)], env)
    .then(() => true, () => false);
}

// Opening the panel without typing `pair`: a key in the window's keys.json, Pair in its + menu (programs.json), and
// the panel opened bare (no props), which fills them itself from the focused terminal (herdr/pair/main.js).

/** What the key runs: Pair's panel, opened bare, to the right of the focused pane (the mod fills in the rest). */
export const OPEN_ACTION = Object.freeze({command: 'pane.split', args: Object.freeze({direction: 'right', mod: MOD})});
/** The keys `pair setup` binds, the first one free in every section of keys.json. */
export const KEY_CHOICES = ['alt-p', 'alt-shift-p', 'ctrl-alt-p'];
const COMMAND_FILE = '.pair-command.json'; // in the mod's folder: how the panel runs this Pair (`pair panel --props`)
const ADDED_FILE = '.pair-added.json'; // in the mod's folder: what setup put in keys.json and programs.json
const ENV_NAMES = ['PAIR_CONFIG', 'PAIR_SOCKET', 'PAIR_AUTH']; // the setup's own config, socket and logins, when it names them

/** How the Herdr window runs this Pair: node and its script, with the config `env` names (`env NAME=value …` first). */
export function pairArgv({execPath = process.execPath, script, env = process.env} = {}) {
  const named = ENV_NAMES.filter(name => env[name]).map(name => `${name}=${env[name]}`);
  return [...(named.length ? ['env', ...named] : []), execPath, '--disable-warning=ExperimentalWarning', script];
}

/** Writes the argv the bare panel runs `pair panel --props` with, beside the mod (a hidden file: no reload). */
export function writePairCommand(argv, env = process.env) {
  writeFileSync(join(modDir(env), COMMAND_FILE), `${JSON.stringify({argv})}\n`);
}

/** The + menu's entry for Pair in programs.json: `pair panel` in the new tab puts the panel back in the tab you were in. */
export const programEntry = argv => ({name: 'Pair', icon: `mods/${MOD}/pair.svg`, tint: true, tile: '#3b5bdb', color: '#ffffff', run: [...argv, 'panel']});

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A JSON file of the window's: its value, null when there is none; throws for one that does not parse. */
function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Writes `value` to `path` at once (a temp file renamed: the window never reads half of it), after a copy of the old one. */
function writeJson(path, value) {
  if (existsSync(path)) {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    writeFileSync(`${path}.pair-bak-${stamp}`, readFileSync(path));
  }
  const temp = `${path}.pair-${randomBytes(4).toString('hex')}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

function readAdded(env) {
  try { return JSON.parse(readFileSync(join(modDir(env), ADDED_FILE), 'utf8')); } catch { return {}; }
}

/**
 * `pair setup`: the key that opens the panel (keys.json's `global`, the first of KEY_CHOICES no section binds) and
 * Pair in the + menu (programs.json), merged into the window's files, each kept first as `<file>.pair-bak-<time>`.
 * What it adds is recorded beside the mod, so `pair uninstall` removes only that. A binding or entry already there
 * that is not Pair's is left alone. Returns the lines it has to say.
 */
export function addLaunchers({env = process.env, argv}) {
  const home = appHome(env);
  const added = readAdded(env);
  const lines = [];
  // The key.
  try {
    const path = join(home, 'keys.json');
    const keys = readJson(path);
    if (!keys) {
      lines.push(`No key for the panel: the Herdr window has no ${tilde(path, env)} yet (it writes one on its first start); run \`pair setup\` again then`);
    } else {
      const bound = Object.entries(keys).flatMap(([section, bindings]) => Object.entries(bindings ?? {}).map(([key, action]) => ({section, key, action})));
      const ours = bound.find(({action}) => same(action, OPEN_ACTION));
      if (ours) {
        lines.push(`Key: ${ours.key} opens the panel`);
        if (!added.keys) added.keys = {section: ours.section, key: ours.key, action: OPEN_ACTION};
      } else {
        const key = KEY_CHOICES.find(choice => !bound.some(each => each.key === choice));
        if (!key) lines.push(`No key for the panel: ${KEY_CHOICES.join(', ')} are all taken in ${tilde(path, env)}`);
        else {
          writeJson(path, {...keys, global: {...(keys.global ?? {}), [key]: OPEN_ACTION}});
          added.keys = {section: 'global', key, action: OPEN_ACTION};
          lines.push(`Key: ${key} opens the panel beside the focused terminal (added to ${tilde(path, env)})`);
        }
      }
    }
  } catch (error) {
    lines.push(`No key for the panel: ${error.message}`);
  }
  // The + menu.
  try {
    const path = join(home, 'programs.json');
    const file = readJson(path) ?? {};
    const entry = programEntry(argv);
    const now = file.programs?.[MOD];
    if (same(now, entry)) {
      lines.push('+ menu: Pair is in it');
    } else if (now !== undefined && !(added.programs && same(now, added.programs.entry))) {
      lines.push(`+ menu: ${tilde(path, env)} has a "${MOD}" entry of its own, left as it is`);
    } else {
      writeJson(path, {...file, programs: {...(file.programs ?? {}), [MOD]: entry}});
      added.programs = {name: MOD, entry};
      lines.push(`+ menu: Pair opens the panel in the tab you are in (added to ${tilde(path, env)})`);
    }
  } catch (error) {
    lines.push(`Pair is not in the + menu: ${error.message}`);
  }
  writeFileSync(join(modDir(env), ADDED_FILE), `${JSON.stringify(added)}\n`);
  return lines;
}

/** `pair uninstall`: takes out of keys.json and programs.json what setup added, unless it was changed since. */
export function removeLaunchers(env = process.env) {
  const home = appHome(env);
  const added = readAdded(env);
  const lines = [];
  try {
    const path = join(home, 'keys.json');
    const keys = added.keys ? readJson(path) : null;
    const {section, key, action} = added.keys ?? {};
    if (keys?.[section] && key in keys[section]) {
      if (same(keys[section][key], action)) {
        const {[key]: _gone, ...rest} = keys[section];
        writeJson(path, {...keys, [section]: rest});
        lines.push(`Removed the key ${key} from ${tilde(path, env)}`);
      } else lines.push(`Left ${key} in ${tilde(path, env)}: it does something else now`);
    }
  } catch (error) {
    lines.push(`The key stays: ${error.message}`);
  }
  try {
    const path = join(home, 'programs.json');
    const file = added.programs ? readJson(path) : null;
    const now = file?.programs?.[added.programs.name];
    if (now !== undefined) {
      if (same(now, added.programs.entry)) {
        const {[added.programs.name]: _gone, ...rest} = file.programs;
        writeJson(path, {...file, programs: rest});
        lines.push(`Removed Pair from the + menu (${tilde(path, env)})`);
      } else lines.push(`Left the "${added.programs.name}" entry in ${tilde(path, env)}: it was changed`);
    }
  } catch (error) {
    lines.push(`Pair stays in the + menu: ${error.message}`);
  }
  return lines;
}

const tilde = (path, env) => {
  const home = env.HOME || homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
};

/** herdr-core's socket and session as the Herdr window's terminals have them: the environment's, else the default. */
export function coreOf(env = process.env) {
  const socket = env.HC_SOCKET || env.HC_TERMINAL_SOCKET || join(env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`, 'herdr-core', 'default.sock');
  return {core: socket, session: env.HC_SESSION || null};
}

/**
 * What the panel opened bare (by its key or the + menu) needs that only Pair knows, for the terminal it opens beside:
 * `{cwd, terminal, core, session, panel, history}`. The daemon must be up (its panel file written), as `pair` has it.
 */
export async function bareProps({cwd, terminal, config, env = process.env, waitMs = 3000}) {
  for (const end = Date.now() + waitMs; !readPanelFile(config) && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 100));
  if (!readPanelFile(config)) throw new Error(panelWanted(config, env) ? 'the daemon has no panel port yet' : 'the panel is off in the config ("herdrPanel": false)');
  return {cwd, terminal, ...coreOf(env), panel: panelFile(config), history: join(config.dataDir, 'chat-history.json')};
}

/**
 * `pair panel` in the terminal the + menu started (a new tab, just after the one you were in): the panel opens bare
 * in that tab beside its focused terminal, the tab is selected again, and this tab closes. False when it cannot (no
 * window, not shown there, no tab before it).
 */
export async function panelFromMenu(herdr, {env = process.env, command = appCommandOf(env), mod = MOD} = {}) {
  if (herdr?.kind !== 'core' || !command) return false;
  const {spaces = []} = await appRun(command, ['ls'], env);
  for (const space of spaces) {
    const tabs = space.tabs ?? [];
    const at = tabs.findIndex(tab => (tab.terminals ?? []).some(each => each.terminal === herdr.pane));
    if (at < 0) continue;
    const back = tabs[at - 1] ?? tabs[at + 1];
    if (!back) return false;
    await appRun(command, ['do', 'tab.select', '--id', back.id], env);
    await appRun(command, ['do', 'pane.split', '--direction', 'right', '--mod', mod, ...(mod === MOD ? [] : ['--props', JSON.stringify({mod})])], env);
    await appRun(command, ['do', 'tab.close', '--id', tabs[at].id, '--confirmed', 'true'], env).catch(() => {}); // closes this terminal too
    return true;
  }
  return false;
}

/**
 * `pair setup`'s part in the Herdr window: the mod (installMod), how it runs this Pair, its key and + menu entry
 * (addLaunchers). Returns what was done to the mod ('installed', 'updated', 'same') and the launchers' lines.
 */
export function setUpPanel({env = process.env, version, argv}) {
  const done = installMod({env, version});
  writePairCommand(argv, env);
  return {done, lines: addLaunchers({env, argv})};
}

/** `pair uninstall`'s part: the key and the + menu entry setup added, then the mod. Returns the lines to say. */
export function removePanel(env = process.env) {
  const lines = removeLaunchers(env);
  if (removeMod(env)) lines.push(`Removed Pair's panel from the Herdr window (${tilde(modDir(env), env)}).`);
  return lines;
}
