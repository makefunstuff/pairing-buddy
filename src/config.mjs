// One config file for the daemon: the models (one for both roles, or one each), the talk level and where things live.
// It is JSON with // and /* */ comments; the first run writes the commented example there.
import {copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {thinkingBudgetForLevel} from '@earendil-works/pi-ai/api/simple-options';
import {MIN_CONTEXT, replyRoom} from './context.mjs';
import {storedKey} from './credentials.mjs';
import {readServiceEnv} from './service-env.mjs';
import {voiceConfig} from './voice.mjs';

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

/** Where `pair auth` keeps the logins and keys: next to the config, or `$PAIR_AUTH`. */
export function authPath() {
  return process.env.PAIR_AUTH || join(dirname(configPath()), 'auth.json');
}

/** Where `pair setup` keeps the variables named by "apiKeyEnv" for the service: next to the config. */
export function serviceEnvPath() {
  return join(dirname(configPath()), 'service.env');
}

/**
 * Where the model entry at `name` sends its requests: a pi-ai `provider` (its own API, catalog and login), or an `api`
 * at a `baseUrl`. Its key comes from one of `auth` (a key stored by `pair auth login`), `apiKey`, `apiKeyFile` and
 * `apiKeyEnv`.
 */
function checkSource(name, entry) {
  const keys = ['auth', 'apiKey', 'apiKeyFile', 'apiKeyEnv'].filter(field => entry[field] !== undefined);
  if (keys.length > 1) throw new Error(`config: ${name} takes one of ${keys.join(', ')}`);
  if (entry.provider === undefined) {
    if (!['openai', 'anthropic'].includes(entry.api)) throw new Error(`config: ${name} needs a "provider", or an "api": "openai" or "anthropic"`);
    if (entry.auth !== undefined && (typeof entry.auth !== 'string' || !entry.auth)) throw new Error(`config: ${name}.auth must name a key stored by \`pair auth login\``);
    return;
  }
  if (typeof entry.provider !== 'string' || !entry.provider) throw new Error(`config: ${name}.provider must be a provider id (see \`pair auth list\`)`);
  if (entry.api !== undefined || entry.baseUrl !== undefined) throw new Error(`config: ${name} names a provider, which brings its own api and baseUrl`);
  if (keys.length) throw new Error(`config: ${name} names a provider: log in with \`pair auth login ${entry.provider}\` instead of ${keys[0]}`);
}

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

// How much the Partner thinks for each kind of turn: an answer as Navigator, as Scout or as Driver, and a remark
// nobody asked for. A remark may come a few seconds later; a wrong one costs the user more than the wait.
export const THINKING_DEFAULTS = {navigator: 'medium', scout: 'medium', driver: 'medium', remark: 'low'};

export const ANSWER_TOKENS = 2048; // the Partner's words and tool calls, on top of its thinking
// A model entry's window when neither the config nor the model's server or catalog says: local servers are often
// started with a small context.
export const DEFAULT_CONTEXT = 32768;

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

/** `thinkingLevelMap`: a level -> the server's name for it, or null for a level it does not have. */
function checkLevelMap(map, name) {
  if (map === undefined) return;
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error(`config: ${name} must map thinking levels to the server's names for them`);
  for (const [level, sent] of Object.entries(map)) {
    if (!THINKING_LEVELS.includes(level)) throw new Error(`config: ${name}.${level}: the levels are ${THINKING_LEVELS.join(', ')}`);
    if (sent !== null && typeof sent !== 'string') throw new Error(`config: ${name}.${level} must be a name the server takes, or null`);
  }
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
export function modelConfig(role, entry, name = `models.${role}`, found = null) {
  if (!entry || typeof entry !== 'object') throw new Error(`config: ${name} is missing`);
  checkSource(name, entry);
  if (typeof entry.model !== 'string' || !entry.model) throw new Error(`config: ${name}.model is missing`);
  if (entry.api === 'openai' && !entry.baseUrl) throw new Error(`config: ${name}.baseUrl is missing`);
  checkLevelMap(entry.thinkingLevelMap, `${name}.thinkingLevelMap`);
  const contextWindow = entry.contextWindow ?? found?.tokens ?? DEFAULT_CONTEXT;
  const base = {
    baseUrl: entry.api === 'anthropic' ? 'https://api.anthropic.com' : undefined,
    contextWindow,
    // Where the window comes from, for `pair doctor`: the config, `found` (see context-window.mjs) or the default.
    windowFrom: entry.contextWindow !== undefined ? 'config' : found?.from ?? 'default',
    ...(entry.contextWindow !== undefined && found?.served ? {servedWindow: found.tokens} : {}),
  };
  if (role !== 'partner') return {...base, maxTokens: ANSWER_TOKENS, reasoning: false, ...entry};
  if (contextWindow < MIN_CONTEXT) {
    const told = base.windowFrom === 'config' ? '' : ` (${base.windowFrom}; set "contextWindow" to say otherwise)`;
    throw new Error(`config: ${name}.contextWindow is ${contextWindow}${told}: the Partner needs at least ${MIN_CONTEXT} tokens, for its tools, a file it reads and its reply`);
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

/** Whether two model entries send their requests to the same server (or provider), which may answer one at a time. */
export const sameServer = (a, b) => a.provider === b.provider && a.api === b.api && a.baseUrl === b.baseUrl;

/** Whether two model entries name the same model on the same server. */
export const sameModel = (a, b) => sameServer(a, b) && a.model === b.model;

/** Where a model entry's model is, for people: "m at http://host/v1" or "m on provider". */
export const whereIs = entry => (entry.provider ? `${entry.model} on ${entry.provider}` : `${entry.model} at ${entry.baseUrl}`);

/**
 * `{watcher, partner}`: one `model` for both roles, or `models` with an entry for each, where the Watcher's may be
 * "same as partner".
 */
function parseModels(raw, windows) {
  if (raw.model !== undefined && raw.models !== undefined) throw new Error('config: set "model" (one model for both roles) or "models", not both');
  if (raw.model !== undefined) {
    const partner = modelConfig('partner', raw.model, 'model', windows.partner);
    return {watcher: modelConfig('watcher', watcherOn(raw.model), 'model', windows.partner), partner};
  }
  const watcher = raw.models?.watcher;
  if (typeof watcher === 'string' && watcher !== SAME_AS_PARTNER) throw new Error(`config: models.watcher is a model entry, or "${SAME_AS_PARTNER}"`);
  const partner = modelConfig('partner', raw.models?.partner, undefined, windows.partner);
  return {
    watcher: watcher === SAME_AS_PARTNER
      ? modelConfig('watcher', watcherOn(raw.models.partner), undefined, windows.partner)
      : modelConfig('watcher', watcher, undefined, windows.watcher),
    partner,
  };
}

/** One line on which models serve the two roles, for `pair setup`. */
export function rolesText({watcher, partner}) {
  if (sameModel(watcher, partner)) return `one model for both roles: ${whereIs(partner)}`;
  return `the Watcher ${whereIs(watcher)}, the Partner ${whereIs(partner)}`;
}

/**
 * The API key of a model entry: the stored key `auth`, `apiKey`, the file `apiKeyFile` or the env var `apiKeyEnv`,
 * from the environment or else the file `pair setup` stored it in for the service.
 */
export function apiKeyOf(entry) {
  if (entry.auth) return storedKey(authPath(), entry.auth);
  if (entry.apiKey) return entry.apiKey;
  if (entry.apiKeyFile) return readFileSync(entry.apiKeyFile.replace(/^~(?=\/)/, homedir()), 'utf8').trim();
  if (entry.apiKeyEnv) return process.env[entry.apiKeyEnv] ?? readServiceEnv(serviceEnvPath())[entry.apiKeyEnv];
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

/** `taskCommand`: the command, as words, that :Pair tasks runs for each task, with {title} and {description} in them. */
function taskCommand(raw) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || !raw.length || !raw.every(word => typeof word === 'string' && word)) {
    throw new Error('config: taskCommand must be a command as a list of words, for example ["gh", "issue", "create", "--title", "{title}"]');
  }
  return raw;
}

/** The work board's command (herdr-projects), which the context card and the goal are read from; null for none. */
function boardCommand(raw = 'herdr-projects') {
  if (raw !== null && (typeof raw !== 'string' || !raw.trim())) throw new Error('config: board must be the board\'s command, or null');
  return raw && raw.trim().replace(/^~(?=\/)/, homedir());
}

/**
 * `sessionRoots` lists the folders that each have their own session, for a monorepo where the git root is too coarse:
 * a folder, or `<folder>/*` for every folder in it.
 */
function sessionRoots(raw = []) {
  if (!Array.isArray(raw) || raw.some(path => typeof path !== 'string' || !path.trim())) throw new Error('config: sessionRoots must list folders');
  return raw.map(path => {
    const each = /\/\*$/.test(path);
    return {path: projectPath(each ? path.slice(0, -2) : path), each};
  });
}

/**
 * The daemon's config from the file's `raw` JSON. `windows` holds the context window each role's model has where
 * the config does not say, `{tokens, from, served}` (see context-window.mjs).
 */
export function parseConfig(raw, {windows = {}} = {}) {
  const level = raw.level ?? 'normal';
  if (!LEVELS.includes(level)) throw new Error(`config: level must be one of ${LEVELS.join(', ')}`);
  const models = parseModels(raw, windows);
  if (raw.agents !== undefined && typeof raw.agents !== 'boolean') throw new Error('config: agents must be true or false');
  return {
    level,
    typingPauseMs: raw.typingPauseMs ?? 2000,
    autoTune: raw.autoTune ?? true,
    // A cloud model is never unloaded, and each ping would be a paid request.
    keepWarm: raw.keepWarm ?? models.watcher.api === 'openai',
    socket: raw.socket ?? defaultSocketPath(),
    dataDir: raw.dataDir ?? join(xdg('XDG_STATE_HOME', '.local/state'), 'pairing-buddy'),
    testOnSave: testCommands(raw.testOnSave),
    sessionRoots: sessionRoots(raw.sessionRoots),
    voice: voiceConfig(raw.voice), // push-to-talk; null when off (see voice.mjs)
    taskCommand: taskCommand(raw.taskCommand),
    board: boardCommand(raw.board),
    windows, // as found (see context-window.mjs), so a reload can keep one a server cannot tell then
    agents: raw.agents ?? true, // relays your other agents' news (see agents.mjs)
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

/** The config file's JSON, its comments stripped. */
export function readConfig(path = configPath()) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { throw new Error(`No config at ${path}; run \`pair setup\``); }
  try { return JSON.parse(stripComments(text)); } catch (error) { throw new Error(`config: ${path} is not valid JSON (${error.message})`); }
}

export function loadConfig(path = configPath()) {
  return parseConfig(readConfig(path));
}
