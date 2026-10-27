// Pairing sessions, their chat history, the remarks Pair made unasked with the user's verdict on each, and the
// ledger of everything Pair did, next to the Partner's own pi-durable database.
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
  note TEXT,
  pickup TEXT, -- JSON: where the next session picks up, {first: {step, file, line, text}, tests} (see debrief.mjs)
  active_ms INTEGER NOT NULL DEFAULT 0,
  worked INTEGER NOT NULL DEFAULT 0 -- the user worked in it (see WORK_EVENTS in session.mjs), not only read
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
  verdict TEXT,
  waited_ms INTEGER, -- how long its trigger waited for the model while the Partner was at work
  shown INTEGER NOT NULL DEFAULT 0 -- it reached the user: stored at the start of its turn, it may never have
);
-- What the decision model (see decision.mjs) answered about each moment the gate judged with it, and what came of it:
-- the gate's verdict, what the old rules (the Watcher's score against the bar) would have done, and the remark it led
-- to, whose verdict is the outcome. \`fallback\` says why the model gave no answer, when the rules decided instead.
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  at INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  sort TEXT, -- noise, worth or ask
  sort_p REAL,
  speak_p REAL, -- that a remark is worth interrupting for now
  score REAL, -- the Watcher's, when it was asked
  bar REAL,
  rule TEXT, -- speak or drop: the score against the bar; null when the Watcher was not asked
  verdict TEXT NOT NULL, -- the gate's: speak or drop
  fallback TEXT, -- down, timeout, error or malformed
  remark_id INTEGER,
  state TEXT -- JSON: what the model was told about the moment (see decision.mjs), so the moment can be judged again
);
-- Active pairing time per clock hour (hour = ms since the epoch / 3600000), counted when it happened, so a
-- session left open for days adds to each day it was used.
CREATE TABLE IF NOT EXISTS activity (
  hour INTEGER PRIMARY KEY,
  ms INTEGER NOT NULL
);
-- The same per project (a session root), for \`pair stats --project\`; kept since v0.9, so older hours are missing.
CREATE TABLE IF NOT EXISTS project_activity (
  root TEXT NOT NULL,
  hour INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  PRIMARY KEY (root, hour)
);
-- The ledger of what Pair did (see ledger.mjs). As JSON: data is what the list shows, detail what one entry opens
-- to (a command's output, why Pair stayed quiet, a file's text before and after an edit).
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  detail TEXT,
  state TEXT
);`;

const HOUR = 60 * 60_000;
const ACTION_COLUMNS = new Set(['text', 'data', 'detail', 'state']);

