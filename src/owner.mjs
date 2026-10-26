// One daemon per data directory. SQLite's EXCLUSIVE locking mode holds a POSIX lock for as long as
// the connection is open, and the kernel drops it when the process dies: no stale PID file to clean up.
// Same approach as pi-durable-worker's durable-host.
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';

export function acquireOwner(dataDir) {
  const db = new DatabaseSync(join(dataDir, 'daemon.lock'), {timeout: 0});
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    db.exec('CREATE TABLE IF NOT EXISTS owner (pid INTEGER)');
    db.exec('COMMIT');
  } catch (error) {
    db.close();
    if (/locked|busy/i.test(String(error?.message))) throw new Error(`Another pair daemon already owns ${dataDir}`);
    throw error;
  }
  return {release: () => db.close()};
}
