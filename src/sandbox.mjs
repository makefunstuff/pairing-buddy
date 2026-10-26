// The sandbox of Pair's pane, when bubblewrap is there: the disk read-only except the project and the folders the
// config names, a private /tmp, no network (name lookups included) unless allowed, and the sockets that reach your
// desktop session, herdr or the daemon hidden. The command policy still decides what runs; the sandbox limits what an allowed command does.
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';

const BWRAP = 'bwrap';
// Container daemons run anything they are asked to as root.
const ROOT_SOCKETS = ['/run/docker.sock', '/run/podman/podman.sock'];
// Daemons that look names up on the network for a client: without the network, a lookup would still carry data out.
// The system bus is among them, since systemd-resolved answers lookups there too.
const LOOKUP_SOCKETS = [
  '/run/systemd/resolve/io.systemd.Resolve', '/run/systemd/resolve/io.systemd.Resolve.Monitor', '/run/nscd/socket',
  '/run/avahi-daemon/socket', '/run/dbus/system_bus_socket',
];

let works;

/** Whether bubblewrap is installed and may make namespaces here (some systems forbid it to users); checked once. */
export function sandboxWorks() {
  works ??= spawnSync(BWRAP, ['--ro-bind', '/', '/', '--unshare-all', 'true'], {stdio: 'ignore', timeout: 5000}).status === 0;
  return works;
}

/**
 * The words that start a program in the sandbox, in `cwd`: `writable` are the folders besides `cwd` that it may
 * write, `readable` files it must see even in /tmp, `hidden` the sockets it must not reach. `XDG_RUNTIME_DIR` (your
 * session's sockets) is an empty folder in it.
 */
export function sandboxWords({cwd, writable = [], readable = [], hidden = [], network = false, runtimeDir = process.env.XDG_RUNTIME_DIR}) {
  const words = [BWRAP, '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'];
  if (runtimeDir) words.push('--tmpfs', runtimeDir);
  for (const path of readable.filter(existsSync)) words.push('--ro-bind', path, path);
  for (const path of [cwd, ...writable].filter(existsSync)) words.push('--bind', path, path);
  // Last, so that a writable folder holding one of them does not show it again.
  const sockets = [...hidden, ...ROOT_SOCKETS, ...(network ? [] : LOOKUP_SOCKETS)];
  for (const path of sockets.filter(existsSync)) words.push('--ro-bind', '/dev/null', path);
  words.push('--unshare-all', ...(network ? ['--share-net'] : []), '--chdir', cwd);
  return words;
}
