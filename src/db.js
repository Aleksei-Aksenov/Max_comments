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
      text TEXT,
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

    CREATE TABLE IF NOT EXISTS reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      emoji TEXT DEFAULT '👍',
      UNIQUE(comment_id, user_id)
    );
  `);

  // Migration: add reply_to_id if not exists
  try {
    db.exec(`ALTER TABLE comments ADD COLUMN reply_to_id INTEGER REFERENCES comments(id)`);
  } catch {
    // column already exists — ignore
  }

  // Migration: add emoji column to reactions if not exists
  try {
    db.exec(`ALTER TABLE reactions ADD COLUMN emoji TEXT DEFAULT '👍'`);
  } catch {
    // column already exists — ignore
  }

  // Migration: add text to threads if not exists
try {
  db.exec(`ALTER TABLE threads ADD COLUMN text TEXT`);
} catch {
  // column already exists — ignore
}

  // Migration: add attachments to threads if not exists
try {
  db.exec(`ALTER TABLE threads ADD COLUMN attachments TEXT`);
} catch {
  // column already exists — ignore
}
  // Migration: add channel_title to threads if not exists
try {
  db.exec(`ALTER TABLE threads ADD COLUMN channel_title TEXT`);
} catch {
  // column already exists — ignore
}
  // Migration: add channel_avatar to threads if not exists
try {
  db.exec(`ALTER TABLE threads ADD COLUMN channel_avatar TEXT`);
} catch {
  // column already exists — ignore
}

try {
  db.exec(`ALTER TABLE threads ADD COLUMN image_url TEXT`);
} catch {}

  // Migration: update UNIQUE constraint for reactions (if needed)
  // Note: SQLite doesn't support DROP CONSTRAINT directly, so we need to recreate the table
  // This is a simplified approach - for existing databases you might need a more complex migration
  try {
    // Check if old UNIQUE constraint exists (without emoji)
    const tableInfo = db.prepare(`PRAGMA table_info(reactions)`).all();
    const hasOldConstraint = tableInfo.some(col => col.name === 'comment_id');
    
    if (hasOldConstraint) {
      // Recreate reactions table with new UNIQUE constraint
      db.exec(`
        CREATE TABLE reactions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          comment_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          emoji TEXT DEFAULT '👍',
          UNIQUE(comment_id, user_id)
        );
        
        INSERT INTO reactions_new (id, comment_id, user_id, emoji)
        SELECT id, comment_id, user_id, '👍' FROM reactions;
        
        DROP TABLE reactions;
        ALTER TABLE reactions_new RENAME TO reactions;
      `);
    }
  } catch (error) {
    // Table might not exist yet or already has correct schema
    console.log('Migration note:', error.message);
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

function normalizeAttachments(rawAttachments) {
  if (!rawAttachments || !Array.isArray(rawAttachments)) return [];
  
  return rawAttachments.map(att => {
    if (att.type === 'image') {
      return {
        type: 'photo',
        platform: 'max',
        url: att.payload?.url || att.url || ''
      };
    }
    
    if (att.type === 'video') {
      const videoId = att.payload?.id || att.payload?.video_id;
      return {
        type: 'video',
        platform: 'max',
        video_id: videoId,
        preview: att.thumbnail?.url || '',
        duration: att.duration || null
      };
    }
    
    return null;
  }).filter(Boolean);
}

function createThread({
  channelId,
  channelTitle,
  channelAvatar,
  mid,
  token,
  text,
  attachments,  // ← это уже JSON строка из handleMessageCreated
  image_url,
  created_at
}) {
  // attachments УЖЕ строка JSON от handleMessageCreated
  // Проверяем, что это строка и не пустая
  let attachmentsJson = '[]';
  
  if (typeof attachments === 'string' && attachments !== '[]' && attachments.length > 2) {
    attachmentsJson = attachments;
  } else if (attachments && typeof attachments === 'object') {
    // На всякий случай, если вдруг пришел объект
    attachmentsJson = JSON.stringify(attachments);
  }
  
  console.log('🔥 createThread - saving attachments:', attachmentsJson);

  const stmt = db.prepare(`
    INSERT INTO threads (
      channel_id,
      channel_title,
      channel_avatar,
      mid,
      token,
      text,
      created_at,
      attachments,
      image_url
    )
    VALUES (
      @channelId,
      @channelTitle,
      @channelAvatar,
      @mid,
      @token,
      @text,
      @createdAt,
      @attachments,
      @imageUrl
    )
  `);

  const result = stmt.run({
    channelId: String(channelId),
    channelTitle: channelTitle || null,
    channelAvatar: channelAvatar || null,
    mid,
    token,
    text: text || '',
    createdAt: created_at || Date.now(),
    attachments: attachmentsJson,
    imageUrl: image_url || null
  });

  console.log('🔥 Thread created, id:', result.lastInsertRowid);
  return result.lastInsertRowid;
}

function addComment({ threadId, userId, text, created_at, replyToId = null }) {
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
    SELECT c.id, c.thread_id, c.user_id, c.text, c.reply_to_id,
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

function toggleReaction({ commentId, userId, emoji }) {
  const existing = db.prepare(`
    SELECT emoji FROM reactions
    WHERE comment_id = ? AND user_id = ?
  `).get(commentId, userId);

  if (existing) {
    if (existing.emoji === emoji) {
      // убираем реакцию
      db.prepare(`
        DELETE FROM reactions
        WHERE comment_id = ? AND user_id = ?
      `).run(commentId, userId);

      return { liked: false, emoji };
    } else {
      // меняем реакцию
      db.prepare(`
        UPDATE reactions
        SET emoji = ?
        WHERE comment_id = ? AND user_id = ?
      `).run(emoji, commentId, userId);

      return { liked: true, emoji };
    }
  } else {
    // новая реакция
    db.prepare(`
      INSERT INTO reactions (comment_id, user_id, emoji)
      VALUES (?, ?, ?)
    `).run(commentId, userId, emoji);

    return { liked: true, emoji };
  }
}



function getThreadById(threadId) {
  const stmt = db.prepare(`
    SELECT id, channel_id, mid, token, created_at 
    FROM threads 
    WHERE id = ?
  `);
  return stmt.get(threadId);
}

// Обновленная функция getReactionsByCommentId с учетом текущего пользователя
function getReactionsByCommentIdWithUser(commentId, currentUserId) {
  const stmt = db.prepare(`
    SELECT emoji, user_id 
    FROM reactions 
    WHERE comment_id = ?
  `);
  const allReactions = stmt.all(commentId);
  
  // Группируем по emoji
  const grouped = {};
  for (const r of allReactions) {
    if (!grouped[r.emoji]) {
      grouped[r.emoji] = { count: 0, liked: false };
    }
    grouped[r.emoji].count++;
    if (String(r.user_id) === String(currentUserId)) {
      grouped[r.emoji].liked = true;
    }
  }
  return grouped;
}

// Функция для получения всех реакций комментария (массив)
function getReactionsByCommentId(commentId) {
  const stmt = db.prepare(`
    SELECT emoji, COUNT(*) as count 
    FROM reactions 
    WHERE comment_id = ? 
    GROUP BY emoji
  `);
  return stmt.all(commentId);
}

function getUserReaction(commentId, userId) {
  const stmt = db.prepare(`
    SELECT emoji FROM reactions 
    WHERE comment_id = ? AND user_id = ?
  `);
  return stmt.get(commentId, userId);
}

function getThreadByToken(token) {
  const stmt = db.prepare(`
    SELECT * FROM threads WHERE token = ?
  `);
  const thread = stmt.get(token);
  
  if (thread && thread.attachments) {
    // Don't parse here, let handleSession handle it
    // Just ensure it's not double-parsed
  }
  
  return thread;
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
  getThreadById,  
  createThread,
  addComment,
  getComments,
  getCommentById,
  toggleReaction,
  getReactionsByCommentIdWithUser,  
  getUserReaction,
  getThreadByToken
};
