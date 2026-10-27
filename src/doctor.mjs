// `pair doctor`: checks each part Pair needs, one line each, and says what is wrong in plain words.
import {execFile} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {basename, delimiter, dirname, join} from 'node:path';
import {credentialState} from './auth.mjs';
import {authPath, configPath, mostThinking, replyTokens, sameModel, sameServer, whereIs} from './config.mjs';
import {SMALL_CONTEXT} from './context.mjs';
import {loadSizedConfig} from './context-window.mjs';
import {fileCredentialStore, readableByOthers} from './credentials.mjs';
import {herdrRequest} from './herdr.mjs';
import {listModels, shareServer, SWAP_FACTOR, SWAP_MS} from './loaded-model.mjs';
import {createPairModels, knownProviders} from './models.mjs';
import {levelGroups, probeModel, probeThinking} from './probe.mjs';
import {requestDaemon} from './protocol.mjs';
import {keyVariables, readServiceEnv} from './service-env.mjs';
import {serviceManager} from './service.mjs';
import {VERSION} from './version.mjs';
import {RATE, recorderOf, transcribe} from './voice.mjs';

const WATCHER_MS = 1500; // the Watcher scores every candidate remark: about a second is the aim
const PARTNER_MS = 20_000;
const NVIM_MS = 10_000;
const EXAMPLE_MODELS = ['your-model', 'your-small-model', 'your-larger-model'];

const ok = (name, text) => ({level: 'ok', name, text});
const warn = (name, text) => ({level: 'warn', name, text});
const fail = (name, text) => ({level: 'fail', name, text});

export const tilde = path => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);
const seconds = ms => `${(ms / 1000).toFixed(1)} s`;
const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const onPath = (name, env) => (env.PATH ?? '').split(delimiter).some(dir => existsSync(join(dir, name)));

/** Every check, in order, as `{level: ok|warn|fail, name, text}`; yields each as soon as it is known. */
export async function* doctor({
  path = configPath(), env = process.env, manager = serviceManager(), service = async () => manager?.state(), nvimPlugin = nvimHasPlugin, auth = authPath(), credentials = fileCredentialStore(auth),
  serviceEnv = join(dirname(path), 'service.env'), // as serviceEnvPath() has it
} = {}) {
  let config;
  try {
    config = await loadSizedConfig(path);
  } catch (error) {
    yield fail('config', error.message);
    return;
  }
  const examples = Object.values(config.models).filter(entry => EXAMPLE_MODELS.includes(entry.model));
  yield examples.length
    ? warn('config', `${tilde(path)} still has the example's model names: set your models there`)
    : ok('config', tilde(path));
  yield serviceCheck(await service(), manager);
  const status = await requestDaemon(config.socket, {type: 'status'}).catch(() => null);
  yield daemonCheck(status, config, manager);
  // A connected Neovim has the plugin; only without one is Neovim started to look (it can take seconds).
  const connected = status?.sessions.some(session => session.editors > 0);
  yield connected ? ok('plugin', 'loaded in the connected Neovims') : pluginCheck(await nvimPlugin(env));
  if (status) yield editorsCheck(status);
  yield await herdrCheck(env);
  if (existsSync(auth)) yield loginsCheck(auth);
  if (keyVariables(config).length) yield keysCheck(keyVariables(config), env, serviceEnv);
  yield await voiceCheck(config.voice);
  yield* modelChecks(config, status, credentials);
}

/** The service's `state` under `manager` (see service.mjs); without one, the supervisor restarts the daemon. */
export function serviceCheck(state, manager) {
  if (!manager) return warn('service', 'no systemd or launchd here: `pair` runs the daemon under a supervisor that restarts it when it fails, but nothing starts it at login');
  if (!state.installed) return warn('service', 'not installed: `pair setup` makes the daemon start at login and restart when it fails');
  if (state.node && !existsSync(state.node)) return fail('service', `it runs Node.js from ${tilde(state.node)}, which is gone: run \`pair setup\` again`);
  if (!state.active) return fail('service', `installed but not running: see \`${manager.logs}\`, then \`${manager.restart}\``);
  if (!state.enabled) return warn('service', `running, but it does not start at login: \`${manager.enable}\``);
  return ok('service', 'starts at login, running');
}

