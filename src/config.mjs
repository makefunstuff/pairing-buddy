// One config file for the daemon: the models (one for both roles, or one each), the talk level and where things live.
// It is JSON with // and /* */ comments; the first run writes the commented example there.
import {execFile} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {thinkingBudgetForLevel} from '@earendil-works/pi-ai/api/simple-options';
import {MIN_CONTEXT, replyRoom} from './context.mjs';
import {storedKey} from './credentials.mjs';
import {RUN_TIMEOUT_MS} from './scout-pane.mjs';
import {scoutPaneConfig} from './scout-shell.mjs';
import {FALLBACK_TIMEOUT_MS, PROFILES, RERANK_TIMEOUT_MS, RERANK_TOP, profileConfig, rerankConfig as searchRerankConfig} from 'semantic-grep';
import {readServiceEnv} from './service-env.mjs';
import {LEVELS} from '../herdr/pair/commands.js';
import {voiceConfig} from './voice.mjs';

const EXAMPLE = fileURLToPath(new URL('../config.example.json', import.meta.url));

export {LEVELS};

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
  if (entry.apiKeyCommand !== undefined) throw new Error(`config: ${name} takes auth, apiKey, apiKeyFile or apiKeyEnv; apiKeyCommand is for search by meaning's embedding, cross-encoder and notes writer`);
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

// How much the Partner thinks for each kind of turn: an answer as Navigator, as Scout or as Driver, a remark
// nobody asked for, and a /gen request. A remark may come a few seconds later; a wrong one costs the user more than the wait.
export const THINKING_DEFAULTS = {navigator: 'medium', scout: 'medium', driver: 'medium', remark: 'low', gen: 'medium'};

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
  if (entry.images !== undefined && typeof entry.images !== 'boolean') throw new Error(`config: ${name}.images must be true or false`);
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

/**
 * Whether two model entries' requests have to be put in order: they go to one server of your own, which may answer
 * one request at a time. A cloud provider (`provider`) answers many at once, so its roles never wait for each other.
 */
export const oneAtATime = (a, b) => sameServer(a, b) && !a.provider;

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

// The decision model's APIs at a baseUrl, by the config's name for them: OpenAI's Decisions API (`POST /decisions`), the
// System One API TypeSafe, OpenRouter and llama.cpp serve (`POST /systemone`), and a chat model on llama.cpp's server
// asked for the probability of each answer (see pi-ai's README, "Classification").
export const DECISION_APIS = {openai: 'openai-decisions', 'system-one': 'typesafe-system-one', 'llama-cpp': 'llama-cpp-classify'};
// A decision the gate waits longer for than this is not taken: Pair goes by its own rules at once (see decision.mjs).
export const DECISION_TIMEOUT_MS = 1500;

/**
 * The optional `decision` entry: a classifier model (TypeSafe's Jev, Cloudflare's Clef, OpenAI's Decisions API) that
 * answers the speak gate's questions with probabilities. Like a role's entry it names a pi-ai `provider` and one of
 * its classifier models, or an `api` of DECISION_APIS at a `baseUrl`; `timeoutMs` is how long the gate waits for it.
 * null without one: Pair decides by its own rules, as without the entry.
 */
