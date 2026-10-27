// The sandbox of Pair's pane, when bubblewrap is there: the disk read-only except the project and the folders the
// config names, a private /tmp, your cache folder writable but with its writes thrown away, no network (name lookups
// included) unless allowed, and every socket of yours hidden, so a command cannot reach herdr, the daemon or your
// desktop session. The command policy still decides what runs; the sandbox limits what an allowed command does.
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

const BWRAP = 'bwrap';
// Container daemons run anything they are asked to as root.
const ROOT_SOCKETS = ['/run/docker.sock', '/run/podman/podman.sock'];
// Daemons that look names up on the network for a client: without the network, a lookup would still carry data out.
// The system bus is among them, since systemd-resolved answers lookups there too.
const LOOKUP_SOCKETS = [
  '/run/systemd/resolve/io.systemd.Resolve', '/run/systemd/resolve/io.systemd.Resolve.Monitor', '/run/nscd/socket',
  '/run/avahi-daemon/socket', '/run/dbus/system_bus_socket',
];

const probe = args => spawnSync(BWRAP, ['--ro-bind', '/', '/', '--unshare-all', ...args, 'true'], {stdio: 'ignore', timeout: 5000}).status === 0;
let works;
let overlays;

/**
 * Whether bubblewrap is installed and may make namespaces here (some systems forbid it to users), with the mounts the
 * pane's sandbox makes: a container may allow the namespaces and still refuse a new /proc. Checked once.
 */
export function sandboxWorks() {
  works ??= probe(['--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp']);
  return works;
}

/** Whether bubblewrap can lay a writable layer, thrown away at the end, over a folder (bubblewrap 0.10, Linux 5.11). */
export function overlayWorks() {
  overlays ??= sandboxWorks() && probe(['--overlay-src', '/etc', '--tmp-overlay', '/etc']);
  return overlays;
}

/**
 * The paths of the listening unix sockets that are yours: herdr's (its API and its terminal clients'), the daemon's,
 * your editors', agents' and password managers'. Sockets made after the pane opened are not among them.
 */
export function userSockets() {
  let table;
  try { table = readFileSync('/proc/net/unix', 'utf8'); } catch { return []; }
  // Each line ends with the path, after seven fields; abstract sockets have none, or one starting with "@".
  const paths = new Set(table.split('\n').slice(1).map(line => line.trim().split(/\s+/).slice(7).join(' ')).filter(path => path.startsWith('/')));
  return [...paths].filter(path => {
    try {
      const stat = statSync(path);
      return stat.isSocket() && stat.uid === process.getuid();
    } catch {
      return false;
    }
  });
}

/** Your cache folder, and Go's build cache when it lives elsewhere: tests and builds write there as they run. */
export function cacheFolders(env = process.env) {
  const cache = env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return [...new Set([cache, ...(env.GOCACHE ? [env.GOCACHE] : [])])];
}

/**
 * The words that start a program in the sandbox, in `cwd`: `writable` are the folders besides `cwd` that it may
 * write, `readable` files it must see even in /tmp, `hidden` sockets it must not reach besides `sockets` (yours).
 * `caches` are writable with their writes thrown away: in an overlay that still shows what is there when
 * `overlay`, else in an empty folder. `XDG_RUNTIME_DIR` (your session's sockets) is an empty folder in it.
 */
export function sandboxWords({
  cwd, writable = [], readable = [], hidden = [], network = false, runtimeDir = process.env.XDG_RUNTIME_DIR,
  caches = cacheFolders(), overlay = overlayWorks(), sockets = userSockets(),
}) {
  const words = [BWRAP, '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'];
  if (runtimeDir) words.push('--tmpfs', runtimeDir);
  const open = [cwd, ...writable];
  for (const path of caches.filter(path => existsSync(path) && !open.includes(path))) {
    words.push(...(overlay ? ['--overlay-src', path, '--tmp-overlay', path] : ['--tmpfs', path]));
  }
  for (const path of readable.filter(existsSync)) words.push('--ro-bind', path, path);
  for (const path of open.filter(existsSync)) words.push('--bind', path, path);
  // Last, so that a writable folder holding one of them does not show it again.
  const all = new Set([...hidden, ...sockets, ...ROOT_SOCKETS, ...(network ? [] : LOOKUP_SOCKETS)]);
  for (const path of [...all].filter(existsSync)) words.push('--ro-bind', '/dev/null', path);
  words.push('--unshare-all', ...(network ? ['--share-net'] : []), '--chdir', cwd);
  return words;
}
