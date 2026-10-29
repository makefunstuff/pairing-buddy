// The long-lived daemon: one Unix socket for Neovim, the chat pane and the shell hook; one session per project,
// shared by every Neovim and chat pane open in it.
import {chmodSync, mkdirSync, unlinkSync} from 'node:fs';
import {realpath} from 'node:fs/promises';
import {createServer} from 'node:net';
import {basename, join, resolve} from 'node:path';
import {AgentRelay, itemName} from './agent-relay.mjs';
import {AgentBoard, STATUSES} from './agents.mjs';
import {oneAtATime} from './config.mjs';
import {goalFromContext, SOURCES} from './context-card.mjs';
import {loadSizedConfig} from './context-window.mjs';
import {byUse, herdrFocus, noteEditor} from './editors.mjs';
import {expireTries} from './gen-tree.mjs';
import {gitRoot, repoNames} from './git.mjs';
import {createDecider, DecisionModel} from './decision.mjs';
import {MODEL_ROLES, ModelHealth} from './health.mjs';
import {NoteMargin} from './margin.mjs';
import {oneAnswer} from './note-reading.mjs';
import {HerdrPanes} from './herdr.mjs';
import {followLoaded, shareServer} from './loaded-model.mjs';
import {DETAIL_KEPT_MS} from './ledger.mjs';
import {Listener} from './listen.mjs';
import {createDecisionModel, createPairModels} from './models.mjs';
import {acquireOwner} from './owner.mjs';
import {EditorPaneHost, HerdrPaneHost} from './pane-hosts.mjs';
import {Panes, PaneWatch} from './pane-watch.mjs';
import {NvimPanes} from './nvim-panes.mjs';
import {openPartner} from './partner.mjs';
import {Pace} from './pace.mjs';
import {probeModel} from './probe.mjs';
import {projectContext} from './project-context.mjs';
import {readMessages, sendMessage} from './protocol.mjs';
import {configChanges, RESTART_FIELDS, watchConfig} from './reload.mjs';
import {rememberScores} from './score-memory.mjs';
import {ScoutPane} from './scout-pane.mjs';
import {PairSession} from './session.mjs';
import {openRootOf, sessionRootOf} from './session-root.mjs';
import {ModelSlot} from './slot.mjs';
import {openStore} from './store.mjs';
import {Terminals} from './terminals.mjs';
import {TmuxPanes, tmuxPane} from './tmux.mjs';
import {ALL_TOOLS, ROLES} from './tools.mjs';
import {VERSION} from './version.mjs';
import {createWatcher, momentOf} from './watcher.mjs';

const EDITOR_REPLY_MS = 2000;
const EDIT_REPLY_MS = 30_000; // Neovim replies to the Driver's edit once it has typed it
const TICK_MS = 1000;
// While the user works, the Watcher's model is asked at least this often, so a server that unloads idle models
// (often after 5 min) still has it loaded when a remark is worth scoring.
const KEEP_WARM_MS = 4 * 60_000;
const MODEL_NAMES = {watcher: 'Watcher', partner: 'Partner'};
// A session ends by itself, with its note, after this long without the user, or once its last Neovim and chat pane
// have been closed this long (a Neovim restarted at once keeps it).
const IDLE_END_MS = 45 * 60_000;
const ALONE_END_MS = 60_000;
const CONTEXT_EVERY_MS = 60_000; // git and the board are read again this often, and when a command ends
const CONTEXT_FRESH_MS = 5000; // the context card reads them again when they are older than this

/** What the chat says when the decision model goes down (`reason`) or answers again (null). */
export function decisionNote(reason) {
  return reason
    ? `The decision model is not answering (${reason}). Pair decides by its own rules until it answers again; \`pair doctor\` checks it.`
    : 'The decision model answers again.';
}

/** What the chat says when a model goes down (`reason`) or answers again (null). */
export function healthNote(role, reason) {
  return reason
    ? `The ${MODEL_NAMES[role]} model is not answering (${reason}). Pair stays quiet until it answers again; \`pair doctor\` checks it.`
    : `The ${MODEL_NAMES[role]} model answers again.`;
}

const timestamp = () => new Date().toTimeString().slice(0, 8);
const defaultLog = line => process.stderr.write(`${timestamp()} ${line}\n`);

/**
 * `probe(role)` checks that a model answers (see probe.mjs); tests pass their own, a short `keepWarmMs`, and a short
 * `agentsPollMs` for the agent relay's board and herdr. With `configFile`, the daemon takes changes to it as they are
 * saved (see reload.mjs); `modelsFor(config)` builds the models of a config, at start and after a change, and
 * `decisionFor(config)` its decision model (`{models, model}`, or null; see decision.mjs).
 */
