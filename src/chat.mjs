// The chat pane: where the user talks to Pair and reads what it says.
import {connect} from 'node:net';
import {clearLine, createInterface, cursorTo} from 'node:readline';
import {agentListLines} from './agent-relay.mjs';
import {dim, formatMessage} from './chat-style.mjs';
import {LEVELS} from './config.mjs';
import {ledgerText} from './ledger.mjs';
import {readMessages, sendMessage} from './protocol.mjs';

const HELP = `/goal <text>   set the session goal
/level ${LEVELS.join('|')}   how often Pair speaks unasked
/scout         Pair may search and run commands in its own pane
/navigate      back to watching and pointing (the default)
/drive [what]  hand Pair the wheel for one change (or say "you take it" or "your turn")
+  or /useful  Pair's last remark was useful
-  or /noise   it was not (a remark you never see counts as not useful too)
/today         what Pair did here today
?  or /why     the one idea worth keeping behind what Pair said last
/agents        your other agents and board tasks, the ones that need you first
/end           end the session now and write a session note (it also ends by itself)
/quit          close this pane (the session goes on)
anything else  ask Pair`;

// Saying one of these hands Pair the wheel, the way you would to a person next to you: alone, or followed by
// a request after punctuation ("you take it: set the timeout"). "your turn to explain: ..." stays a question.
const HAND_OVER = /^(you take it|your turn)\s*([.!,:;-]|$)/i;

/** The parsed form of one typed line: a daemon message, or a local action. */
export function parseInput(line) {
  const text = line.trim();
  if (!text) return null;
  const [command, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ');
  if (command === '/goal' && arg) return {type: 'goal', text: arg};
  if (command === '/level' && LEVELS.includes(arg)) return {type: 'level', level: arg};
  if (command === '/scout') return {type: 'role', role: 'scout'};
  if (command === '/navigate') return {type: 'role', role: 'navigator'};
  if (command === '/drive') return {type: 'drive', text: arg};
  if (command === '/end') return {type: 'end'};
  if (command === '/today') return {type: 'today'};
  if (command === '/agents') return {type: 'agents'};
  if (text === '+' || command === '/useful') return {type: 'feedback', useful: true};
  if (text === '-' || command === '/noise') return {type: 'feedback', useful: false};
  if (text === '?' || command === '/why') return {type: 'teach'};
  if (command === '/quit') return {local: 'quit'};
  if (command.startsWith('/')) return {local: 'help'};
  if (HAND_OVER.test(text)) return {type: 'drive', text};
  return {type: 'ask', text};
}

/** The answer to a "may Pair run this?" question: only y or yes allows it. */
export const allows = line => /^\s*y(es)?\s*$/i.test(line);

const RECONNECT_MS = 1000;

export function runChat(socketPath) {
  let socket;
  let welcomed = false; // the daemon has greeted this pane once: a reconnect skips the history it shows
  let away = false; // the daemon went away and the pane is reconnecting
  const rl = createInterface({input: process.stdin, output: process.stdout, prompt: '› '});
  let confirming = null; // the id of the question the next line answers
  const look = {accent: null, color: !!process.stdout.isTTY && !process.env.NO_COLOR}; // the accent: the editor's, once it sends it
  const showRole = role => rl.setPrompt(`${role} › `);
  const print = text => {
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    process.stdout.write(`${text}\n`);
    rl.prompt(true);
  };
  const say = (sender, text) => print(formatMessage(sender, text, {...look, width: process.stdout.columns ?? 0}));

  const hello = resume => sendMessage(socket, {
    type: 'hello',
    role: 'chat',
    cwd: process.cwd(),
    resume,
    herdr: process.env.HERDR_SOCKET_PATH
      ? {socket: process.env.HERDR_SOCKET_PATH, workspace: process.env.HERDR_WORKSPACE_ID, pane: process.env.HERDR_PANE_ID}
      : null,
  });

  // When the daemon restarts (systemd, an upgrade), the pane waits for it and carries on.
  function connectDaemon() {
    socket = connect(socketPath);
    socket.on('connect', () => hello(welcomed));
    socket.on('error', error => {
      if (welcomed) return; // the close that follows retries
      print(`Cannot reach the pair daemon: ${error.message}`);
      process.exit(1);
    });
    socket.on('close', () => {
      if (!welcomed) return;
      if (!away) say('system', 'the pair daemon went away; reconnecting…');
      away = true;
      setTimeout(connectDaemon, RECONNECT_MS);
    });
    readMessages(socket, onMessage);
  }

  function onMessage(message) {
    if (message.type === 'welcome') {
      look.accent = message.accent ?? look.accent;
      showRole(message.role);
      if (away) say('system', 'reconnected');
      else say('system', `pairing on ${message.root} (${message.level}) · /help`);
      welcomed = true;
      away = false;
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
    if (message.type === 'ledger') print(ledgerText(message).map(line => dim(`·· ${line}`, look)).join('\n'));
    // Another agent's news, at your breakpoint: one line, like the pane's own notes.
    if (message.type === 'agents' && message.item) say('system', `◇ ${message.text}${message.more ? ` (+${message.more} more · /agents)` : ''}`);
    if (message.type === 'agent_list') print(agentListLines(message).join('\n'));
    if (message.type === 'accent') look.accent = message.color;
    if (message.type === 'remark') print(dim('·· + useful  - noise', look));
    // What you type is already on screen; your own lines come back only as history.
    const echo = message.sender === 'user' && !message.history;
    if (message.type === 'message' && !echo) say(message.sender, message.text);
    if (message.type === 'ended') {
      say('system', `session ended${message.why ? ` by itself: ${message.why}` : ''}`);
      hello(false); // starts the next session, which asks for its goal
    }
  }
  connectDaemon();

  rl.on('line', line => {
    if (confirming !== null) {
      sendMessage(socket, {type: 'confirm', id: confirming, ok: allows(line)});
      confirming = null;
      return rl.prompt();
    }
    const input = parseInput(line);
    if (input?.local === 'quit') return rl.close();
    if (input?.local === 'help') print(HELP);
    else if (input && away) say('system', 'not sent: the daemon is not back yet');
    else if (input) sendMessage(socket, input);
    rl.prompt();
  });
  // Typing here counts as typing too, so Pair does not speak up in the middle of your question.
  let typingSent = 0;
  process.stdin.on('keypress', () => {
    if (Date.now() - typingSent < 500) return;
    typingSent = Date.now();
    sendMessage(socket, {type: 'event', event: {kind: 'typing'}});
  });
  rl.on('close', () => { socket.end(); process.exit(0); });
  rl.prompt();
}