export function decisionConfig(entry, name = 'decision') {
  if (entry === undefined || entry === null) return null;
  if (typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`config: ${name} must be a model entry`);
  const keys = ['auth', 'apiKey', 'apiKeyFile', 'apiKeyEnv'].filter(field => entry[field] !== undefined);
  if (keys.length > 1) throw new Error(`config: ${name} takes one of ${keys.join(', ')}`);
  if (entry.apiKeyCommand !== undefined) throw new Error(`config: ${name} takes auth, apiKey, apiKeyFile or apiKeyEnv; apiKeyCommand is for search by meaning's embedding, cross-encoder and notes writer`);
  if (typeof entry.model !== 'string' || !entry.model) throw new Error(`config: ${name}.model is missing`);
  if (entry.provider !== undefined) {
    if (typeof entry.provider !== 'string' || !entry.provider) throw new Error(`config: ${name}.provider must be a provider id (see \`pair auth list\`)`);
    if (entry.api !== undefined || entry.baseUrl !== undefined) throw new Error(`config: ${name} names a provider, which brings its own api and baseUrl`);
    if (keys.length) throw new Error(`config: ${name} names a provider: log in with \`pair auth login ${entry.provider}\` instead of ${keys[0]}`);
  } else {
    if (!(entry.api in DECISION_APIS)) throw new Error(`config: ${name} needs a "provider", or an "api": ${Object.keys(DECISION_APIS).map(api => `"${api}"`).join(', ')}`);
    if (typeof entry.baseUrl !== 'string' || !entry.baseUrl) throw new Error(`config: ${name}.baseUrl is missing`);
    if (entry.auth !== undefined && (typeof entry.auth !== 'string' || !entry.auth)) throw new Error(`config: ${name}.auth must name a key stored by \`pair auth login\``);
  }
  const timeoutMs = entry.timeoutMs ?? DECISION_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !(timeoutMs > 0)) throw new Error(`config: ${name}.timeoutMs must be a number of milliseconds`);
  if (entry.contextWindow !== undefined && !(Number.isInteger(entry.contextWindow) && entry.contextWindow > 0)) throw new Error(`config: ${name}.contextWindow must be a number of tokens`);
  return {contextWindow: DEFAULT_CONTEXT, ...entry, timeoutMs};
}

/** One line on which models serve the two roles, for `pair setup`. */
export function rolesText({watcher, partner}) {
  if (sameModel(watcher, partner)) return `one model for both roles: ${whereIs(partner)}`;
  return `the Watcher ${whereIs(watcher)}, the Partner ${whereIs(partner)}`;
}

/**
 * The API key of a model entry: the stored key `auth`, `apiKey`, the file `apiKeyFile` or the env var `apiKeyEnv`,
 * from the environment or else the file `pair setup` stored it in for the service; for search by meaning's models,
 * also the output of `apiKeyCommand` (semantic-grep's, run at each request).
 */
export function apiKeyOf(entry) {
  if (entry.auth) return storedKey(authPath(), entry.auth);
  if (entry.apiKey) return entry.apiKey;
  if (entry.apiKeyFile) return readFileSync(entry.apiKeyFile.replace(/^~(?=\/)/, homedir()), 'utf8').trim();
  if (entry.apiKeyEnv) return process.env[entry.apiKeyEnv] ?? readServiceEnv(serviceEnvPath())[entry.apiKeyEnv];
  if (entry.apiKeyCommand) return commandKey(entry.apiKeyCommand);
  return undefined;
}

const KEY_COMMAND_MS = 5 * 60_000; // how long a key a command printed is used before the command runs again
const KEY_COMMAND_RETRY_MS = 20_000; // how soon a command that failed or printed nothing runs again
const KEY_COMMAND_TIMEOUT_MS = 30_000;
const commandKeys = new Map(); // command -> {key, at, pending}

/**
 * The key `command` printed (an `apiKeyCommand`), never waited for: the daemon is one process, and every request
 * asks for its key. The command runs in the background, at the first ask and again once its key is
 * KEY_COMMAND_MS old (a key rotated meanwhile is used that long), or KEY_COMMAND_RETRY_MS after it failed; until its
 * first answer there is no key (that request fails as with a missing key, and the next has it). Its output is never
 * logged.
 */
export function commandKey(command) {
  const known = commandKeys.get(command) ?? {key: undefined, at: 0, pending: null};
  commandKeys.set(command, known);
  if (!known.pending && Date.now() - known.at >= (known.key ? KEY_COMMAND_MS : KEY_COMMAND_RETRY_MS)) runKeyCommand(command, known);
  return known.key;
}

