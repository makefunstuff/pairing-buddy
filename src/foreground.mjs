// The command running in a terminal outside herdr, from its shell's process id: the terminal's foreground process
// group, when it is not the shell's own. herdr says this itself (herdr.mjs); a Neovim :terminal and a tmux pane give
// only the shell's pid. Linux reads /proc; elsewhere (macOS) `ps` says the same.
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';

const run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, {timeout: 2000}, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

/** The terminal's foreground process group of process `pid`, from /proc/<pid>/stat (after the name, which may hold spaces). */
async function procGroup(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[5]);
}

async function procCommand(pid) {
  const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
  return argv.length ? argv.join(' ') : (await readFile(`/proc/${pid}/comm`, 'utf8')).trim();
}

async function psGroup(pid) {
  return Number((await run('ps', ['-o', 'tpgid=', '-p', String(pid)])).trim());
}

async function psCommand(pid) {
  return (await run('ps', ['-o', 'command=', '-p', String(pid)])).trim();
}

/** The command line of process `pid`, or null when it is gone. */
export async function processCommand(pid, {proc = process.platform === 'linux'} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return (await (proc ? procCommand(pid) : psCommand(pid))) || null;
  } catch {
    return null;
  }
}

/**
 * The command line running in the foreground of shell `pid`'s terminal, or null while the shell waits at its
 * prompt, or is gone. `proc` says whether /proc is there to read (Linux).
 */
export async function foregroundCommand(pid, {proc = process.platform === 'linux'} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const group = await (proc ? procGroup(pid) : psGroup(pid));
    if (!(group > 0) || group === pid) return null;
    return (await (proc ? procCommand(group) : psCommand(group))) || null;
  } catch {
    return null; // the shell, or the command, ended while Pair looked
  }
}
