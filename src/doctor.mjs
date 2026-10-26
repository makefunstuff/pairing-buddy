// `pair doctor`: checks each part Pair needs, one line each, and says what is wrong in plain words.
import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, delimiter, join} from 'node:path';
import {credentialState} from './auth.mjs';
import {authPath, configPath, loadConfig, mostThinking} from './config.mjs';
import {fileCredentialStore, readableByOthers} from './credentials.mjs';
import {herdrRequest} from './herdr.mjs';
import {listModels} from './loaded-model.mjs';
import {createPairModels} from './models.mjs';
import {levelGroups, probeModel, probeThinking} from './probe.mjs';
import {requestDaemon} from './protocol.mjs';
import {serviceState, UNIT} from './service.mjs';
import {VERSION} from './version.mjs';

const WATCHER_MS = 1500; // the Watcher scores every candidate remark: about a second is the aim
const PARTNER_MS = 20_000;
const NVIM_MS = 10_000;
const EXAMPLE_MODELS = ['your-small-model', 'your-larger-model'];

const ok = (name, text) => ({level: 'ok', name, text});
const warn = (name, text) => ({level: 'warn', name, text});
const fail = (name, text) => ({level: 'fail', name, text});

export const tilde = path => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);
const seconds = ms => `${(ms / 1000).toFixed(1)} s`;
const onPath = (name, env) => (env.PATH ?? '').split(delimiter).some(dir => existsSync(join(dir, name)));

/** Every check, in order, as `{level: ok|warn|fail, name, text}`; yields each as soon as it is known. */
export async function* doctor({
  path = configPath(), env = process.env, service = serviceState, nvimPlugin = nvimHasPlugin, auth = authPath(), credentials = fileCredentialStore(auth),
} = {}) {
  let config;
  try {
    config = loadConfig(path);
  } catch (error) {
    yield fail('config', error.message);
    return;
  }
  const examples = Object.values(config.models).filter(entry => EXAMPLE_MODELS.includes(entry.model));
  yield examples.length
    ? warn('config', `${tilde(path)} still has the example's model names: set your models there`)
    : ok('config', tilde(path));
  yield serviceCheck(await service());
  const status = await requestDaemon(config.socket, {type: 'status'}).catch(() => null);
  yield daemonCheck(status, config);
  // A connected Neovim has the plugin; only without one is Neovim started to look (it can take seconds).
  const connected = status?.sessions.some(session => session.editors > 0);
  yield connected ? ok('plugin', 'loaded in the connected Neovims') : pluginCheck(await nvimPlugin(env));
  if (status) yield editorsCheck(status);
  yield await herdrCheck(env);
  if (existsSync(auth)) yield loginsCheck(auth);
  yield* modelChecks(config, status, credentials);
}

export function serviceCheck(state) {
  if (!state.installed) return warn('service', 'not installed: `pair setup` makes the daemon start at login and restart when it fails');
  if (state.node && !existsSync(state.node)) return fail('service', `it runs Node.js from ${tilde(state.node)}, which is gone: run \`pair setup\` again`);
  if (!state.active) return fail('service', `installed but not running: see \`journalctl --user -u ${UNIT} -n 20\`, then \`systemctl --user restart ${UNIT}\``);
  if (!state.enabled) return warn('service', `running, but it does not start at login: \`systemctl --user enable ${UNIT}\``);
  return ok('service', 'starts at login, running');
}

export function daemonCheck(status, config) {
  if (!status) return fail('daemon', `nothing answers on ${tilde(config.socket)}: run \`pair setup\`, or \`pair daemon\` in a terminal`);
  if (status.version !== VERSION) {
    return warn('daemon', `it runs version ${status.version} and this pair is ${VERSION}: \`systemctl --user restart ${UNIT}\``);
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
 * Whether the login or key a model entry needs is there and, for a subscription, still renews: `{error}` with the fix
 * when not, else `{note}` on the login (nothing for an entry with its own key or none).
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
  return {note: credentialState(await credentials.read(id))};
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
  const shared = ['provider', 'api', 'baseUrl', 'model'].every(field => watcher[field] === partner[field]);
  for (const role of shared ? ['watcher'] : ['watcher', 'partner']) {
    const name = shared ? 'models' : role;
    const entry = config.models[role];
    const where = entry.provider ? `${entry.model} on ${entry.provider}` : `${entry.model} at ${entry.baseUrl}`;
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
    const limit = role === 'watcher' ? WATCHER_MS : PARTNER_MS;
    if (probe.ms > limit) {
      yield warn(name, role === 'watcher'
        ? `${where} answers, but takes ${seconds(probe.ms)}: the Watcher scores every candidate remark and should take about 1 s. Use a smaller model, or set "reasoning": true if it thinks by default`
        : `${where} answers, but takes ${seconds(probe.ms)} for one word`);
    } else {
      yield ok(name, `${where} answers in ${seconds(probe.ms)}${login.note ? `; ${login.note}` : ''}`);
    }
    if (role === 'watcher' && probe.thought) {
      yield warn(name, `${where} thinks although the Watcher's thinking is off, so it is slow and may give no score: set "reasoning": true `
        + 'and, on an OpenAI-compatible server, "compat": {"thinkingFormat": ...} for its thinking switch, or use a model that does not think');
    }
    for (const seen of shared ? ['watcher', 'partner'] : [role]) {
      if (status?.models?.[seen]) yield warn(name, `the daemon still has the ${seen} as down (${status.models[seen]}); it checks again within 30 s`);
    }
    if (role === 'partner' || shared) yield* thinkingChecks(pairModels, partner);
  }
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
        ? warn('thinking', `${entry.model} thinks although "thinking" is off: set its server's thinking switch ("compat": {"thinkingFormat": ...}), or let it think`)
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
      + '("compat": {"thinkingFormat": ...}); if it cannot, set "reasoning": false');
    return;
  }
  yield ok('thinking', `the Partner thinks (up to "${level}"), ${seconds(probe.ms)} for a short sum`);
  const same = (await levelGroups(models, model, levels)).find(group => group.length > 1);
  if (same) {
    const names = same.map(name => `"${name}"`).join(', ');
    yield entry.provider
      ? ok('thinking', `${names} are one level for ${entry.model} (pi-ai's catalog maps them so)`)
      : warn('thinking', `${names} send ${entry.model} the same request, so thinking is only on or off: `
        + 'if its server takes a level, set "compat": {"supportsReasoningEffort": true} (it is then sent as reasoning_effort) '
        + 'or {"thinkingTokenBudgetField": "<the server\'s field>"} (a token budget)');
  }
}