function runKeyCommand(command, known) {
  known.pending = new Promise(resolve => {
    execFile('/bin/sh', ['-c', command], {encoding: 'utf8', timeout: KEY_COMMAND_TIMEOUT_MS}, (error, out) => {
      known.key = error ? undefined : out.trim() || undefined; // a key the command no longer prints is not kept
      known.at = Date.now(); // a failing command is not run again on every request either, but soon
      known.pending = null;
      resolve(known.key);
    });
  });
  return known.pending;
}

/** Runs the `apiKeyCommand` of each of `entries` now, so their first requests have a key. Resolves once they answered. */
export function primeKeyCommands(entries) {
  return Promise.all(entries.filter(entry => entry?.apiKeyCommand).map(entry => {
    commandKey(entry.apiKeyCommand);
    return commandKeys.get(entry.apiKeyCommand).pending;
  }));
}

/**
 * `entry` for semantic-grep to ask with Pair's key: a cross-encoder or a notes writer is asked by semantic-grep itself,
 * which reads `apiKey` first; here that is apiKeyOf(entry), so `auth` and the variables `pair setup` stored for the
 * service work there too. Not enumerable: the key is never in a snapshot or a log. Without its `apiKeyCommand`:
 * semantic-grep would run it, waiting for it, whenever Pair's has no key yet (commandKey).
 */
export function withPairKey(entry) {
  if (!entry) return entry;
  const own = {...entry};
  delete own.apiKey;
  delete own.apiKeyCommand;
  return Object.defineProperty(own, 'apiKey', {get: () => apiKeyOf(entry), enumerable: false});
}

/** `path` with `~` expanded, as the real path the daemon names projects by when it exists. */
function projectPath(path) {
  const full = resolve(path.replace(/^~(?=\/|$)/, homedir()));
  try { return realpathSync(full); } catch { return full; }
}

/**
 * `testOnSave` maps a project's folder to the command Pair runs in its pane when you save a source file there: the
 * command, or `{command, timeoutSeconds, affected}` to give it more (or less) than two minutes, or to run it whole on
 * every save (`affected: false`) where Pair would run only the tests the save affects. Each becomes
 * `{command, timeoutMs, affected}`.
 */
function testCommands(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config: testOnSave must map project folders to commands');
  return Object.fromEntries(Object.entries(raw).map(([path, entry]) => {
    const {command, timeoutSeconds = RUN_TIMEOUT_MS / 1000, affected = true, ...rest} = typeof entry === 'string' ? {command: entry} : entry ?? {};
    if (typeof command !== 'string' || !command.trim()) throw new Error(`config: testOnSave["${path}"] must be a command`);
    if (typeof timeoutSeconds !== 'number' || !(timeoutSeconds > 0)) throw new Error(`config: testOnSave["${path}"].timeoutSeconds must be a number of seconds`);
    if (typeof affected !== 'boolean') throw new Error(`config: testOnSave["${path}"].affected must be true or false`);
    if (Object.keys(rest).length) throw new Error(`config: testOnSave["${path}"] has no ${Object.keys(rest).join(', ')}`);
    return [projectPath(path), {command: command.trim(), timeoutMs: timeoutSeconds * 1000, affected}];
  }));
}

// What one /gen request may do at most: they stop a model that loops, they are no review budget (see gen.mjs).
export const GEN_LIMITS = {files: 40, lines: 4000, commands: 8, minutes: 10};
// The note a /gen brief has when the user pinned none, when the project has it (see brief.mjs).
export const GEN_BRIEF = 'NOTES.md';
// Days a /gen try folder stays once it last changed, and a scaffold's copy once it was last used (see gen-tree.mjs).
export const GEN_KEEP_TRIES = 7;
// Where a /gen scaffold goes without --branch or --copy: 'tree', a copy in Pair's data folder; or 'worktree'.
export const GEN_SCAFFOLD = 'tree';

