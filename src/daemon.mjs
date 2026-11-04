// The long-lived daemon: one Unix socket for Neovim, the chat pane and the shell hook; one session per project,
// shared by every Neovim and chat pane open in it.
import {execFile} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, unlinkSync} from 'node:fs';
import {realpath} from 'node:fs/promises';
import {createServer} from 'node:net';
import {homedir} from 'node:os';
import {basename, join, resolve} from 'node:path';
import {AgentRelay, itemName} from './agent-relay.mjs';
import {AgentBoard, STATUSES} from './agents.mjs';
import {oneAtATime} from './config.mjs';
import {goalFromContext, SOURCES} from './context-card.mjs';
import {loadSizedConfig} from './context-window.mjs';
import {byUse, herdrFocus, noteEditor} from './editors.mjs';
import {MODEL, pythonOf, RUNTIME} from './embedder.mjs';
import {expireTries} from './gen-tree.mjs';
import {gitRoot, repoNames} from './git.mjs';
import {createDecider, DecisionModel} from './decision.mjs';
import {MODEL_ROLES, ModelHealth} from './health.mjs';
import {NoteMargin} from './margin.mjs';
import {oneAnswer} from './note-reading.mjs';
import {HerdrPanes} from './herdr.mjs';
import {CorePaneHost, CorePanes, HerdrApp} from './herdr-core.mjs';
import {authenticate, panelMessage, startPanelListener} from './herdr-panel.mjs';
import {followLoaded, shareServer} from './loaded-model.mjs';
import {DETAIL_KEPT_MS} from './ledger.mjs';
import {editOrigin} from './fold.mjs';
import {Listener} from './listen.mjs';
import {downloadOmni, gb, installVoiceRuntime, OMNI, OmniVoice, omniInstall, omniMissing, omniReady, omniRuntimeOf, removeOmni, venvHasLiteRT, voicePythonsOn, voiceWheelsOf} from './omni.mjs';
import {usesOmni} from './voice.mjs';
import {createDecisionModel, createPairModels, createRerankEndpoints} from './models.mjs';
import {acquireOwner} from './owner.mjs';
import {EditorPaneHost, HerdrPaneHost} from './pane-hosts.mjs';
import {Panes, PaneWatch} from './pane-watch.mjs';
import {NvimPanes} from './nvim-panes.mjs';
import {TASK_CHANGES_MS, TaskChanges, taskFiles} from './overlap.mjs';
import {openPartner} from './partner.mjs';
import {Pace} from './pace.mjs';
import {probeModel} from './probe.mjs';
import {projectContext} from './project-context.mjs';
import {readMessages, sendMessage} from './protocol.mjs';
import {findPython, madeByPair, Runtime, RUNTIME_VERSION, venvPython} from './runtime.mjs';
import {pairReranker, pairSearch} from './search.mjs';
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
const mb = bytes => Math.round(bytes / 1e6);
const tilde = path => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

/**
 * `probe(role)` checks that a model answers (see probe.mjs); tests pass their own, a short `keepWarmMs`, a short
 * `agentsPollMs` for the agent relay's board and herdr, and a short `taskChangesPollMs` for what the board's tasks
 * change. With `configFile`, the daemon takes changes to it as they are
 * saved (see reload.mjs); `modelsFor(config)` builds the models of a config, at start and after a change, and
 * `decisionFor(config)` its decision model (`{models, model}`, or null; see decision.mjs), and `rerankerFor(config)`
 * search by meaning's reranker (a Reranker over its models, or null; see search.mjs).
 */
