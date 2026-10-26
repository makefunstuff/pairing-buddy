// The long-lived daemon: one Unix socket for Neovim, the chat pane and the shell hook; one session per project,
// shared by every Neovim and chat pane open in it.
import {chmodSync, mkdirSync, unlinkSync} from 'node:fs';
import {realpath} from 'node:fs/promises';
import {createServer} from 'node:net';
import {basename, join, sep} from 'node:path';
import {gitBranch, gitRoot} from './git.mjs';
import {ModelHealth} from './health.mjs';
import {PaneWatch} from './herdr.mjs';
import {followLoaded, shareServer} from './loaded-model.mjs';
import {createPairModels} from './models.mjs';
import {acquireOwner} from './owner.mjs';
import {openPartner} from './partner.mjs';
import {probeModel} from './probe.mjs';
import {readMessages, sendMessage} from './protocol.mjs';
import {ScoutPane} from './scout-pane.mjs';
import {PairSession} from './session.mjs';
import {openStore} from './store.mjs';
import {ROLE_TOOLS, ROLES} from './tools.mjs';
import {VERSION} from './version.mjs';
import {createWatcher} from './watcher.mjs';

const EDITOR_REPLY_MS = 2000;
const TICK_MS = 1000;
// While the user works, the Watcher's model is asked at least this often, so a server that unloads idle models
// (often after 5 min) still has it loaded when a remark is worth scoring.
const KEEP_WARM_MS = 4 * 60_000;
const MODEL_NAMES = {watcher: 'Watcher', partner: 'Partner'};

/** What the chat says when a model goes down (`reason`) or answers again (null). */
export function healthNote(role, reason) {
  return reason
    ? `The ${MODEL_NAMES[role]} model is not answering (${reason}). Pair stays quiet until it answers again; \`pair doctor\` checks it.`
    : `The ${MODEL_NAMES[role]} model answers again.`;
}

const timestamp = () => new Date().toTimeString().slice(0, 8);
const defaultLog = line => process.stderr.write(`${timestamp()} ${line}\n`);

