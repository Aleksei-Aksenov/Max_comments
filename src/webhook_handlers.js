const { config } = require('./config');
const {
  upsertMember,
  removeMember,
  getThreadByChannelMid,
  createThread,
} = require('./db');
const { generateToken, encodePayload } = require('./payload');
const { updateMessageAddButton } = require('./max_api');

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
  const existing = getThreadByChannelMid({ channelId: String(chatId), mid });

  let token = existing?.token;
  if (!token) {
    token = generateToken();
    createThread({ channelId: String(chatId), mid, token });
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
