// Pairing sessions and their chat history, next to the Partner's own pi-durable database.
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
);`;

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  // Databases from v0.1 have no role column.
  if (!db.prepare('SELECT 1 FROM pragma_table_info(\'sessions\') WHERE name = \'role\'').get()) {
    db.exec('ALTER TABLE sessions ADD COLUMN role TEXT NOT NULL DEFAULT \'navigator\'');
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

    addMessage: (sessionId, sender, text, at) => db.prepare('INSERT INTO messages (session_id, at, sender, text) VALUES (?, ?, ?, ?)').run(sessionId, at, sender, text),
    messages: (sessionId, limit = 50) => db.prepare('SELECT at, sender, text FROM (SELECT rowid, * FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT ?) ORDER BY rowid').all(sessionId, limit),

    close: () => db.close(),
  };
}