export function daemonCheck(status, config, manager) {
  if (!status) return fail('daemon', `nothing answers on ${tilde(config.socket)}: run \`pair setup\`, or \`pair daemon\` in a terminal`);
  if (status.version !== VERSION) {
    const restart = manager?.installed() ? `\`${manager.restart}\`` : `stop it (\`kill ${status.pid}\`) and run \`pair\``;
    return warn('daemon', `it runs version ${status.version} and this pair is ${VERSION}: ${restart}`);
  }
  const minutes = Math.round((Date.now() - status.startedAt) / 60_000);
  const sessions = status.sessions.length === 1 ? '1 session' : `${status.sessions.length} sessions`;
  return ok('daemon', `version ${status.version}, up ${minutes} min, ${sessions}`);
}

/** Whether Neovim, started with the user's own config, finds the plugin: "yes", "no", "no-nvim" or "timeout". */
export function nvimHasPlugin(env) {
  if (!onPath('nvim', env)) return Promise.resolve('no-nvim');
  const probe = "lua io.stdout:write('pair-plugin:' .. (pcall(require, 'pair') and 'yes' or 'no'))";
  return new Promise(resolve => {
    execFile('nvim', ['--headless', '-c', probe, '-c', 'qa!'], {timeout: NVIM_MS, env}, (error, stdout) => {
      const found = /pair-plugin:(yes|no)/.exec(stdout)?.[1];
      resolve(found ?? (error?.killed ? 'timeout' : 'no'));
    });
  });
}

export function pluginCheck(found) {
  if (found === 'no-nvim') return fail('plugin', 'Neovim (nvim) is not on PATH');
  if (found === 'timeout') return warn('plugin', `not checked: Neovim did not start headless within ${NVIM_MS / 1000} s`);
  if (found === 'no') return fail('plugin', 'your Neovim config does not load the plugin: add it with lazy.nvim (see the README)');
  return ok('plugin', 'your Neovim config loads it');
}

export function editorsCheck(status) {
  const connected = status.sessions.filter(session => session.editors > 0);
  if (!connected.length) return warn('neovim', 'none connected: run `:Pair start` in Neovim, or set `auto_connect = true` in its setup');
  const count = connected.reduce((sum, session) => sum + session.editors, 0);
  return ok('neovim', `${count} connected, in ${connected.map(session => basename(session.root)).join(', ')}`);
}

export async function herdrCheck(env) {
  if (!env.HERDR_SOCKET_PATH) {
    return onPath('herdr', env)
      ? warn('herdr', 'not checked here: run `pair doctor` in a herdr pane to check it')
      : warn('herdr', 'not installed: Pair works without it as Navigator only, with `pair chat` in any terminal');
  }
  const started = Date.now();
  try {
    const {panes} = await herdrRequest(env.HERDR_SOCKET_PATH, 'pane.list', {workspace_id: env.HERDR_WORKSPACE_ID});
    return ok('herdr', `answers in ${Date.now() - started} ms, ${panes.length} panes in this workspace`);
  } catch (error) {
    return fail('herdr', `does not answer on its socket (${error.message})`);
  }
}

export function loginsCheck(path) {
  return readableByOthers(path)
    ? fail('logins', `${tilde(path)} holds your logins and keys and others can read it: chmod 600 ${tilde(path)}`)
    : ok('logins', `${tilde(path)}, readable by you only`);
}

/**
 * Whether the daemon, run as a service without your shell's environment, finds the variables `names` that model
 * entries take their keys from ("apiKeyEnv"): `pair setup` stores them in the file at `path`.
 */
export function keysCheck(names, env, path) {
  if (readableByOthers(path)) return fail('keys', `${tilde(path)} holds your keys and others can read it: chmod 600 ${tilde(path)}`);
  const stored = readServiceEnv(path);
  const unset = names.filter(name => !stored[name] && !env[name]);
  if (unset.length) return fail('keys', `${unset.join(', ')} ${unset.length === 1 ? 'is' : 'are'} not set: set ${unset.length === 1 ? 'it' : 'them'} and run \`pair setup\`, or store the key with \`pair auth login NAME\` and "auth"`);
  const shellOnly = names.filter(name => !stored[name]);
  if (shellOnly.length) return warn('keys', `${shellOnly.join(', ')} ${shellOnly.length === 1 ? 'is' : 'are'} set in this shell only, which the service does not see: run \`pair setup\` to store ${shellOnly.length === 1 ? 'it' : 'them'} for it`);
  return ok('keys', `${names.join(', ')} stored for the service in ${tilde(path)}, readable by you only`);
}

