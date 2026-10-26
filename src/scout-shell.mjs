// The shell of Pair's pane: a plain bash, or one that loads your rc file first (scout-pane.bash), and either one in
// the sandbox when there is one (sandbox.mjs). Set by `scoutPane` in the config.
import {execFile} from 'node:child_process';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sandboxWords, sandboxWorks} from './sandbox.mjs';

const RC_WRAPPER = fileURLToPath(new URL('./scout-pane.bash', import.meta.url));
const PROMPT = 'scout[\\#] exit $? $ ';
const SANDBOX = ['auto', true, false];
const NAMES_MS = 10_000;

/** `text` as one shell word. */
export const shellQuote = text => `'${text.replaceAll("'", "'\\''")}'`;

const word = text => (/^[\w@%+=:,./-]+$/.test(text) ? text : shellQuote(text));
const expand = path => resolve(path.replace(/^~(?=\/|$)/, homedir()));

/**
 * `scoutPane` in the config: `rc`, an rc file the pane loads (true for ~/.bashrc); `sandbox`, "auto" (when
 * bubblewrap works), true (always: without bubblewrap the pane does not open) or false; and for the sandbox,
 * `network` and the folders besides the project it may write, `writable`.
 */
export function scoutPaneConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config: scoutPane must be an object');
  const unknown = Object.keys(raw).find(key => !['rc', 'sandbox', 'network', 'writable'].includes(key));
  if (unknown) throw new Error(`config: scoutPane.${unknown} is not a setting; they are rc, sandbox, network and writable`);
  const {rc = false, sandbox = 'auto', network = false, writable = []} = raw;
  if (typeof rc !== 'boolean' && (typeof rc !== 'string' || !rc)) throw new Error('config: scoutPane.rc must be an rc file, or true for ~/.bashrc');
  if (!SANDBOX.includes(sandbox)) throw new Error('config: scoutPane.sandbox must be "auto", true or false');
  if (typeof network !== 'boolean') throw new Error('config: scoutPane.network must be true or false');
  if (!Array.isArray(writable) || !writable.every(path => typeof path === 'string' && path)) throw new Error('config: scoutPane.writable must list folders');
  return {rc: rc === true ? join(homedir(), '.bashrc') : rc ? expand(rc) : null, sandbox, network, writable: writable.map(expand)};
}

/** Whether the pane runs in the sandbox; throws when the config asks for one that cannot be made here. */
export function sandboxed(setup, works = sandboxWorks) {
  if (setup.sandbox === false) return false;
  if (works()) return true;
  if (setup.sandbox === true) throw new Error('scoutPane.sandbox is true, and bubblewrap (bwrap) is not installed or may not make namespaces here');
  return false;
}

/**
 * The line typed into a new pane to start its shell in `cwd`, and whether that shell is sandboxed. `writable` and
 * `hidden` are the daemon's additions to the sandbox: where the tests on save write, and its and herdr's sockets.
 */
export function shellLine({setup, cwd, writable = [], hidden = [], works = sandboxWorks}) {
  const inSandbox = sandboxed(setup, works);
  // No history file: Pair's commands stay out of yours.
  const env = ['env', 'HISTFILE=', `PS1=${PROMPT}`, ...(setup.rc ? [`PAIR_SCOUT_RC=${setup.rc}`] : [])];
  const readable = setup.rc ? [setup.rc, RC_WRAPPER] : [];
  const sandbox = inSandbox ? sandboxWords({cwd, writable: [...setup.writable, ...writable], readable, hidden, network: setup.network}) : [];
  const bash = ['bash', '--noprofile', ...(setup.rc ? ['--rcfile', RC_WRAPPER] : ['--norc']), '-i'];
  return {line: `exec ${[...env, ...sandbox, ...bash].map(word).join(' ')}`, sandboxed: inSandbox};
}

// Prints each alias as "a", its name and its text, and each function as "f" and its name, NUL-separated after a mark.
const LIST_NAMES = 'printf "\\0pair\\0"; for n in "${!BASH_ALIASES[@]}"; do printf "a\\0%s\\0%s\\0" "$n" "${BASH_ALIASES[$n]}"; done; for n in $(compgen -A function); do printf "f\\0%s\\0" "$n"; done';

/** The aliases and functions that `rc`'s shell has, as `{aliases: {name: text}, functions: [names]}`. */
export function rcNames(rc, cwd) {
  return new Promise((resolve, reject) => {
    const child = execFile('bash', ['--noprofile', '--rcfile', RC_WRAPPER, '-i', '-c', LIST_NAMES], {cwd, env: {...process.env, PAIR_SCOUT_RC: rc}, timeout: NAMES_MS}, (error, stdout) => {
      const mark = stdout.indexOf('\0pair\0');
      if (error || mark === -1) return reject(new Error(`could not list the aliases and functions of ${rc}: ${error?.message ?? 'its shell printed nothing'}`));
      const fields = stdout.slice(mark + 6).split('\0');
      const names = {aliases: {}, functions: []};
      for (let i = 0; i < fields.length - 1;) {
        if (fields[i] === 'a') { names.aliases[fields[i + 1]] = fields[i + 2]; i += 3; } else { names.functions.push(fields[i + 1]); i += 2; }
      }
      resolve(names);
    });
    child.stdin.end();
  });
}