/** `probe(role)` checks that a model answers (see probe.mjs); tests pass their own, and a short `keepWarmMs`. */
export async function startDaemon(config, {pairModels = createPairModels(config), probe, log = defaultLog, keepWarmMs = KEEP_WARM_MS} = {}) {
  mkdirSync(config.dataDir, {recursive: true, mode: 0o700});
  const owner = acquireOwner(config.dataDir);
  const store = openStore(join(config.dataDir, 'sessions.sqlite'));
  const sessions = new Map(); // root -> Promise<PairSession>
  const live = new Map(); // root -> PairSession, once loaded
  const watches = new Map(); // root -> PaneWatch
  const clients = new Set();
  const replies = new Map();
  let nextRequest = 0;
  const startedAt = Date.now();

  // Two models on one server: the Watcher follows what the server has loaded (see loaded-model.mjs).
  const chooseWatcherModel = shareServer(config.models.watcher, config.models.partner)
    ? followLoaded({entries: config.models, watcher: pairModels.watcher, partner: pairModels.partner, log})
    : async () => pairModels.watcher;
  const modelOf = role => (role === 'watcher' ? chooseWatcherModel() : pairModels.partner);

  const health = new ModelHealth({
    probe: probe ?? (async role => probeModel(pairModels.models, await modelOf(role))),
    onChange(role, reason) {
      log(reason ? `${role} model down: ${reason}` : `${role} model answers again`);
      for (const client of clients) {
        if (client.role) sendMessage(client.socket, {type: 'health', models: health.snapshot(), text: healthNote(role, reason)});
      }
    },
  });
  /** `promise`, reported to the health of `role`'s model as it settles. */
  const reported = (role, promise) => promise.then(
    value => { health.report(role); return value; },
    error => { health.report(role, error.message); throw error; },
  );

  const sessionOfConversation = id => [...live.values()].find(session => session.conversationId === id);
  const hand = name => (conversationId, args) => {
    const session = sessionOfConversation(conversationId);
    if (!session) throw new Error('This pairing session has ended');
    return session[name](args);
  };
  const partner = await openPartner({
    storage: join(config.dataDir, 'partner.sqlite'),
    models: pairModels.models,
    model: pairModels.partner,
    thinking: config.models.partner.thinking,
    hands: {
      ...Object.fromEntries(ROLE_TOOLS.driver.map(name => [name, hand(name)])), // the Driver has every tool
      roleOf: conversationId => sessionOfConversation(conversationId)?.role ?? 'navigator',
    },
  });
  const scoreRemark = createWatcher({models: pairModels.models, model: pairModels.watcher, chooseModel: chooseWatcherModel});
  const score = async (trigger, state) => {
    const result = await scoreRemark(trigger, state);
    health.report('watcher', result.error);
    return result;
  };
  const sessionPartner = {...partner, ask: (conversationId, content) => reported('partner', partner.ask(conversationId, content))};

  const clientsOf = (session, role) => [...clients].filter(client => client.session === session && client.role === role);
  /** The Neovims attached to `session`, the one the user used last first. */
  const editorsOf = session => clientsOf(session, 'editor').sort((a, b) => b.activeAt - a.activeAt);

  /**
   * Sends `message` to the clients of `session` named by `to`: "chat", all "editors", or the "editor" the user
   * used last (so with two Neovims open in one project, a point shows in the one you are working in).
   * Returns how many got it.
   */
  function notify(session, to, message) {
    const targets = to === 'chat' ? clientsOf(session, 'chat') : editorsOf(session).slice(0, to === 'editors' ? undefined : 1);
    for (const client of targets) sendMessage(client.socket, message);
    return targets.length;
  }

  function askEditor(editor, message) {
    const id = ++nextRequest;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { replies.delete(id); reject(new Error('The editor did not reply')); }, EDITOR_REPLY_MS);
      replies.set(id, result => { clearTimeout(timer); resolve(result); });
      sendMessage(editor.socket, {...message, id});
    });
  }

  /** Asks the editor the user used last; a read asks the others too until one has the file loaded. */
  async function requestEditor(session, message) {
    const editors = editorsOf(session);
    if (!editors.length) throw new Error('No editor attached');
    if (message.type !== 'read') return askEditor(editors[0], message);
    for (const editor of editors) {
      const reply = await askEditor(editor, message).catch(() => null);
      if (typeof reply?.text === 'string') return reply;
    }
    return {text: null};
  }

  async function refreshBranch(session) {
    const name = await gitBranch(session.root);
    if (name) session.receive({kind: 'branch', name});
  }

  /** The project a working directory belongs to: an open session containing it, else its git root, else itself. */
  async function rootOf(cwd) {
    const dir = await realpath(cwd ?? process.cwd());
    const open = [...sessions.keys()].find(root => dir === root || dir.startsWith(root + sep));
    return open ?? (await gitRoot(dir)) ?? dir;
  }

  function loadSession(root) {
    if (sessions.has(root)) return sessions.get(root);
    const loading = (async () => {
      const record = store.activeSession(root)
        ?? store.createSession({root, conversationId: await partner.createConversation(), goal: null, level: config.level, at: Date.now()});
      const session = new PairSession({
        record, store, partner: sessionPartner, score, health,
        previousNote: store.previousNote(root, record.id),
        autoTune: config.autoTune,
        typingPauseMs: config.typingPauseMs,
        notify: (role, message) => notify(session, role, message),
        requestEditor: message => requestEditor(session, message),
        log: line => log(`[${basename(root)}] ${line}`),
      });
      // A stored conversation gets the model now in the config, and one from v0.1, which had no roles, its role's tools.
      await session.configurePartner(session.role);
      live.set(root, session);
      refreshBranch(session);
      return session;
    })();
    sessions.set(root, loading);
    return loading;
  }

  function receive(session, event) {
    session.receive(event);
    if (event.kind === 'command_end') refreshBranch(session);
  }

  function watchHerdr(session, herdr) {
    if (watches.has(session.root) || !herdr?.socket) return;
    const sessionLog = line => log(`[${basename(session.root)}] ${line}`);
    session.scout = new ScoutPane({socketPath: herdr.socket, workspaceId: herdr.workspace, besidePane: herdr.pane, cwd: session.root, log: sessionLog});
    const watch = new PaneWatch({
      socketPath: herdr.socket,
      workspaceId: herdr.workspace,
      chatPane: herdr.pane,
      scout: session.scout,
      emit: event => receive(session, event),
      log: sessionLog,
    });
    session.panes = watch;
    watches.set(session.root, watch);
    watch.start();
    log(`[${basename(session.root)}] watching herdr workspace ${herdr.workspace}`);
  }

  async function endSession(session) {
    await session.end();
    watches.get(session.root)?.stop();
    watches.delete(session.root);
    sessions.delete(session.root);
    live.delete(session.root);
    for (const client of clients) {
      if (client.session !== session) continue;
      sendMessage(client.socket, {type: 'ended'});
      client.session = null;
    }
  }

  async function hello(client, message) {
    client.role = message.role;
    client.activeAt = Date.now();
    client.session = await loadSession(await rootOf(message.cwd));
    const {session} = client;
    sendMessage(client.socket, {
      type: 'welcome', root: session.root, goal: session.state.goal, level: session.budget.level, role: session.role, models: health.snapshot(),
    });
    if (client.role !== 'chat') return;
    watchHerdr(session, message.herdr);
    // A chat pane that reconnects after a daemon restart already shows the history.
    if (message.resume) return;
    const history = store.messages(session.id);
    for (const old of history) sendMessage(client.socket, {type: 'message', history: true, ...old});
    if (!history.length) session.greet();
  }

  /** What `pair doctor` asks the daemon. */
  function status() {
    return {
      type: 'status',
      version: VERSION,
      pid: process.pid,
      startedAt,
      models: health.snapshot(),
      sessions: [...live.values()].map(session => ({
        root: session.root,
        role: session.role,
        goal: session.state.goal,
        editors: editorsOf(session).length,
        chats: clientsOf(session, 'chat').length,
        herdr: watches.has(session.root),
      })),
    };
  }

  /** A command the shell hook saw end, with its exit code. Ignored when its project has no session. */
  async function shellCommand(message) {
    const session = live.get(await rootOf(message.cwd));
    if (!session) return;
    const watch = watches.get(session.root);
    watch?.markHooked(message.pane);
    const output = watch && message.pane ? await watch.output(message.pane, message.cmd).catch(() => '') : '';
    receive(session, {kind: 'command_end', pane: message.pane ?? null, cmd: message.cmd, exit: message.exit, output});
  }

  async function handle(client, message) {
    if (message.type === 'hello') return (client.ready = hello(client, message));
    if (message.type === 'status') return sendMessage(client.socket, status());
    if (message.type === 'command') return shellCommand(message);
    if (message.type === 'reply') return replies.get(message.id)?.(message.result);
    // A client may send right after its hello; wait until the hello has found its session.
    await client.ready;
    const {session} = client;
    if (!session) return sendMessage(client.socket, {type: 'message', sender: 'system', text: 'No active session; send hello first', at: Date.now()});
    // What you do in a Neovim makes it the one Pair shows things in; its LSP's diagnostics do not.
    if (client.role === 'editor' && message.event?.kind !== 'diagnostics') client.activeAt = Date.now();
    if (message.type === 'event') return receive(session, message.event);
    if (message.type === 'ask') return session.ask(message.text);
    if (message.type === 'goal') return session.setGoal(message.text);
    if (message.type === 'level') return session.setLevel(message.level);
    if (message.type === 'role' && ROLES.includes(message.role)) return session.setRole(message.role);
    if (message.type === 'drive') return session.drive(message.text ?? '');
    if (message.type === 'take_back') return session.takeBack();
    if (message.type === 'confirm') return session.answer(message.id, message.ok === true);
    if (message.type === 'feedback') return session.feedback({useful: message.useful === true, id: message.remark ?? undefined, implicit: message.implicit === true});
    if (message.type === 'end') return endSession(session);
  }

  const server = createServer(socket => {
    const client = {socket, role: null, session: null, activeAt: 0, ready: Promise.resolve()};
    clients.add(client);
    socket.on('close', () => clients.delete(client));
    socket.on('error', () => {});
    readMessages(socket, message => handle(client, message).catch(error => {
      log(`${message.type} failed: ${error.stack ?? error}`);
      sendMessage(socket, {type: 'message', sender: 'system', text: `Error: ${error.message}`, at: Date.now()});
    }));
  });

  // The owner lock is held, so a socket file left behind is from a daemon that died.
  try { unlinkSync(config.socket); } catch {}
  await new Promise((resolve, reject) => server.once('error', reject).listen(config.socket, resolve));
  chmodSync(config.socket, 0o600);

  /** Keeps the Watcher's model loaded while someone works, unless it is down: then the health probe checks it. */
  function keepWarm() {
    const now = Date.now();
    if (!config.keepWarm || now - scoreRemark.lastCallAt < keepWarmMs || !health.ok('watcher')) return;
    if (![...live.values()].some(session => session.active(now))) return;
    scoreRemark.warm().then(result => health.report('watcher', result.error));
  }

  const ticker = setInterval(() => {
    for (const session of live.values()) session.tick().catch(error => log(`tick failed: ${error.stack ?? error}`));
    keepWarm();
  }, TICK_MS);

  health.start();
  log(`pair daemon ${VERSION} listening on ${config.socket}`);

  return {
    async close() {
      clearInterval(ticker);
      health.stop();
      for (const watch of watches.values()) watch.stop();
      for (const client of clients) client.socket.destroy();
      await new Promise(resolve => server.close(resolve));
      await partner.close();
      store.close();
      owner.release();
    },
  };
}
