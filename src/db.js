const Database = require('better-sqlite3');
const { config } = require('./config');

const db = new Database(config.dbPath);

db.pragma('journal_mode = WAL');

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_members (
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (channel_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      mid TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      UNIQUE(channel_id, mid)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(thread_id) REFERENCES threads(id)
    );

  `);

  // Migration: add reply_to_id if not exists
  try {
    db.exec(`ALTER TABLE comments ADD COLUMN reply_to_id INTEGER REFERENCES comments(id)`);
  } catch {
    // column already exists — ignore
  }
}

function upsertMember({ channelId, userId, name }) {
  const stmt = db.prepare(`
    INSERT INTO channel_members (channel_id, user_id, name, updated_at)
    VALUES (@channelId, @userId, @name, @updatedAt)
    ON CONFLICT(channel_id, user_id)
    DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
  `);
  stmt.run({ channelId, userId, name, updatedAt: Date.now() });
}

function removeMember({ channelId, userId }) {
  const stmt = db.prepare(`
    DELETE FROM channel_members
    WHERE channel_id = ? AND user_id = ?
  `);
  stmt.run(channelId, userId);
}

function isMember({ channelId, userId }) {
  const stmt = db.prepare(`
    SELECT 1 FROM channel_members
    WHERE channel_id = ? AND user_id = ?
    LIMIT 1
  `);
  const row = stmt.get(channelId, userId);
  return Boolean(row);
}

function getThreadByChannelMid({ channelId, mid }) {
  const stmt = db.prepare(`
    SELECT * FROM threads WHERE channel_id = ? AND mid = ?
  `);
  return stmt.get(channelId, mid);
}

function getThreadByToken(token) {
  const stmt = db.prepare(`
    SELECT * FROM threads WHERE token = ?
  `);
  return stmt.get(token);
}

function createThread({ channelId, mid, token }) {
  const stmt = db.prepare(`
    INSERT INTO threads (channel_id, mid, token, created_at)
    VALUES (@channelId, @mid, @token, @createdAt)
  `);
  const result = stmt.run({ channelId, mid, token, createdAt: Date.now() });
  return result.lastInsertRowid;
}

function addComment({ threadId, userId, text, replyToId = null }) {
  const stmt = db.prepare(`
    INSERT INTO comments (thread_id, user_id, text, created_at, reply_to_id)
    VALUES (@threadId, @userId, @text, @createdAt, @replyToId)
  `);
  const result = stmt.run({
    threadId,
    userId,
    text,
    createdAt: Date.now(),
    replyToId: replyToId || null,
  });
  return result.lastInsertRowid;
}

function getComments({ threadId, limit = 100, afterId = 0 }) {
  const stmt = db.prepare(`
    SELECT c.id, c.thread_id, c.user_id, c.text, c.created_at, c.reply_to_id,
           COALESCE(m.name, c.user_id) AS name,
           r.text AS reply_to_text,
           COALESCE(rm.name, r.user_id) AS reply_to_name
    FROM comments c
    LEFT JOIN channel_members m
      ON m.user_id = c.user_id
      AND m.channel_id = (SELECT channel_id FROM threads WHERE id = c.thread_id)
    LEFT JOIN comments r ON r.id = c.reply_to_id
    LEFT JOIN channel_members rm
      ON rm.user_id = r.user_id
      AND rm.channel_id = (SELECT channel_id FROM threads WHERE id = c.thread_id)
    WHERE c.thread_id = ? AND c.id > ?
    ORDER BY c.id ASC
    LIMIT ?
  `);
  return stmt.all(threadId, afterId, limit);
}

function getCommentById(id) {
  const stmt = db.prepare(`
    SELECT c.id, c.user_id, c.text,
           COALESCE(m.name, c.user_id) AS name
    FROM comments c
    LEFT JOIN channel_members m
      ON m.user_id = c.user_id
      AND m.channel_id = (SELECT channel_id FROM threads WHERE id = c.thread_id)
    WHERE c.id = ?
  `);
  return stmt.get(id);
}

function getMembersStats() {
  return db.prepare(`
    SELECT channel_id, COUNT(*) as members_count
    FROM channel_members
    GROUP BY channel_id
    ORDER BY members_count DESC
  `).all();
}

module.exports = {
  db,
  migrate,
  upsertMember,
  removeMember,
  isMember,
  getMembersStats,
  getThreadByChannelMid,
  getThreadByToken,
  createThread,
  addComment,
  getComments,
  getCommentById,
};
