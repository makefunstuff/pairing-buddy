// A stand-in for herdr's socket API, just enough for Pair: panes to list, split, close and read, and a
// shell in each new pane that runs scripted commands and shows the prompt Scout's bash would show.
import {createServer} from 'node:net';
import {readMessages, sendMessage} from '../src/protocol.mjs';

/**
 * `commands` maps a command line to `{output, exit}`; others print nothing and exit 0. The workspace starts
 * with the user's pane `w1:p1` and the chat pane `w1:p2`. `sent` records every send_text as [pane, text].
 */
export async function fakeHerdr(socketPath, {commands = {}} = {}) {
  const panes = new Map([['w1:p1', {label: null, lines: ['$ ']}], ['w1:p2', {label: null, lines: ['› ']}]]);
  const sent = [];
  let next = 3;

  function type(pane, text) {
    const shell = panes.get(pane);
    if (text.startsWith('exec env HISTFILE=')) {
      shell.count = 1;
      shell.lines.push('scout[1] exit 0 $ ');
      return;
    }
    if (text === '\x03' || shell.count === undefined) return;
    const command = text.replace(/^\x15/, '').replace(/\r$/, '');
    const {output = '', exit = 0} = commands[command] ?? {};
    shell.lines[shell.lines.length - 1] += command;
    if (output) shell.lines.push(...output.split('\n'));
    shell.lines.push(`scout[${++shell.count}] exit ${exit} $ `);
  }

  const lastLines = (pane, lines = 1000) => panes.get(pane).lines.slice(-lines).join('\n');

  const methods = {
    'pane.list': () => ({panes: [...panes].map(([pane_id, pane]) => ({pane_id, label: pane.label, focused: pane_id === 'w1:p1'}))}),
    'pane.split': () => {
      const pane_id = `w1:p${next++}`;
      panes.set(pane_id, {label: null, lines: ['$ ']});
      return {pane: {pane_id}};
    },
    'pane.rename': ({pane_id, label}) => { panes.get(pane_id).label = label; return {}; },
    'pane.close': ({pane_id}) => { panes.delete(pane_id); return {}; },
    'pane.send_text': ({pane_id, text}) => { sent.push([pane_id, text]); type(pane_id, text); return {}; },
    'pane.read': ({pane_id, lines}) => ({read: {text: lastLines(pane_id, lines)}}),
    'pane.wait_for_output': ({pane_id, lines, match}) => {
      if (!new RegExp(match.value, 'm').test(lastLines(pane_id, lines))) throw new Error('timed out waiting for output match');
      return {};
    },
    'pane.process_info': ({pane_id}) => ({process_info: {pane_id, shell_pid: 1, foreground_processes: [{pid: 1, name: 'bash'}]}}),
  };

  const server = createServer(socket => readMessages(socket, ({id, method, params}) => {
    try {
      sendMessage(socket, {id, result: methods[method](params)});
    } catch (error) {
      sendMessage(socket, {id, error: {message: error.message}});
    }
  }));
  await new Promise(resolve => server.listen(socketPath, resolve));
  return {panes, sent, close: () => new Promise(resolve => server.close(resolve))};
}