/**
 * `gen`: `{limits, brief, keepTries, network, scaffold}`, each limit a whole number above zero, the rest of a limit
 * its default; `brief` a path in the project, or null for a brief of the goal and the board task only; `keepTries`
 * the days a try folder or a scaffold's copy stays; `network` whether the runs of a try or a scaffold reach the
 * network; `scaffold` where a scaffold goes, 'tree' or 'worktree'.
 */
function genConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config: gen must be an object, for example {"limits": {"lines": 2000}}');
  const {limits = {}, brief = GEN_BRIEF, keepTries = GEN_KEEP_TRIES, network = false, scaffold = GEN_SCAFFOLD, ...rest} = raw;
  if (Object.keys(rest).length) throw new Error(`config: gen has no ${Object.keys(rest).join(', ')} (only limits, brief, keepTries, network and scaffold)`);
  if (!['tree', 'worktree'].includes(scaffold)) throw new Error('config: gen.scaffold must be "tree" (a copy in Pair\'s data folder) or "worktree" (a git worktree on a branch gen/<n>)');
  if (!Number.isInteger(keepTries) || keepTries < 1) throw new Error('config: gen.keepTries must be a whole number of days above 0');
  if (typeof network !== 'boolean') throw new Error('config: gen.network must be true or false');
  if (brief !== null && (typeof brief !== 'string' || !brief.trim() || isAbsolute(brief))) throw new Error('config: gen.brief must be a path in the project, like "NOTES.md", or null');
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new Error('config: gen.limits must be an object');
  for (const [name, value] of Object.entries(limits)) {
    if (!(name in GEN_LIMITS)) throw new Error(`config: gen.limits.${name}: the limits are ${Object.keys(GEN_LIMITS).join(', ')}`);
    if (!Number.isInteger(value) || value < 1) throw new Error(`config: gen.limits.${name} must be a whole number above 0`);
  }
  return {limits: {...GEN_LIMITS, ...limits}, brief, keepTries, network, scaffold};
}

/** `taskCommand`: the command, as words, that :Pair tasks runs for each task, with {title} and {description} in them. */
function taskCommand(raw) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || !raw.length || !raw.every(word => typeof word === 'string' && word)) {
    throw new Error('config: taskCommand must be a command as a list of words, for example ["gh", "issue", "create", "--title", "{title}"]');
  }
  return raw;
}

/** The work board's command (Shepherdr's `shepherdr`), which the context card, the goal and the relay read; null for none. */
function boardCommand(raw = 'shepherdr') {
  if (raw !== null && (typeof raw !== 'string' || !raw.trim())) throw new Error('config: board must be the board\'s command, or null');
  return raw && raw.trim().replace(/^~(?=\/)/, homedir());
}

/**
 * Search by meaning (see search.mjs, and semantic-grep): false turns it off for good; else `{python, threads, index,
 * profile, notes}`: the Python whose litert-lm-api runs EmbeddingGemma 2 (else a venv in Pair's data folder, else
 * python3), the cores it may use, where the index lives ("data", Pair's data folder, the default, or "project", .pair/
 * in the repository), one of semantic-grep's model profiles (its docs/profiles.md: "laptop", "beefy", "cloud",
 * "openrouter"), which names the `embedding` and `rerank` models (see profiledConfig), and `notes`: true, or an entry
 * over the profile's notes writer (the laptop's without a profile), for notes written while nothing is searched
 * (semantic-grep's docs/notes.md), checked as semantic-grep checks them. It is on once its model is downloaded
 * (`:Pair find on`), or at once with an "embedding" model or a profile.
 */
