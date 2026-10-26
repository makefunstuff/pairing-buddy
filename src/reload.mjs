// The daemon watches its config file and takes a change without a restart: what changed, checked as at start.
// A config with an error is not taken: the daemon keeps the one it runs and says why.
import {watch} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {basename, dirname} from 'node:path';
import {loadConfig} from './config.mjs';

const SETTLE_MS = 200; // an editor's save can be several writes, or a write and a rename

/** The fields of a parsed config that a change can touch, in the order the chat names them. */
const FIELDS = ['models', 'level', 'typingPauseMs', 'autoTune', 'keepWarm', 'testOnSave', 'voice', 'socket', 'dataDir'];

/** Only a restart moves these: the daemon listens on its socket and holds its data directory. */
export const RESTART_FIELDS = ['socket', 'dataDir'];

/** The fields that differ between two parsed configs. */
export function configChanges(running, next) {
  return FIELDS.filter(field => JSON.stringify(running[field]) !== JSON.stringify(next[field]));
}

/**
 * Watches the config at `path` (its directory, since many editors save by renaming a new file over it) and calls
 * `onChange(config)` with each new valid config, or `onError(message)` when the file has an error. Returns `close()`.
 */
export function watchConfig(path, {onChange, onError, settleMs = SETTLE_MS}) {
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
      config = loadConfig(path);
    } catch (error) {
      return onError(error.message);
    }
    onChange(config);
  }

  const watcher = watch(dirname(path), (event, name) => {
    if (name && name !== basename(path)) return;
    clearTimeout(timer);
    timer = setTimeout(check, settleMs);
  });
  return {
    close() {
      clearTimeout(timer);
      watcher.close();
    },
  };
}
