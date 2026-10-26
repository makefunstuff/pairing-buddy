// Pairing sessions, their chat history and the remarks Pair made unasked with the user's verdict on each,
// next to the Partner's own pi-durable database.
import {DatabaseSync} from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  root TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  goal TEXT,
  level TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'navigator',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  note TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  at INTEGER NOT NULL,
  sender TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS remarks (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  trigger TEXT NOT NULL,
  score REAL,
  at INTEGER NOT NULL,
  verdict TEXT
);
-- Active pairing time per clock hour (hour = ms since the epoch / 3600000), counted when it happened, so a
-- session left open for days adds to each day it was used.
CREATE TABLE IF NOT EXISTS activity (
  hour INTEGER PRIMARY KEY,
  ms INTEGER NOT NULL
);`;

const HOUR = 60 * 60_000;

/** Columns added since v0.1, with their definitions. */
const ADDED_COLUMNS = {
  role: 'TEXT NOT NULL DEFAULT \'navigator\'',
};

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  for (const [column, definition] of Object.entries(ADDED_COLUMNS)) {
    if (!db.prepare('SELECT 1 FROM pragma_table_info(\'sessions\') WHERE name = ?').get(column)) {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${column} ${definition}`);
    }
  }
  const toSession = row => row && {...row, conversation_id: JSON.parse(row.conversation_id)};

  return {
    /** The session of `root` that has not ended, if any. */
    activeSession: root => toSession(db.prepare('SELECT * FROM sessions WHERE root = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1').get(root)),

    createSession({root, conversationId, goal, level, at}) {
      const {lastInsertRowid} = db.prepare('INSERT INTO sessions (root, conversation_id, goal, level, started_at) VALUES (?, ?, ?, ?, ?)')
        .run(root, JSON.stringify(conversationId), goal ?? null, level, at);
      return toSession(db.prepare('SELECT * FROM sessions WHERE id = ?').get(lastInsertRowid));
    },

    setGoal: (id, goal) => db.prepare('UPDATE sessions SET goal = ? WHERE id = ?').run(goal, id),
    setLevel: (id, level) => db.prepare('UPDATE sessions SET level = ? WHERE id = ?').run(level, id),
    setRole: (id, role) => db.prepare('UPDATE sessions SET role = ? WHERE id = ?').run(role, id),
    endSession: (id, note, at) => db.prepare('UPDATE sessions SET ended_at = ?, note = ? WHERE id = ?').run(at, note, id),

    /** The note of the last ended session of `root` before session `id`: where the next session starts from. */
    previousNote: (root, id) => db.prepare('SELECT note FROM sessions WHERE root = ? AND id < ? AND note IS NOT NULL ORDER BY id DESC LIMIT 1').get(root, id)?.note ?? null,

    addMessage: (sessionId, sender, text, at) => db.prepare('INSERT INTO messages (session_id, at, sender, text) VALUES (?, ?, ?, ?)').run(sessionId, at, sender, text),
    messages: (sessionId, limit = 50) => db.prepare('SELECT at, sender, text FROM (SELECT rowid, * FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT ?) ORDER BY rowid').all(sessionId, limit),

    addRemark: ({sessionId, trigger, score, at}) => Number(db.prepare('INSERT INTO remarks (session_id, trigger, score, at) VALUES (?, ?, ?, ?)')
      .run(sessionId, trigger, score ?? null, at).lastInsertRowid),
    dropRemark: id => db.prepare('DELETE FROM remarks WHERE id = ?').run(id),
    /** Records the user's verdict on remark `id`, "useful" or "dismissed"; false when there is no such remark. */
    rateRemark: (id, verdict) => db.prepare('UPDATE remarks SET verdict = ? WHERE id = ?').run(verdict, id).changes > 0,
    /** Records that the user saw remark `id` (they edited after it showed), unless it has a verdict already. */
    seeRemark: id => db.prepare('UPDATE remarks SET verdict = \'seen\' WHERE id = ? AND verdict IS NULL').run(id),
    /** Every remark since `since`, newest first. */
    remarks: since => db.prepare('SELECT id, trigger, score, at, verdict FROM remarks WHERE at >= ? ORDER BY id DESC').all(since),
    /** Adds `ms` of active pairing, just before `at`, to its hour. */
    addActive: (at, ms) => db.prepare('INSERT INTO activity (hour, ms) VALUES (?, ?) ON CONFLICT (hour) DO UPDATE SET ms = ms + excluded.ms')
      .run(Math.floor(at / HOUR), ms),
    /** How long the user was active since `since`, in ms, in any session: whole hours, from the one `since` falls in. */
    activeMs: since => db.prepare('SELECT coalesce(sum(ms), 0) AS ms FROM activity WHERE hour >= ?').get(Math.floor(since / HOUR)).ms,

    close: () => db.close(),
  };
}
