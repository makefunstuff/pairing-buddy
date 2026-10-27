// A stand-in for herdr's socket API, just enough for Pair: panes to list, split, close and read, events to
// subscribe to, and a
// shell in each new pane that runs scripted commands, shows the prompt Scout's bash would show and writes the
// files its rc file would (see pane-runs.mjs).
import {appendFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {readMessages, sendMessage} from '../src/protocol.mjs';

/**
 * `commands` maps a command line to `{output, exit}`; others print nothing and exit 0. It may instead be a
 * function of the command line that resolves with them, to really run commands. The workspace starts
 * with the user's pane `w1:p1` and the chat pane `w1:p2`; `w1:p1` has focus until `focus(pane)` moves it, which
 * pushes the event to subscribers, as `scroll(pane, offset)` does. The panes in `nvims` run Neovim; `processes`
 * maps a pane to more foreground processes other than the shell. `sent` records every send_text as [pane, text],
 * `calls` the method of every request. `agents` is what agent.list answers (change it in place); `focused`
 * records the targets of agent.focus.
 */
export async function fakeHerdr(socketPath, {commands = {}, agents = [], nvims = []} = {}) {
  const panes = new Map([['w1:p1', {label: null, lines: ['$ ']}], ['w1:p2', {label: null, lines: ['› ']}]]);
  for (const pane of nvims) if (!panes.has(pane)) panes.set(pane, {label: null, lines: ['']});
  let focusedPane = 'w1:p1';
  const sent = [];
  const focused = [];
  const calls = []; // the method of every request
  const processes = new Map();
  const subscribers = new Set(); // {socket, subscriptions}
  let next = 3;

  function push(event, data, wanted = ({type}) => type.replace('.', '_') === event) {
    for (const {socket, subscriptions} of subscribers) {
      if (subscriptions.some(wanted)) sendMessage(socket, {event, data});
    }
  }

  async function type(pane, text) {
    const shell = panes.get(pane);
    const runs = /^exec env .*?PAIR_RUNS=('[^']+'|\S+)/.exec(text)?.[1].replace(/^'|'$/g, '');
    if (runs) {
      Object.assign(shell, {count: 1, runs});
      mkdirSync(runs, {recursive: true});
      writeFileSync(join(runs, 'next'), '1\n');
      shell.lines.push('scout[1] exit 0 $ ');
      return;
    }
    if (text === '\x03' || shell.count === undefined) return;
    const command = text.replace(/^\x15/, '').replace(/\r$/, '');
    shell.lines[shell.lines.length - 1] += command;
    writeFileSync(join(shell.runs, 'next'), `running ${shell.count}\n`);
    const {output = '', exit = 0} = (typeof commands === 'function' ? await commands(command) : commands[command]) ?? {};
    if (output) shell.lines.push(...output.split('\n'));
    const marked = `\x1b]133;C;aid=pair${shell.count}\x07${output ? `${output}\n` : ''}\x1b]133;D;${exit};aid=pair${shell.count}\x07`;
    appendFileSync(join(shell.runs, 'pane.log'), marked);
    // As the real shell does: `next` first, the exit code last.
    writeFileSync(join(shell.runs, 'next'), `${shell.count + 1}\n`);
    writeFileSync(join(shell.runs, `${shell.count++}.exit`), `${exit}\n`);
    shell.lines.push(`scout[${shell.count}] exit ${exit} $ `);
  }

  const lastLines = (pane, lines = 1000) => panes.get(pane).lines.slice(-lines).join('\n');

  const methods = {
    'pane.list': () => ({panes: [...panes].map(([pane_id, pane]) => ({pane_id, label: pane.label, focused: pane_id === focusedPane, scroll: {offset_from_bottom: pane.offset ?? 0}}))}),
    'pane.split': () => {
      const pane_id = `w1:p${next++}`;
      panes.set(pane_id, {label: null, lines: ['$ ']});
      setImmediate(() => push('pane_created', {pane: {pane_id}}));
      return {pane: {pane_id}};
    },
    'pane.rename': ({pane_id, label}) => { panes.get(pane_id).label = label; return {}; },
    'pane.close': ({pane_id}) => { panes.delete(pane_id); setImmediate(() => push('pane_closed', {pane_id})); return {}; },
    'pane.send_text': ({pane_id, text}) => { sent.push([pane_id, text]); type(pane_id, text); return {}; },
    'pane.read': ({pane_id, lines}) => ({read: {text: lastLines(pane_id, lines)}}),
    'pane.wait_for_output': async ({pane_id, lines, match, timeout_ms}) => {
      const end = Date.now() + Math.min(timeout_ms ?? 0, 5000);
      while (!new RegExp(match.value, 'm').test(lastLines(pane_id, lines))) {
        if (Date.now() >= end) throw new Error('timed out waiting for output match');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return {};
    },
    'agent.list': () => ({type: 'agent_list', agents}),
    'agent.focus': ({target}) => {
      if (!agents.some(agent => agent.pane_id === target)) throw new Error(`agent target ${target} not found`);
      focused.push(target);
      return {};
    },
    'pane.process_info': ({pane_id}) => ({process_info: {
      pane_id, shell_pid: 1,
      foreground_processes: [{pid: 1, name: 'bash'}, ...(nvims.includes(pane_id) ? [{pid: 2, name: 'nvim', argv: ['nvim']}] : []), ...(processes.get(pane_id) ?? [])],
    }}),
  };

  const server = createServer(socket => readMessages(socket, async ({id, method, params}) => {
    if (method === 'events.subscribe') {
      const subscriber = {socket, subscriptions: params.subscriptions};
      subscribers.add(subscriber);
      socket.on('close', () => subscribers.delete(subscriber));
      return sendMessage(socket, {id, result: {type: 'subscription_started'}});
    }
    calls.push(method);
    try {
      sendMessage(socket, {id, result: await methods[method](params)});
    } catch (error) {
      sendMessage(socket, {id, error: {message: error.message}});
    }
  }));
  await new Promise(resolve => server.listen(socketPath, resolve));
  return {
    panes, sent, calls, processes, subscribers, agents, focused,
    focus(pane) {
      focusedPane = pane;
      push('pane_focused', {pane_id: pane, workspace_id: 'w1'});
    },
    scroll(pane, offset) {
      panes.get(pane).offset = offset;
      push('pane.scroll_changed', {pane_id: pane, scroll: {offset_from_bottom: offset}}, ({type, pane_id}) => type === 'pane.scroll_changed' && pane_id === pane);
    },
    close() {
      for (const {socket} of subscribers) socket.destroy();
      return new Promise(resolve => server.close(resolve));
    },
  };
}
