// A stand-in for herdr's socket API, for the captures, which show Neovim alone. The workspace has the Neovim
// pane `w1:p1`, the chat pane `w1:p2` and the user's shell `w1:p3`, which is the :terminal inside that Neovim:
// reading it reads the terminal's lines from Neovim. Pair's own pane (Scout's) runs each command for real, with
// bash in the project, and shows the prompt Scout's bash would show.
import {execFile} from 'node:child_process';
import {createServer} from 'node:net';
import {readMessages, sendMessage} from '../../src/protocol.mjs';

const run = (command, cwd) => new Promise(resolve => {
  execFile('bash', ['-c', command], {cwd, maxBuffer: 1 << 24}, (error, stdout, stderr) => resolve({output: (stdout + stderr).replace(/\n$/, ''), exit: error ? error.code ?? 1 : 0}));
});

/** The lines of the first terminal buffer in the Neovim listening on `server`. */
const terminalText = server => new Promise(resolve => {
  const expr = 'join(getbufline(get(filter(range(1, bufnr("$")), {_, b -> getbufvar(b, "&buftype") ==# "terminal"}), 0, 0), 1, "$"), "\\n")';
  execFile('nvim', ['--server', server, '--remote-expr', expr], (error, stdout) => resolve(error ? '' : stdout));
});

/** Serves the stand-in on `socketPath`: commands in Pair's pane run in `cwd`, and `nvim` is Neovim's server address. */
export async function standInHerdr(socketPath, {cwd, nvim, log = () => {}}) {
  const panes = new Map([['w1:p1', {lines: []}], ['w1:p2', {lines: []}], ['w1:p3', {lines: []}]]);
  let next = 4;

  async function type(pane, text) {
    const shell = panes.get(pane);
    if (text.startsWith('exec env HISTFILE=')) {
      shell.count = 1;
      shell.lines.push('scout[1] exit 0 $ ');
      return;
    }
    if (text === '\x03' || shell.count === undefined) return;
    const command = text.replace(/^\x15/, '').replace(/\r$/, '');
    shell.lines[shell.lines.length - 1] += command;
    log(`pair's pane runs: ${command}`);
    const {output, exit} = await run(command, cwd);
    if (output) shell.lines.push(...output.split('\n'));
    shell.lines.push(`scout[${++shell.count}] exit ${exit} $ `);
  }

  const lastLines = async (pane, lines = 1000) => (pane === 'w1:p3' ? terminalText(nvim) : panes.get(pane).lines.slice(-lines).join('\n'));

  const methods = {
    'pane.list': () => ({panes: [...panes.keys()].map(pane_id => ({pane_id, label: panes.get(pane_id).label ?? null, focused: pane_id === 'w1:p1'}))}),
    'pane.split': () => {
      const pane_id = `w1:p${next++}`;
      panes.set(pane_id, {lines: ['$ ']});
      return {pane: {pane_id}};
    },
    'pane.rename': ({pane_id, label}) => { panes.get(pane_id).label = label; return {}; },
    'pane.close': ({pane_id}) => { panes.delete(pane_id); return {}; },
    'pane.send_text': ({pane_id, text}) => { type(pane_id, text); return {}; },
    'pane.read': async ({pane_id, lines}) => ({read: {text: await lastLines(pane_id, lines)}}),
    'pane.wait_for_output': async ({pane_id, lines, match, timeout_ms}) => {
      const end = Date.now() + (timeout_ms ?? 0);
      while (!new RegExp(match.value, 'm').test(await lastLines(pane_id, lines))) {
        if (Date.now() >= end) throw new Error('timed out waiting for output match');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return {};
    },
    // Neovim runs in w1:p1; every other shell is at its prompt (the shell hook reports the user's commands).
    'pane.process_info': ({pane_id}) => ({process_info: {
      pane_id, shell_pid: 1, foreground_processes: pane_id === 'w1:p1' ? [{pid: 1, name: 'bash'}, {pid: 2, name: 'nvim'}] : [{pid: 1, name: 'bash'}],
    }}),
  };

  const server = createServer(socket => readMessages(socket, async ({id, method, params}) => {
    try {
      sendMessage(socket, {id, result: await methods[method](params)});
    } catch (error) {
      sendMessage(socket, {id, error: {message: error.message}});
    }
  }));
  await new Promise(resolve => server.listen(socketPath, resolve));
  return {close: () => new Promise(resolve => server.close(resolve))};
}