function meaningConfig(raw = {}) {
  if (raw === false) return false;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config: meaning must be false or an object, for example {"threads": 2}');
  const {python, threads, index, profile, notes, ...rest} = raw;
  if (Object.keys(rest).length) throw new Error(`config: meaning has no ${Object.keys(rest).join(', ')} (only python, threads, index, profile and notes)`);
  if (python !== undefined && (typeof python !== 'string' || !python.trim())) throw new Error('config: meaning.python must be the path of a Python with litert-lm-api');
  if (threads !== undefined && !(Number.isInteger(threads) && threads > 0)) throw new Error('config: meaning.threads must be a whole number above 0');
  if (index !== undefined && !['data', 'project'].includes(index)) throw new Error('config: meaning.index must be "data" (Pair\'s data folder) or "project" (.pair/ in the repository)');
  if (profile !== undefined && profile !== null && !Object.hasOwn(PROFILES, profile)) {
    throw new Error(`config: meaning.profile must be one of ${Object.keys(PROFILES).map(name => `"${name}"`).join(', ')} (semantic-grep's docs/profiles.md)`);
  }
  if (notes !== undefined && notes !== null && typeof notes !== 'boolean' && (typeof notes !== 'object' || Array.isArray(notes))) {
    throw new Error('config: meaning.notes must be true, false or a notes writer entry, for example {"model": "qwen3.5-9b"}');
  }
  let written = null;
  try {
    written = profileConfig({profile: profile ?? undefined, notes}).notes;
  } catch (error) { // semantic-grep's words are for its Lua setup(); Pair's config is JSON
    throw new Error(`config: meaning.${error.message.replace('sendCode = true', '"sendCode": true')}`);
  }
  if (written && typeof notes === 'object' && notes.auth !== undefined) { // Pair's stored key replaces the profile's
    if (typeof notes.auth !== 'string' || !notes.auth) throw new Error('config: meaning.notes.auth must name a key stored by `pair auth login`');
    for (const field of KEY_FIELDS) if (field !== 'auth') delete written[field];
  }
  return {...(python ? {python: python.trim()} : {}), ...(threads ? {threads} : {}), ...(index ? {index} : {}), ...(profile ? {profile} : {}), ...(written ? {notes: written} : {})};
}

// What an entry says about its own model only: dropped from the profile's when the config names another model or API
// (as semantic-grep's profiles.mjs), and the key fields, Pair's `auth` among them: the config's own replaces the
// profile's, and a profile's key never goes to another server.
const OF_THE_MODEL = ['dimensions', 'queryPrefix', 'documentPrefix', 'queryBody', 'documentBody', 'band', 'pickNear', 'chars', 'top', 'timeoutMs'];
const KEY_FIELDS = ['auth', 'apiKey', 'apiKeyFile', 'apiKeyEnv', 'apiKeyCommand'];

/** The config's own `embedding` or `rerank` entry `own` over its profile's `base`, as semantic-grep's setup() takes it. */
function overProfile(base, own) {
  if (own === undefined || own === null) return base ?? null;
  if (!base || own === false || Array.isArray(own) || typeof own !== 'object' || own.provider !== undefined) return own;
  const trimmed = url => String(url).replace(/\/+$/, '');
  const otherModel = (own.model && own.model !== base.model) || (own.api && own.api !== base.api);
  const otherKey = KEY_FIELDS.some(key => own[key] !== undefined) || (own.baseUrl && trimmed(own.baseUrl) !== trimmed(base.baseUrl));
  const kept = Object.entries(base).filter(([key]) => !(otherModel && OF_THE_MODEL.includes(key)) && !(otherKey && KEY_FIELDS.includes(key)));
  return {...Object.fromEntries(kept), ...own};
}

/**
 * The `embedding` and `rerank` of `raw`, with "meaning": {"profile": ...}: the profile's models (semantic-grep's
 * docs/profiles.md), with what the config sets itself over them: `{"baseUrl": ...}` moves one, another model is an
 * entry of its own, `"rerank": false` turns the profile's reranker off, a list or a decision model is the config's
 * own. Without a profile, the config's as they are.
 */
