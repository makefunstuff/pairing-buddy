// The logins and keys of `pair auth`: one JSON file, readable by its owner only, one credential per provider
// (pi-ai's `CredentialStore`). The daemon, `pair doctor` and `pair auth` may refresh a token at the same time, and a
// refresh can rotate the refresh token, so every write holds a lock file: a token is refreshed once, by one of them.
import {randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {dirname} from 'node:path';

const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 60_000; // a lock older than any refresh was left by a process that died holding it
const LOCK_RETRY_MS = 50;

/** Every stored credential, by provider id; empty when there is no file yet. */
export function readCredentials(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  try { return JSON.parse(text); } catch { throw new Error(`${path} is not valid JSON: log in again with \`pair auth login\``); }
}

/** The stored API key of `name`, if it has one. */
export function storedKey(path, name) {
  const credential = readCredentials(path)[name];
  return credential?.type === 'api_key' ? credential.key : undefined;
}

/** Whether others than the owner can read the file at `path` (false when there is none). */
export function readableByOthers(path) {
  try { return (statSync(path).mode & 0o077) !== 0; } catch { return false; }
}

function writeCredentials(path, credentials) {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  // Written next to it and renamed, so a reader never sees half a file.
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(credentials, null, 2)}\n`, {mode: 0o600});
  renameSync(temporary, path);
}

async function withLock(path, fn) {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await (await open(lock, 'wx', 0o600)).close();
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let age = 0;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; }
      if (age > LOCK_STALE_MS) { rmSync(lock, {force: true}); continue; }
      if (Date.now() > until) throw new Error(`${lock} is held by another pair process; remove it if none runs`);
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  try { return await fn(); } finally { rmSync(lock, {force: true}); }
}

/** pi-ai's `CredentialStore` over the file at `path`. */
export function fileCredentialStore(path) {
  // One write at a time in this process too: the lock file cannot tell its own holder apart.
  let chain = Promise.resolve();
  const serialized = fn => {
    const run = chain.then(() => withLock(path, fn));
    chain = run.catch(() => {});
    return run;
  };
  return {
    async read(providerId) {
      return readCredentials(path)[providerId];
    },
    async list() {
      return Object.entries(readCredentials(path)).map(([providerId, credential]) => ({providerId, type: credential.type}));
    },
    modify(providerId, fn) {
      return serialized(async () => {
        const credentials = readCredentials(path);
        const next = await fn(credentials[providerId]);
        if (next === undefined) return credentials[providerId];
        writeCredentials(path, {...credentials, [providerId]: next});
        return next;
      });
    },
    delete(providerId) {
      return serialized(async () => {
        const {[providerId]: _removed, ...rest} = readCredentials(path);
        writeCredentials(path, rest);
      });
    },
  };
}

/** The id this installation gives OpenAI's "Sign in with ChatGPT", made on first use and kept next to the logins. */
export function deviceId(path) {
  try { return readFileSync(path, 'utf8').trim(); } catch {
    const id = randomUUID();
    mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    writeFileSync(path, `${id}\n`, {mode: 0o600});
    return id;
  }
}
