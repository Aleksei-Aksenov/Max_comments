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
      channel_title TEXT,
      channel_avatar TEXT,
      attachments TEXT,
      image_url TEXT,
      UNIQUE(channel_id, mid)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      reply_to_id INTEGER REFERENCES comments(id),
      FOREIGN KEY(thread_id) REFERENCES threads(id)
    );

    CREATE TABLE IF NOT EXISTS reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      emoji TEXT DEFAULT '👍',
      created_at INTEGER DEFAULT 0,
      UNIQUE(comment_id, user_id, emoji)
    );
  `);

  // Индексы для производительности
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_reactions_comment ON reactions(comment_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_thread ON comments(thread_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_threads_channel ON threads(channel_id, mid)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_reactions_unique ON reactions(comment_id, user_id, emoji)`);
  } catch (error) {
    console.log('Index creation note:', error.message);
  }

  // Миграции для старых баз (безопасные ALTER TABLE)
  try {
    db.exec(`ALTER TABLE comments ADD COLUMN reply_to_id INTEGER REFERENCES comments(id)`);
  } catch {}
  
  try {
    db.exec(`ALTER TABLE threads ADD COLUMN text TEXT`);
  } catch {}
  
  try {
    db.exec(`ALTER TABLE threads ADD COLUMN attachments TEXT`);
  } catch {}
  
  try {
    db.exec(`ALTER TABLE threads ADD COLUMN channel_title TEXT`);
  } catch {}
  
  try {
    db.exec(`ALTER TABLE threads ADD COLUMN channel_avatar TEXT`);
  } catch {}
  
  try {
    db.exec(`ALTER TABLE threads ADD COLUMN image_url TEXT`);
  } catch {}
  
  // Для колонки created_at в reactions - только если её нет
  try {
    db.exec(`ALTER TABLE reactions ADD COLUMN created_at INTEGER DEFAULT 0`);
  } catch {}
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
  console.log('🔄 toggleReaction called:', { commentId, userId, emoji });
  
  const existing = db.prepare(`
    SELECT emoji FROM reactions
    WHERE comment_id = ? AND user_id = ?
  `).get(commentId, userId);
  
  console.log('📌 Existing reaction:', existing);

  if (existing) {
    if (existing.emoji === emoji) {
      // убираем реакцию
      console.log('🗑️ Removing reaction');
      db.prepare(`
        DELETE FROM reactions
        WHERE comment_id = ? AND user_id = ?
      `).run(commentId, userId);
      return { liked: false, emoji };
    } else {
      // меняем реакцию
      console.log('🔄 Changing reaction from', existing.emoji, 'to', emoji);
      db.prepare(`
        UPDATE reactions
        SET emoji = ?, created_at = ?
        WHERE comment_id = ? AND user_id = ?
      `).run(emoji, Date.now(), commentId, userId);
      return { liked: true, emoji };
    }
  } else {
    // новая реакция
    console.log('✨ Adding new reaction');
    db.prepare(`
      INSERT INTO reactions (comment_id, user_id, emoji, created_at)
      VALUES (?, ?, ?, ?)
    `).run(commentId, userId, emoji, Date.now());
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
    SELECT r.emoji, r.user_id, r.created_at, COALESCE(m.name, r.user_id) as name
    FROM reactions r
    LEFT JOIN channel_members m ON m.user_id = r.user_id
    WHERE r.comment_id = ?
    ORDER BY r.created_at DESC
  `);
  const allReactions = stmt.all(commentId);
  
  const grouped = {};
  for (const r of allReactions) {
    if (!grouped[r.emoji]) {
      grouped[r.emoji] = { count: 0, liked: false, users: [] };
    }
    grouped[r.emoji].count++;
    grouped[r.emoji].users.push({
      user_id: r.user_id,
      name: r.name,
      created_at: r.created_at
    });
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

// Получить всех пользователей, поставивших реакцию на комментарий
function getReactionUsers(commentId, emoji) {
  const stmt = db.prepare(`
    SELECT r.user_id, r.emoji, r.created_at, m.name
    FROM reactions r
    LEFT JOIN channel_members m ON m.user_id = r.user_id
    WHERE r.comment_id = ?
    ${emoji ? 'AND r.emoji = ?' : ''}
    ORDER BY r.created_at DESC
  `);
  
  if (emoji) {
    return stmt.all(commentId, emoji);
  }
  return stmt.all(commentId);
}

// Получить все реакции комментария сгруппированные по пользователям
function getAllReactionsWithUsers(commentId) {
  console.log('🔍 getAllReactionsWithUsers for comment:', commentId);
  
  const stmt = db.prepare(`
    SELECT r.emoji, r.user_id, r.created_at, COALESCE(m.name, r.user_id) as name
    FROM reactions r
    LEFT JOIN channel_members m ON m.user_id = r.user_id
    WHERE r.comment_id = ?
    ORDER BY r.created_at DESC
  `);
  const result = stmt.all(commentId);
  console.log('📊 Query result:', result);
  return result;
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
  getThreadByToken,
  getAllReactionsWithUsers,
};
