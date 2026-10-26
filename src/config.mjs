// One config file for the daemon: the two models, the talk level and where things live.
// It is JSON with // and /* */ comments; the first run writes the commented example there.
import {copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const EXAMPLE = fileURLToPath(new URL('../config.example.json', import.meta.url));

export const LEVELS = ['quiet', 'normal', 'chatty'];

export function xdg(name, fallback) {
  return process.env[name] || join(homedir(), fallback);
}

export function defaultSocketPath() {
  if (process.env.PAIR_SOCKET) return process.env.PAIR_SOCKET;
  const runtime = process.env.XDG_RUNTIME_DIR;
  return runtime ? join(runtime, 'pairing-buddy.sock') : `/tmp/pairing-buddy-${process.getuid()}.sock`;
}

export function configPath() {
  return process.env.PAIR_CONFIG || join(xdg('XDG_CONFIG_HOME', '.config'), 'pairing-buddy', 'config.json');
}

/** Checks one model entry and fills its defaults. */
export function modelConfig(role, entry) {
  if (!entry || typeof entry !== 'object') throw new Error(`config: models.${role} is missing`);
  if (!['openai', 'anthropic'].includes(entry.api)) throw new Error(`config: models.${role}.api must be "openai" or "anthropic"`);
  if (typeof entry.model !== 'string' || !entry.model) throw new Error(`config: models.${role}.model is missing`);
  if (entry.api === 'openai' && !entry.baseUrl) throw new Error(`config: models.${role}.baseUrl is missing`);
  return {
    baseUrl: entry.api === 'anthropic' ? 'https://api.anthropic.com' : undefined,
    contextWindow: 32768,
    // The Partner's; the Watcher answers with one number (see watcher.mjs). Thinking counts toward it, and the
    // checks that need it (see THINKING in session.mjs) think even when the config says off.
    maxTokens: entry.reasoning ? 8192 : 2048,
    reasoning: false,
    thinking: 'off',
    ...entry,
  };
}

/** The API key of a model entry: `apiKey`, else the file `apiKeyFile`, else the env var `apiKeyEnv`. */
export function apiKeyOf(entry) {
  if (entry.apiKey) return entry.apiKey;
  if (entry.apiKeyFile) return readFileSync(entry.apiKeyFile.replace(/^~(?=\/)/, homedir()), 'utf8').trim();
  if (entry.apiKeyEnv) return process.env[entry.apiKeyEnv];
  return undefined;
}

/** `path` with `~` expanded, as the real path the daemon names projects by when it exists. */
function projectPath(path) {
  const full = resolve(path.replace(/^~(?=\/|$)/, homedir()));
  try { return realpathSync(full); } catch { return full; }
}

/** `testOnSave` maps a project's folder to the command Pair runs in its pane when you save a source file there. */
function testCommands(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config: testOnSave must map project folders to commands');
  return Object.fromEntries(Object.entries(raw).map(([path, command]) => {
    if (typeof command !== 'string' || !command.trim()) throw new Error(`config: testOnSave["${path}"] must be a command`);
    return [projectPath(path), command.trim()];
  }));
}

export function parseConfig(raw) {
  const level = raw.level ?? 'normal';
  if (!LEVELS.includes(level)) throw new Error(`config: level must be one of ${LEVELS.join(', ')}`);
  const models = {watcher: modelConfig('watcher', raw.models?.watcher), partner: modelConfig('partner', raw.models?.partner)};
  return {
    level,
    typingPauseMs: raw.typingPauseMs ?? 2000,
    autoTune: raw.autoTune ?? true,
    // A cloud model is never unloaded, and each ping would be a paid request.
    keepWarm: raw.keepWarm ?? models.watcher.api === 'openai',
    socket: raw.socket ?? defaultSocketPath(),
    dataDir: raw.dataDir ?? join(xdg('XDG_STATE_HOME', '.local/state'), 'pairing-buddy'),
    testOnSave: testCommands(raw.testOnSave),
    models,
  };
}

/** `text` without its // and /* *\/ comments; strings are kept as they are. */
export function stripComments(text) {
  return text.replace(/("(?:[^"\\\n]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match, string) => string ?? '');
}

/** Writes the commented example to `path` if there is no config yet; true when it did. */
export function createConfig(path = configPath()) {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), {recursive: true});
  copyFileSync(EXAMPLE, path);
  return true;
}

export function loadConfig(path = configPath()) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { throw new Error(`No config at ${path}; run \`pair setup\``); }
  let raw;
  try { raw = JSON.parse(stripComments(text)); } catch (error) { throw new Error(`config: ${path} is not valid JSON (${error.message})`); }
  return parseConfig(raw);
}
