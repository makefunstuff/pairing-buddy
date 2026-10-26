// One config file for the daemon: the models (one for both roles, or one each), the talk level and where things live.
// It is JSON with // and /* */ comments; the first run writes the commented example there.
import {copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {thinkingBudgetForLevel} from '@earendil-works/pi-ai/api/simple-options';
import {MIN_CONTEXT, replyRoom} from './context.mjs';

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

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

// How much the Partner thinks for each kind of turn: an answer as Navigator, as Scout or as Driver, and a remark
// nobody asked for. A remark may come a few seconds later; a wrong one costs the user more than the wait.
export const THINKING_DEFAULTS = {navigator: 'medium', scout: 'medium', driver: 'medium', remark: 'low'};

export const ANSWER_TOKENS = 2048; // the Partner's words and tool calls, on top of its thinking

/**
 * The Partner's `thinking`: one level for every kind of turn, or some kinds' levels with the defaults for the rest.
 * `name` is where the config has it.
 */
export function thinkingConfig(raw = {}, name = 'models.partner.thinking') {
  const levels = typeof raw === 'string' ? Object.fromEntries(Object.keys(THINKING_DEFAULTS).map(kind => [kind, raw])) : raw;
  if (!levels || typeof levels !== 'object' || Array.isArray(levels)) throw new Error(`config: ${name} must be a level or map kinds to levels`);
  for (const [kind, level] of Object.entries(levels)) {
    if (!(kind in THINKING_DEFAULTS)) throw new Error(`config: ${name}.${kind}: the kinds are ${Object.keys(THINKING_DEFAULTS).join(', ')}`);
    if (!THINKING_LEVELS.includes(level)) throw new Error(`config: ${name}: "${level}" is not one of ${THINKING_LEVELS.join(', ')}`);
  }
  return {...THINKING_DEFAULTS, ...levels};
}

/** The highest of `thinking`'s levels. */
export function mostThinking(thinking) {
  return Object.values(thinking).reduce((most, level) => (THINKING_LEVELS.indexOf(level) > THINKING_LEVELS.indexOf(most) ? level : most), 'off');
}

/** Tokens the Partner's reply needs at `level`: its thinking budget and the answer after it. */
export const replyTokens = level => ANSWER_TOKENS + (level === 'off' ? 0 : thinkingBudgetForLevel(level));

/**
 * Checks one model entry and fills its defaults; `name` is where the config has it. The Partner thinks
 * (`reasoning`, so Pair can set its level); the Watcher never does, and answers with one number whatever its
 * `maxTokens` (see watcher.mjs).
 */
export function modelConfig(role, entry, name = `models.${role}`) {
  if (!entry || typeof entry !== 'object') throw new Error(`config: ${name} is missing`);
  if (!['openai', 'anthropic'].includes(entry.api)) throw new Error(`config: ${name}.api must be "openai" or "anthropic"`);
  if (typeof entry.model !== 'string' || !entry.model) throw new Error(`config: ${name}.model is missing`);
  if (entry.api === 'openai' && !entry.baseUrl) throw new Error(`config: ${name}.baseUrl is missing`);
  const base = {baseUrl: entry.api === 'anthropic' ? 'https://api.anthropic.com' : undefined, contextWindow: 32768};
  if (role !== 'partner') return {...base, maxTokens: ANSWER_TOKENS, reasoning: false, ...entry};
  const contextWindow = entry.contextWindow ?? base.contextWindow;
  if (contextWindow < MIN_CONTEXT) {
    throw new Error(`config: ${name}.contextWindow is ${contextWindow}: the Partner needs at least ${MIN_CONTEXT} tokens, for its tools, a file it reads and its reply`);
  }
  const thinking = thinkingConfig(entry.thinking, `${name}.thinking`);
  return {
    ...base,
    // Thinking counts toward it: room for the most thinking any turn does and the answer after it, as far as the
    // context window leaves room for the conversation too.
    maxTokens: Math.min(replyTokens(mostThinking(thinking)), replyRoom(contextWindow)),
    reasoning: true,
    ...entry,
    thinking,
  };
}

export const SAME_AS_PARTNER = 'same as partner';

/**
 * The Watcher's entry when one model serves both roles: the Partner's model, asked as the Watcher asks. It can
 * think whenever the Partner can (`reasoning`), so Pair switches its thinking off; it always runs at temperature 0.
 */
function watcherOn(partner) {
  const {thinking, maxTokens, samplingParams, ...model} = partner;
  return {...model, reasoning: partner.reasoning ?? true};
}

/** Whether two model entries name the same model on the same server. */
export const sameModel = (a, b) => a.api === b.api && a.baseUrl === b.baseUrl && a.model === b.model;

/** Whether two model entries send their requests to the same server, which may answer one at a time. */
export const sameServer = (a, b) => a.api === b.api && a.baseUrl === b.baseUrl;

/**
 * `{watcher, partner}`: one `model` for both roles, or `models` with an entry for each, where the Watcher's may be
 * "same as partner".
 */
function parseModels(raw) {
  if (raw.model !== undefined && raw.models !== undefined) throw new Error('config: set "model" (one model for both roles) or "models", not both');
  if (raw.model !== undefined) {
    const partner = modelConfig('partner', raw.model, 'model');
    return {watcher: modelConfig('watcher', watcherOn(raw.model), 'model'), partner};
  }
  const watcher = raw.models?.watcher;
  if (typeof watcher === 'string' && watcher !== SAME_AS_PARTNER) throw new Error(`config: models.watcher is a model entry, or "${SAME_AS_PARTNER}"`);
  const partner = modelConfig('partner', raw.models?.partner);
  return {watcher: watcher === SAME_AS_PARTNER ? modelConfig('watcher', watcherOn(raw.models.partner)) : modelConfig('watcher', watcher), partner};
}

/** One line on which models serve the two roles, for `pair setup`. */
export function rolesText({watcher, partner}) {
  if (sameModel(watcher, partner)) return `one model for both roles: ${partner.model} at ${partner.baseUrl}`;
  return `the Watcher ${watcher.model} at ${watcher.baseUrl}, the Partner ${partner.model} at ${partner.baseUrl}`;
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
  const models = parseModels(raw);
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
