const { config } = require('./config');
const {
  upsertMember,
  removeMember,
  getThreadByChannelMid,
  createThread,
} = require('./db');
const { generateToken, encodePayload } = require('./payload');
const { updateMessageAddButton, getMessage, getChannelInfo } = require('./max_api');

function extractMessageCreated(update) {
  if (!update || !update.message || !update.message.body) return null;
  const chatId = update.message?.recipient?.chat_id;
  const mid = update.message?.body?.mid;
  const chatType = update.message?.recipient?.chat_type;
  if (!chatId || !mid || chatType !== 'channel') return null;
  return { chatId, mid };
}

async function handleMessageCreated(update) {
  const data = extractMessageCreated(update);
  if (!data) return { skipped: true };

  const { chatId, mid } = data;

  const existing = getThreadByChannelMid({
    channelId: String(chatId),
    mid
  });

  let token = existing?.token;

  if (!token) {
    token = generateToken();

    let text = '';
    let createdAt = null;
    let rawAttachments = [];
    let imageUrl = '';
    let processedAttachments = [];
    let channelTitle = 'Канал';
    let channelAvatar = '';

    try {
      // Получаем информацию о канале
      const channelInfo = await getChannelInfo(chatId);
      if (channelInfo) {
        channelTitle = channelInfo.title;
        channelAvatar = channelInfo.avatar;
      }
      console.log('Channel info saved:', { channelTitle, channelAvatar });

      const msg = await getMessage(mid);
      console.log('RAW MESSAGE:', JSON.stringify(msg, null, 2));

      text = msg?.body?.text || '';
      createdAt = msg?.timestamp || Date.now();
      rawAttachments = msg?.body?.attachments || [];

      // Обработка вложений
      if (Array.isArray(rawAttachments)) {
        processedAttachments = rawAttachments.map(att => {
          if (att.type === 'image') {
            return {
              type: 'photo',
              platform: 'max',
              url: att.payload?.url || ''
            };
          }
          
          if (att.type === 'video') {
            const videoId = att.payload?.id || att.payload?.video_id;
            return {
              type: 'video',
              platform: 'max',
              video_id: videoId,
              chat_id: String(chatId),
              message_mid: mid,
              preview: att.thumbnail?.url || '',
              duration: att.duration || null
            };
          }
          
          return null;
        }).filter(Boolean);
        
        const firstImage = processedAttachments.find(att => att.type === 'photo');
        if (firstImage) {
          imageUrl = firstImage.url;
        }
      }
    } catch (e) {
      console.error('Failed to fetch message:', e);
    }

    createThread({
      channelId: String(chatId),
      channelTitle: channelTitle,    // ← сохраняем
      channelAvatar: channelAvatar,  // ← сохраняем
      mid,
      token,
      text,
      created_at: createdAt,
      attachments: JSON.stringify(processedAttachments),
      image_url: imageUrl
    });
  }

  const payload = encodePayload({ token });
  const url = `https://max.ru/${config.maxBotName}?startapp=${payload}`;

  const result = await updateMessageAddButton({
    chatId,
    mid,
    buttonText: config.buttonText,
    url,
  });

  return { updated: true, result };
}

function handleUserAdded(update) {
  const user = update?.event_context?.affected_user || update?.user;
  const chatId = update?.event_context?.chat_info?.chat_id || update?.chat_id;
  if (!user || !chatId) return { skipped: true };
  const name = user.name || [user.first_name, user.last_name].filter(Boolean).join(' ');
  upsertMember({
    channelId: String(chatId),
    userId: String(user.user_id),
    name,
  });
  return { upserted: true };
}

function handleUserRemoved(update) {
  const user = update?.event_context?.affected_user || update?.user;
  const chatId = update?.event_context?.chat_info?.chat_id || update?.chat_id;
  if (!user || !chatId) return { skipped: true };
  removeMember({
    channelId: String(chatId),
    userId: String(user.user_id),
  });
  return { removed: true };
}

module.exports = {
  handleMessageCreated,
  handleUserAdded,
  handleUserRemoved,
};