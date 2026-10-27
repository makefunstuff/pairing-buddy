// The environment variables named by "apiKeyEnv", kept for the daemon in a file only you can read: a service started
// at login (systemd, launchd) does not get your shell's environment. The daemon reads it as it needs a key, so a key
// stored there takes effect without a restart. One NAME=value per line, as systemd's EnvironmentFile has it.
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

/** The variables in the file at `path`, by name; empty when there is none. */
export function readServiceEnv(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  return Object.fromEntries(text.split('\n')
    .map(line => /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line))
    .filter(Boolean)
    .map(([, name, value]) => [name, value]));
}

/** The names of the variables the config's model entries take their keys from. */
export const keyVariables = config => [...new Set([...Object.values(config.models), config.decision].map(entry => entry?.apiKeyEnv).filter(Boolean))];

/**
 * Stores each of `names` that `env` has in the file at `path`, readable by its owner only, next to what it holds.
 * Returns `{stored, missing}`: the names stored, and those `env` does not have.
 */
export function storeServiceEnv(path, names, env) {
  const values = readServiceEnv(path);
  const stored = names.filter(name => env[name]);
  for (const name of stored) values[name] = env[name];
  if (stored.length) {
    mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    const temporary = `${path}.${process.pid}.tmp`; // renamed, so a reader never sees half a file
    writeFileSync(temporary, Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join(''), {mode: 0o600});
    renameSync(temporary, path);
  }
  return {stored, missing: names.filter(name => !env[name])};
}
