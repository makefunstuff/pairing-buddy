// The chat pane: where the user talks to Pair and reads what it says. In a terminal it is a full-screen pane
// (chat-render.mjs draws it, chat-screen.mjs talks to the terminal, chat-input.mjs is what you type); when its input
// or output is no terminal, or with `pair chat --plain` or TERM=dumb, it is the plain line-by-line pane it always was.
import {execFile} from 'node:child_process';
import {connect} from 'node:net';
import {basename, join} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {clearLine, createInterface, cursorTo} from 'node:readline';
import {agentListLines} from './agent-relay.mjs';
import {openHistory} from './chat-history.mjs';
import {LineEditor} from './chat-input.mjs';
import {remarkKeys, renderFrame, searchText, shownTool, toolDone, transcriptLines} from './chat-render.mjs';
import {KeyDecoder, Screen} from './chat-screen.mjs';
import {dim, formatMessage} from './chat-style.mjs';
import {LEVELS} from './config.mjs';
import {ledgerText} from './ledger.mjs';
import {readMessages, sendMessage} from './protocol.mjs';
import {tmuxOf} from './tmux.mjs';

/** The commands of the chat, as [name, arguments, what it does]: the help, the menu `/` opens, and Tab complete them. */
export const COMMANDS = [
  ['/goal', '<text>', 'set the session goal'],
  ['/level', LEVELS.join('|'), 'how often Pair speaks unasked'],
  ['/quiet', '', 'speak unasked only when it matters'],
  ['/normal', '', 'the usual level'],
  ['/chatty', '', 'speak unasked more often'],
  ['/scout', '', 'Pair may search and run commands in its own pane'],
  ['/navigate', '', 'back to watching and pointing (the default)'],
  ['/drive', '[what]', 'hand Pair the wheel for one change (or say "you take it")'],
  ['/drive!', '[what]', 'let Pair keep the wheel until you take it back'],
  ['/cancel', '', 'stop the answer Pair is working on (Esc)'],
  ['/why', '', 'the one idea worth keeping behind what Pair said last (or ?)'],
  ['/explain', '[n]', 'the same, about remark n of /remarks'],
  ['/remarks', '', 'the last remarks, numbered: +2 or -2 rates the second last'],
  ['/useful', '[n]', 'Pair\'s last remark was useful (or +)'],
  ['/noise', '[n]', 'it was not (or -); a remark you never see counts as not useful too'],
  ['/mute', '[kind]', 'no more remarks of this kind (the last remark\'s) this session'],
  ['/unmute', '[kind]', 'let them speak again (all of them)'],
  ['/undo', '', 'undo Pair\'s last change: an edit of the Driver\'s, a suggestion you took'],
  ['/today', '', 'what Pair did here today'],
  ['/agents', '', 'your other agents and board tasks, the ones that need you first'],
  ['/search', '<text>', 'find in the conversation (Ctrl-F)'],
  ['/copy', '[n]', 'copy Pair\'s last answer (or the nth last) to the clipboard'],
  ['/clear', '', 'clear the pane; the session and its history stay'],
  ['/end', '', 'end the session now with its debrief (it also ends by itself)'],
  ['/first', '<step>', 'tomorrow\'s first step, with a file:line (after the debrief, e edits it)'],
  ['/help', '', 'the keys and the commands (? on an empty line)'],
  ['/quit', '', 'close this pane (the session goes on)'],
];

const HELP = [
  ...COMMANDS.map(([name, args, what]) => `${`${name}${args ? ` ${args}` : ''}`.padEnd(30)} ${what}`),
  `${'anything else'.padEnd(30)} ask Pair; @here asks about what you selected in Neovim`,
].join('\n');

// Saying one of these hands Pair the wheel, the way you would to a person next to you: alone, or followed by
// a request after punctuation ("you take it: set the timeout"). "your turn to explain: ..." stays a question.
const HAND_OVER = /^(you take it|your turn)\s*([.!,:;-]|$)/i;
const HERE = /(^|\s)@here\b/;