/** Columns added since v0.1, by table, with their definitions. */
const ADDED_COLUMNS = {
  sessions: {role: 'TEXT NOT NULL DEFAULT \'navigator\'', pickup: 'TEXT', active_ms: 'INTEGER NOT NULL DEFAULT 0', worked: 'INTEGER NOT NULL DEFAULT 0'},
  remarks: {waited_ms: 'INTEGER', shown: 'INTEGER NOT NULL DEFAULT 0'},
  decisions: {state: 'TEXT'},
};
/** What an added column starts with in the rows already there, where its default is wrong. */
const FILLED = {
  // Until v0.9 only work counted as active time.
  'sessions.worked': 'UPDATE sessions SET worked = active_ms > 0',
  // A remark that said something has its words in the ledger.
  'remarks.shown': `UPDATE remarks SET shown = EXISTS (SELECT 1 FROM actions a WHERE a.kind = 'said' AND json_extract(a.data, '$.remark') = remarks.id)`,
};

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    for (const [column, definition] of Object.entries(columns)) {
      if (!db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        if (FILLED[`${table}.${column}`]) db.exec(FILLED[`${table}.${column}`]);
      }
    }
  }
  const toSession = row => row && {...row, conversation_id: JSON.parse(row.conversation_id)};

  return {
    /** The session of `root` that has not ended, if any. */
    activeSession: root => toSession(db.prepare('SELECT * FROM sessions WHERE root = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1').get(root)),

    /** The session of conversation `conversationId` that has not ended, if any. */
    activeSessionOf: conversationId => toSession(db.prepare('SELECT * FROM sessions WHERE conversation_id = ? AND ended_at IS NULL').get(JSON.stringify(conversationId))),

    /** The messages of session `id` since `since`, oldest first. */
    messagesSince: (id, since) => db.prepare('SELECT at, sender, text FROM messages WHERE session_id = ? AND at >= ? ORDER BY rowid').all(id, since),

    createSession({root, conversationId, goal, level, at}) {
      const {lastInsertRowid} = db.prepare('INSERT INTO sessions (root, conversation_id, goal, level, started_at) VALUES (?, ?, ?, ?, ?)')
        .run(root, JSON.stringify(conversationId), goal ?? null, level, at);
      return toSession(db.prepare('SELECT * FROM sessions WHERE id = ?').get(lastInsertRowid));
    },

    setGoal: (id, goal) => db.prepare('UPDATE sessions SET goal = ? WHERE id = ?').run(goal, id),
    setLevel: (id, level) => db.prepare('UPDATE sessions SET level = ? WHERE id = ?').run(level, id),
    setRole: (id, role) => db.prepare('UPDATE sessions SET role = ? WHERE id = ?').run(role, id),
    endSession: (id, note, at, pickup = null) => db.prepare('UPDATE sessions SET ended_at = ?, note = ?, pickup = ? WHERE id = ?')
      .run(at, note, pickup && JSON.stringify(pickup), id),
    updateDebrief: (id, note, pickup) => db.prepare('UPDATE sessions SET note = ?, pickup = ? WHERE id = ?').run(note, JSON.stringify(pickup), id),
    /** The last ended session of `root` before session `id` that left a note: {id, note, pickup, endedAt}, or null. */
    lastSession(root, id) {
      const row = db.prepare('SELECT id, note, pickup, ended_at FROM sessions WHERE root = ? AND id < ? AND note IS NOT NULL ORDER BY id DESC LIMIT 1').get(root, id);
      return row ? {id: row.id, note: row.note, pickup: row.pickup && JSON.parse(row.pickup), endedAt: row.ended_at} : null;
    },

    /** The note of the last ended session of `root` before session `id`: where the next session starts from. */
    previousNote: (root, id) => db.prepare('SELECT note FROM sessions WHERE root = ? AND id < ? AND note IS NOT NULL ORDER BY id DESC LIMIT 1').get(root, id)?.note ?? null,

    addMessage: (sessionId, sender, text, at) => db.prepare('INSERT INTO messages (session_id, at, sender, text) VALUES (?, ?, ?, ?)').run(sessionId, at, sender, text),
    messages: (sessionId, limit = 50) => db.prepare('SELECT at, sender, text FROM (SELECT rowid, * FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT ?) ORDER BY rowid').all(sessionId, limit),

    addRemark: ({sessionId, trigger, score, at, waitedMs}) => Number(db.prepare('INSERT INTO remarks (session_id, trigger, score, at, waited_ms) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, trigger, score ?? null, at, waitedMs ?? null).lastInsertRowid),
    dropRemark: id => db.prepare('DELETE FROM remarks WHERE id = ?').run(id),
    /** Records the user's verdict on remark `id`, "useful" or "dismissed"; false when there is no such remark. */
    rateRemark: (id, verdict) => db.prepare('UPDATE remarks SET verdict = ? WHERE id = ?').run(verdict, id).changes > 0,
    /** Records that the user saw remark `id` (they edited after it showed), unless it has a verdict already. */
    seeRemark: id => db.prepare('UPDATE remarks SET verdict = \'seen\' WHERE id = ? AND verdict IS NULL').run(id),
    /** The remarks of session `id`, oldest first. */
    sessionRemarks: id => db.prepare('SELECT id, trigger, score, at, verdict FROM remarks WHERE session_id = ? ORDER BY id').all(id),
    /** The last remark of session `id`, or null: what feedback without a number rates, also after a daemon restart. */
    lastRemark: id => db.prepare('SELECT id FROM remarks WHERE session_id = ? AND shown ORDER BY id DESC LIMIT 1').get(id)?.id ?? null,
    /** Records that remark `id` reached the user. */
    showRemark: id => db.prepare('UPDATE remarks SET shown = 1 WHERE id = ?').run(id),
    /** Every remark since `since`, newest first, with the project (`root`) it was made in. */
    remarks: since => db.prepare(`SELECT r.id, r.trigger, r.score, r.at, r.verdict, r.waited_ms AS waitedMs, s.root
      FROM remarks r JOIN sessions s ON s.id = r.session_id WHERE r.at >= ? ORDER BY r.id DESC`).all(since),
    /**
     * The last `limit` remarks in `root` that reached the user, newest first, each with the first line of what Pair said in it (from the
     * ledger): the list the chat rates an older remark from.
     */
    recentRemarks: (root, limit) => db.prepare(`SELECT r.id, r.trigger, r.at, r.verdict,
        (SELECT a.text FROM actions a WHERE a.kind = 'said' AND json_extract(a.data, '$.remark') = r.id) AS text
      FROM remarks r JOIN sessions s ON s.id = r.session_id WHERE s.root = ? AND r.shown ORDER BY r.id DESC LIMIT ?`).all(root, limit),
    /** Logs one decision of the gate's made with the decision model (see the decisions table); returns its id. */
    addDecision: ({sessionId, at, trigger, sort = null, sortP = null, speakP = null, score = null, bar = null, rule = null, verdict, fallback = null, state = null}) => Number(db.prepare(
      'INSERT INTO decisions (session_id, at, trigger, sort, sort_p, speak_p, score, bar, rule, verdict, fallback, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(sessionId, at, trigger, sort, sortP, speakP, score, bar, rule, verdict, fallback, state && JSON.stringify(state)).lastInsertRowid),
    /** The remark decision `id` led to. */
    linkDecision: (id, remarkId) => db.prepare('UPDATE decisions SET remark_id = ? WHERE id = ?').run(remarkId, id),
    /**
     * The decisions since `since`, newest first, with the project they were made in and what became of their remark:
     * `remarkAt` and `verdict`, both null when it said nothing (or there was none).
     */
    decisions: since => db.prepare(`SELECT d.id, d.trigger, d.at, d.sort, d.sort_p AS sortP, d.speak_p AS speakP, d.score, d.bar, d.rule, d.verdict AS decided,
        d.fallback, d.remark_id AS remarkId, d.state, s.root, r.at AS remarkAt, r.verdict, r.shown
      FROM decisions d JOIN sessions s ON s.id = d.session_id LEFT JOIN remarks r ON r.id = d.remark_id WHERE d.at >= ? ORDER BY d.id DESC`).all(since)
      .map(row => ({...row, state: row.state && JSON.parse(row.state)})),
    /** Adds `ms` of active pairing in project `root`, just before `at`, to its hour. */
    addActive(at, ms, root) {
      const hour = Math.floor(at / HOUR);
      db.prepare('INSERT INTO activity (hour, ms) VALUES (?, ?) ON CONFLICT (hour) DO UPDATE SET ms = ms + excluded.ms').run(hour, ms);
      db.prepare('INSERT INTO project_activity (root, hour, ms) VALUES (?, ?, ?) ON CONFLICT (root, hour) DO UPDATE SET ms = ms + excluded.ms')
        .run(root, hour, ms);
    },
    /** Adds `ms` of active pairing to session `id`, and that the user `worked` in it; `sessionActiveMs` is its total. */
    addSessionActive: (id, ms, worked) => db.prepare('UPDATE sessions SET active_ms = active_ms + ?, worked = max(worked, ?) WHERE id = ?')
      .run(ms, worked ? 1 : 0, id),
    sessionActiveMs: id => db.prepare('SELECT active_ms FROM sessions WHERE id = ?').get(id)?.active_ms ?? 0,
    /** How long the user was active since `since`, in ms, in any session: whole hours, from the one `since` falls in. */
    activeMs: since => db.prepare('SELECT coalesce(sum(ms), 0) AS ms FROM activity WHERE hour >= ?').get(Math.floor(since / HOUR)).ms,
    /** The same in project `root` alone. */
    projectActiveMs: (root, since) => db.prepare('SELECT coalesce(sum(ms), 0) AS ms FROM project_activity WHERE root = ? AND hour >= ?')
      .get(root, Math.floor(since / HOUR)).ms,
    /** Whether project `root` has any session: `pair stats --project` names a folder that never had one. */
    knownRoot: root => !!db.prepare('SELECT 1 FROM sessions WHERE root = ? LIMIT 1').get(root),

    /**
     * What the earlier sessions of `root` (not session `id`) kept that has any of `words` in it: their goals and notes,
     * as `{session, at, goal, note}`, and their chat lines, as `{session, at, goal, sender, text}`; at most `limit` of
     * each, newest first. Ranking them is recall.mjs's.
     */
    history(root, id, words, limit) {
      const any = words.map(() => '{column} LIKE ? ESCAPE \'\\\'').join(' OR ');
      const patterns = words.map(word => `%${word.replace(/[\\%_]/g, '\\$&')}%`);
      const notes = db.prepare(`SELECT id AS session, coalesce(ended_at, started_at) AS at, goal, note FROM sessions
        WHERE root = ? AND id != ? AND (${any.replaceAll('{column}', 'note')} OR ${any.replaceAll('{column}', 'goal')})
        ORDER BY id DESC LIMIT ?`).all(root, id, ...patterns, ...patterns, limit);
      const lines = db.prepare(`SELECT m.session_id AS session, m.at, s.goal, m.sender, m.text FROM messages m JOIN sessions s ON s.id = m.session_id
        WHERE s.root = ? AND s.id != ? AND (${any.replaceAll('{column}', 'm.text')})
          AND (s.note IS NULL OR instr(m.text, s.note) = 0) -- the debrief in the chat is the note again
        ORDER BY m.rowid DESC LIMIT ?`).all(root, id, ...patterns, limit);
      return {notes, lines};
    },

    addAction: ({sessionId, at, kind, text, data = {}, detail = null}) => Number(db.prepare('INSERT INTO actions (session_id, at, kind, text, data, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, at, kind, text, JSON.stringify(data), detail && JSON.stringify(detail)).lastInsertRowid),
    /** Sets the text, data, detail or state of action `id`, those that `changes` has. */
    updateAction(id, changes) {
      for (const [column, value] of Object.entries(changes)) {
        if (!ACTION_COLUMNS.has(column)) throw new Error(`No action column ${column}`);
        const json = (column === 'data' || column === 'detail') && value !== null;
        db.prepare(`UPDATE actions SET ${column} = ? WHERE id = ?`).run(json ? JSON.stringify(value) : value, id);
      }
    },
    /** Action `id` with its detail and the root of its session, or undefined. */
    action(id) {
      const row = db.prepare('SELECT a.*, s.root FROM actions a JOIN sessions s ON s.id = a.session_id WHERE a.id = ?').get(id);
      return row && {...row, data: JSON.parse(row.data), detail: row.detail && JSON.parse(row.detail)};
    },
    /** The actions in `root` since `since`, oldest first, without their detail, each with its remark's verdict. */
    actions: (root, since) => db.prepare(`SELECT a.id, a.at, a.kind, a.text, a.data, a.detail IS NOT NULL AS more, a.state, r.verdict
      FROM actions a JOIN sessions s ON s.id = a.session_id LEFT JOIN remarks r ON r.id = json_extract(a.data, '$.remark')
      WHERE s.root = ? AND a.at >= ? ORDER BY a.id`).all(root, since).map(row => ({...row, data: JSON.parse(row.data), more: !!row.more})),
    /** Forgets what the actions before `before` open to: outputs and edits' text are the bulk of the store. */
    forgetActionDetails: before => db.prepare('UPDATE actions SET detail = NULL WHERE at < ? AND detail IS NOT NULL').run(before),
    /** The verdicts on the remarks made in `root` since `since`. */
    verdicts: (root, since) => db.prepare('SELECT r.verdict FROM remarks r JOIN sessions s ON s.id = r.session_id WHERE s.root = ? AND r.at >= ?')
      .all(root, since).map(row => row.verdict),

    close: () => db.close(),
  };
}
