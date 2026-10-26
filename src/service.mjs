// What starts the daemon at login and restarts it when it fails: a systemd user service on Linux, a launchd agent on
// macOS. Without either, `pair` runs the daemon under its own supervisor (see supervise.mjs), which restarts it too.
import {existsSync} from 'node:fs';
import {launchd} from './launchd.mjs';
import {systemd} from './systemd.mjs';

/**
 * The service manager here, or null: `{name, installed(), install({node, script, env}), remove(), state(), start(),
 * restart, enable, logs}`, the last three the commands to tell the user. A Linux booted with systemd has the directory.
 */
export function serviceManager(platform = process.platform, systemdBooted = existsSync('/run/systemd/system')) {
  if (platform === 'darwin') return launchd;
  if (platform === 'linux' && systemdBooted) return systemd;
  return null;
}
