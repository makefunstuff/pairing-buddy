// One config file for the daemon: the two models, the talk level and where things live.
// It is JSON with // and /* */ comments; the first run writes the commented example there.
import {copyFileSync, existsSync, mkdirSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
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
    maxTokens: 2048, // the Partner's; the Watcher answers with one number (see watcher.mjs)
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

export function parseConfig(raw) {
  const level = raw.level ?? 'normal';
  if (!LEVELS.includes(level)) throw new Error(`config: level must be one of ${LEVELS.join(', ')}`);
  return {
    level,
    typingPauseMs: raw.typingPauseMs ?? 2000,
    autoTune: raw.autoTune ?? true,
    keepWarm: raw.keepWarm ?? true,
    socket: raw.socket ?? defaultSocketPath(),
    dataDir: raw.dataDir ?? join(xdg('XDG_STATE_HOME', '.local/state'), 'pairing-buddy'),
    models: {watcher: modelConfig('watcher', raw.models?.watcher), partner: modelConfig('partner', raw.models?.partner)},
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
