// The daemon as a launchd agent on macOS: it starts at login and restarts when it fails.
import {execFile} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';

export const LABEL = 'io.github.makefunstuff.pairing-buddy';

export const agentPath = () => join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
export const logPath = () => join(homedir(), 'Library', 'Logs', 'pairing-buddy.log');
const domain = () => `gui/${process.getuid()}`;

const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const string = (value, indent) => `${indent}<string>${xml(value)}</string>`;

/**
 * The agent that runs `script daemon` with `node`; `env` holds variables the daemon needs, such as PAIR_CONFIG. It is
 * started again when it exits with an error or a signal, not when it stops cleanly.
 */
export function agentFile({node, script, env = {}, log = logPath()}) {
  const variables = Object.entries(env).map(([name, value]) => `    <key>${xml(name)}</key>\n${string(value, '    ')}\n`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[node, '--disable-warning=ExperimentalWarning', script, 'daemon'].map(word => string(word, '    ')).join('\n')}
  </array>
${variables ? `  <key>EnvironmentVariables</key>\n  <dict>\n${variables}  </dict>\n` : ''}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>2</integer>
  <key>StandardOutPath</key>
${string(log, '  ')}
  <key>StandardErrorPath</key>
${string(log, '  ')}
</dict>
</plist>
`;
}

/** Runs `launchctl ...args`; resolves `{ok, output}`, never rejects. */
export function launchctl(...args) {
  return new Promise(resolve => {
    execFile('launchctl', args, {timeout: 15_000}, (error, stdout, stderr) => {
      resolve({ok: !error, output: `${stdout}${stderr}`.trim() || error?.message || ''});
    });
  });
}

/** Writes the agent and (re)loads it, which starts it, so it runs this install's code. */
async function install(agent) {
  mkdirSync(dirname(agentPath()), {recursive: true});
  mkdirSync(dirname(logPath()), {recursive: true});
  writeFileSync(agentPath(), agentFile(agent));
  await launchctl('bootout', `${domain()}/${LABEL}`); // the agent of an earlier setup, if it is loaded
  await launchctl('enable', `${domain()}/${LABEL}`);
  const loaded = await launchctl('bootstrap', domain(), agentPath());
  if (!loaded.ok) throw new Error(`launchctl bootstrap failed: ${loaded.output}`);
}

async function remove() {
  await launchctl('bootout', `${domain()}/${LABEL}`);
  rmSync(agentPath(), {force: true});
}

/** Starts the agent: loads it if it is not, which starts it, else starts it now. */
async function start() {
  const started = await launchctl('kickstart', `${domain()}/${LABEL}`);
  return started.ok ? started : launchctl('bootstrap', domain(), agentPath());
}

/** `{installed, enabled, active, node}`: `node` is the Node.js the agent runs, which an upgrade may have removed. */
async function state() {
  if (!existsSync(agentPath())) return {installed: false, enabled: false, active: false, node: null};
  const node = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(readFileSync(agentPath(), 'utf8'))?.[1]
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&') ?? null;
  const [printed, disabled] = await Promise.all([launchctl('print', `${domain()}/${LABEL}`), launchctl('print-disabled', domain())]);
  const enabled = !new RegExp(`"${LABEL.replaceAll('.', '\\.')}" => (true|disabled)`).test(disabled.output);
  return {installed: true, enabled, active: printed.ok && /^\s*state = running$/m.test(printed.output), node};
}

/** The service manager on macOS (see service.mjs). */
export const launchd = {
  name: `the launchd agent ${LABEL}`,
  installed: () => existsSync(agentPath()),
  install,
  remove,
  state,
  start,
  restart: `launchctl kickstart -k gui/$(id -u)/${LABEL}`,
  enable: `launchctl enable gui/$(id -u)/${LABEL}`,
  logs: `tail -n 20 ~/Library/Logs/pairing-buddy.log`,
};
