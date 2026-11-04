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
    return Number.isInteger(found.port) && typeof found.token === 'string' ? found : null;
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
  if (had && !installedModVersion(env)) throw new Error(`${dir} holds a mod Pair did not install; move it away, then run \`pair setup\` again`);
  mkdirSync(dir, {recursive: true});
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

/** The version of Pair that installed the mod, or null when it is not installed (or not Pair's). */
export function installedModVersion(env = process.env) {
  try { return readFileSync(join(modDir(env), VERSION_FILE), 'utf8').trim() || null; } catch { return null; }
}

/** Removes the mod that `pair setup` installed; true when there was one. A folder Pair did not write is left. */
export function removeMod(env = process.env) {
  if (!installedModVersion(env)) return false;
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