export async function startDaemon(config, {
  configFile = null, modelsFor = createPairModels, pairModels = modelsFor(config), decisionFor = createDecisionModel, probe, log = defaultLog, keepWarmMs = KEEP_WARM_MS,
  idleEndMs = IDLE_END_MS, aloneEndMs = ALONE_END_MS, agentsPollMs,
} = {}) {
  mkdirSync(config.dataDir, {recursive: true, mode: 0o700});
  mkdirSync(join(config.dataDir, 'runs'), {recursive: true}); // the output of the tests run on save, one file per session
  mkdirSync(join(config.dataDir, 'gen'), {recursive: true}); // /gen's folders: the tries, writable in the pane's sandbox
  expireTries(join(config.dataDir, 'gen'), config.gen.keepTries).catch(() => {}); // and a new request of a try expires them again
  const owner = acquireOwner(config.dataDir);
  const store = openStore(join(config.dataDir, 'sessions.sqlite'));
  store.forgetActionDetails(Date.now() - DETAIL_KEPT_MS);
  const sessions = new Map(); // root -> Promise<PairSession>
  const live = new Map(); // root -> PairSession, once loaded
  const margins = new Map(); // root -> its NoteMargin
  const watches = new Map(); // root -> PaneWatch
  const paneSources = new Map(); // root -> what its PaneWatch watches: {herdr, tmux, chatPane}
  const listeners = new Map(); // root -> Listener, once someone holds the listen key there
  const relays = new Map(); // root -> AgentRelay
  const clients = new Set();
  const replies = new Map();
  let nextRequest = 0;
  const startedAt = Date.now();

  // Both roles on one server of your own, which may answer one request at a time: the slot puts their requests in order.
  const slot = new ModelSlot({exclusive: oneAtATime(config.models.watcher, config.models.partner)});
  // How long the Watcher's calls take, and what Pair asks about while they take long (see pace.mjs).
  const pace = new Pace({on: config.watcherPace ?? true, log});
  let models; // what the daemon builds on the config's models (see buildModels); a config change rebuilds it
  let rebuilt = Promise.resolve(); // a rebuild of the models under way, which a Partner turn waits for
  const modelOf = role => (role === 'watcher' ? models.chooseWatcherModel() : models.pairModels.partner);

  const health = new ModelHealth({
    probe: probe ?? (async role => probeModel(models.pairModels.models, await modelOf(role))),
    onChange(role, reason) {
      log(reason ? `${role} model down: ${reason}` : `${role} model answers again`);
      for (const client of clients) {
        if (client.role) sendMessage(client.socket, {type: 'health', models: health.snapshot(), text: healthNote(role, reason)});
      }
    },
  });
  /**
   * The gate's decision model, as the config sets it (null without one). Down or slow, it says so once and the gate
   * goes by its own rules until a probe finds it answering again.
   */
  let decision = null;
  function useDecision(built) {
    decision?.stop();
    decision = built && new DecisionModel({
      ask: createDecider({models: built.models, model: built.model, timeoutMs: config.decision.timeoutMs}),
      log,
      onChange(reason) {
        log(reason ? `decision model down: ${reason}` : 'decision model answers again');
        for (const client of clients) {
          if (client.role) sendMessage(client.socket, {type: 'health', models: health.snapshot(), text: decisionNote(reason)});
        }
      },
    });
  }
  useDecision(decisionFor(config));

  /** `promise`, reported to the health of `role`'s model as it settles. */
  const reported = (role, promise) => promise.then(
    value => { health.report(role); return value; },
    error => { health.report(role, error.message); throw error; },
  );

  // Your other agents, read from the board and herdr; each session relays their news at its breakpoints.
  const agents = config.agents
    ? new AgentBoard({board: config.board, pollMs: agentsPollMs, log, wanted: () => [...clients].some(client => client.session), onChange: change => { for (const relay of relays.values()) relay.hear(change); }})
    : null;

  // A session's own conversation, or one of its /gen requests' (see gen.mjs).
  const sessionOfConversation = id => [...live.values()].find(session => session.owns(id));
  const hand = name => (conversationId, args) => {
    const session = sessionOfConversation(conversationId);
    if (!session) throw new Error('This pairing session has ended');
    return session.useTool(name, args, conversationId);
  };

  let partnerAsked = false; // since the Watcher's last call: its next call may find the Partner's model loaded
  const deferred = {deferred: true, reason: 'the Partner has the model'};

  /** The Watcher's scoring and the Partner on `pairModels`, as the config sets them. */
  async function buildModels(pairModels) {
    // Two models on one server: the Watcher follows what the server has loaded (see loaded-model.mjs).
    const chooseWatcherModel = shareServer(config.models.watcher, config.models.partner)
      ? followLoaded({entries: config.models, watcher: pairModels.watcher, partner: pairModels.partner, log})
      : async () => pairModels.watcher;
    slot.exclusive = oneAtATime(config.models.watcher, config.models.partner);
    const partner = await openPartner({
      storage: join(config.dataDir, 'partner.sqlite'),
      models: pairModels.models,
      model: pairModels.partner,
      thinking: config.models.partner.thinking,
      backgroundCompaction: !slot.exclusive,
      hands: {
        ...Object.fromEntries(ALL_TOOLS.map(name => [name, hand(name)])),
        roleOf: conversationId => sessionOfConversation(conversationId)?.roleOf(conversationId) ?? 'navigator',
      },
    });
    const scoreRemark = createWatcher({models: pairModels.models, model: pairModels.watcher, chooseModel: chooseWatcherModel});
    // Scores are remembered for these models only: other models may score the same moment otherwise.
    const remembered = rememberScores(async (trigger, state) => {
      const afterPartner = partnerAsked;
      const started = Date.now();
      const result = await slot.watch(signal => scoreRemark(trigger, state, {signal}));
      if (!result) return deferred;
      partnerAsked = false;
      const ms = Date.now() - started;
      chooseWatcherModel.timed?.(ms, afterPartner);
      pace.hear(ms);
      health.report('watcher', result.error);
      return result;
    }, {momentOf});
    return {pairModels, chooseWatcherModel, partner, scoreRemark, remembered};
  }
  models = await buildModels(pairModels);

  // A remembered score waits for the Partner too: on one server the remark it lets through would queue behind it.
  const score = (trigger, state) => (slot.exclusive && slot.busy() ? deferred : models.remembered(trigger, state));
  // The sessions' Partner: always the one on the config's models, its turns put in order by the slot.
  const sessionPartner = {
    createConversation: () => models.partner.createConversation(),
    setRole: (...args) => models.partner.setRole(...args),
    thinkingOf: (...args) => models.partner.thinkingOf(...args),
    cancel: conversationId => slot.cancel(conversationId),
    // The user stops their own question's turn: the slot cancels only remarks, so this goes to the Partner itself.
    stop: conversationId => models.partner.cancel(conversationId),
    modelName: () => models.pairModels.partner.name ?? models.pairModels.partner.id,
    ask: async (conversationId, content, options) => {
      await rebuilt;
      const {partner} = models;
      return slot.turn(
        {
          conversation: conversationId,
          asked: options?.kind !== 'remark',
          cancel: () => partner.cancel(conversationId).catch(error => log(`cancelling a remark failed: ${error.message}`)),
        },
        () => { partnerAsked = true; return reported('partner', partner.ask(conversationId, content, options)); },
      );
    },
    finish: (conversationId, submissionId) => slot.turn(
      {conversation: conversationId, asked: true, cancel: () => {}},
      () => reported('partner', models.partner.finish(conversationId, submissionId)),
    ),
  };

  /**
   * The Partner's model reads a note, outside its conversation, in the slot like a turn: a reading nobody `asked`
   * for gives way to the user's questions, and its cancel is no sign that the model is down.
   */
  function askNoteModel(systemPrompt, content, {asked = false} = {}) {
    const controller = new AbortController();
    const read = () => oneAnswer({models: models.pairModels.models, model: models.pairModels.partner, signal: controller.signal}, systemPrompt, content).then(
      text => { health.report('partner'); return text; },
      error => { if (!controller.signal.aborted) health.report('partner', error.message); throw error; },
    );
    return slot.turn({conversation: null, asked, cancel: async () => controller.abort()}, read);
  }

  /**
   * Builds the models of the config anew, between the Partner's turns: it waits for the turns at work, and turns
   * that start meanwhile wait for it. Each session's conversation then gets the new model.
   */
  function rebuildModels(pairModels) {
    rebuilt = (async () => {
      do await new Promise(resolve => setTimeout(resolve, 50)); while (slot.busy());
      await models.partner.close(); // its SQLite file is the new Partner's
      models = await buildModels(pairModels);
      await models.partner.resume();
      for (const session of live.values()) await session.configurePartner(session.role);
      health.check(MODEL_ROLES);
    })();
    return rebuilt;
  }

  // The config as last saved: a change is told against it, so a socket or dataDir that waits for a restart is told once.
  let saved = config;

  /** Says `text` in every chat pane and Neovim, as a line from the system. */
  function tellAll(text) {
    for (const client of clients) {
      if (client.role) sendMessage(client.socket, {type: 'message', sender: 'system', text, at: Date.now()});
    }
  }

  /**
   * Takes a changed config: new sessions get all of it; the open ones get the typing pause, auto-tuning, tests on
   * save, voice, the task command and the board at once, and the models between turns. The socket, the data directory
   * and turning the agent relay on or off wait for a restart.
   */
  async function reload(next) {
    const changed = configChanges(saved, next);
    if (!changed.length) return;
    let nextModels = null;
    let nextDecision = null;
    try {
      if (changed.includes('models')) nextModels = modelsFor(next);
      if (changed.includes('decision')) nextDecision = decisionFor(next);
    } catch (error) {
      return refuse(error.message);
    }
    saved = next;
    config = {...next, socket: config.socket, dataDir: config.dataDir, agents: config.agents};
    if (changed.includes('decision')) {
      useDecision(nextDecision);
      decision?.start();
    }
    pace.on = config.watcherPace ?? true;
    for (const session of live.values()) {
      session.typingPauseMs = config.typingPauseMs;
      session.autoTune = config.autoTune;
      session.setTestOnSave(testOnSaveOf(session.root, session.id));
      session.gen.limits = config.gen.limits; // a request already running keeps the limits it started with
      session.gen.briefName = config.gen.brief;
      Object.assign(session.gen, {keepTries: config.gen.keepTries, network: config.gen.network, sandbox: config.scoutPane.sandbox, scaffold: config.gen.scaffold, board: config.board});
      Object.assign(margins.get(session.root) ?? {}, {typingPauseMs: config.typingPauseMs, taskCommand: config.taskCommand});
    }
    if (changed.includes('board')) {
      readContext = projectContext({board: config.board});
      if (agents) agents.board = config.board;
    }
    if (changed.includes('voice')) {
      for (const listener of listeners.values()) listener.close();
      listeners.clear();
    }
    if (nextModels) await rebuildModels(nextModels);
    const now = changed.filter(field => !RESTART_FIELDS.includes(field));
    const later = changed.filter(field => RESTART_FIELDS.includes(field));
    const notes = [
      now.length && `Config reloaded: ${now.join(', ')}.`,
      now.includes('level') && 'The talk level is for new sessions; /level sets this one\'s.',
      later.length && `${later.join(' and ')} change${later.length === 1 ? 's' : ''} only when the daemon restarts.`,
    ].filter(Boolean);
    log(`config: ${changed.join(', ')} changed`);
    tellAll(notes.join(' '));
  }

  function refuse(message) {
    log(`config not reloaded: ${message}`);
    tellAll(`The config has an error, so Pair keeps the one it runs: ${message}`);
  }

  const clientsOf = (session, role) => [...clients].filter(client => client.session === session && client.role === role);
  /** The Neovims attached to `session`, the one the user is in first (see editors.mjs). */
  const editorsOf = session => byUse(clientsOf(session, 'editor'));

  /**
   * Sends `message` to the clients of `session` named by `to`: "chat", all "editors", or the "editor" the user is
   * in (so with two Neovims open in one project, a point shows in the one you are working in).
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
      const timeoutMs = message.type === 'edit' ? EDIT_REPLY_MS : EDITOR_REPLY_MS;
      const timer = setTimeout(() => { replies.delete(id); reject(new Error('The editor did not reply')); }, timeoutMs);
      replies.set(id, result => { clearTimeout(timer); resolve(result); });
      sendMessage(editor.socket, {...message, id});
    });
  }

  /**
   * Asks the editor the user is in; a read asks the others too until one has the file loaded, and the unsaved
   * `buffers` come from all of them.
   */
  async function requestEditor(session, message) {
    const editors = editorsOf(session);
    if (!editors.length) throw new Error('No editor attached');
    if (message.type === 'buffers') {
      const replies = await Promise.all(editors.filter(editor => editor.buffers).map(editor => askEditor(editor, message).catch(() => null)));
      return {buffers: replies.flatMap(reply => (Array.isArray(reply?.buffers) ? reply.buffers : []))};
    }
    if (message.type !== 'read') return askEditor(editors[0], message);
    for (const editor of editors) {
      const reply = await askEditor(editor, message).catch(() => null);
      if (typeof reply?.text === 'string') return reply;
    }
    return {text: null};
  }

  let readContext = projectContext({board: config.board});
  const contextReads = new Map(); // session -> {at, reading}: the last read of its git and board, or the one under way

  /** What the chat's header says of the board: how many of the repo's other tasks work and need you; null without one. */
  const boardCounts = board => (board ? {space: board.space, working: board.working, needs: board.waiting.length} : null);

  /** Reads the project's git and board into the session state, unless a read is under way or `freshMs` old. */
  function refreshContext(session, freshMs = 0) {
    const last = contextReads.get(session);
    if (last && (last.reading || Date.now() - last.at < freshMs)) return last.reading ?? Promise.resolve();
    const reading = readContext(session.root)
      .then(event => {
        const before = JSON.stringify(boardCounts(session.state.board));
        session.receive(event);
        const counts = boardCounts(session.state.board);
        if (JSON.stringify(counts) !== before) notify(session, 'chat', {type: 'board', board: counts}); // the chat's header
      }, error => log(`[${basename(session.root)}] context: ${error.message}`))
      .finally(() => contextReads.set(session, {at: Date.now(), reading: null}));
    contextReads.set(session, {at: last?.at ?? 0, reading});
    return reading;
  }

  /**
   * The project a working directory belongs to: the session root the config gives it (see session-root.mjs), else
   * its git root (so a worktree inside the main checkout is a project of its own), else an open session containing
   * it, else itself.
   */
  async function rootOf(cwd) {
    const dir = await realpath(cwd ?? process.cwd());
    return sessionRootOf(dir, config.sessionRoots) ?? (await gitRoot(dir)) ?? openRootOf(dir, sessions.keys()) ?? dir;
  }

  /** The tests on save of the project at `root`, for its session `id`: `{command, timeoutMs, affected, outputFile}`, or null. */
  function testOnSaveOf(root, id) {
    return config.testOnSave[root] ? {...config.testOnSave[root], outputFile: join(config.dataDir, 'runs', `${id}.out`)} : null;
  }

  function loadSession(root) {
    if (sessions.has(root)) return sessions.get(root);
    const loading = (async () => {
      const record = store.activeSession(root)
        ?? store.createSession({root, conversationId: await sessionPartner.createConversation(), goal: null, level: config.level, at: Date.now()});
      const session = new PairSession({
        record, store, partner: sessionPartner, score, pace, health, decision: () => decision,
        previousNote: store.previousNote(root, record.id),
        lastSession: store.lastSession(root, record.id),
        autoTune: config.autoTune,
        typingPauseMs: config.typingPauseMs,
        testOnSave: testOnSaveOf(root, record.id),
        checkOutput: join(config.dataDir, 'runs', `${record.id}.check.out`), // the hand-over's check: writable in the sandbox too
        genLimits: config.gen.limits,
        genBrief: config.gen.brief,
        genDir: join(config.dataDir, 'gen'), genKeepTries: config.gen.keepTries, genNetwork: config.gen.network, genSandbox: config.scoutPane.sandbox, genScaffold: config.gen.scaffold, genBoard: config.board,
        askModel: (systemPrompt, content) => askNoteModel(systemPrompt, content, {asked: true}), // the /gen brief's checks
        notify: (role, message) => notify(session, role, message),
        requestEditor: message => requestEditor(session, message),
        log: line => log(`[${basename(root)}] ${line}`),
      });
      session.panes = new Terminals({editors: () => editorsOf(session), ask: askEditor, watch: () => watches.get(root) ?? null});
      margins.set(root, new NoteMargin({
        root,
        state: () => session.state,
        receive: event => session.receive(event),
        read: path => session.bufferText(path).catch(() => ''),
        ask: askNoteModel,
        notify: (role, message) => notify(session, role, message),
        message: (sender, text) => session.message(sender, text),
        typingPauseMs: config.typingPauseMs,
        ready: () => health.ok('partner') && !(slot.exclusive && slot.busy()),
        taskCommand: config.taskCommand,
        log: line => log(`[${basename(root)}] ${line}`),
      }));
      // A stored conversation gets the model now in the config, and one from v0.1, which had no roles, its role's tools.
      await session.configurePartner(session.role);
      live.set(root, session);
      session.repos = [...new Set([basename(root), ...await repoNames(root)])]; // the names the board may know it by
      await refreshContext(session);
      // No ceremony: a session starts with the goal of its board task, or of its branch, instead of asking.
      const goal = !session.state.goal && goalFromContext(session.state);
      if (goal) session.setGoal(goal.text, goal.from);
      if (agents) {
        const send = message => notify(session, 'editors', message) + notify(session, 'chat', message);
        const breakpoint = () => session.breakpoints.last(session.state, Date.now());
        const wait = () => session.typing() || session.busy || session.role === 'driver';
        relays.set(root, new AgentRelay({root, repos: session.repos, send, breakpoint, wait}));
      }
      return session;
    })();
    sessions.set(root, loading);
    return loading;
  }

  function receive(session, event) {
    session.receive(event);
    if (event.kind === 'command_end') refreshContext(session);
    if (event.kind === 'focus' && event.target === 'editor') herdrFocus(clientsOf(session, 'editor'), event.pane);
  }

  /** Pair's pane for `session` on `host` (pane-hosts.mjs). */
  function scoutPane(session, host) {
    return new ScoutPane({
      // The runs folder for the tests on save, and /gen's for the tries, whose runs narrow the sandbox to their own folder.
      host, cwd: session.root, runsDir: join(config.dataDir, 'panes'), setup: config.scoutPane, writable: [join(config.dataDir, 'runs'), join(config.dataDir, 'gen')],
      hidden: [config.socket], log: line => log(`[${basename(session.root)}] ${line}`),
    });
  }

  /** Without herdr, Pair's pane opens in one of the session's Neovims, as a :terminal buffer. */
  function editorPane(session) {
    session.scout ??= scoutPane(session, new EditorPaneHost({editors: () => editorsOf(session), ask: askEditor}));
  }

  /** A chat pane in herdr: Pair's pane moves there, and its PaneWatch watches herdr's panes too. */
  function watchHerdr(session, herdr) {
    if (!herdr?.socket || paneSources.get(session.root)?.herdr) return;
    session.scout?.close().catch(() => {}); // a pane it had in Neovim before the herdr chat pane came
    session.scout = scoutPane(session, new HerdrPaneHost({socketPath: herdr.socket, workspaceId: herdr.workspace, besidePane: herdr.pane}));
    watchPanes(session, {herdr, chatPane: herdr.pane});
    log(`[${basename(session.root)}] watching herdr workspace ${herdr.workspace}`);
  }

  /**
   * The session's PaneWatch over the user's terminals: the :terminal buffers of its Neovims always, the panes of
   * herdr once a chat pane there says hello, and of the tmux session a Neovim or the chat runs in. A source more
   * than it has makes it anew. `chatPane` is the chat's, which is Pair's and not the user's.
   */
  function watchPanes(session, {herdr = null, tmux = null, chatPane = null} = {}) {
    const known = paneSources.get(session.root) ?? {herdr: null, tmux: null, chatPane: null};
    const wanted = {herdr: known.herdr ?? herdr, tmux: known.tmux ?? tmux, chatPane: known.chatPane ?? chatPane};
    if (watches.has(session.root) && JSON.stringify(wanted) === JSON.stringify(known)) return;
    paneSources.set(session.root, wanted);
    watches.get(session.root)?.stop();
    const sources = [];
    if (wanted.herdr) sources.push(new HerdrPanes({socketPath: wanted.herdr.socket, workspaceId: wanted.herdr.workspace}));
    if (wanted.tmux) sources.push(new TmuxPanes({socketPath: wanted.tmux.socket, pane: wanted.tmux.pane}));
    sources.push(new NvimPanes({editors: () => editorsOf(session), ask: askEditor}));
    const sessionLog = line => log(`[${basename(session.root)}] ${line}`);
    const watch = new PaneWatch({
      source: new Panes(sources, {log: sessionLog}),
      chatPane: wanted.chatPane,
      scout: session.scout,
      emit: event => receive(session, event),
      log: sessionLog,
    });
    watches.set(session.root, watch);
    watch.start();
  }

  /** The session's push-to-talk (see listen.mjs); null when the config has no voice. */
  function listenerOf(session) {
    if (!config.voice) return null;
    if (!listeners.has(session.root)) {
      listeners.set(session.root, new Listener({
        voice: config.voice, session, dir: join(config.dataDir, 'voice'),
        ask: (text, selection) => session.ask(text, selection, {question: true}),
        log: line => log(`[${basename(session.root)}] ${line}`),
      }));
    }
    return listeners.get(session.root);
  }

  function listen(client, session, message) {
    const listener = listenerOf(session);
    if (!listener) return sendMessage(client.socket, {type: 'heard', error: 'voice is off: set "voice" in the config (see docs/voice.md)'});
    if (message.action === 'start') return listener.start(reply => sendMessage(client.socket, reply), message.selection ?? null, client);
    if (message.action === 'stop') return listener.stop();
    if (message.action === 'cancel') return listener.cancel();
  }

  const ending = new Set();

  /** Ends `session`; `why` says it ended by itself, in the chat. Only a session with work in it gets a debrief. */
  async function endSession(session, why = null) {
    if (ending.has(session)) return;
    ending.add(session);
    if (why) log(`[${basename(session.root)}] session ends by itself: ${why}`);
    await session.end().finally(() => ending.delete(session));
    contextReads.delete(session);
    listeners.get(session.root)?.close();
    listeners.delete(session.root);
    watches.get(session.root)?.stop();
    watches.delete(session.root);
    paneSources.delete(session.root);
    sessions.delete(session.root);
    live.delete(session.root);
    margins.delete(session.root);
    relays.delete(session.root);
    for (const client of clients) {
      if (client.session !== session) continue;
      sendMessage(client.socket, {type: 'ended', why});
      client.session = null;
    }
  }

  async function hello(client, message) {
    client.role = message.role;
    client.activeAt = Date.now();
    // The herdr or tmux pane a Neovim runs in.
    client.pane = message.pane ?? (message.tmux?.pane ? tmuxPane(message.tmux.pane) : null);
    client.pid = message.pid ?? null; // a Neovim's, which names its terminals (terminals.mjs)
    client.buffers = message.buffers === true; // a plugin that lists its unsaved buffers; an older one never answers
    client.session = await loadSession(await rootOf(message.cwd));
    const {session} = client;
    sendMessage(client.socket, {
      type: 'welcome', root: session.root, goal: session.state.goal, level: session.budget.level, role: session.role, keep: session.keepWheel, models: health.snapshot(),
      accent: session.accent, model: sessionPartner.modelName(), muted: [...session.muted], board: boardCounts(session.state.board),
    });
    // The chat pane's status row starts from what Pair does now, and how much it looked at so far.
    if (client.role === 'chat') {
      sendMessage(client.socket, session.activityNow);
      sendMessage(client.socket, session.presence);
      // And today's /gen cards: the keys under each, and the request at work, for the status.
      for (const card of session.gen.cards()) sendMessage(client.socket, card);
    }
    // A Neovim that connects (or reconnects) after a test run shows its result too, and a late answer it missed.
    if (client.role === 'editor' && session.testsShown) sendMessage(client.socket, session.testsShown);
    if (client.role === 'editor' && session.runShown) sendMessage(client.socket, session.runShown);
    if (client.role === 'editor' && session.runLineShown) sendMessage(client.socket, session.runLineShown);
    // The files of /gen file requests still to review, as buffers: a Neovim that restarted lost them.
    if (client.role === 'editor') for (const files of session.gen.reopen()) sendMessage(client.socket, files);
    // And the code taken from /gen that is not the user's yet: ┊ again on its lines, found by their text.
    if (client.role === 'editor') sendMessage(client.socket, {type: 'gen_marks', marks: session.gen.allMarks(), all: true});
    if (message.herdr?.socket) agents?.useHerdr(message.herdr.socket);
    const relayed = relays.get(session.root)?.last;
    if (client.role === 'editor' && relayed) sendMessage(client.socket, relayed);
    if (client.role === 'editor' && session.lateForEditors) {
      sendMessage(client.socket, session.lateForEditors);
      session.lateForEditors = null;
    }
    // The first Neovim after a long gap picks up where the last session stopped (see pickup.mjs).
    if (client.role === 'editor') session.pickUp().catch(error => log(`pick-up failed: ${error.stack ?? error}`));
    if (client.role === 'editor') editorPane(session);
    const tmux = message.tmux?.socket && message.tmux.pane ? {socket: message.tmux.socket, pane: message.tmux.pane} : null;
    if (client.role === 'editor') watchPanes(session, {tmux});
    if (client.role !== 'chat') return;
    watchHerdr(session, message.herdr);
    if (!message.herdr?.socket) watchPanes(session, {tmux, chatPane: tmux && tmuxPane(tmux.pane)});
    // A chat pane that reconnects after a daemon restart already shows the history, up to the restart.
    if (message.resume) {
      for (const missed of store.messagesSince(session.id, startedAt)) sendMessage(client.socket, {type: 'message', history: true, ...missed});
      return;
    }
    const history = store.messages(session.id);
    for (const old of history) sendMessage(client.socket, {type: 'message', history: true, ...old});
    if (!history.length) session.greet();
  }

  /**
   * A typed question. From the chat, `here` asks about what the user selected last in Neovim (else their line), and
   * `about` is the remark it follows up on.
   */
  async function askFrom(client, session, message) {
    const selection = message.selection ?? (message.here ? await requestEditor(session, {type: 'selection'}).catch(() => null) : null);
    const picked = selection?.file ? selection : null;
    if (message.here && !picked) session.message('system', 'No Neovim answered for @here, so the question goes without lines.');
    const about = Number.isInteger(message.about) ? message.about : null;
    return session.askTyped(message.text, picked, {question: client.role === 'editor', about});
  }

  /**
   * A /gen request (see gen.mjs). From Neovim it brings the cursor's `place` or the `selection`, and the `token` of
   * the mark there; from the chat, the Neovim the user works in is asked for them.
   */
  function genFrom(client, session, message) {
    const place = (where, keys) => (where && typeof where.file === 'string' && keys.every(key => Number.isInteger(where[key])) ? where : null);
    return session.gen.request({
      text: typeof message.text === 'string' ? message.text : '',
      shape: typeof message.shape === 'string' ? message.shape : null,
      here: message.here === true,
      selection: place(message.selection, ['from', 'to']),
      place: place(message.place, ['line']),
      token: Number.isInteger(message.token) ? message.token : null,
      from: client.role === 'editor' ? 'editor' : 'chat',
    });
  }

  /** /brief and :Pair brief (see gen.mjs): the chat says what it did, and the Neovim that asked does too. */
  async function briefFrom(client, session, message) {
    const text = await session.gen.pinBrief({file: typeof message.file === 'string' ? message.file : null, off: message.off === true});
    if (client.role === 'editor') sendMessage(client.socket, {type: 'message', sender: 'system', text, at: Date.now()});
  }

  /** What a /gen try says to the Neovim that asked, which may have no chat pane to show it. */
  function toEditor(client, text) {
    if (client.role === 'editor' && text) sendMessage(client.socket, {type: 'message', sender: 'system', text, at: Date.now()});
  }

  /**
   * /keep [path] and :Pair keep [path]: from Neovim, with the try or scaffold `file` it is in; k in :Pair gen list,
   * with the scaffold's `action` and the `piece` to keep (see gen.mjs).
   */
  async function keepFrom(client, session, message) {
    const file = typeof message.file === 'string' ? message.file : null;
    const int = value => (Number.isInteger(value) ? value : null);
    toEditor(client, await session.gen.keep({
      path: typeof message.path === 'string' ? message.path : '', file, n: int(message.gen), action: int(message.action), piece: int(message.piece),
    }));
  }

  /**
   * Generated code becomes the user's: the marks `ids` they edited (`how` 'edit') or owned with :Pair own, or with
   * `all` every mark in the project, or in `file`.
   */
  function ownFrom(session, message) {
    const how = message.how === 'edit' ? 'edit' : 'own';
    if (Array.isArray(message.ids) && message.ids.length) return session.gen.own(message.ids, how);
    if (message.all === true) return session.gen.ownAll();
    if (typeof message.file === 'string') return session.gen.ownAll(resolve(session.root, message.file));
    if (how === 'own') session.gen.own([], how);
  }

  /** x in :Pair gen list, :Pair gen drop, /gen drop: a scaffold's copy is deleted. */
  async function copyDeleteFrom(client, session, message) {
    toEditor(client, await session.gen.deleteCopy({action: Number.isInteger(message.action) ? message.action : null}));
  }

  /** r in :Pair gen list: a scaffold's copy is checked again. */
  async function checkFrom(client, session, message) {
    toEditor(client, await session.gen.checkAgain({action: Number.isInteger(message.action) ? message.action : null}));
  }

  /** The run key in a try's buffer, :Pair gen run, /gen run: the try runs again in Pair's pane. */
  async function tryRunFrom(client, session, message) {
    const file = typeof message.file === 'string' ? message.file : null;
    toEditor(client, await session.gen.rerun({file, n: Number.isInteger(message.gen) ? message.gen : null}));
  }

  /** /gen tries in the chat says them; :Pair gen tries gets them to pick one to open. */
  async function triesFrom(client, session) {
    if (client.role === 'editor') return sendMessage(client.socket, {type: 'gen_tries', tries: await session.gen.tries()});
    await session.gen.triesText();
  }

  /** The id of the `number`th last remark in the session's project, as /remarks lists them; null without a number. */
  function remarkNumbered(session, number) {
    if (!Number.isInteger(number) || number < 1) return null;
    return store.recentRemarks(session.root, number)[number - 1]?.id ?? null;
  }

  /** Sends `message` to the Neovim the user works in; says so in the chat when there is none. */
  function relayToEditor(session, message) {
    if (!notify(session, 'editor', message)) session.message('system', 'No Neovim is connected to this session: :Pair start in Neovim first.');
  }

  /** What `pair doctor` asks the daemon. */
  function status() {
    return {
      type: 'status',
      version: VERSION,
      pid: process.pid,
      startedAt,
      models: health.snapshot(),
      slot: slot.snapshot(),
      pace: pace.snapshot(), // what the Watcher's calls cost, and what Pair is not asking about
      decision: decision?.snapshot() ?? null, // whether the decision model is down, and how often the gate fell back
      sessions: [...live.values()].map(session => ({
        root: session.root,
        role: session.role,
        goal: session.state.goal,
        editors: editorsOf(session).length,
        chats: clientsOf(session, 'chat').length,
        herdr: !!paneSources.get(session.root)?.herdr,
        tmux: !!paneSources.get(session.root)?.tmux,
      })),
    };
  }

  /** Every task and agent but this session's own task, the most urgent first, for `:Pair agents` and `/agents`. */
  function agentList(session) {
    const items = (agents?.list() ?? [])
      .filter(item => item.where !== session.root)
      .sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status))
      .map(item => ({...item, name: itemName(item, session.repos)}));
    return {type: 'agent_list', items, off: !agents};
  }

  /**
   * Focuses the agent's pane in herdr. Either way the relayed line about it is answered: the key also puts away a
   * line whose agent has no pane any more (a finished task's).
   */
  async function goToAgent(client, session, key) {
    const relay = relays.get(session.root);
    const shown = relay?.shown?.key === key;
    try {
      const went = await agents?.focus(key);
      if (!went && !shown) sendMessage(client.socket, {type: 'message', sender: 'system', text: 'Cannot go there: its agent has no pane open now.', at: Date.now()});
    } catch (error) {
      sendMessage(client.socket, {type: 'message', sender: 'system', text: `Cannot go there: ${error.message}.`, at: Date.now()});
    }
    if (shown) relay.clear();
  }

  /**
   * o, d or t on a task or agent (`what`: 'open', 'diff', 'term'), from `:Pair agents`, the relay line, or the chat's
   * relay line: what it left behind goes to the Neovim that asked, else the session's, which opens it. Without a
   * Neovim, the chat says where it is.
   */
  async function agentLink(client, session, {key, what}) {
    if (!['open', 'diff', 'term'].includes(what) || typeof key !== 'string') return;
    const found = agents ? await agents.leftBehind(key, what) : {error: 'the agent relay is off ("agents": false in the config)'};
    const reply = {type: 'agent_link', key, what, ...found};
    const editor = client.role === 'editor' ? client : editorsOf(session)[0];
    if (editor && !found.error) return sendMessage(editor.socket, reply);
    const say = text => sendMessage(client.socket, {type: 'message', sender: 'system', text, at: Date.now()});
    if (found.error) return client.role === 'editor' ? sendMessage(client.socket, reply) : say(`Nothing to open: ${found.error}.`);
    if (what === 'open') return say(found.links.map(link => `${link.label}: ${link.url}`).join('\n'));
    say(what === 'term' ? `${found.title}'s worktree: ${found.where} (no Neovim to open a terminal in)` : 'The diff opens in Neovim, and none is connected.');
  }

  /** The pane watch of the session of the shell hook's `message`, or null when its project has none. */
  async function hookWatch(message) {
    const session = live.get(await rootOf(message.cwd));
    return session ? {session, watch: watches.get(session.root) ?? null} : null;
  }

  /** The herdr or tmux pane of a shell hook's environment, or null. */
  const outerPane = message => message.pane || (message.tmux ? tmuxPane(message.tmux) : null);

  /** The terminal of the shell that sent a hook's `message` (a Neovim :terminal's, by its pid), else its outer pane. */
  const hookPane = (watch, message) => watch.paneOf({shell: message.shell ?? null, pane: outerPane(message)});

  /** A command the shell hook saw end, with its exit code. Ignored when its project has no session. */
  async function shellCommand(message) {
    const {session, watch} = await hookWatch(message) ?? {};
    if (!session) return;
    const pane = watch ? await hookPane(watch, message) : outerPane(message);
    const output = watch && pane ? await watch.commandEnded(pane, message).catch(() => '') : '';
    if (output === null) return; // one of Pair's own panes (the chat's, Scout's), whose shell has the user's hook
    receive(session, {kind: 'command_end', pane, cmd: message.cmd, exit: message.exit, output, cwd: message.cwd});
  }

  /** The shell hook in a terminal: a shell started, or a command started in it (see shell-hook.mjs). */
  async function shellStarted(message) {
    const {watch} = await hookWatch(message) ?? {};
    const pane = watch && await hookPane(watch, message);
    if (!pane) return;
    if (message.type === 'shell') watch.shellReady(pane, message);
    else await watch.commandStarted(pane, message).catch(error => log(`shell hook: ${error.message}`));
  }

  /** zsh's hook says keys were pressed at a prompt. It sends no cwd: the watch that has its terminal tells the session. */
  function shellTyping(message) {
    for (const watch of watches.values()) watch.keysTypedIn({shell: message.shell ?? null, pane: outerPane(message)});
  }

  async function handle(client, message) {
    if (message.type === 'hello') return (client.ready = hello(client, message));
    if (message.type === 'status') return sendMessage(client.socket, status());
    if (message.type === 'command') return shellCommand(message);
    if (message.type === 'shell' || message.type === 'command_start') return shellStarted(message);
    if (message.type === 'typing') return shellTyping(message);
    if (message.type === 'reply') return replies.get(message.id)?.(message.result);
    // A client may send right after its hello; wait until the hello has found its session.
    await client.ready;
    const {session} = client;
    if (!session) return sendMessage(client.socket, {type: 'message', sender: 'system', text: 'No active session; send hello first', at: Date.now()});
    if (client.role === 'editor') noteEditor(client, message);
    if (message.type === 'event') return receive(session, message.event);
    if (message.type === 'ask') return askFrom(client, session, message);
    if (message.type === 'cancel') return session.stop();
    if (message.type === 'mute') return session.mute(typeof message.trigger === 'string' ? message.trigger : null);
    if (message.type === 'unmute') return session.unmute(typeof message.trigger === 'string' ? message.trigger : null);
    if (message.type === 'undo_last') return session.undoLast();
    // From the chat pane: a suggestion taken, or a place to go to, in the Neovim the user works in.
    if (message.type === 'accept' && Number.isInteger(message.action)) return relayToEditor(session, {type: 'accept', action: message.action});
    if (message.type === 'go' && typeof message.file === 'string') return relayToEditor(session, {type: 'go', file: resolve(session.root, message.file), line: Number(message.line) || 1});
    if (message.type === 'goal') return session.setGoal(message.text);
    if (message.type === 'first' && typeof message.text === 'string' && message.text.trim()) return session.setFirst(message.text.trim());
    if (message.type === 'level') return session.setLevel(message.level);
    if (message.type === 'role' && ROLES.includes(message.role)) return session.setRole(message.role);
    if (message.type === 'drive') return session.drive(message.text ?? '', message.selection ?? null, {keep: message.keep === true});
    if (message.type === 'take_back') return session.takeBack();
    if (message.type === 'new') return session.startNew(message.idea ?? '', message.file ?? 'NOTES.md');
    if (message.type === 'answer') return session.blankPage?.open ? session.blankPage.answer(message.text ?? '') : session.message('system', 'No questions of :Pair new are running here (the daemon may have restarted). :Pair new starts again.');
    if (message.type === 'new_stop') return session.blankPage?.stop();
    if (message.type === 'confirm') return session.answer(message.id, message.ok === true, undefined, typeof message.text === 'string' ? message.text : '');
    if (message.type === 'feedback') {
      const number = Number.isInteger(message.number) && message.number > 0 ? message.number : undefined;
      return session.feedback({useful: message.useful === true, id: message.remark ?? undefined, number, implicit: message.implicit === true});
    }
    if (message.type === 'remarks') return sendMessage(client.socket, session.remarkList());
    if (message.type === 'seen') return session.seen(message.remark);
    if (message.type === 'today') return sendMessage(client.socket, {type: 'ledger', ...session.today()});
    if (message.type === 'ledger_detail') return sendMessage(client.socket, {type: 'ledger_detail', ids: message.ids, detail: session.ledgerDetail(message.ids ?? [])});
    if (message.type === 'undo') return session.undo(message.action);
    if (message.type === 'applied') return session.applied(message.action, message.before, message.after, {piece: message.piece, from: message.from, to: message.to});
    if (message.type === 'gen') return genFrom(client, session, message);
    if (message.type === 'gen_answer' && Number.isInteger(message.gen)) return session.gen.answer(message.gen, message.id, message.text);
    if (message.type === 'gen_dropped' && Number.isInteger(message.action)) return session.gen.dropped(message.action, message.piece);
    if (message.type === 'gen_written' && Number.isInteger(message.action)) return session.gen.fileTaken(message.action, message.piece, message.text);
    if (message.type === 'gen_review') return sendMessage(client.socket, session.gen.review());
    if (message.type === 'gen_decide' && Number.isInteger(message.action)) return session.gen.decide(message.action, message.guess);
    if (message.type === 'gen_cancel') return session.gen.cancel();
    if (message.type === 'gen_list') return session.gen.list();
    // Owning generated code (owning.mjs): an edit of its lines, :Pair own [range|file|!], lines gone, and where they are.
    if (message.type === 'gen_own') return ownFrom(session, message);
    if (message.type === 'gen_gone' && Array.isArray(message.ids)) return session.gen.gone(message.ids);
    if (message.type === 'gen_marks_at' && Array.isArray(message.marks)) return session.gen.moved(message.marks);
    if (message.type === 'keep') return keepFrom(client, session, message);
    if (message.type === 'gen_try_run') return tryRunFrom(client, session, message);
    if (message.type === 'gen_tries') return triesFrom(client, session);
    if (message.type === 'gen_tree_drop' && Number.isInteger(message.action) && Number.isInteger(message.piece)) return session.gen.dropTree(message.action, message.piece);
    if (message.type === 'gen_copy_delete') return copyDeleteFrom(client, session, message);
    // The keys of a gen card in the chat (see Gen.card): d drops what is left, Enter and k open it in Neovim.
    if (message.type === 'gen_drop_all' && Number.isInteger(message.action)) return session.gen.dropAll(message.action);
    if (message.type === 'gen_open' && Number.isInteger(message.action)) return session.gen.open(message.action, message.what === 'next' ? 'next' : 'open');
    if (message.type === 'gen_check') return checkFrom(client, session, message);
    if (message.type === 'brief') return briefFrom(client, session, message);
    if (message.type === 'trail') return sendMessage(client.socket, session.trail());
    if (message.type === 'forget_trail') return session.forgetTrail();
    if (message.type === 'runs') return session.runs().then(runs => sendMessage(client.socket, runs));
    if (message.type === 'release') return session.release();
    if (message.type === 'accent') return session.setAccent(message.color);
    if (message.type === 'decision') return margins.get(session.root).decide(message.file, message.line);
    if (message.type === 'tasks') return margins.get(session.root).tasks(message.file);
    if (message.type === 'tasks_add') return margins.get(session.root).addTasks(message.file, message.tasks ?? []);
    if (message.type === 'teach') return session.teach(message.text || undefined, message.remark ?? remarkNumbered(session, message.number));
    if (message.type === 'end') return endSession(session);
    if (message.type === 'listen') return listen(client, session, message);
    if (message.type === 'focus') {
      watches.get(session.root)?.refresh(); // its terminal, if you are in one, has the focus no more, or again
      return listenerOf(session)?.focus(message.on === true);
    }
    if (message.type === 'panes') return watches.get(session.root)?.refresh();
    if (message.type === 'agents') return sendMessage(client.socket, agentList(session));
    if (message.type === 'agent_go') return goToAgent(client, session, message.key);
    if (message.type === 'agent_link') return agentLink(client, session, message);
    if (message.type === 'context') return sendCard(client, session);
    if (message.type === 'hide' && SOURCES.includes(message.source)) {
      session.receive({kind: 'hide', source: message.source, hidden: message.hidden !== false});
      return sendCard(client, session);
    }
  }

  /** The context card for the Neovim that asked, with git and the board read again when they are not fresh. */
  async function sendCard(client, session) {
    await refreshContext(session, CONTEXT_FRESH_MS);
    sendMessage(client.socket, session.card());
  }

  /** Once the last Neovim and chat pane of `session` closed and none came back for `aloneEndMs`, it ends. */
  function endWhenAlone(session) {
    if (!session || clientsOf(session, 'editor').length || clientsOf(session, 'chat').length) return;
    setTimeout(() => {
      const back = [...clients].some(client => client.session === session);
      if (!back && live.get(session.root) === session) endSession(session, 'its last Neovim closed').catch(error => log(`end failed: ${error.stack ?? error}`));
    }, aloneEndMs).unref();
  }

  const server = createServer(socket => {
    const client = {socket, role: null, session: null, activeAt: 0, focused: null, ready: Promise.resolve()};
    clients.add(client);
    socket.on('close', () => {
      clients.delete(client);
      if (client.session) listeners.get(client.session.root)?.drop(client); // no microphone stays open for a gone editor
      endWhenAlone(client.session);
    });
    socket.on('error', () => {});
    readMessages(socket, message => handle(client, message).catch(error => {
      log(`${message.type} failed: ${error.stack ?? error}`);
      sendMessage(socket, {type: 'message', sender: 'system', text: `Error: ${error.message}`, at: Date.now()});
    }));
  });

  // The user's questions the daemon was answering when it stopped: their sessions are loaded before the Partner
  // goes on, so its tool calls find them; a question whose session ended is dropped.
  const late = [];
  const orphans = [];
  for (const turn of models.partner.interrupted) {
    const record = store.activeSessionOf(turn.conversationId);
    if (record) late.push({...turn, session: await loadSession(record.root)});
    else orphans.push(turn.conversationId);
  }
  for (const conversationId of orphans) await models.partner.cancel(conversationId);
  await models.partner.resume();

  // The owner lock is held, so a socket file left behind is from a daemon that died.
  try { unlinkSync(config.socket); } catch {}
  await new Promise((resolve, reject) => server.once('error', reject).listen(config.socket, resolve));
  chmodSync(config.socket, 0o600);

  /**
   * Keeps the Watcher's model loaded while someone works, unless it is down (then the health probe checks it) or
   * the Partner is at work on the same server, which keeps it loaded.
   */
  function keepWarm() {
    const now = Date.now();
    if (!config.keepWarm || now - models.scoreRemark.lastCallAt < keepWarmMs || !health.ok('watcher')) return;
    if (slot.exclusive && slot.busy()) return;
    if (![...live.values()].some(session => session.active(now))) return;
    // A ping measures the server's own cost per request, so the pace keeps measuring while Pair asks about nothing.
    const started = Date.now();
    models.scoreRemark.warm().then(result => { pace.hear(Date.now() - started); health.report('watcher', result.error); });
  }

  const ticker = setInterval(() => {
    for (const session of live.values()) {
      if (session.idle(idleEndMs)) {
        endSession(session, `nothing happened for ${Math.round(idleEndMs / 60_000)} min`).catch(error => log(`end failed: ${error.stack ?? error}`));
        continue;
      }
      session.tick().catch(error => log(`tick failed: ${error.stack ?? error}`));
      refreshContext(session, CONTEXT_EVERY_MS);
      // While :Pair new asks its questions, the note is theirs: no marks in its margin until they end.
      if (!session.blankPage?.open) margins.get(session.root)?.tick().catch(error => log(`margin failed: ${error.stack ?? error}`));
    }
    for (const relay of relays.values()) relay.tick();
    keepWarm();
  }, TICK_MS);

  health.start();
  decision?.start();
  agents?.start();
  const configWatch = configFile && watchConfig(configFile, {
    // The windows asked again as at start; one a server cannot tell now stays as the running config has it.
    load: path => loadSizedConfig(path, {before: saved}),
    onChange: next => reload(next).catch(error => refuse(error.message)),
    onError: refuse,
  });
  log(`pair daemon ${VERSION} listening on ${config.socket}`);
  for (const {session, conversationId, submissionId, question} of late) {
    log(`[${basename(session.root)}] finishing the answer the restart interrupted`);
    session.lateAnswer(question, () => sessionPartner.finish(conversationId, submissionId))
      .catch(error => log(`late answer failed: ${error.stack ?? error}`));
  }

  return {
    async close() {
      configWatch?.close();
      clearInterval(ticker);
      health.stop();
      decision?.stop();
      agents?.stop();
      for (const watch of watches.values()) watch.stop();
      for (const listener of listeners.values()) listener.close();
      for (const client of clients) client.socket.destroy();
      await new Promise(resolve => server.close(resolve));
      await rebuilt;
      for (const session of live.values()) session.gen.close(); // a request waiting for an answer would hold the Partner open
      await models.partner.close();
      store.close();
      owner.release();
    },
  };
}
