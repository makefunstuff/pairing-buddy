// The daemon watches its config file and takes a change without a restart: what changed, checked as at start.
// A config with an error is not taken: the daemon keeps the one it runs and says why.
import {realpathSync, watch} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {basename, dirname} from 'node:path';
import {loadConfig} from './config.mjs';

const SETTLE_MS = 200; // an editor's save can be several writes, or a write and a rename

/** The fields of a parsed config that a change can touch, in the order the chat names them. */
const FIELDS = [
  'models', 'decision', 'level', 'typingPauseMs', 'autoTune', 'keepWarm', 'watcherPace', 'testOnSave', 'sessionRoots', 'voice', 'taskCommand', 'board', 'agents',
  'socket', 'dataDir',
];

/** Only a restart moves these: the daemon listens on its socket, holds its data directory and starts the agent relay. */
export const RESTART_FIELDS = ['socket', 'dataDir', 'agents'];

/** The fields that differ between two parsed configs. */
export function configChanges(running, next) {
  return FIELDS.filter(field => JSON.stringify(running[field]) !== JSON.stringify(next[field]));
}

/**
 * Watches the config at `path` and calls `onChange(config)` with each new valid config, or `onError(message)` when the
 * file has an error. Returns `close()`. It watches the file's directory, since many editors save by renaming a new
 * file over it; for a config that is a symlink (into a dotfiles repository, say), the target's directory too.
 * `load(path)` reads and checks the config (the daemon's also asks the servers for their windows, see context-window.mjs).
 */
export function watchConfig(path, {onChange, onError, load = loadConfig, settleMs = SETTLE_MS}) {
  let timer = null;
  let last = null; // the text last read, so a save that changes nothing is no change
  readFile(path, 'utf8').then(text => { last ??= text; }, () => {});

  async function check() {
    const text = await readFile(path, 'utf8').catch(() => null);
    if (text === last) return;
    last = text;
    if (text === null) return onError(`${path} is gone`);
    let config;
    try {
      config = await load(path);
    } catch (error) {
      return onError(error.message);
    }
    onChange(config);
  }

  const watchers = new Map(); // a watched file (the config, or its symlink's target) -> the watch of its directory
  function follow(file) {
    if (watchers.has(file)) return;
    try {
      watchers.set(file, watch(dirname(file), (event, name) => {
        if (name && name !== basename(file)) return;
        clearTimeout(timer);
        timer = setTimeout(changed, settleMs);
      }));
    } catch {} // the target's directory is gone: the config's own directory is still watched
  }
  /** The symlink may point elsewhere now: its new target is watched too. */
  function changed() {
    try { follow(realpathSync(path)); } catch {}
    return check();
  }
  follow(path);
  try { follow(realpathSync(path)); } catch {}
  return {
    close() {
      clearTimeout(timer);
      for (const watcher of watchers.values()) watcher.close();
    },
  };
}