function profiledConfig(raw, meaning) {
  const base = meaning?.profile ? PROFILES[meaning.profile] : {};
  return {
    embedding: embeddingConfig(overProfile(base.embedding, raw.embedding)),
    rerank: rerankConfig(overProfile(base.rerank, raw.rerank)),
  };
}

/**
 * The optional `embedding` entry, next to the models: an embedding model behind an OpenAI-compatible `/v1/embeddings`
 * (`"api": "openai"` at a `baseUrl`, its key as a model's), which search by meaning uses instead of EmbeddingGemma 2.
 * `queryPrefix` and `documentPrefix` are the prompts it was trained with, where Pair does not know them; `dimensions`
 * asks a model that can for shorter vectors. null without one.
 */
export function embeddingConfig(entry, name = 'embedding') {
  if (entry === undefined || entry === null) return null;
  if (typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`config: ${name} must be a model entry, for example {"api": "openai", "baseUrl": "http://127.0.0.1:8080/v1", "model": "jina-embeddings-v2-base-code"}`);
  if (entry.provider !== undefined) throw new Error(`config: ${name} takes an "api": "openai" at a "baseUrl", not a provider`);
  if (entry.api !== 'openai') throw new Error(`config: ${name}.api must be "openai": an OpenAI-compatible /v1/embeddings`);
  if (typeof entry.baseUrl !== 'string' || !entry.baseUrl) throw new Error(`config: ${name}.baseUrl is missing`);
  if (typeof entry.model !== 'string' || !entry.model) throw new Error(`config: ${name}.model is missing`);
  const keys = KEY_FIELDS.filter(field => entry[field] !== undefined);
  if (keys.length > 1) throw new Error(`config: ${name} takes one of ${keys.join(', ')}`);
  if (entry.apiKeyCommand !== undefined && (typeof entry.apiKeyCommand !== 'string' || !entry.apiKeyCommand.trim())) throw new Error(`config: ${name}.apiKeyCommand must be a command`);
  for (const field of ['queryPrefix', 'documentPrefix']) {
    if (entry[field] !== undefined && typeof entry[field] !== 'string') throw new Error(`config: ${name}.${field} must be text`);
  }
  if (entry.dimensions !== undefined && !(Number.isInteger(entry.dimensions) && entry.dimensions > 0)) throw new Error(`config: ${name}.dimensions must be a whole number above 0`);
  return {...entry};
}

/**
 * The optional `rerank` entry, next to `embedding`: a decision model that reorders the first pieces of a settled search
 * (semantic-grep's Reranker), or a list of them, best first, each asked when the ones before it fail. A model entry as
 * `decision`'s (a `provider`, or an `api` of DECISION_APIS at a `baseUrl`), with `top`, how many pieces it reorders,
 * and `timeoutMs`, how long a search waits for it: by default 3 s, and 1 s for a model that another follows. Or a
 * cross-encoder, `"api": "rerank"` at a `baseUrl` (llama.cpp's --rerank, Cohere, Jina, Voyage: POST <baseUrl>/rerank),
 * which semantic-grep asks itself and which reorders every piece it reads; its `chars` (how much of each piece it
 * reads) is 1200 by default. A list of entries, or null without one: off.
 */