/**
 * Push-to-talk: a recorder, the whisper.cpp model, and how long whisper takes for a second of audio on the CPU; and the
 * speech command, if one is set.
 */
export async function voiceCheck(voice, found = name => onPath(name, process.env)) {
  if (!voice) return ok('voice', 'off: to speak to Pair, set "voice" in the config (see docs/voice.md)');
  const recorder = recorderOf(voice, found);
  if (!recorder) return fail('voice', 'no recorder found: install pw-record (pipewire), parec (pulseaudio-utils) or arecord (alsa-utils), or set voice.record');
  if (!existsSync(voice.model)) return fail('voice', `no whisper.cpp model at ${tilde(voice.model)}: see docs/voice.md`);
  const speech = voice.speak?.trim().split(/\s+/)[0];
  if (speech && !found(speech)) return warn('voice', `the speech command \`${speech}\` is not on PATH: answers are not read aloud when you are away`);
  const dir = mkdtempSync(join(tmpdir(), 'pair-doctor-voice-'));
  const started = Date.now();
  try {
    await transcribe(voice, Buffer.alloc(RATE * 2), {dir});
  } catch (error) {
    return fail('voice', `whisper.cpp fails: ${error.message}`);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
  const records = voice.record ? 'your record command' : recorder[0];
  const speaks = speech ? `, and \`${speech}\` reads answers aloud when you are away` : '';
  return ok('voice', `${records} records, whisper.cpp hears a second in ${seconds(Date.now() - started)} on the CPU${speaks}`);
}

/**
 * Whether the login or key a model entry needs is there and, for a subscription, still renews: `{error}` with the fix
 * when not, else `{note}` on the login, with `subscription` for a subscription's (nothing for an entry with its own key
 * or none).
 */
export async function loginCheck(entry, models, credentials) {
  const id = entry.provider ?? entry.auth;
  if (!id) return {};
  const relogin = `run \`pair auth login ${id}\``;
  const stored = await credentials.read(id);
  if (entry.auth) return stored?.type === 'api_key' ? {} : {error: `no key stored as "${id}": ${relogin}`};
  if (!stored) return (await models.checkAuth(id)) ? {} : {error: `no login or key for ${id}: ${relogin}`};
  if (stored.type !== 'oauth') return {note: 'key stored'};
  try {
    await models.getAuth(id); // renews an expired token, as the daemon would
  } catch (error) {
    return {error: `the ${id} login has expired or was revoked (${error.message}): ${relogin} again`};
  }
  const subscription = Boolean(knownProviders().get(id)?.auth.oauth?.isSubscription);
  return {note: credentialState(await credentials.read(id)), subscription};
}

/** A warning for a Watcher on a subscription: it would spend the plan fast, and the plan's terms may not allow it. */
export function subscriptionCheck(name, entry) {
  return warn(name, `the Watcher runs on your ${entry.provider} subscription: it asks about every candidate remark, which spends the plan's `
    + 'shared limits fast, and the plan\'s terms may not allow it (docs/config.md, "Before you use a subscription"). '
    + 'Give the Watcher a local or pay-per-use model');
}

/** The model ids an OpenAI-compatible server lists (null when it does not list), or `{error}` when it does not answer. */
async function listedModels(entry) {
  try {
    const listed = await listModels(entry, {timeoutMs: 5000});
    return {ids: listed?.map(model => model.id) ?? null}; // some servers do not list; the probe tells
  } catch (error) {
    return {error: error.cause?.code ?? error.cause?.message ?? error.message};
  }
}

async function* modelChecks(config, status, credentials) {
  let pairModels;
  try {
    pairModels = createPairModels(config, {credentials});
  } catch (error) {
    yield fail('models', error.message);
    return;
  }
  const {watcher, partner} = config.models;
  const shared = sameModel(watcher, partner);
  const answered = new Set();
  for (const role of shared ? ['watcher'] : ['watcher', 'partner']) {
    const name = shared ? 'models' : role;
    const entry = config.models[role];
    const where = whereIs(entry);
    if (entry.api === 'openai') {
      const listed = await listedModels(entry);
      if (listed.error) { yield fail(name, `nothing answers at ${entry.baseUrl} (${listed.error}): is the server running?`); continue; }
      if (listed.ids && !listed.ids.includes(entry.model)) {
        yield fail(name, `the server at ${entry.baseUrl} does not serve "${entry.model}"; it lists: ${listed.ids.join(', ') || 'nothing'}`);
        continue;
      }
    }
    const login = await loginCheck(entry, pairModels.models, credentials);
    if (login.error) { yield fail(name, `${where}: ${login.error}`); continue; }
    const probe = await probeModel(pairModels.models, pairModels[role]);
    if (!probe.ok) { yield fail(name, `${where} fails: ${probe.error}`); continue; }
    answered.add(role);
    const limit = role === 'watcher' ? WATCHER_MS : PARTNER_MS;
    if (probe.ms > limit) {
      yield warn(name, role === 'watcher'
        ? `${where} answers, but takes ${seconds(probe.ms)}: the Watcher scores every candidate remark and should take about 1 s. Use a smaller model, or set "reasoning": true if it thinks by default`
        : `${where} answers, but takes ${seconds(probe.ms)} for one word`);
    } else {
      yield ok(name, `${where} answers in ${seconds(probe.ms)}${login.note ? `; ${login.note}` : ''}`);
    }
    if (role === 'watcher' && login.subscription) yield subscriptionCheck(name, entry);
    if (role === 'watcher' && probe.thought) {
      yield warn(name, `${where} thinks although the Watcher's thinking is off, so it is slow and may give no score: set "reasoning": true `
        + 'and, on an OpenAI-compatible server, its thinking switch (`pair doctor --thinking` finds it), or use a model that does not think');
    }
    for (const seen of shared ? ['watcher', 'partner'] : [role]) {
      if (status?.models?.[seen]) yield warn(name, `the daemon still has the ${seen} as down (${status.models[seen]}); it checks again within 30 s`);
    }
    if (role === 'partner' || shared) yield* thinkingChecks(pairModels, partner);
  }
  if (sameServer(watcher, partner)) yield rolesCheck(config.models, status?.slot);
  if (shareServer(watcher, partner) && answered.size === 2) yield await swapCheck(pairModels);
  yield contextCheck(partner);
}

/**
 * How the two roles share one server, and, from the daemon's `slot` (see slot.mjs), how the Watcher fared since
 * it started.
 */
export function rolesCheck({watcher, partner}, slot) {
  const measured = slot?.scores
    ? `. Since the daemon started: ${count(slot.scores, 'score')}, ${seconds(slot.scoreMedianMs)} each (median); your questions cancelled `
      + `${count(slot.cancelled.scores, 'score')} and ${count(slot.cancelled.remarks, 'remark')} still at work`
    : '';
  if (sameModel(watcher, partner)) {
    return ok('roles', 'one model serves both: the Watcher asks it for one number without thinking, the Partner thinks. '
      + `The Watcher waits while the Partner works, and your questions go first${measured}`);
  }
  return ok('roles', `two models on one server: the Watcher waits while the Partner works. If the server holds one model at a time, `
    + `give both roles one model ("model" in the config), so it never reloads${measured}`);
}

/**
 * Two models on one server: whether it reloads when the roles switch. The Watcher is asked right after the
 * Partner (the models checks asked it last), then again: a first answer far slower than the second is a reload.
 */
export async function swapCheck({models, watcher}, probe = probeModel) {
  const after = await probe(models, watcher, {timeoutMs: 120_000});
  const again = await probe(models, watcher);
  if (!after.ok || !again.ok) return warn('swap', 'not measured: the Watcher failed when asked again');
  if (after.ms > SWAP_MS && after.ms > SWAP_FACTOR * again.ms) {
    return warn('swap', `the server reloads when the roles switch: the Watcher took ${seconds(after.ms)} right after the Partner and ${seconds(again.ms)} `
      + 'next. Give both roles one model ("model" in the config); until then the daemon sees the reloads and the Watcher uses the Partner\'s model');
  }
  return ok('swap', `no reload when the roles switch: the Watcher took ${seconds(after.ms)} right after the Partner, ${seconds(again.ms)} next`);
}

/** Whether the Partner's context window leaves its reply the room its thinking needs, and where the window comes from. */
export function contextCheck(entry) {
  const most = entry.reasoning ? mostThinking(entry.thinking) : 'off';
  const needs = replyTokens(most);
  if (entry.servedWindow && entry.contextWindow > entry.servedWindow) {
    return warn('context', `"contextWindow" is ${entry.contextWindow}, but the server serves ${entry.servedWindow}: requests fail once the conversation `
      + 'outgrows the server\'s window. Set it to what the server serves, or remove it so Pair asks the server');
  }
  if (needs > entry.maxTokens) {
    return warn('context', `the Partner's reply has room for ${entry.maxTokens} tokens, and thinking at "${most}" takes up to ${needs} with the answer, `
      + 'so its thinking is cut short: give the model more context ("contextWindow", and the server\'s own), or set "thinking" lower');
  }
  if (entry.contextWindow < SMALL_CONTEXT) {
    return warn('context', `${entry.contextWindow} tokens: the Partner's conversation is compacted every few turns; ${SMALL_CONTEXT} or more works better`);
  }
  const from = {config: 'from the config', default: 'the default: neither the config nor the server says'}[entry.windowFrom] ?? `from ${entry.windowFrom}`;
  return ok('context', `${entry.contextWindow} tokens (${from}): ${entry.maxTokens} for the Partner's reply, the rest for its conversation`);
}

/**
 * Whether the Partner thinks as configured: a model that thinks whatever it is told, one that cannot think, one whose
 * switch Pair does not know, and levels the server cannot tell apart each say so. A provider's model can think if
 * pi-ai's catalog says so, and the catalog maps its levels.
 */
async function* thinkingChecks(pairModels, entry) {
  const {models, partner: model} = pairModels;
  const levels = [...new Set(Object.values(entry.thinking))].filter(level => level !== 'off');
  if (entry.provider && !model.reasoning) {
    yield ok('thinking', `${entry.model} does not think, says pi-ai's catalog: the Partner answers without`);
    return;
  }
  if (!model.reasoning || !levels.length) {
    const probe = await probeModel(models, model);
    if (!probe.ok) return; // the models check said why
    if (!model.reasoning) {
      yield probe.thought
        ? ok('thinking', `"reasoning" is false: ${entry.model} thinks as it always does, at its own level`)
        : warn('thinking', `"reasoning" is false and ${entry.model} answered without thinking: the Partner does not think. If the model can, remove "reasoning": false`);
    } else {
      yield probe.thought
        ? warn('thinking', `${entry.model} thinks although "thinking" is off: set its server's thinking switch (\`pair doctor --thinking\` finds it), or let it think`)
        : ok('thinking', 'off for every kind of turn, as configured');
    }
    return;
  }
  const level = mostThinking(entry.thinking);
  const probe = await probeThinking(models, model, level);
  if (!probe.ok) {
    yield fail('thinking', `${entry.model} fails when asked to think (${probe.error}): for a model that cannot think, set "reasoning": false`);
    return;
  }
  if (!probe.thought) {
    yield warn('thinking', `${entry.model} answered with no thinking at "${level}": if it can think, set its server's thinking switch `
      + '(`pair doctor --thinking` finds it); if it cannot, set "reasoning": false');
    return;
  }
  yield ok('thinking', `the Partner thinks (up to "${level}"), ${seconds(probe.ms)} for a short sum`);
  const same = (await levelGroups(models, model, levels)).find(group => group.length > 1);
  if (same) {
    const names = same.map(name => `"${name}"`).join(', ');
    yield entry.provider
      ? ok('thinking', `${names} are one level for ${entry.model} (pi-ai's catalog maps them so)`)
      : warn('thinking', `${names} send ${entry.model} the same request, so thinking is only on or off: `
        + '`pair doctor --thinking` finds the field its server takes a level in, and prints the "compat" to paste');
  }
}
