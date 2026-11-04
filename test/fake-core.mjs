// A stand-in for herdr-core's socket API (JSON-RPC 2.0, a line each way) and for the Herdr window's command
// (`herdr-app status`, `ls`, `do`), just enough for Pair: terminals to list, get, read, start, type into and kill,
// events to subscribe to, and in a terminal Pair starts for Scout a shell that runs scripted commands, shows the
// prompt Scout's bash would show and writes the files its rc file would (see pane-runs.mjs). It never reaches a real
// herdr-core or Herdr window.
import {appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {readMessages, sendMessage} from '../src/protocol.mjs';

export const SPACE_ID = 'sp1';
export const TAB_ID = 'tb1';

/**
 * `commands` maps a command line run in Pair's terminal to `{output, exit}`. The core starts with the user's shell
 * `t1` and the chat `t2`, both shown in the window's space `sp1`; `t3`, a shell shown in another space; and `t4`, an
 * agent no window shows, which says it is `working` (OSC 7501). `run(t, argv)` puts a command in a terminal's
 * foreground and `done(t)` takes it away. `sent` records every terminal.send as [t, text], `keys` every
 * terminal.keys as [t, keys], `started` the params of every terminal.run, `calls` the method of every request.
 */
export async function fakeCore(socketPath, {commands = {}} = {}) {
  const shown = (space = SPACE_ID) => ({'herdr.space': space, 'herdr.tab': TAB_ID});
  const terminals = new Map();
  let pids = 100;
  let next = 5;
  let seq = 0;
  const add = (address, {labels = {}, status = null, argv = ['/usr/bin/bash'], lines = ['$ ']} = {}) => {
    const pid = pids++;
    terminals.set(address, {address, pid, argv, cwd: '/home/me', labels, status, state: 'live', title: '', lines, foreground: {pid, name: argv[0].split('/').at(-1), argv, cwd: '/home/me'}});
  };
  add('t1', {labels: shown()});
  add('t2', {labels: shown(), argv: ['node', 'pair', 'chat'], lines: ['› ']});
  add('t3', {labels: shown('sp2')});
  add('t4', {status: {state: 'working', app: 'claude-code', msg: 'Reading src/a.js'}, argv: ['claude']});
  const sent = [];
  const keys = [];
  const started = [];
  const calls = [];
  const subscribers = new Set(); // {socket, labels}

  const view = ({lines, ...terminal}) => terminal;
  const matches = (terminal, labels = {}) => Object.entries(labels).every(([key, value]) => terminal.labels[key] === value);
  function push(type, address) {
    const terminal = terminals.get(address);
    for (const {socket, labels} of subscribers) {
      if (!terminal || matches(terminal, labels)) sendMessage(socket, {jsonrpc: '2.0', method: 'event', params: {type, terminal: address, data: {}, seq: ++seq}});
    }
  }
  function get(address) {
    const terminal = terminals.get(address);
    if (!terminal) throw Object.assign(new Error(`no terminal "${address}"`), {kind: 'not_found'});
    return terminal;
  }

  async function type(address, text) {
    const shell = get(address);
    if (shell.count === undefined) return;
    const command = text;
    shell.lines[shell.lines.length - 1] += command;
    writeFileSync(join(shell.runs, 'next'), `running ${shell.count}\n`);
    const line = /^pair-run\b/.test(command) ? readFileSync(join(shell.runs, 'line'), 'utf8').replace(/\n$/, '') : command;
    const {output = '', exit = 0} = (typeof commands === 'function' ? await commands(line) : commands[line]) ?? {};
    if (output) shell.lines.push(...output.split('\n'));
    appendFileSync(join(shell.runs, 'pane.log'), `\x1b]133;C;aid=pair${shell.count}\x07${output ? `${output}\n` : ''}\x1b]133;D;${exit};aid=pair${shell.count}\x07`);
    writeFileSync(join(shell.runs, 'next'), `${shell.count + 1}\n`);
    writeFileSync(join(shell.runs, `${shell.count++}.exit`), `${exit}\n`);
    shell.lines.push(`scout[${shell.count}] exit ${exit} $ `);
  }

  const methods = {
    'server.status': () => ({version: '0.1.16', live: [...terminals.values()].filter(terminal => terminal.state === 'live').length}),
    'terminal.list': ({labels = {}}) => ({terminals: [...terminals.values()].filter(terminal => matches(terminal, labels)).map(view), hidden_finished: 0, machines: []}),
    'terminal.get': ({terminal}) => view(get(terminal)),
    // The screen has empty rows below the prompt, as a real one does.
    'terminal.read': ({terminal, lines}) => ({text: `${get(terminal).lines.slice(-lines).join('\n')}\n\n\n`, complete: true, how: 'history'}),
    'terminal.run': params => {
      if (fake.refuseRun) throw Object.assign(new Error('the core refused'), {kind: 'spawn_failed'});
      started.push(params);
      const address = `t${next++}`;
      add(address, {labels: params.labels ?? {}, argv: params.argv?.length ? params.argv : ['sh', '-c', params.line]});
      const runs = /^exec env .*?PAIR_RUNS=('[^']+'|\S+)/.exec(params.line ?? '')?.[1].replace(/^'|'$/g, '');
      if (runs) {
        Object.assign(terminals.get(address), {count: 1, runs, lines: ['scout[1] exit 0 $ ']});
        mkdirSync(runs, {recursive: true});
        writeFileSync(join(runs, 'next'), '1\n');
      }
      setImmediate(() => push('created', address));
      return {...view(terminals.get(address)), first_message: null};
    },
    'terminal.send': ({terminal, text}) => { get(terminal); sent.push([terminal, text]); type(terminal, text); return {turn: 0, status: null}; },
    'terminal.keys': ({terminal, keys: pressed}) => { get(terminal); keys.push([terminal, pressed]); return {turn: 0}; },
    'terminal.kill': ({terminal}) => {
      Object.assign(get(terminal), {state: 'finished', foreground: null});
      setImmediate(() => push('finished', terminal));
      return view(get(terminal));
    },
  };

  const server = createServer(socket => readMessages(socket, async ({id, method, params}) => {
    if (method === 'events.subscribe') {
      const subscriber = {socket, labels: params?.labels ?? {}};
      subscribers.add(subscriber);
      socket.on('close', () => subscribers.delete(subscriber));
      return sendMessage(socket, {jsonrpc: '2.0', id, result: {seq, terminals: []}});
    }
    calls.push(method);
    try {
      if (!methods[method]) throw Object.assign(new Error(`unknown method ${method}`), {kind: 'unknown_method'});
      sendMessage(socket, {jsonrpc: '2.0', id, result: await methods[method](params ?? {})});
    } catch (error) {
      sendMessage(socket, {jsonrpc: '2.0', id, error: {code: -32000, message: error.message, data: {kind: error.kind ?? 'error'}}});
    }
  }));
  await new Promise(resolve => server.listen(socketPath, resolve));
  const fake = {
    refuseRun: false, // terminal.run fails
    terminals, sent, keys, started, calls, subscribers,
    run(address, argv) {
      get(address).foreground = {pid: pids++, name: argv[0], argv, cwd: '/home/me'};
    },
    done(address) {
      const terminal = get(address);
      terminal.foreground = {pid: terminal.pid, name: 'bash', argv: terminal.argv, cwd: '/home/me'};
    },
    close() {
      for (const {socket} of subscribers) socket.destroy();
      return new Promise(resolve => server.close(resolve));
    },
  };
  return fake;
}

const APP = String.raw`#!/usr/bin/env node
const {appendFileSync, readFileSync} = require('node:fs');
const dir = __dirname;
const args = process.argv.slice(2);
appendFileSync(dir + '/calls.jsonl', JSON.stringify(args) + '\n');
const state = JSON.parse(readFileSync(dir + '/state.json', 'utf8'));
if (!state.window) { process.stderr.write('Herdr is not running\n'); process.exit(1); }
const panes = Object.entries(state.panes);
if (args[0] === 'status') console.log(JSON.stringify({space: state.space, tab: 'tb1', focused_pane: state.focused, layout: 'main', floats: {}, overlays: [], errors: []}));
else if (args[0] === 'ls') console.log(JSON.stringify({spaces: [{id: 'sp1', name: 'shop', tabs: [{id: 'tb1', terminals: panes.map(([pane, terminal]) => ({terminal, pane, status: null}))}]}], recent: []}));
else if (args[0] === 'do' && args[1] === 'agent.focus') console.log(JSON.stringify({}));
else if (args[0] === 'do' && args[1] === 'pane.split' && state.refuseSplit) { console.log(JSON.stringify({error: 'no such mod'})); process.exit(1); }
else if (args[0] === 'do' && args[1] === 'pane.split') console.log(JSON.stringify({pane: 'p9'}));
else { console.log(JSON.stringify({error: 'unknown command'})); process.exit(1); }
`;

/**
 * Writes a fake `herdr-app` into `dir`: {command, set(state), calls()}. Its state: `window` (false: no window runs),
 * `space` (the space it shows), `focused` (the focused pane), `panes` (pane id -> the terminal it shows), `refuseSplit`
 * (`do pane.split` fails, as for a mod the window does not have).
 */
export function fakeApp(dir, state = {}) {
  const command = join(dir, 'herdr-app');
  writeFileSync(join(dir, 'package.json'), '{"type": "commonjs"}');
  writeFileSync(command, APP);
  chmodSync(command, 0o755);
  writeFileSync(join(dir, 'calls.jsonl'), '');
  let now = {window: true, space: SPACE_ID, focused: 'p1', panes: {p1: 't1', p2: 't2'}, ...state};
  const set = change => { now = {...now, ...change}; writeFileSync(join(dir, 'state.json'), JSON.stringify(now)); };
  set({});
  return {
    command, set,
    calls: () => readFileSync(join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)),
  };
}