export function rerankConfig(value, name = 'rerank') {
  if (value === undefined || value === null || value === false) return null;
  const list = Array.isArray(value);
  if (list && !value.length) throw new Error(`config: ${name} lists no model`);
  return (list ? value : [value]).map((entry, i, all) => {
    const label = list ? `${name}[${i}]` : name;
    const {top, timeoutMs, ...rest} = entry ?? {};
    if (top !== undefined && !(Number.isInteger(top) && top >= 2 && top <= 30)) throw new Error(`config: ${label}.top must be a whole number from 2 to 30`);
    if (timeoutMs !== undefined && !(typeof timeoutMs === 'number' && timeoutMs > 0)) throw new Error(`config: ${label}.timeoutMs must be a number of milliseconds`);
    if (entry?.api === 'rerank') {
      if (entry.provider !== undefined) throw new Error(`config: ${label} is a cross-encoder at a baseUrl ("api": "rerank"), not a provider's`);
      let parsed;
      try { [parsed] = searchRerankConfig(entry, label); } catch (error) { throw new Error(`config: ${error.message}`); }
      return {...parsed, timeoutMs: timeoutMs ?? (i < all.length - 1 ? FALLBACK_TIMEOUT_MS : RERANK_TIMEOUT_MS)};
    }
    const parsed = decisionConfig(typeof entry === 'object' && !Array.isArray(entry) ? rest : entry, label);
    return {...parsed, top: top ?? RERANK_TOP, timeoutMs: timeoutMs ?? (i < all.length - 1 ? FALLBACK_TIMEOUT_MS : RERANK_TIMEOUT_MS)};
  });
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
  const meaning = meaningConfig(raw.meaning);
  const searchModels = profiledConfig(raw, meaning);
  if (!LEVELS.includes(level)) throw new Error(`config: level must be one of ${LEVELS.join(', ')}`);
  const models = parseModels(raw, windows);
  if (raw.agents !== undefined && typeof raw.agents !== 'boolean') throw new Error('config: agents must be true or false');
  if (raw.watcherPace !== undefined && typeof raw.watcherPace !== 'boolean') throw new Error('config: watcherPace must be true or false');
  if (raw.plan !== undefined && typeof raw.plan !== 'boolean') throw new Error('config: plan must be true or false');
  if (raw.herdrPanel !== undefined && ![true, false, 'auto'].includes(raw.herdrPanel)) throw new Error('config: herdrPanel must be true, false or "auto"');
  return {
    level,
    typingPauseMs: raw.typingPauseMs ?? 2000,
    autoTune: raw.autoTune ?? true,
    plan: raw.plan ?? true, // Pair proposes the goal's steps (see thread.mjs); /plan still sets your own without it
    // A slow server is the floor under every new moment: while the Watcher's calls take long, Pair asks about fewer
    // kinds of moment (see pace.mjs). false asks about every kind whatever the server costs.
    watcherPace: raw.watcherPace ?? true,
    // A cloud model is never unloaded, and each ping would be a paid request.
    keepWarm: raw.keepWarm ?? models.watcher.api === 'openai',
    socket: raw.socket ?? defaultSocketPath(),
    dataDir: raw.dataDir ?? join(xdg('XDG_STATE_HOME', '.local/state'), 'pairing-buddy'),
    testOnSave: testCommands(raw.testOnSave),
    meaning, // search by meaning's Python, cores, profile and notes writer, or false (see search.mjs)
    sessionRoots: sessionRoots(raw.sessionRoots),
    scoutPane: scoutPaneConfig(raw.scoutPane), // Pair's pane: your rc file and the sandbox (see scout-shell.mjs)
    voice: voiceConfig(raw.voice), // push-to-talk; null when off (see voice.mjs)
    taskCommand: taskCommand(raw.taskCommand),
    gen: genConfig(raw.gen), // what one /gen request may do at most, and its brief's note (see gen.mjs)
    board: boardCommand(raw.board),
    windows, // as found (see context-window.mjs), so a reload can keep one a server cannot tell then
    agents: raw.agents ?? true, // relays your other agents' news (see agents.mjs)
    herdrPanel: raw.herdrPanel ?? 'auto', // the Herdr panel's loopback port: "auto" opens it when the Herdr window is installed (see herdr-panel.mjs)
    models,
    decision: decisionConfig(raw.decision), // the gate's decision model, or null (see decision.mjs)
    embedding: searchModels.embedding, // search by meaning's model at a /v1/embeddings (its profile's, or its own), or null for EmbeddingGemma 2
    rerank: searchModels.rerank, // the decision models that reorder a settled search's first pieces, best first, or null (see search.mjs)
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