/** The parsed form of one typed line: a daemon message, or a local action. */
export function parseInput(line) {
  const text = line.trim();
  if (!text) return null;
  const [command, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ');
  const number = /^[1-9]$/.test(arg) ? Number(arg) : undefined;
  if (command === '/goal' && arg) return {type: 'goal', text: arg};
  if (command === '/first' && arg) return {type: 'first', text: arg};
  if (command === '/level' && LEVELS.includes(arg)) return {type: 'level', level: arg};
  if (['/quiet', '/normal', '/chatty'].includes(command) && !arg) return {type: 'level', level: command.slice(1)};
  if (command === '/scout') return {type: 'role', role: 'scout'};
  if (command === '/navigate') return {type: 'role', role: 'navigator'};
  if (command === '/drive') return {type: 'drive', text: arg};
  if (command === '/drive!') return {type: 'drive', text: arg, keep: true};
  if (command === '/end') return {type: 'end'};
  if (command === '/today') return {type: 'today'};
  if (command === '/agents') return {type: 'agents'};
  if (command === '/cancel') return {type: 'cancel'};
  if (command === '/undo') return {type: 'undo_last'};
  if (command === '/mute') return arg ? {type: 'mute', trigger: arg} : {type: 'mute'};
  if (command === '/unmute') return arg ? {type: 'unmute', trigger: arg} : {type: 'unmute'};
  // +2, -3, /useful 2: a verdict on an older remark, by its number in /remarks.
  const numbered = /^([+-])\s*([1-9])$/.exec(text);
  if (numbered) return {type: 'feedback', useful: numbered[1] === '+', number: Number(numbered[2])};
  if (['/useful', '/noise'].includes(command) && number) return {type: 'feedback', useful: command === '/useful', number};
  if (text === '+' || command === '/useful') return {type: 'feedback', useful: true};
  if (text === '-' || command === '/noise') return {type: 'feedback', useful: false};
  if (command === '/remarks') return {type: 'remarks'};
  if (text === '?' || command === '/why') return {type: 'teach'};
  if (command === '/explain') return number ? {type: 'teach', number} : {type: 'teach'};
  if (command === '/quit') return {local: 'quit'};
  if (command === '/help') return {local: 'help'};
  if (command === '/clear') return {local: 'clear'};
  if (command === '/copy') return number ? {local: 'copy', number} : {local: 'copy'};
  if (command === '/search') return {local: 'search', text: arg};
  if (command.startsWith('/')) return {local: 'unknown', command};
  if (HAND_OVER.test(text)) return {type: 'drive', text};
  return HERE.test(text) ? {type: 'ask', text, here: true} : {type: 'ask', text};
}

const OUTCOMES = {dismissed: 'noise'};
const pad = n => String(n).padStart(2, '0');
/** The time of `at`, with its day when that is not today's. */
function when(at, now) {
  const date = new Date(at);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === new Date(now).toDateString() ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

/** The last remarks (newest first, see PairSession.remarkList) as numbered lines for the chat. */
export function remarkLines(remarks, now = Date.now()) {
  if (!remarks.length) return ['Pair has made no remark here yet.'];
  const width = Math.max(...remarks.map(remark => remark.trigger.length));
  return [
    ...remarks.map((remark, i) => [`${i + 1}`, when(remark.at, now), remark.trigger.padEnd(width), remark.text ?? '(its words were not kept)',
      `(${OUTCOMES[remark.outcome] ?? remark.outcome})`].join('  ')),
    '+2 or -2 rates the second last, and so on',
  ];
}

/** The answer to a "may Pair run this?" question: only y or yes allows it. */
export const allows = line => /^\s*y(es)?\s*$/i.test(line);

const RECONNECT_MS = 1000;

/**
 * The pane's line to the daemon: hello on connect, and when the daemon restarts, waits for it and says hello again
 * with `resume`. `on.message`, `on.lost` (it went away), `on.failed` (it was never there).
 */
function linkDaemon(socketPath, on, {cwd = process.cwd(), env = process.env} = {}) {
  const link = {socket: null, welcomed: false, away: false, closed: false, attempts: 0}; // attempts: to reconnect, since it went away
  link.hello = resume => sendMessage(link.socket, {
    type: 'hello',
    role: 'chat',
    cwd,
    resume,
    herdr: env.HERDR_SOCKET_PATH
      ? {socket: env.HERDR_SOCKET_PATH, workspace: env.HERDR_WORKSPACE_ID, pane: env.HERDR_PANE_ID}
      : null,
    tmux: tmuxOf(env),
  });
  link.send = message => sendMessage(link.socket, message);
  function open() {
    if (link.away) link.attempts += 1;
    link.socket = connect(socketPath);
    link.socket.on('connect', () => link.hello(link.welcomed));
    link.socket.on('error', error => {
      if (!link.welcomed) on.failed(error);
    });
    link.socket.on('close', () => {
      if (!link.welcomed || link.closed) return;
      if (!link.away) on.lost();
      link.away = true;
      setTimeout(open, RECONNECT_MS);
    });
    readMessages(link.socket, message => {
      if (message.type === 'welcome') {
        on.message(message, {reconnected: link.away});
        link.welcomed = true;
        link.away = false;
        link.attempts = 0;
        return;
      }
      on.message(message, {});
    });
  }
  /** Closes the line for good: no reconnecting. */
  link.close = () => {
    link.closed = true;
    link.socket?.destroy();
  };
  open();
  return link;
}

/**
 * Runs the chat pane on `socketPath`. `dataDir` keeps what you sent (Up brings it back); `plain` forces the plain
 * pane. `input` and `output` are the terminal (tests pass streams, with `full` to get the full-screen pane anyway
 * and `size` for its columns and rows); `cwd` and `env` say where it runs (the project, herdr's pane).
 */
export function runChat(socketPath, {dataDir = null, plain = false, full = false, input = process.stdin, output = process.stdout, size = null, cwd = process.cwd(), env = process.env, exit = code => process.exit(code)} = {}) {
  const terminal = input.isTTY && output.isTTY && env.TERM !== 'dumb';
  if (plain || (!terminal && !full)) return runPlainChat(socketPath, {input, output, exit, cwd, env});
  return startChatPane(socketPath, {dataDir, input, output, size, exit, cwd, env});
}

// The plain pane: lines as they come, a readline prompt.

function runPlainChat(socketPath, {input, output, exit, cwd, env}) {
  const rl = createInterface({input, output, prompt: '› '});
  let confirming = null; // the id of the question the next line answers
  let first = null; // tomorrow's first step, which `e` edits, right after the debrief
  let listed = []; // the ids of the remarks /remarks showed last: what +2 and -2 rate
  const look = {accent: null, color: !!output.isTTY && !env.NO_COLOR}; // the accent: the editor's, once it sends it
  const showRole = role => rl.setPrompt(`${role} › `);
  const print = text => {
    clearLine(output, 0);
    cursorTo(output, 0);
    output.write(`${text}\n`);
    rl.prompt(true);
  };
  const say = (sender, text) => print(formatMessage(sender, text, {...look, width: output.columns ?? 0}));

  const link = linkDaemon(socketPath, {
    failed: error => {
      print(`Cannot reach the pair daemon: ${error.message}`);
      exit(1);
    },
    lost: () => say('system', 'the pair daemon went away; reconnecting…'),
    message: onMessage,
  }, {cwd, env});

  function onMessage(message, {reconnected}) {
    if (message.type === 'welcome') {
      look.accent = message.accent ?? look.accent;
      showRole(message.role);
      if (reconnected) say('system', 'reconnected');
      else say('system', `pairing on ${message.root} (${message.level}) · /help`);
      for (const role of ['watcher', 'partner']) {
        if (message.models?.[role]) say('system', `The ${role} model is not answering (${message.models[role]}).`);
      }
    }
    if (message.type === 'health') say('system', message.text);
    if (message.type === 'role') {
      showRole(message.role);
      rl.prompt(true);
    }
    if (message.type === 'confirm') {
      confirming = message.id;
      say('pair', `${message.text} [y/N]`);
    }
    if (message.type === 'confirmed' && message.id === confirming) confirming = null; // answered, or timed out
    if (message.type === 'first' && message.step) {
      first = message.step;
      print(dim('·· e edits tomorrow\'s first step', look));
    }
    if (message.type === 'ledger') print(ledgerText(message).map(line => dim(`·· ${line}`, look)).join('\n'));
    // Another agent's news, at your breakpoint: one line, like the pane's own notes.
    if (message.type === 'agents' && message.item) say('system', `◇ ${message.text}${message.more ? ` (+${message.more} more · /agents)` : ''}`);
    if (message.type === 'agent_list') print(agentListLines(message).join('\n'));
    if (message.type === 'remarks') {
      listed = message.remarks.map(remark => remark.id);
      print(remarkLines(message.remarks).map(line => dim(`·· ${line}`, look)).join('\n'));
    }
    if (message.type === 'accent') look.accent = message.color;
    if (message.type === 'remark') print(dim('·· + useful  - noise', look));
    // What a question's tools did, one dim line each, as they happen.
    if (message.type === 'tool' && shownTool(message.tool)) print(dim(`  ⎿ ${toolDone(message.tool, message.what)}`, look));
    // What you type is already on screen; your own lines come back only as history.
    const echo = message.sender === 'user' && !message.history;
    if (message.type === 'message' && !echo) say(message.sender, message.text);
    if (message.type === 'ended') {
      say('system', `session ended${message.why ? ` by itself: ${message.why}` : ''}`);
      link.hello(false); // starts the next session, which asks for its goal
    }
  }

  rl.on('line', line => {
    if (confirming !== null) {
      link.send({type: 'confirm', id: confirming, ok: allows(line), text: line.trim()});
      confirming = null;
      return rl.prompt();
    }
    // `e` right after the debrief puts its first step on the line, to edit and send with Enter.
    const editing = first !== null && line.trim() === 'e';
    const step = first;
    first = null;
    if (editing) {
      rl.prompt();
      return rl.write(`/first ${step}`);
    }
    const input = parseInput(line);
    if (input?.local === 'quit') return rl.close();
    if (input?.local === 'help') print(HELP);
    else if (input?.local === 'unknown') print(dim(`·· there is no ${input.command}; /help lists the commands`, look));
    else if (input?.local) print(dim(`·· ${line.trim().split(/\s+/)[0]} works in the full-screen pane only`, look));
    else if (input && link.away) say('system', 'not sent: the daemon is not back yet');
    else if (input?.number && input.type === 'feedback' && listed[input.number - 1]) link.send({...input, remark: listed[input.number - 1]});
    else if (input) link.send(input);
    rl.prompt();
  });
  // Typing here counts as typing too, so Pair does not speak up in the middle of your question.
  let typingSent = 0;
  input.on('keypress', () => {
    if (Date.now() - typingSent < 500) return;
    typingSent = Date.now();
    link.send({type: 'event', event: {kind: 'typing'}});
  });
  rl.on('close', () => { link.close(); exit(0); });
  rl.prompt();
}

// The full-screen pane.

const KIND_OF = {user: 'you', pair: 'pair', system: 'system'};
const BUSY = new Set(['thinking', 'tool']);
const FLASH_MS = 2500;
const MAX_FILES = 20_000;

/** The project's files for @ completion: git's list, else none. */
function projectFiles(root) {
  return new Promise(resolve => {
    execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {cwd: root, maxBuffer: 32 * 1024 * 1024}, (error, stdout) => {
      resolve(error ? [] : stdout.split('\n').filter(Boolean).slice(0, MAX_FILES));
    });
  });
}

/** The files of `files` that `query` picks: those that start with it, then those with it in their name, then the rest that have its letters in order. */
export function pickFiles(files, query, limit = 6) {
  const q = query.toLowerCase();
  const scored = [];
  for (const file of files) {
    const f = file.toLowerCase();
    const name = f.slice(f.lastIndexOf('/') + 1);
    let score;
    if (f.startsWith(q)) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (f.includes(q)) score = 2;
    else {
      let i = 0;
      for (const char of f) if (char === q[i]) i += 1;
      if (i < q.length) continue;
      score = 3;
    }
    scored.push([score, file.length, file]);
    if (scored.length > 2000) break;
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, limit).map(([, , file]) => file);
}

/**
 * The full-screen pane on `socketPath`: returns the pane, whose `frame()` is what it shows now, as plain lines
 * (for tests), and `key(sequence)` feeds it keys as the terminal would.
 */
export function startChatPane(socketPath, {dataDir = null, input, output, size = null, exit, cwd = process.cwd(), env = process.env}) {
  const color = Boolean(output.isTTY) && !env.NO_COLOR;
  const look = {accent: null, color};
  const measure = size ?? (() => ({width: output.columns ?? 80, height: output.rows ?? 24}));
  const screen = new Screen(output, {mouse: true, tmux: Boolean(env.TMUX)});
  const decoder = new KeyDecoder();
  const history = dataDir ? openHistory(join(dataDir, 'chat-history.json')) : null;
  const editor = new LineEditor();
  const state = {
    entries: [],
    header: {project: basename(cwd), goal: null, role: null, level: null, muted: []},
    root: null,
    model: null,
    connection: 'connecting',
    activity: {state: 'idle'},
    presence: null,
    turn: null,
    down: [], // the roles whose model is not answering
    mode: 'idle', // idle, select, search, help
    selected: -1,
    scroll: 0, // lines scrolled up from the bottom; 0 follows what comes
    total: 0,
    search: '',
    found: -1, // the match you are on, by its number in the selected message
    awaySince: null, // when the daemon went away
    helpScroll: 0,
    menuChosen: 0,
    menuClosedFor: null, // the text the menu was closed for with Esc
    confirming: null, // the id of the question Pair asks
    first: null, // tomorrow's first step, which `e` edits right after the debrief
    listed: [], // the ids of the remarks /remarks showed last
    about: null, // the remark a follow-up is about: {id, text}
    files: [],
    flash: null, // a short note in the footer: {text, until}
    ctrlC: 0,
    frame: 0,
    last: {lines: [], transcript: {ranges: [], height: 0, total: 0}},
  };
  let nextId = 1;
  let turnFrom = 1; // the first entry of Pair's turn now: what came since it started

  const add = entry => {
    state.entries.push({id: nextId++, at: Date.now(), ...entry});
    return state.entries.at(-1);
  };
  const note = (text, kind = 'system') => add({kind, text});
  const flash = text => {
    state.flash = {text, until: Date.now() + FLASH_MS};
    setTimeout(render, FLASH_MS + 50).unref?.();
  };
  const busy = () => BUSY.has(state.activity.state);
  const partialIndex = () => state.entries.findLastIndex(entry => entry.partial);
  const dropPartial = () => {
    const i = partialIndex();
    if (i !== -1) state.entries.splice(i, 1);
  };
  /** Whether Pair's question for the goal is the last word on it: asked, and nothing you typed since. */
  const goalAsked = () => {
    const lastYou = state.entries.findLastIndex(entry => entry.kind === 'you');
    return state.entries.findLastIndex(entry => entry.meta?.goal === 'ask' || /^What are we doing this session\?/.test(entry.text ?? '')) > lastYou;
  };
  const latestRemark = () => state.entries.findLastIndex(entry => entry.meta?.trigger && entry.kind === 'watch');
  /**
   * The remark whose keys work at once (+ - a j on an empty line): the last one, unrated, while it is the last thing
   * said (the pane's notes, such as the tests on save, may follow it, but not a list such as /remarks, whose +2 must
   * type); -1 when there is none. Its last line shows those keys.
   */
  const liveRemark = () => {
    const i = latestRemark();
    if (i === -1 || state.entries[i].verdict) return -1;
    return state.entries.slice(i + 1).every(entry => ['system', 'error'].includes(entry.kind)) ? i : -1;
  };

  /** A message from the daemon as an entry: who speaks, and what the pane shows it with. */
  function entryOf(message) {
    const meta = message.meta ?? {};
    let kind = KIND_OF[message.sender] ?? 'system';
    if (kind === 'pair' && meta.trigger) kind = 'watch';
    if (kind === 'system' && meta.error) kind = 'error';
    const about = meta.about ? state.entries.find(entry => entry.meta?.remark === meta.about && entry.kind === 'watch') : null;
    return {kind, text: message.text, at: message.at ?? Date.now(), meta, aboutText: about?.text.split('\n')[0]};
  }

  function onMessage(message, {reconnected = false} = {}) {
    switch (message.type) {
      case 'welcome': {
        look.accent = message.accent ?? look.accent;
        state.connection = 'up';
        state.root = message.root;
        state.header = {...state.header, project: basename(message.root), goal: message.goal ?? null, role: message.role, level: message.level, muted: message.muted ?? []};
        state.model = message.model ?? null;
        state.down = Object.entries(message.models ?? {}).filter(([, why]) => why).map(([role]) => role);
        if (!reconnected) {
          if (history) editor.history = history.of(message.root);
          projectFiles(message.root).then(files => { state.files = files; });
          for (const role of state.down) note(`The ${role} model is not answering (${message.models[role]}). \`pair doctor\` checks it.`, 'error');
        }
        break;
      }
      case 'health':
        state.down = Object.entries(message.models ?? {}).filter(([, why]) => why).map(([role]) => role);
        note(message.text, state.down.length ? 'error' : 'system');
        break;
      case 'role':
        state.header.role = message.role;
        break;
      case 'goal':
        state.header.goal = message.goal;
        break;
      case 'level':
        state.header.level = message.level;
        break;
      case 'muted':
        state.header.muted = message.kinds ?? [];
        break;
      case 'accent':
        look.accent = message.color;
        break;
      case 'activity':
        if (state.activity.state === 'idle' && message.state !== 'idle') turnFrom = nextId; // a turn starts
        state.activity = message;
        if (message.state === 'idle') dropPartial();
        break;
      case 'presence':
        state.presence = message;
        break;
      case 'turn': {
        if (message.asked) state.turn = message;
        dropPartial();
        // What the turn took goes in the margin of the first thing Pair said in it (a wide pane has room for it there).
        const said = state.entries.find(entry => entry.id >= turnFrom && ['pair', 'watch'].includes(entry.kind));
        if (said && !message.cancelled) said.turn = {ms: message.ms, tokens: message.tokens};
        turnFrom = nextId;
        break;
      }
      case 'partial': {
        const i = partialIndex();
        if (!message.text) dropPartial();
        else if (i !== -1) state.entries[i].text = message.text;
        else add({kind: 'pair', text: message.text, partial: true});
        break;
      }
      case 'tool': {
        if (!shownTool(message.tool)) break;
        const last = state.entries.at(-1);
        const tools = last?.kind === 'tool' ? last : state.entries.at(-2)?.kind === 'tool' && last?.partial ? state.entries.at(-2) : add({kind: 'tool', tools: []});
        tools.tools.push({tool: message.tool, what: message.what});
        break;
      }
      case 'confirm':
        state.confirming = message.id;
        add({kind: 'confirm', text: message.text, confirm: message.id, ...(message.command ? {command: message.command} : {})});
        break;
      case 'confirmed': {
        if (message.id === state.confirming) state.confirming = null;
        const entry = state.entries.find(e => e.confirm === message.id);
        if (entry && entry.answer === undefined) entry.answer = false; // it timed out
        break;
      }
      case 'first':
        if (message.step) {
          state.first = message.step;
          note('e edits tomorrow\'s first step');
        }
        break;
      case 'ledger':
        add({kind: 'note', text: ledgerText(message).join('\n')});
        break;
      case 'agents':
        if (message.item) note(`◇ ${message.text}${message.more ? ` (+${message.more} more · /agents)` : ''}`);
        break;
      case 'agent_list':
        add({kind: 'note', text: agentListLines(message).join('\n')});
        break;
      case 'remarks':
        state.listed = message.remarks.map(remark => remark.id);
        add({kind: 'note', text: remarkLines(message.remarks).join('\n')});
        break;
      case 'message': {
        // The goal, said again: the header shows it. Only when Pair's question for it is still open (the goal was
        // set elsewhere: :Pair goal, the board) does the note stay, to answer it.
        if (message.meta?.goal === 'set' && !goalAsked()) break;
        const entry = entryOf(message);
        if (message.sender === 'user' && !message.history) {
          // What you sent is on screen already: the daemon's copy takes its place, with the lines it is about.
          const mine = state.entries.find(e => e.pending);
          if (mine) {
            Object.assign(mine, entry, {pending: false});
            break;
          }
        }
        const i = partialIndex();
        if (i !== -1 && entry.kind !== 'you') {
          const partial = state.entries[i];
          // The answer that streamed: the whole of it in its place.
          if (entry.kind === 'pair' && entry.text.startsWith(partial.text.slice(0, 24))) {
            state.entries[i] = {...partial, ...entry, partial: false};
            break;
          }
          state.entries.splice(i, 0, {id: nextId++, ...entry});
          break;
        }
        add(entry);
        break;
      }
      case 'applied': {
        const entry = state.entries.find(e => e.meta?.suggestion?.action === message.action);
        if (entry) entry.applied = true;
        flash('Taken in Neovim, unsaved: u there undoes it, /undo here');
        break;
      }
      case 'ended':
        note(`session ended${message.why ? ` by itself: ${message.why}` : ''}`);
        link.hello(false);
        break;
      default:
        return;
    }
    render();
  }

  // Sending.

  function send(message) {
    if (state.connection !== 'up') {
      flash('Not sent: the daemon is not back yet. What you typed is kept; Enter sends it once it is');
      return false;
    }
    link.send(message);
    return true;
  }

  function submit() {
    const text = editor.text;
    if (!text.trim()) return;
    if (state.confirming !== null) {
      answer(text);
      editor.clear();
      return;
    }
    // `e` right after the debrief puts its first step on the line, to edit and send with Enter.
    if (state.first !== null && text.trim() === 'e') {
      editor.set(`/first ${state.first}`);
      state.first = null;
      return;
    }
    state.first = null;
    const parsed = parseInput(text);
    if (!parsed) return;
    if (parsed.local) return local(parsed, text);
    if (state.connection !== 'up') return send(parsed);
    editor.take();
    if (state.root) history?.add(state.root, text);
    if (parsed.type === 'ask' || (parsed.type === 'drive' && parsed.text)) {
      const about = state.about;
      add({kind: 'you', text: parsed.text, pending: true, meta: about ? {about: about.id} : {}, aboutText: about?.text});
      if (about && parsed.type === 'ask') parsed.about = about.id;
      state.about = null;
      state.scroll = 0;
    }
    if (parsed.type === 'feedback') rated(parsed);
    send(parsed.type === 'feedback' && parsed.number && state.listed[parsed.number - 1] ? {...parsed, remark: state.listed[parsed.number - 1]} : parsed);
  }

  /** Marks the remark a verdict is about as rated, on screen. */
  function rated({useful, remark, number}) {
    const id = remark ?? (number ? state.listed[number - 1] : null);
    const i = id ? state.entries.findLastIndex(entry => entry.meta?.remark === id) : latestRemark();
    if (i !== -1) state.entries.filter(entry => entry.meta?.remark === state.entries[i].meta.remark).forEach(entry => { entry.verdict = useful ? 'useful' : 'noise'; });
  }

  function answer(text) {
    const ok = allows(text);
    send({type: 'confirm', id: state.confirming, ok, text: text.trim()});
    const entry = state.entries.find(e => e.confirm === state.confirming);
    if (entry) entry.answer = ok;
    state.confirming = null;
  }

  function local(parsed, text) {
    editor.take();
    if (parsed.local === 'quit') return quit(0);
    if (parsed.local === 'help') return openHelp();
    if (parsed.local === 'clear') {
      state.entries = [];
      state.selected = -1;
      state.scroll = 0;
      return;
    }
    if (parsed.local === 'copy') {
      const answers = state.entries.filter(entry => ['pair', 'watch'].includes(entry.kind) && !entry.partial);
      const entry = answers[answers.length - (parsed.number ?? 1)];
      return entry ? copy(entry) : flash('Pair has said nothing to copy yet');
    }
    if (parsed.local === 'search') return openSearch(parsed.text);
    note(`There is no ${parsed.command}: / lists the commands. "${text.trim()}" is still below to fix.`, 'error');
    editor.set(text);
  }

  function copy(entry) {
    screen.copy(searchText(entry));
    flash('Copied, through the terminal\'s clipboard (OSC 52)');
  }

  function quit(code) {
    screen.stop();
    if (input.isTTY) input.setRawMode?.(false);
    link.close();
    exit(code);
  }

  // Modes.

  function openHelp() {
    state.mode = 'help';
    state.helpScroll = 0;
  }

  function openSearch(text = '') {
    state.mode = 'search';
    state.search = text;
    state.searchNote = '';
    findMatch(-1, true);
  }

  /**
   * Goes to the next match of the search (by `step`, -1 older), from the one you are on; `fromEnd`, to the newest.
   * Matches are counted as the pane shows them, so ↑ and ↓ step through each of them, not message by message.
   */
  function findMatch(step, fromEnd = false) {
    if (!state.search) {
      state.searchNote = '';
      return;
    }
    const {ranges} = transcriptLines(state.entries, measure().width, {query: state.search});
    const hits = ranges.flatMap(({matches}, i) => Array.from({length: matches}, (_, nth) => [i, nth]));
    if (!hits.length) {
      state.searchNote = 'no match';
      return;
    }
    const at = hits.findIndex(([i, nth]) => i === state.selected && nth === state.found);
    const next = fromEnd || at === -1 ? hits.length - 1 : (at + step + hits.length) % hits.length;
    [state.selected, state.found] = hits[next];
    const messages = ranges.filter(range => range.matches).length;
    state.searchNote = `${next + 1} of ${hits.length} · in ${messages} message${messages === 1 ? '' : 's'}`;
  }

  /** Selects the message `by` away from the selected one (-1: older); none selected, the newest. */
  function selectBy(by) {
    if (!state.entries.length) return;
    state.found = -1;
    if (state.selected === -1) state.selected = state.entries.length - 1;
    else state.selected = Math.max(0, Math.min(state.entries.length - 1, state.selected + by));
    state.mode = 'select';
  }

  function deselect() {
    state.selected = -1;
    state.found = -1;
    if (state.mode === 'select') state.mode = 'idle';
  }

  /** The keys on a selected message. True when the key was one of them. */
  function act(key) {
    const entry = state.entries[state.selected];
    if (!entry) return false;
    const {meta = {}} = entry;
    const name = key.name;
    if (name === 'c') copy(entry);
    else if (name === 'a' && meta.suggestion) {
      send({type: 'accept', action: meta.suggestion.action}); // Neovim says when it took it (applied)
    } else if (name === 'j' && meta.place) {
      if (send({type: 'go', file: meta.place.file, line: meta.place.line})) flash(`Neovim goes to ${meta.place.file}:${meta.place.line}; Ctrl-O comes back`);
    } else if ((name === '+' || name === '-') && meta.remark) {
      rated({useful: name === '+', remark: meta.remark});
      send({type: 'feedback', useful: name === '+', remark: meta.remark});
    } else if (name === 'm' && meta.trigger) send({type: 'mute', trigger: meta.trigger});
    else if (name === 'f' && meta.remark) {
      state.about = {id: meta.remark, text: entry.text.split('\n')[0]};
      deselect();
    } else if (name === 'e' && meta.remark) send({type: 'teach', remark: meta.remark});
    else if (name === 'enter') entry.expanded = !entry.expanded;
    else return false;
    return true;
  }

  /** A key of the last remark's action line (+ - a j). True when it acted. */
  function remarkKey(name) {
    const i = liveRemark();
    if (i === -1) return false;
    const {meta} = state.entries[i];
    const {apply, jump} = remarkKeys(state.entries, i);
    if (name === '+' || name === '-') {
      rated({useful: name === '+', remark: meta.remark});
      send({type: 'feedback', useful: name === '+', remark: meta.remark});
    } else if (name === 'a' && apply) send({type: 'accept', action: apply.meta.suggestion.action});
    else if (name === 'j' && jump) {
      const {file, line} = jump.meta.place;
      if (send({type: 'go', file, line})) flash(`Neovim goes to ${file}:${line}; Ctrl-O comes back`);
    } else return false;
    return true;
  }

  // The menu over the input: commands after /, files after @.

  function menu() {
    if (state.mode !== 'idle' || state.menuClosedFor === editor.text) return null;
    if (/^\/\S*$/.test(editor.text)) {
      const items = COMMANDS.filter(([name]) => name.startsWith(editor.text)).map(([name, args, what]) => ({label: name, args, detail: what, value: name}));
      return items.length && !(items.length === 1 && items[0].value === editor.text && !items[0].args) ? {kind: 'command', items} : null;
    }
    const word = editor.word();
    if (word.text.startsWith('@') && editor.cursor === word.end) {
      const query = word.text.slice(1);
      const here = 'here'.startsWith(query) ? [{label: '@here', detail: 'what you selected in Neovim, else your line', value: '@here'}] : [];
      const files = pickFiles(state.files, query, 6 - here.length).map(file => ({label: `@${file}`, value: `@${file}`}));
      const items = [...here, ...files];
      // A word already whole needs no menu: Enter sends.
      return items.length && !items.some(item => item.value === word.text) ? {kind: 'file', items} : null;
    }
    return null;
  }

  /** Takes the menu's chosen item; `run` also sends a command that needs nothing more. */
  function complete(open, run) {
    const item = open.items[Math.min(state.menuChosen, open.items.length - 1)];
    state.menuChosen = 0;
    if (open.kind === 'file') return editor.replaceWord(`${item.value} `);
    if (run && !item.args) {
      editor.set(item.value);
      return submit();
    }
    editor.set(item.args ? `${item.value} ` : item.value);
  }

  // Keys.

  function onKey(key) {
    if (key.mouse) return onMouse(key);
    if (key.paste !== undefined) {
      if (state.mode === 'search') state.search += key.paste.replace(/\n/g, ' ');
      else {
        if (state.mode !== 'idle') deselect();
        editor.insert(key.paste);
      }
      return;
    }
    const {name, ctrl, meta} = key;
    if (ctrl && name === 'c') return ctrlC();
    if (ctrl && name === 'l') return screen.invalidate();
    if (ctrl && name === 'd' && editor.empty) return quit(0);
    if (state.mode === 'help') {
      if (name === 'down' || name === 'pagedown') state.helpScroll += name === 'down' ? 1 : 10;
      else if (name === 'up' || name === 'pageup') state.helpScroll = Math.max(0, state.helpScroll - (name === 'up' ? 1 : 10));
      else state.mode = 'idle';
      return;
    }
    if (state.mode === 'search') return searchKey(key);
    if (meta && name === 'up') return selectBy(-1);
    if (meta && name === 'down') return selectBy(1);
    if (meta && name === 'l') return cycleLevel();
    if (meta && name === 'm') {
      screen.setMouse(!screen.mouse);
      return flash(screen.mouse ? 'The mouse wheel scrolls the pane' : 'Mouse off: select text with it; Alt-M turns it on again');
    }
    if (ctrl && name === 'f') return openSearch();
    if (name === 'pageup' || name === 'pagedown') return scrollBy(name === 'pageup' ? 1 : -1, Math.max(1, Math.floor(state.last.transcript.height / 2)));
    if (state.mode === 'select') {
      if (name === 'escape') return deselect();
      if (!meta && !ctrl && (name === 'up' || name === 'down')) return selectBy(name === 'up' ? -1 : 1);
      if (!meta && !ctrl && act(key)) return;
      deselect();
    }
    const open = menu();
    if (open) {
      if (name === 'up' || name === 'down') {
        state.menuChosen = (state.menuChosen + (name === 'up' ? -1 : 1) + open.items.length) % open.items.length;
        return;
      }
      if (name === 'tab') return complete(open, false);
      if (name === 'enter' && !meta && !key.shift) return complete(open, open.kind === 'command');
      if (name === 'escape') {
        state.menuClosedFor = editor.text;
        return;
      }
    }
    if (name === 'escape') {
      if (state.confirming !== null) {
        answer('n');
        return editor.clear(); // what you had typed answered nothing: it is not sent later as a question
      }
      if (busy() || state.activity.state === 'remark') return send({type: 'cancel'});
      if (state.about) state.about = null;
      return;
    }
    // Pair asks: y or n on an empty line answers at once.
    if (state.confirming !== null && editor.empty && !ctrl && !meta && /^[yYnN]$/.test(name)) return answer(name);
    if (name === '?' && editor.empty && !ctrl && !meta) return openHelp();
    // The keys on the last remark's action line act at once, on an empty line, while it is the last thing said.
    if (editor.empty && !ctrl && !meta && state.confirming === null && ['+', '-', 'a', 'j'].includes(name) && remarkKey(name)) return;
    if (name === 'enter' && (meta || key.shift)) return editor.insert('\n');
    if (ctrl && name === 'j') return editor.insert('\n');
    if (name === 'enter') return submit();
    if (name === 'end' && editor.empty) {
      state.scroll = 0;
      return;
    }
    if (name === 'home' && editor.empty) {
      state.scroll = Math.max(0, state.total - state.last.transcript.height);
      return;
    }
    edit(key);
    state.menuChosen = state.menuChosen && menu() ? state.menuChosen : 0;
  }

  function edit({name, ctrl, meta}) {
    if (ctrl && name === 'a') return editor.home();
    if (ctrl && name === 'e') return editor.end();
    if (ctrl && name === 'u') return editor.killToStart();
    if (ctrl && name === 'k') return editor.killToEnd();
    if ((ctrl && name === 'w') || (meta && name === 'backspace')) return editor.deleteWordBack();
    if ((meta && name === 'b') || (ctrl && name === 'left')) return editor.wordLeft();
    if ((meta && name === 'f') || (ctrl && name === 'right')) return editor.wordRight();
    if (ctrl || meta) return;
    if (name === 'backspace') return editor.backspace();
    if (name === 'delete') return editor.delete();
    if (name === 'left') return editor.left();
    if (name === 'right') return editor.right();
    if (name === 'home') return editor.home();
    if (name === 'end') return editor.end();
    if (name === 'up') return editor.up();
    if (name === 'down') return editor.down();
    if (name === 'tab' || name === 'escape') return;
    if (name === 'space') return editor.insert(' ');
    if ([...name].length === 1) editor.insert(name);
  }

  function searchKey({name, ctrl, meta}) {
    if (name === 'escape') {
      state.mode = 'idle';
      state.search = '';
      state.selected = -1;
      state.found = -1;
      return;
    }
    if (name === 'enter') {
      state.mode = state.selected === -1 ? 'idle' : 'select';
      state.query = state.search;
      return;
    }
    if (name === 'up' || (ctrl && name === 'p')) return findMatch(-1);
    if (name === 'down' || (ctrl && name === 'n')) return findMatch(1);
    if (name === 'backspace') state.search = state.search.slice(0, -1);
    else if (!ctrl && !meta && [...name].length === 1) state.search += name;
    else if (name === 'space') state.search += ' ';
    findMatch(-1, true);
  }

  function ctrlC() {
    if (busy()) return send({type: 'cancel'});
    if (!editor.empty || state.about || state.mode !== 'idle') {
      editor.clear();
      state.about = null;
      state.mode = 'idle';
      state.selected = -1;
      return;
    }
    if (Date.now() - state.ctrlC < 2000) return quit(0);
    state.ctrlC = Date.now();
    flash('Ctrl-C again closes the pane; the session goes on');
  }

  function cycleLevel() {
    const level = LEVELS[(LEVELS.indexOf(state.header.level) + 1) % LEVELS.length];
    send({type: 'level', level});
  }

  function scrollBy(direction, lines) {
    const most = Math.max(0, state.total - state.last.transcript.height);
    state.scroll = Math.max(0, Math.min(most, state.scroll + direction * lines));
  }

  function onMouse({mouse, y}) {
    if (mouse === 'wheelup') return scrollBy(1, 3);
    if (mouse === 'wheeldown') return scrollBy(-1, 3);
    // A click on a message selects it.
    const {transcript} = state.last;
    const top = 1; // the header, in its rule
    const row = y - 1 - top;
    if (row < 0 || row >= transcript.height) return;
    const end = Math.max(0, transcript.total - state.scroll);
    const line = Math.max(0, end - transcript.height) + row - Math.max(0, transcript.height - end);
    const index = transcript.ranges.findIndex(range => line >= range.start && line < range.end);
    if (index === -1) return deselect();
    state.selected = index;
    state.found = -1;
    state.mode = 'select';
  }

  // Drawing.

  function view() {
    const open = menu();
    if (open) state.menuChosen = Math.min(state.menuChosen, open.items.length - 1);
    const askedForGoal = !state.header.goal && goalAsked();
    const selectedEntry = state.entries[state.selected];
    return {
      header: state.header,
      entries: state.entries,
      selected: state.selected,
      latestRemark: liveRemark(),
      scroll: state.scroll,
      editor,
      mode: open && state.mode === 'idle' ? 'menu' : state.mode,
      menu: open ? {kind: open.kind, items: open.items, chosen: state.menuChosen} : null,
      search: state.search,
      searchNote: state.searchNote,
      found: state.found,
      query: state.mode === 'select' ? state.query : '',
      helpScroll: state.helpScroll,
      commands: COMMANDS,
      activity: state.activity,
      presence: state.presence,
      connection: state.connection,
      away: state.connection === 'away' ? {since: state.awaySince, attempts: link.attempts} : null,
      turn: state.turn,
      model: state.down.length ? `⚠ ${state.down.join(', ')} not answering` : state.model,
      role: state.header.role,
      now: Date.now(),
      frame: state.frame,
      confirming: state.confirming !== null,
      about: state.about?.text,
      busy: busy(),
      editorEmpty: editor.empty,
      selectedEntry: selectedEntry && {...selectedEntry, folded: Boolean(state.last.transcript.ranges[state.selected]?.folded)},
      showEmpty: !state.entries.some(entry => ['you', 'pair', 'watch', 'tool', 'confirm'].includes(entry.kind) && !entry.meta?.greeting), // Pair's greeting goes with the card
      writing: partialIndex() !== -1,
      placeholder: state.connection === 'away' ? 'what you type is kept; Enter sends once it is back'
        : state.confirming !== null ? 'or type an answer'
        : askedForGoal ? 'the session\'s goal, or "later"'
          : busy() ? 'type ahead' : 'Ask Pair anything · / for commands',
    };
  }

  let scheduled = false;
  function render() {
    if (scheduled) return;
    scheduled = true;
    setImmediate(draw);
  }

  function draw() {
    scheduled = false;
    if (!screen.on) return;
    const {width, height} = measure();
    const v = view();
    let frame = renderFrame(v, {width, height, look});
    // New lines below while you read further up: what you read stays where it is.
    if (state.scroll > 0 && frame.transcript.total > state.total) {
      state.scroll += frame.transcript.total - state.total;
      frame = renderFrame({...v, scroll: state.scroll}, {width, height, look});
    }
    // The selected message in sight; the match you are on, when the message is taller than the pane.
    const whole = frame.transcript.ranges[state.selected];
    const range = whole?.found !== undefined && whole.end - whole.start > frame.transcript.height ? {start: whole.found, end: whole.found + 1} : whole;
    if (range) {
      const end = frame.transcript.total - state.scroll;
      const start = end - frame.transcript.height;
      let scroll = state.scroll;
      if (range.start < start) scroll = frame.transcript.total - range.start - frame.transcript.height;
      else if (range.end > end) scroll = frame.transcript.total - range.end;
      scroll = Math.max(0, Math.min(scroll, Math.max(0, frame.transcript.total - frame.transcript.height)));
      if (scroll !== state.scroll) {
        state.scroll = scroll;
        frame = renderFrame({...v, scroll}, {width, height, look});
      }
    }
    state.total = frame.transcript.total;
    if (state.flash && state.flash.until > Date.now()) {
      frame.lines[frame.lines.length - 1] = ` ${state.flash.text}`; // body text: it speaks to you
    }
    state.last = frame;
    screen.draw(frame.lines, frame.cursor);
  }

  // Typing here counts as typing too, so Pair does not speak up in the middle of your question.
  let typingSent = 0;
  const utf8 = new StringDecoder('utf8'); // a character split across two reads stays whole
  input.on('data', data => {
    for (const key of decoder.feed(typeof data === 'string' ? data : utf8.write(data))) {
      onKey(key);
      if (!key.mouse && Date.now() - typingSent > 500 && state.connection === 'up') {
        typingSent = Date.now();
        link.send({type: 'event', event: {kind: 'typing'}});
      }
    }
    render();
  });

  const link = linkDaemon(socketPath, {
    failed: error => {
      screen.stop();
      output.write(`Cannot reach the pair daemon: ${error.message}\n`);
      exit(1);
    },
    lost: () => {
      state.connection = 'away';
      state.awaySince = Date.now();
      render();
    },
    message: onMessage,
  }, {cwd, env});

  screen.start();
  if (input.isTTY) input.setRawMode?.(true);
  input.resume?.();
  output.on?.('resize', () => {
    screen.invalidate();
    render();
  });
  // The spinner turns while Pair works; the "2m ago" of the status row moves on.
  const ticker = setInterval(() => {
    state.frame += 1;
    if (busy() || state.activity.state === 'remark' || state.connection !== 'up' || state.frame % 40 === 0) render();
  }, 250);
  ticker.unref?.();
  const restore = () => screen.stop();
  process.once('exit', restore);
  render();

  return {
    /** What the pane shows now, as plain lines. */
    frame: () => state.last.lines,
    /** Feeds `data` as if typed. */
    key: data => input.emit('data', Buffer.from(data)),
    state,
    close: () => {
      clearInterval(ticker);
      process.removeListener('exit', restore);
      screen.stop();
      link.close();
    },
  };
}