export async function startDaemon(config, {
  configFile = null, modelsFor = createPairModels, pairModels = modelsFor(config), decisionFor = createDecisionModel, probe, log = defaultLog, keepWarmMs = KEEP_WARM_MS,
  idleEndMs = IDLE_END_MS, aloneEndMs = ALONE_END_MS, agentsPollMs, taskChangesPollMs = TASK_CHANGES_MS,
  appCommand = 'herdr-app', // the Herdr window's command, for herdr-core's focus and agents
  herdrPanel = false, // the Herdr panel's loopback port (see herdr-panel.mjs): `pair daemon` opens it as the config says
  meaningWith = {}, // tests' fetch and embedder for search by meaning (see search.mjs)
  rerankerFor = (entries, logTo) => (entries.rerank ? pairReranker(createRerankEndpoints(entries), {log: logTo}) : null),
  omniWith = {}, // tests' LFM3-Omni for voice (see omni.mjs): {voice, fetch, free, files, runtime, litert, wheels, pythons, pythonsOn, install}
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
  const coreSources = new Map(); // root -> its herdr-core terminals (CorePanes), whose focus the Herdr panel may push
  const pushedFocus = new Map(); // herdr-core socket -> its window's focus as a Herdr panel last pushed it, while one is connected
  const listeners = new Map(); // root -> Listener, once someone holds the listen key there
  const relays = new Map(); // root -> AgentRelay
  const clients = new Set();
  const indexProgress = new Map(); // root -> how far its index's last build went, for a Herdr panel that comes later
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
    ? new AgentBoard({board: config.board, pollMs: agentsPollMs, appCommand, log, wanted: () => [...clients].some(client => client.session), onChange: change => { for (const relay of relays.values()) relay.hear(change); }})
    : null;

  // Search by meaning (semantic-grep's Meaning, see search.mjs): the index of each project with a session, its words at
  // once and its vectors in the background once it has a model; its builds and searches go to that project's ledger,
  // and how far a build is to its Neovims.
  const {meaning, runtime: meaningRuntime, turnOff: meaningTurnOff} = pairSearch({
    config, log,
    keepVenv: () => omniReady(config.dataDir), // :Pair find off leaves the venv to voice while LFM3-Omni is here
    reranker: rerankerFor(config, log), // the decision model that reorders a settled search, or null (see search.mjs)
    book: (root, kind, text, options) => live.get(root)?.ledger.add(kind, text, options),
    progress: (root, how) => {
      indexProgress.set(root, how);
      const session = live.get(root);
      // To its Neovims, and to the Herdr panel, whose header shows how far the index is.
      if (session) for (const client of [...clientsOf(session, 'editor'), ...clientsOf(session, 'chat').filter(client => client.panel)]) sendMessage(client.socket, {type: 'index_progress', ...how});
    },
    with: meaningWith,
  });

  // Voice's LFM3-Omni (omni.mjs): one helper for every session, started on first use; its download is `:Pair voice on`.
  const omni = omniWith.voice ?? new OmniVoice({python: () => pythonOf(config.meaning, config.dataDir), dataDir: config.dataDir, threads: config.voice?.threads, log});
  let omniDownload = null; // {abort, done} while its files come

  // What the board's working tasks of each repo change on their branches, read while a Neovim is connected (overlap.mjs).
  const taskChanges = new TaskChanges({board: config.board, log});
  const changesReads = new Map(); // session -> the read under way

  /**
   * Reads what the working tasks of `session`'s repo change, into its state (the overlap moment) and, when it changed,
   * to its Neovims (the winbar note). A read under way is not started again; one the board cannot answer keeps the last.
   */
  function readTaskChanges(session) {
    if (changesReads.has(session) || !clientsOf(session, 'editor').length) return changesReads.get(session);
    const {board, branch} = session.state;
    const reading = taskChanges.read({root: session.root, space: board?.space ?? null, own: board?.task?.id ?? null, branch})
      .then(tasks => {
        if (!tasks || live.get(session.root) !== session) return; // the board did not answer, or the session ended
        session.receive({kind: 'task_changes', tasks});
        const shown = {type: 'task_files', files: taskFiles(tasks, session.root)};
        if (JSON.stringify(shown) === JSON.stringify(session.taskFilesShown ?? {type: 'task_files', files: []})) return;
        session.taskFilesShown = shown;
        notify(session, 'editors', shown);
      }, error => log(`[${basename(session.root)}] overlap: ${error.message}`))
      .finally(() => changesReads.delete(session));
    changesReads.set(session, reading);
    return reading;
  }
  const changesTimer = setInterval(() => { for (const session of live.values()) readTaskChanges(session); }, taskChangesPollMs);

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
  function askNoteModel(systemPrompt, content, {asked = false, report = true} = {}) {
    const controller = new AbortController();
    const read = () => oneAnswer({models: models.pairModels.models, model: models.pairModels.partner, signal: controller.signal}, systemPrompt, content).then(
      text => { if (report) health.report('partner'); return text; },
      error => { if (report && !controller.signal.aborted) health.report('partner', error.message); throw error; },
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
    let nextReranker = meaning.reranker;
    try {
      if (changed.includes('models')) nextModels = modelsFor(next);
      if (changed.includes('decision')) nextDecision = decisionFor(next);
      if (changed.includes('rerank')) nextReranker = rerankerFor(next, log);
    } catch (error) {
      return refuse(error.message);
    }
    saved = next;
    config = {...next, socket: config.socket, dataDir: config.dataDir, agents: config.agents};
    if (changed.includes('decision')) {
      useDecision(nextDecision);
      decision?.start();
    }
    if (nextReranker !== meaning.reranker) nextReranker?.follow(meaning.reranker); // the model gets one question at a time still
    meaning.reranker = nextReranker; // the next search asks the new one, or none
    pace.on = config.watcherPace ?? true;
    for (const session of live.values()) {
      session.typingPauseMs = config.typingPauseMs;
      session.autoTune = config.autoTune;
      session.proposing = config.plan;
      session.setTestOnSave(testOnSaveOf(session.root, session.id));
      session.gen.limits = config.gen.limits; // a request already running keeps the limits it started with
      session.gen.briefName = config.gen.brief;
      Object.assign(session.gen, {keepTries: config.gen.keepTries, network: config.gen.network, sandbox: config.scoutPane.sandbox, scaffold: config.gen.scaffold, board: config.board});
      Object.assign(margins.get(session.root) ?? {}, {typingPauseMs: config.typingPauseMs, taskCommand: config.taskCommand});
    }
    if (changed.includes('board')) {
      readContext = projectContext({board: config.board});
      if (agents) agents.board = config.board;
      taskChanges.board = config.board;
    }
    if (changed.includes('voice')) {
      for (const listener of listeners.values()) listener.close();
      listeners.clear();
      omni.threads = config.voice?.threads ?? omni.threads;
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
        proposing: config.plan,
        typingPauseMs: config.typingPauseMs,
        testOnSave: testOnSaveOf(root, record.id),
        checkOutput: join(config.dataDir, 'runs', `${record.id}.check.out`), // the hand-over's check: writable in the sandbox too
        genLimits: config.gen.limits,
        genBrief: config.gen.brief,
        genDir: join(config.dataDir, 'gen'), genKeepTries: config.gen.keepTries, genNetwork: config.gen.network, genSandbox: config.scoutPane.sandbox, genScaffold: config.gen.scaffold, genBoard: config.board,
        askModel: (systemPrompt, content) => askNoteModel(systemPrompt, content, {asked: true}), // the /gen brief's checks
        threadModel: (systemPrompt, content) => askNoteModel(systemPrompt, content, {report: false}), // the plan's steps and done checks: unasked, they give way, and a failure is asked again, not a model down
        notify: (role, message) => notify(session, role, message),
        requestEditor: message => requestEditor(session, message),
        meaningHits: query => meaning.trailHits(root, query), // the search trail's "by meaning" lines
        findCode: (query, options) => meaning.search(root, query, options), // Scout's and the Driver's search, by meaning
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
      meaning.open(root); // once search by meaning is on, its index loads and builds in the background
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
    if (event.kind === 'save' && typeof event.file === 'string') meaning.saved(session.root, event.file).catch(error => log(`meaning: ${error.message}`));
    if (event.kind === 'command_end') refreshContext(session);
    if (event.kind === 'typing' || (event.kind === 'edit' && editOrigin(event.origin) === 'user')) listeners.get(session.root)?.typed({keys: event.kind === 'typing'}); // speech stops as you type, not as Pair does
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

  /**
   * A chat pane in herdr, or a chat terminal in herdr-core (`herdr.kind`, see herdrOf): Pair's pane moves there, and
   * its PaneWatch watches herdr's panes, or the terminals of the chat's space in the Herdr window, too.
   */
  function watchHerdr(session, herdr) {
    if (!herdr?.socket || paneSources.get(session.root)?.herdr) return;
    session.scout?.close().catch(() => {}); // a pane it had in Neovim before the herdr chat pane came
    // The Herdr panel is no terminal: Pair's pane opens beside the terminal it was opened from.
    const host = herdr.kind === 'core'
      ? new CorePaneHost({socketPath: herdr.socket, besidePane: herdr.pane ?? herdr.beside, root: session.root})
      : new HerdrPaneHost({socketPath: herdr.socket, workspaceId: herdr.workspace, besidePane: herdr.pane});
    session.scout = scoutPane(session, host);
    watchPanes(session, {herdr, chatPane: herdr.pane});
    const core = herdr.pane ? `herdr-core terminal ${herdr.pane}'s space` : `Herdr space ${herdr.space}, from the Herdr panel`;
    log(`[${basename(session.root)}] watching ${herdr.kind === 'core' ? core : `herdr workspace ${herdr.workspace}`}`);
  }

  /**
   * The source of the user's panes in herdr or herdr-core, for `root`'s session. On herdr-core, the chat's space is
   * the chat terminal's, or the one the Herdr panel names; while a panel pushes the window's focus, it is not polled.
   */
  function herdrSource(herdr, root) {
    if (herdr.kind !== 'core') return new HerdrPanes({socketPath: herdr.socket, workspaceId: herdr.workspace});
    const source = new CorePanes({
      socketPath: herdr.socket, chatPane: herdr.pane ?? null, space: herdr.pane ? undefined : herdr.space,
      app: new HerdrApp({command: appCommand, env: {HC_SESSION: herdr.session, HERDR_APP_HOME: herdr.appHome}}),
    });
    coreSources.set(root, source);
    if (pushedFocus.has(source.socketPath)) source.pushed(pushedFocus.get(source.socketPath));
    return source;
  }

  /**
   * A Herdr panel of herdr-core `core` pushes its window's focus (`focus`), or the last panel of that core went (null).
   * The window is one for every session of that core, so each of their terminals follows it (each takes it only in its
   * own space), and none asks `herdr-app status` while a panel pushes. Another core session is another window's.
   */
  function pushFocus(core, focus) {
    if (focus) pushedFocus.set(core, focus);
    else pushedFocus.delete(core);
    for (const source of coreSources.values()) if (source.socketPath === core) source.pushed(focus);
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
    coreSources.delete(session.root);
    if (wanted.herdr) sources.push(herdrSource(wanted.herdr, session.root));
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
        voice: config.voice, session, dir: join(config.dataDir, 'voice'), omni: usesOmni(config.voice) ? omni : null,
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
    coreSources.delete(session.root);
    sessions.delete(session.root);
    live.delete(session.root);
    meaning.leave(session.root).catch(() => {});
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
    client.core = client.panel ? message.herdr?.socket ?? null : null; // the herdr-core whose window a panel shows
    client.buffers = message.buffers === true; // a plugin that lists its unsaved buffers; an older one never answers
    meaning.useParsers(message.parsers); // a Neovim's tree-sitter parsers cut its project's files into functions
    client.session = await loadSession(await rootOf(message.cwd));
    const {session} = client;
    sendMessage(client.socket, {
      type: 'welcome', root: session.root, goal: session.state.goal, plan: session.planSteps(), level: session.budget.level, role: session.role, keep: session.keepWheel, models: health.snapshot(),
      accent: session.accent, model: sessionPartner.modelName(), watcher: models.pairModels.watcher.name ?? models.pairModels.watcher.id, muted: [...session.muted], board: boardCounts(session.state.board),
    });
    // The chat pane's status row starts from what Pair does now, and how much it looked at so far.
    if (client.role === 'chat') {
      sendMessage(client.socket, session.activityNow);
      sendMessage(client.socket, session.presence);
      // And today's /gen cards: the keys under each, and the request at work, for the status.
      for (const card of session.gen.cards()) sendMessage(client.socket, card);
      if (client.panel && indexProgress.has(session.root)) sendMessage(client.socket, {type: 'index_progress', ...indexProgress.get(session.root)});
    }
    // A Neovim that connects (or reconnects) after a test run shows its result too, and a late answer it missed.
    if (client.role === 'editor' && session.testsShown) sendMessage(client.socket, session.testsShown);
    if (client.role === 'editor' && session.runShown) sendMessage(client.socket, session.runShown);
    if (client.role === 'editor' && session.runLineShown) sendMessage(client.socket, session.runLineShown);
    // The files the board's working tasks change: the winbar note on those open, read now for the first Neovim.
    if (client.role === 'editor' && session.taskFilesShown) sendMessage(client.socket, session.taskFilesShown);
    if (client.role === 'editor') readTaskChanges(session);
    // The files of /gen file requests still to review, as buffers: a Neovim that restarted lost them.
    if (client.role === 'editor') for (const files of session.gen.reopen()) sendMessage(client.socket, files);
    // And the code taken from /gen that is not the user's yet: ┊ again on its lines, found by their text.
    if (client.role === 'editor') sendMessage(client.socket, {type: 'gen_marks', marks: session.gen.allMarks(), all: true});
    if (message.herdr?.socket) agents?.useHerdr(message.herdr);
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

  /** /brief and :Pair brief, and their sync (see gen.mjs): the chat says what it did, and the Neovim that asked does too. */
  async function briefFrom(client, session, message) {
    const text = message.sync === true ? await session.gen.syncBrief({from: client.role === 'editor' ? 'editor' : 'chat'})
      : await session.gen.pinBrief({file: typeof message.file === 'string' ? message.file : null, off: message.off === true});
    if (client.role === 'editor' && text) sendMessage(client.socket, {type: 'message', sender: 'system', text, at: Date.now()});
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
      meaning: meaning.snapshot(), // search by meaning: its model, the embedder and each open project's index
      panel: panel ? {port: panel.port, file: panel.file, clients: [...clients].filter(client => client.panel && client.role).length} : null, // the Herdr panel's port
      sessions: [...live.values()].map(session => ({
        root: session.root,
        role: session.role,
        goal: session.state.goal,
        editors: editorsOf(session).length,
        chats: clientsOf(session, 'chat').length,
        panels: clientsOf(session, 'chat').filter(client => client.panel).length,
        focusPushed: Boolean(coreSources.get(session.root)?.pushing),
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

  /**
   * t, a and A in a task's review: a tell, "merge it" told to its agent, or archive, run on the pick that named it
   * (`run`), else its command line, copied in Neovim (gen_copy) or said in the chat.
   */
  async function boardDo(client, session, message) {
    const found = await session.gen.reviews.boardDo({task: message.task, verb: message.verb, text: message.text, run: message.run === true});
    const say = text => sendMessage(client.socket, {type: 'message', sender: 'system', text, at: Date.now()});
    if (found.error) return say(`Nothing sent to the board: ${found.error}.`);
    if (found.line) return client.role === 'editor' ? sendMessage(client.socket, {type: 'gen_copy', text: found.line}) : say(found.line);
    session.message('system', found.said);
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
    // pair doctor's check of the reranker, asked here so that it waits its turn with the searches' reranks.
    if (message.type === 'rerank_probe') return sendMessage(client.socket, {type: 'rerank_probe', ...(meaning.reranker ? await meaning.reranker.probe() : {ok: false, error: 'the daemon has no reranker'})});
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
    // The chat's Alt-y: Neovim takes its newest suggestion and goes there, or says it has none.
    if (message.type === 'take') return relayToEditor(session, {type: 'take', ...(Number.isInteger(message.action) ? {action: message.action} : {})});
    if (message.type === 'take_none') return notify(session, 'chat', {type: 'take_none', ...(['gone', 'changed'].includes(message.why) ? {why: message.why} : {})});
    if (message.type === 'suggestion_gone' && Number.isInteger(message.action)) return notify(session, 'chat', {type: 'suggestion_gone', action: message.action});
    if (message.type === 'go' && typeof message.file === 'string') return relayToEditor(session, {type: 'go', file: resolve(session.root, message.file), line: Number(message.line) || 1});
    if (message.type === 'goal') return session.setGoal(message.text);
    if (message.type === 'plan' && typeof message.text === 'string') return session.setPlan(message.text);
    if (message.type === 'plan_off') return session.dropPlan();
    if (message.type === 'plan_show') return session.showPlan();
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
    if (message.type === 'gen_answer' && Number.isInteger(message.gen)) return session.gen.answer(message.gen, message.id, message.text, message.edit);
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
    // A board task's branch as a review (review.mjs): opened, a file's diff, a file or hunk kept, a board command.
    if (message.type === 'review') return toEditor(client, await session.gen.reviews.open(message.task));
    if (message.type === 'review_diff' && Number.isInteger(message.action) && Number.isInteger(message.piece)) {
      return sendMessage(client.socket, {type: 'review_diff', action: message.action, piece: message.piece, ...(await session.gen.reviews.diff(message.action, message.piece))});
    }
    if (message.type === 'review_keep' && Number.isInteger(message.action) && Number.isInteger(message.piece)) {
      return toEditor(client, await session.gen.reviews.keep(message.action, message.piece, Number.isInteger(message.hunk) ? message.hunk : null));
    }
    if (message.type === 'board_do') return boardDo(client, session, message);
    if (message.type === 'brief') return briefFrom(client, session, message);
    if (message.type === 'trail') return sendMessage(client.socket, session.trail());
    if (message.type === 'find' && typeof message.query === 'string') return find(client, session, message);
    if (message.type === 'find_chosen' && typeof message.query === 'string') return meaning.booked(session.root, message.query, message.results ?? [], ' in the picker');
    if (message.type === 'index_rebuild') return indexRebuild(client, session);
    if (message.type === 'search_rpc' && typeof message.method === 'string') return searchRequest(client, session, message);
    if (message.type === 'meaning_on') return meaningOn(client);
    if (message.type === 'meaning_off') return meaningOff(client);
    if (message.type === 'voice_on') return voiceOn(client);
    if (message.type === 'voice_off') return voiceOff(client);
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
    // The Herdr panel: where the window's focus is, each time it moves.
    if (message.type === 'herdr_focus' && client.panel) {
      client.pushesFocus = true;
      return pushFocus(client.core ?? null, {space: typeof message.space === 'string' ? message.space : null, terminal: typeof message.terminal === 'string' ? message.terminal : null});
    }
    if (message.type === 'agents') return sendMessage(client.socket, agentList(session));
    if (message.type === 'agent_go') return goToAgent(client, session, message.key);
    if (message.type === 'agent_link') return agentLink(client, session, message);
    if (message.type === 'context') return sendCard(client, session);
    if (message.type === 'hide' && SOURCES.includes(message.source)) {
      session.receive({kind: 'hide', source: message.source, hidden: message.hidden !== false});
      return sendCard(client, session);
    }
  }

  /**
   * A search of the project: a Neovim's picker asks for the words on every key (`phase` "words") and for the meaning
   * once typing stops ("meaning"), and for the fused ranking's first pieces reranked once that settles ("rerank"),
   * each answer with its `id`; the chat's /find asks for both, fused (and reranked). Each result has
   * its absolute path, for the picker to open.
   */
  async function find(client, session, message) {
    // A key in a picker, or the picker closing: a rerank it asked for before is no longer wanted.
    if (message.phase === 'words' || message.phase === 'cancel') meaning.dropRerank(client);
    if (message.phase === 'cancel') return;
    const query = message.query.trim();
    const answer = message.phase === 'words' ? await meaning.words(session.root, query)
      : message.phase === 'meaning' ? await meaning.meaningOnly(session.root, query)
      : message.phase === 'rerank' ? await meaning.rerank(session.root, query, {who: client})
        : await meaning.search(session.root, query, {book: message.select !== true}); // a pick from vim.ui.select is booked as one
    sendMessage(client.socket, {
      type: 'found', ...(message.id !== undefined ? {id: message.id} : {}), ...answer, root: session.root,
      results: answer.results.map(result => ({...result, path: join(session.root, result.file)})),
    });
  }

  /**
   * semantic-grep.nvim's requests other than a search, from the Neovim that registered Pair's daemon as its source
   * (lua/pair/meaning.lua): "status" (Meaning's snapshot), "check" (the embedding model asked once, the reranker's
   * probe), "open" (the session's project indexed) and "rebuild" (as :Pair index rebuild). Answered with its `id`.
   */
  async function searchRequest(client, session, message) {
    const answer = fields => sendMessage(client.socket, {type: 'search_rpc', id: message.id, ...fields});
    try {
      if (message.method === 'status') return answer({result: meaning.snapshot()});
      if (message.method === 'open') {
        meaning.open(session.root);
        return answer({result: {state: meaning.state}});
      }
      if (message.method === 'rebuild') {
        if (meaning.state === 'disabled') throw new Error('search by meaning is off in the config ("meaning": false)');
        const path = await meaning.rebuild(session.root);
        session.ledger.add('indexed', `rebuilding the search index (:SemanticGrep rebuild): ${path}`);
        return answer({result: {path}});
      }
      if (message.method === 'check') {
        const embedder = meaning.state === 'on' ? meaning.embedder : null;
        let embedding = null;
        if (embedder) {
          const started = Date.now();
          try {
            const [vector] = await embedder.embed([embedder.query('add two numbers')], {urgent: true});
            embedding = {ok: true, ms: Date.now() - started, dimensions: vector.length, model: meaning.modelName};
          } catch (error) {
            embedding = {ok: false, ms: Date.now() - started, error: error.message, model: meaning.modelName};
          }
        }
        const rerank = meaning.reranker ? {...await meaning.reranker.probe(), timeoutMs: meaning.reranker.timeoutMs, models: meaning.reranker.name} : null;
        return answer({result: {embedding, rerank}});
      }
      throw new Error(`Pair's daemon has no ${message.method}`);
    } catch (error) {
      answer({error: error.message});
    }
  }

  /** `:Pair index rebuild`: the project's index made again from its files, in the background. */
  async function indexRebuild(client, session) {
    const tell = text => sendMessage(client.socket, {type: 'meaning_state', ...meaning.snapshot(), text});
    if (meaning.state === 'disabled') return tell('Search by meaning is off in the config ("meaning": false).');
    const path = await meaning.rebuild(session.root);
    session.ledger.add('indexed', `rebuilding the search index (:Pair index rebuild): ${path}`);
    tell(`Rebuilding the search index from the files${meaning.state === 'on' ? ', every vector too' : ''}; the word search works again in a few seconds.`);
  }

  /**
   * `:Pair find on`: LiteRT-LM's install and the model's download, each once and only if missing, said up front with
   * their sizes and told as they go, then the open projects' indexes. What came goes in the ledger.
   */
  async function meaningOn(client) {
    const tell = text => sendMessage(client.socket, {type: 'meaning_state', ...meaning.snapshot(), text});
    if (meaning.state === 'disabled') return tell('Search by meaning is off in the config ("meaning": false).');
    if (config.embedding) { // nothing to download: the config's model is asked again
      await meaning.turnOn();
      return tell(`Search by meaning is on, with ${meaning.modelName}: Pair indexes this project in the background.`);
    }
    if (meaning.state === 'installing' || meaning.state === 'downloading') { // said once already: this waits for it
      await meaning.turnOn().catch(() => {});
      return tell(meaning.state === 'on' ? 'Search by meaning is on: Pair indexes this project in the background.' : 'Search by meaning stays off: the :Pair find on under way did not finish.');
    }
    const needs = await meaning.needs();
    if (!needs.runtime && !needs.model) {
      await meaning.turnOn();
      return tell('Search by meaning is already on: its model and LiteRT-LM are here, and Pair indexes the open projects in the background.');
    }
    const fetches = [
      ...(needs.runtime?.bytes ? [`installing LiteRT-LM ${RUNTIME_VERSION} (${mb(needs.runtime.bytes)} MB from PyPI, SHA-256 pinned) in a venv in Pair's data folder`] : []),
      ...(needs.model ? [`downloading ${MODEL.name} (${mb(MODEL.bytes)} MB from Hugging Face, SHA-256 checked)`] : []),
    ];
    // No wheel for this machine: turnOn says so at once, and nothing is promised first.
    if (fetches.length && (!needs.runtime || needs.runtime.bytes)) tell(`Search by meaning: ${fetches.join(', then ')}, once…`);
    const told = {runtime: 0, model: 0};
    let done;
    try {
      done = await meaning.turnOn({progress: ({phase, bytes, total}) => {
        if (bytes - told[phase] < (phase === 'runtime' ? 8 : 32) << 20) return;
        told[phase] = bytes;
        const what = `Downloading ${phase === 'runtime' ? `LiteRT-LM ${RUNTIME_VERSION}` : MODEL.name}`;
        tell(`${what}: ${Math.round(bytes / (1 << 20))} of ${Math.round(total / (1 << 20))} MiB…`);
      }});
    } catch (error) {
      return tell(`Search by meaning stays off: ${error.message.replace(/\.$/, '')}. The word search works as before.`);
    }
    if (done.runtime) {
      const {python, version, pythonVersion, made} = done.runtime;
      const where = made ? `a venv Pair made with Python ${pythonVersion}` : 'the venv already in Pair\'s data folder';
      const detail = {output: `${RUNTIME}, its wheel from PyPI by the SHA-256 in src/meaning-runtime.txt\n${tilde(python)}${made ? '\n:Pair find off deletes this venv' : ''}`};
      for (const session of live.values()) session.ledger.add('installed', `LiteRT-LM ${version} for search by meaning, in ${where}`, {detail});
    }
    if (done.model) {
      for (const session of live.values()) session.ledger.add('downloaded', `${MODEL.name} for search by meaning (${mb(MODEL.bytes)} MB, SHA-256 checked); indexing this project in the background`);
    }
    tell('Search by meaning is on: Pair indexes this project in the background.');
  }

  /** `:Pair find off`: the embedder stops, and its model, indexes and the venv Pair made leave Pair's data folder. */
  async function meaningOff(client) {
    const was = meaning.state;
    const {venv} = await meaningTurnOff(); // with an "embedding" model too, the venv Pair made for EmbeddingGemma
    const what = `${config.embedding ? 'indexes' : 'model and indexes'}${venv ? ', and the venv with LiteRT-LM that Pair made' : ''}`;
    if (was === 'on' || venv) for (const session of live.values()) session.ledger.add('deleted', `search by meaning's ${what} (:Pair find off)`);
    const text = config.embedding ? `Search by meaning is off: its ${what} are deleted, and the embedding model is not asked until :Pair find on.` : `Search by meaning is off: its ${what} are deleted.`;
    sendMessage(client.socket, {type: 'meaning_state', ...meaning.snapshot(), text});
  }

  /**
   * `:Pair voice on`: what comes said up front, then voice's Python packages (in search by meaning's venv, PAIR-8's
   * install path: LiteRT-LM first if it lacks it) and LFM3-Omni's one download (4.0 GB), each told as it goes and
   * booked.
   */
  async function voiceOn(client) {
    const tell = text => sendMessage(client.socket, {type: 'voice_state', text});
    if (omniDownload) return tell('LFM3-Omni is downloading already.');
    const missing = omniMissing(config.dataDir);
    const python = pythonOf(config.meaning, config.dataDir);
    const check = omniWith.runtime ?? omniRuntimeOf;
    const needsPackages = !(await check(python)).version;
    const ready = `LFM3-Omni is here: ${usesOmni(config.voice) ? 'hold the listen key and speak' : 'set "voice": {} in the config to hear and speak with it'}.`;
    if (!missing && !needsPackages) return tell(ready);
    // meaning.python is the user's: Pair installs nothing there, and says what to run before it downloads anything.
    if (needsPackages && config.meaning?.python) return tell(`Voice is not ready: ${python} lacks voice's packages, and Pair installs nothing into meaning.python: ${omniInstall(python)}.`);
    const runtime = meaningRuntime ?? new Runtime({dataDir: config.dataDir, python: () => pythonOf(config.meaning, config.dataDir), log});
    const litert = needsPackages && !(await (omniWith.litert ?? venvHasLiteRT)(config.dataDir));
    // No wheels for this machine or this Python: said before anything is downloaded, not after LiteRT-LM and its venv.
    // Without a fitting Python at all, runtime.install() says what is missing, also before it downloads anything.
    const fits = (omniWith.pythonsOn ?? voicePythonsOn)();
    if (needsPackages && !fits.length) return tell(`Voice is not ready: voice's packages have no wheels for ${process.platform} ${process.arch}, only Linux (x86-64, ARM64) and macOS on Apple silicon. Nothing was downloaded.`);
    const venv = needsPackages ? await venvVersion(runtime, litert, fits) : null;
    const wheels = venv?.version ? (omniWith.wheels ?? voiceWheelsOf)(venv.version) : null;
    if (venv?.version && !wheels) {
      const again = !venv.kept ? '' : !madeByPair(config.dataDir) ? ', then remove search by meaning\'s venv, which Pair did not make' : omniReady(config.dataDir) ? ', then :Pair voice off and :Pair find off, so Pair makes its venv again with it' : ', then :Pair find off, so Pair makes its venv again with it';
      return tell(`Voice is not ready: voice's packages have wheels for Python ${fits[0]} to ${fits.at(-1)} here; ${venv.kept ? 'search by meaning\'s venv runs' : 'the Python Pair would make its venv with is'} Python ${venv.version}. Install Python ${fits[0]} or newer (python3.${fits[0].split('.')[1]} is enough)${again}, then :Pair voice on again. Nothing was downloaded.`);
    }
    const mb = bytes => Math.round(bytes / 1e6);
    const fetches = [
      ...(litert ? [`LiteRT-LM ${RUNTIME_VERSION}${runtime.bytes ? ` (${mb(runtime.bytes)} MB from PyPI, SHA-256 pinned)` : ''} in a venv in Pair's data folder, as :Pair find on does`] : []),
      ...(needsPackages ? [`voice's Python packages${wheels ? ` (${mb(wheels.reduce((sum, wheel) => sum + wheel.bytes, 0))} MB from PyPI, SHA-256 pinned)` : ''} into ${litert ? 'that venv' : 'search by meaning\'s venv'}`] : []),
      ...(missing ? [`LFM3-Omni-2B, ${gb(missing)} from Hugging Face (${OMNI.repo}, pinned, SHA-256 checked), whose own speech loop (Python, Apache-2.0) runs as you`] : []),
    ];
    tell(`Voice: installing ${fetches.join(', then ')}, once; :Pair voice off stops it and deletes the model.`);
    const abort = new AbortController();
    omniDownload = {abort};
    let told = 0;
    const progress = what => (bytes, total) => {
      if (bytes - told < (what === 'LFM3-Omni' ? 1e9 : 16e6)) return;
      told = bytes;
      tell(`Downloading ${what}: ${what === 'LFM3-Omni' ? `${gb(bytes)} of ${gb(total)}` : `${Math.round(bytes / 1e6)} of ${Math.round(total / 1e6)} MB`}…`);
    };
    // LiteRT-LM and the venv are booked as soon as they are there, whatever comes after.
    const bookLiteRT = ({python: venv, version, pythonVersion, made}) => {
      const detail = {output: `${RUNTIME}, its wheel from PyPI by the SHA-256 in src/meaning-runtime.txt\n${tilde(venv)}${made ? '\n:Pair find off keeps this venv while LFM3-Omni is here' : ''}`};
      for (const session of live.values()) session.ledger.add('installed', `LiteRT-LM ${version} for voice, in ${made ? `a venv Pair made with Python ${pythonVersion}` : 'the venv already in Pair\'s data folder'}`, {detail});
    };
    try {
      const installed = await (omniWith.install ?? installVoiceRuntime)({
        dataDir: config.dataDir, meaning: config.meaning, runtime,
        fetch: omniWith.fetch, signal: abort.signal, progress: progress('voice\'s packages'), check, installedLiteRT: bookLiteRT,
      });
      if (installed) {
        const detail = {output: `${installed.wheels.join('\n')}\nfrom PyPI by the SHA-256 in src/voice-runtime.txt, into ${tilde(installed.python)}`};
        for (const session of live.values()) session.ledger.add('installed', `voice's Python packages (${Math.round(installed.bytes / 1e6)} MB, SHA-256 pinned) in search by meaning's venv, Python ${installed.version}`, {detail});
      }
      told = 0;
      if (missing) {
        await downloadOmni(config.dataDir, {fetch: omniWith.fetch, free: omniWith.free, files: omniWith.files, signal: abort.signal, progress: progress('LFM3-Omni')});
        for (const session of live.values()) session.ledger.add('downloaded', `LFM3-Omni-2B for voice (${gb(missing)}, revision ${OMNI.revision.slice(0, 7)}, SHA-256 checked)`);
      }
    } catch (error) {
      return tell(`Voice is not ready: ${error.message.replace(/\.$/, '')}.`);
    } finally {
      omniDownload = null;
    }
    tell(ready);
  }

  /**
   * The Python version voice's packages would go to ({version: "3.14", kept}): search by meaning's venv when
   * runtime.install() keeps it (it has LiteRT-LM, or Pair did not make it), else the Python runtime.install() would
   * make it with, one of `prefer` first; version is undefined when there is none, which runtime.install() then explains.
   */
  async function venvVersion(runtime, litert, prefer) {
    const python = venvPython(config.dataDir);
    if (!existsSync(python) || (litert && madeByPair(config.dataDir))) return {version: (await findPython(omniWith.pythons ?? runtime.candidates, prefer)).version, kept: false};
    return new Promise(resolve => execFile(python, ['-I', '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], {timeout: 20_000}, (error, stdout) => resolve({version: error ? undefined : stdout.trim(), kept: true})));
  }

  /** `:Pair voice off`: the helper stops, a download stops, and LFM3-Omni's files leave Pair's data folder. */
  async function voiceOff(client) {
    omniDownload?.abort.abort(new Error('voice was turned off (:Pair voice off)'));
    omni.fail(new Error('LFM3-Omni was deleted (:Pair voice off)'));
    const had = omniMissing(config.dataDir) < OMNI.bytes;
    await removeOmni(config.dataDir);
    if (had) for (const session of live.values()) session.ledger.add('deleted', 'LFM3-Omni-2B, voice\'s model (:Pair voice off)');
    sendMessage(client.socket, {type: 'voice_state', text: `LFM3-Omni is deleted${usesOmni(config.voice) ? ': :Pair voice on downloads it again' : ''}.`});
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

  /**
   * A connection: on the socket, or on the Herdr panel's port (`token`), whose first message must carry the token and
   * which gets the notes' text too (see herdr-panel.mjs).
   */
  function serve(socket, token = null) {
    const client = {socket, role: null, session: null, activeAt: 0, focused: null, ready: Promise.resolve(), panel: token !== null};
    const open = token === null ? () => true : authenticate(socket, token);
    if (client.panel) socket.decorate = panelMessage;
    clients.add(client);
    socket.on('close', () => {
      clients.delete(client);
      meaning.forget(client);
      if (client.session) listeners.get(client.session.root)?.drop(client); // no microphone stays open for a gone editor
      // The last panel that pushed the window's focus went: the window is asked for it again.
      if (client.pushesFocus && ![...clients].some(other => other.pushesFocus && other.core === client.core)) pushFocus(client.core ?? null, null);
      endWhenAlone(client.session);
    });
    socket.on('error', () => {});
    readMessages(socket, message => open(message) && handle(client, message).catch(error => {
      log(`${message.type} failed: ${error.stack ?? error}`);
      sendMessage(socket, {type: 'message', sender: 'system', text: `Error: ${error.message}`, at: Date.now()});
    }));
  }
  const server = createServer(socket => serve(socket));
  let panel = null; // the Herdr panel's port, once open

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
  if (herdrPanel) {
    panel = await startPanelListener({config, accept: (socket, token) => serve(socket, token)})
      .catch(error => { log(`the Herdr panel's port did not open: ${error.message}`); return null; });
    if (panel) log(`the Herdr panel's port: 127.0.0.1:${panel.port} (${panel.file})`);
  }

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
      clearInterval(changesTimer);
      health.stop();
      decision?.stop();
      agents?.stop();
      for (const watch of watches.values()) watch.stop();
      for (const listener of listeners.values()) listener.close();
      omniDownload?.abort.abort(new Error('the daemon stops'));
      omni.close();
      for (const client of clients) client.socket.destroy();
      await Promise.all([new Promise(resolve => server.close(resolve)), panel?.close()]);
      await rebuilt;
      for (const session of live.values()) session.gen.close(); // a request waiting for an answer would hold the Partner open
      await meaning.close();
      await models.partner.close();
      store.close();
      owner.release();
    },
  };
}
