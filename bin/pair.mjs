#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// pair: the daemon, the chat pane and the shell hook in one command.
import {spawn} from 'node:child_process';
import {mkdirSync, openSync} from 'node:fs';
import {connect} from 'node:net';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {runChat} from '../src/chat.mjs';
import {defaultSocketPath, loadConfig} from '../src/config.mjs';
import {startDaemon} from '../src/daemon.mjs';
import {herdrRequest} from '../src/herdr.mjs';
import {sendMessage} from '../src/protocol.mjs';
import {shellHook} from '../src/shell-hook.mjs';

const USAGE = `usage:
  pair              open the chat pane next to this one (in herdr), starting the daemon if needed
  pair chat         run the chat pane here
  pair daemon       run the daemon in the foreground
  pair shell-hook bash|zsh   print the shell hook that reports exit codes
  pair report --exit N --cmd TEXT   (used by the shell hook)`;

const reachable = socketPath => new Promise(resolve => {
  const socket = connect(socketPath);
  socket.on('connect', () => { socket.end(); resolve(true); });
  socket.on('error', () => resolve(false));
});

async function ensureDaemon(config) {
  if (await reachable(config.socket)) return;
  mkdirSync(config.dataDir, {recursive: true, mode: 0o700});
  const log = openSync(join(config.dataDir, 'daemon.log'), 'a');
  spawn(process.execPath, [process.argv[1], 'daemon'], {detached: true, stdio: ['ignore', log, log]}).unref();
  for (let i = 0; i < 50; i++) {
    if (await reachable(config.socket)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`The daemon did not start; see ${join(config.dataDir, 'daemon.log')}`);
}

async function daemon(config) {
  const running = await startDaemon(config);
  const stop = async () => { await running.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function openChatPane(config) {
  await ensureDaemon(config);
  if (!process.env.HERDR_ENV) return runChat(config.socket);
  const {pane} = await herdrRequest(process.env.HERDR_SOCKET_PATH, 'pane.split', {
    target_pane_id: process.env.HERDR_PANE_ID, direction: 'right', ratio: 0.7, cwd: process.cwd(), focus: false,
  });
  await herdrRequest(process.env.HERDR_SOCKET_PATH, 'pane.send_text', {pane_id: pane.pane_id, text: `${process.argv[1]} chat\r`});
}

// Runs after every shell command, so it stays silent: no config or no daemon means nothing to report.
function report(args) {
  const {values} = parseArgs({args, options: {exit: {type: 'string'}, cmd: {type: 'string'}}});
  let socketPath;
  try { socketPath = loadConfig().socket; } catch { socketPath = defaultSocketPath(); }
  const socket = connect(socketPath);
  socket.on('error', () => {});
  socket.on('connect', () => {
    sendMessage(socket, {type: 'command', cwd: process.cwd(), pane: process.env.HERDR_PANE_ID ?? null, cmd: values.cmd ?? '', exit: Number(values.exit)});
    socket.end();
  });
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'shell-hook') {
    process.stdout.write(shellHook(args[0], process.argv[1]));
  } else if (command === 'report') {
    report(args);
  } else {
    const config = loadConfig();
    if (command === undefined) await openChatPane(config);
    else if (command === 'chat') { await ensureDaemon(config); runChat(config.socket); }
    else if (command === 'daemon') await daemon(config);
    else { console.log(USAGE); process.exitCode = command === 'help' || command === '--help' ? 0 : 2; }
  }
} catch (error) {
  console.error(`pair: ${error.message}`);
  process.exitCode = 1;
}
