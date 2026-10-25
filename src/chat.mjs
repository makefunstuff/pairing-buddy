// The chat pane: where the user talks to Pair and reads what it says.
import {connect} from 'node:net';
import {clearLine, createInterface, cursorTo} from 'node:readline';
import {LEVELS} from './config.mjs';
import {readMessages, sendMessage} from './protocol.mjs';

const STYLE = {pair: '\x1b[36mpair\x1b[0m', user: '\x1b[2myou\x1b[0m', system: '\x1b[2m··\x1b[0m'};

const HELP = `/goal <text>   set the session goal
/level ${LEVELS.join('|')}   how often Pair speaks unasked
/end           end the session and write a session note
/quit          close this pane (the session goes on)
anything else  ask Pair`;

/** The parsed form of one typed line: a daemon message, or a local action. */
export function parseInput(line) {
  const text = line.trim();
  if (!text) return null;
  const [command, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ');
  if (command === '/goal' && arg) return {type: 'goal', text: arg};
  if (command === '/level' && LEVELS.includes(arg)) return {type: 'level', level: arg};
  if (command === '/end') return {type: 'end'};
  if (command === '/quit') return {local: 'quit'};
  if (command.startsWith('/')) return {local: 'help'};
  return {type: 'ask', text};
}

export function runChat(socketPath) {
  const socket = connect(socketPath);
  const rl = createInterface({input: process.stdin, output: process.stdout, prompt: '› '});
  const print = text => {
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    process.stdout.write(`${text}\n`);
    rl.prompt(true);
  };

  const hello = () => sendMessage(socket, {
    type: 'hello',
    role: 'chat',
    cwd: process.cwd(),
    herdr: process.env.HERDR_SOCKET_PATH
      ? {socket: process.env.HERDR_SOCKET_PATH, workspace: process.env.HERDR_WORKSPACE_ID, pane: process.env.HERDR_PANE_ID}
      : null,
  });
  socket.on('connect', hello);
  socket.on('error', error => { print(`Cannot reach the pair daemon: ${error.message}`); process.exit(1); });
  socket.on('close', () => { print('The pair daemon went away.'); process.exit(0); });

  readMessages(socket, message => {
    if (message.type === 'welcome') print(`${STYLE.system} pairing on ${message.root} (${message.level}) · /help`);
    if (message.type === 'message') print(`${STYLE[message.sender] ?? message.sender} ${message.text}`);
    if (message.type === 'ended') {
      print(`${STYLE.system} session ended`);
      hello(); // starts the next session, which asks for its goal
    }
  });

  rl.on('line', line => {
    const input = parseInput(line);
    if (input?.local === 'quit') return rl.close();
    if (input?.local === 'help') print(HELP);
    else if (input) sendMessage(socket, input);
    rl.prompt();
  });
  rl.on('close', () => { socket.end(); process.exit(0); });
  rl.prompt();
}
