// The daemon as a systemd user service: it starts at login and restarts when it fails.
import {execFile} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {xdg} from './config.mjs';

export const UNIT = 'pairing-buddy.service';

export const unitPath = () => join(xdg('XDG_CONFIG_HOME', '.config'), 'systemd', 'user', UNIT);

/** A path as one word of a unit file's command line. */
const word = path => (/\s/.test(path) ? `"${path}"` : path);

/** The unit file that runs `script daemon` with `node`; `env` holds variables the daemon needs, such as PAIR_CONFIG. */
export function unitFile({node, script, env = {}}) {
  return `[Unit]
Description=pairing-buddy daemon (pair)
Documentation=https://github.com/makefunstuff/pairing-buddy

[Service]
ExecStart=${word(node)} --disable-warning=ExperimentalWarning ${word(script)} daemon
${Object.entries(env).map(([name, value]) => `Environment="${name}=${value}"\n`).join('')}Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

/** Runs `systemctl --user ...args`; resolves `{ok, output}`, never rejects. */
export function systemctl(...args) {
  return new Promise(resolve => {
    execFile('systemctl', ['--user', ...args], {timeout: 15_000}, (error, stdout, stderr) => {
      resolve({ok: !error, output: `${stdout}${stderr}`.trim() || error?.message || ''});
    });
  });
}

/** Writes the unit, enables it for every login and (re)starts it, so it runs this install's code. */
async function install(unit) {
  mkdirSync(dirname(unitPath()), {recursive: true});
  writeFileSync(unitPath(), unitFile(unit));
  for (const args of [['daemon-reload'], ['enable', UNIT], ['restart', UNIT]]) {
    const result = await systemctl(...args);
    if (!result.ok) throw new Error(`systemctl --user ${args.join(' ')} failed: ${result.output}`);
  }
}

async function remove() {
  await systemctl('disable', '--now', UNIT);
  rmSync(unitPath(), {force: true});
  await systemctl('daemon-reload');
}

/** `{installed, enabled, active, node}`: `node` is the Node.js the unit runs, which an upgrade may have removed. */
async function state() {
  if (!existsSync(unitPath())) return {installed: false, enabled: false, active: false, node: null};
  const node = /^ExecStart=("[^"]+"|\S+)/m.exec(readFileSync(unitPath(), 'utf8'))?.[1].replaceAll('"', '') ?? null;
  const [enabled, active] = await Promise.all([systemctl('is-enabled', UNIT), systemctl('is-active', UNIT)]);
  return {installed: true, enabled: enabled.ok, active: active.ok, node};
}

/** The service manager on Linux with systemd (see service.mjs). */
export const systemd = {
  name: UNIT,
  installed: () => existsSync(unitPath()),
  install,
  remove,
  state,
  start: () => systemctl('start', UNIT),
  restart: `systemctl --user restart ${UNIT}`,
  enable: `systemctl --user enable ${UNIT}`,
  logs: `journalctl --user -u ${UNIT} -n 20`,
};
