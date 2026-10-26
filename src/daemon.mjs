// The long-lived daemon: one Unix socket for Neovim, the chat pane and the shell hook; one session per project.
import {chmodSync, mkdirSync, unlinkSync} from 'node:fs';
import {realpath} from 'node:fs/promises';
import {createServer} from 'node:net';
import {basename, join, sep} from 'node:path';
import {gitBranch, gitRoot} from './git.mjs';
import {PaneWatch} from './herdr.mjs';
import {createPairModels} from './models.mjs';
import {acquireOwner} from './owner.mjs';
import {openPartner} from './partner.mjs';
import {readMessages, sendMessage} from './protocol.mjs';
import {PairSession} from './session.mjs';
import {openStore} from './store.mjs';
import {createWatcher} from './watcher.mjs';

const EDITOR_REPLY_MS = 2000;
const TICK_MS = 1000;

const timestamp = () => new Date().toTimeString().slice(0, 8);
const defaultLog = line => process.stderr.write(`${timestamp()} ${line}\n`);

export async function startDaemon(config, {pairModels = createPairModels(config), log = defaultLog} = {}) {
  mkdirSync(config.dataDir, {recursive: true, mode: 0o700});
  const owner = acquireOwner(config.dataDir);
  const store = openStore(join(config.dataDir, 'sessions.sqlite'));
  const sessions = new Map(); // root -> Promise<PairSession>
  const live = new Map(); // root -> PairSession, once loaded
  const watches = new Map(); // root -> PaneWatch
  const clients = new Set();
  const replies = new Map();
  let nextRequest = 0;

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
    hands: {say: hand('say'), point: hand('point'), open: hand('open'), read: hand('read')},
  });
  const score = createWatcher({models: pairModels.models, model: pairModels.watcher});

  function notify(session, role, message) {
    for (const client of clients) if (client.session === session && client.role === role) sendMessage(client.socket, message);
  }

  function requestEditor(session, message) {
    const editor = [...clients].find(client => client.session === session && client.role === 'editor');
    if (!editor) return Promise.reject(new Error('No editor attached'));
    const id = ++nextRequest;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { replies.delete(id); reject(new Error('The editor did not reply')); }, EDITOR_REPLY_MS);
      replies.set(id, result => { clearTimeout(timer); resolve(result); });
      sendMessage(editor.socket, {...message, id});
    });
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
        record, store, partner, score,
        typingPauseMs: config.typingPauseMs,
        notify: (role, message) => notify(session, role, message),
        requestEditor: message => requestEditor(session, message),
        log: line => log(`[${basename(root)}] ${line}`),
      });
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
    const watch = new PaneWatch({
      socketPath: herdr.socket,
      workspaceId: herdr.workspace,
      chatPane: herdr.pane,
      emit: event => receive(session, event),
      log: line => log(`[${basename(session.root)}] ${line}`),
    });
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
    client.session = await loadSession(await rootOf(message.cwd));
    const {session} = client;
    sendMessage(client.socket, {type: 'welcome', root: session.root, goal: session.state.goal, level: session.budget.level});
    if (client.role !== 'chat') return;
    watchHerdr(session, message.herdr);
    const history = store.messages(session.id);
    for (const old of history) sendMessage(client.socket, {type: 'message', history: true, ...old});
    if (!history.length) session.greet();
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
    if (message.type === 'command') return shellCommand(message);
    if (message.type === 'reply') return replies.get(message.id)?.(message.result);
    // A client may send right after its hello; wait until the hello has found its session.
    await client.ready;
    const {session} = client;
    if (!session) return sendMessage(client.socket, {type: 'message', sender: 'system', text: 'No active session; send hello first', at: Date.now()});
    if (message.type === 'event') return receive(session, message.event);
    if (message.type === 'ask') return session.ask(message.text);
    if (message.type === 'goal') return session.setGoal(message.text);
    if (message.type === 'level') return session.setLevel(message.level);
    if (message.type === 'end') return endSession(session);
  }

  const server = createServer(socket => {
    const client = {socket, role: null, session: null, ready: Promise.resolve()};
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

  const ticker = setInterval(() => {
    for (const session of live.values()) session.tick().catch(error => log(`tick failed: ${error.stack ?? error}`));
  }, TICK_MS);

  log(`pair daemon listening on ${config.socket}`);

  return {
    async close() {
      clearInterval(ticker);
      for (const watch of watches.values()) watch.stop();
      for (const client of clients) client.socket.destroy();
      await new Promise(resolve => server.close(resolve));
      await partner.close();
      store.close();
      owner.release();
    },
  };
}
