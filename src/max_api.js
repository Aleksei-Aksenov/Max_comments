const { config } = require('./config');

async function getMessage(mid) {
  const endpoint = `${config.maxApiBase}/messages?message_ids=${encodeURIComponent(mid)}`;
  const res = await fetch(endpoint, {
    headers: { Authorization: config.maxBotToken },
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  // Response: { messages: [ { body: { attachments: [...] } } ] }
  return {
  ...data?.messages?.[0],
  created_at: data?.messages?.[0]?.created_at
};;
}

async function updateMessageAddButton({ chatId, mid, buttonText, url }) {
  const endpoint = `${config.maxApiBase}/messages?message_id=${encodeURIComponent(mid)}`;

  // Fetch existing message to preserve non-keyboard attachments
  const existing = await getMessage(mid);
  const existingAttachments = existing?.body?.attachments || [];

  // Keep all attachments except any existing inline_keyboard (we'll replace it)
  const otherAttachments = existingAttachments.filter(a => a.type !== 'inline_keyboard');

  const body = {
    attachments: [
      ...otherAttachments,
      {
        type: 'inline_keyboard',
        payload: {
          buttons: [
            [
              {
                type: 'link',
                text: buttonText,
                url,
              },
            ],
          ],
        },
      },
    ],
  };

  const res = await fetch(endpoint, {
    method: 'PUT',
    headers: {
      Authorization: config.maxBotToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MAX API error: ${res.status} ${text}`);
  }

  const data = await res.json().catch(() => ({}));
  return data;
}

// Fetch all members of a channel with pagination.
// Calls GET /chats/{chatId}/members?count=100&marker=...
// Returns array of { user_id, name } objects.
async function fetchAllChannelMembers(chatId) {
  const members = [];
  let marker = null;

  for (let page = 0; page < 50; page++) {
    const url = new URL(`${config.maxApiBase}/chats/${encodeURIComponent(chatId)}/members`);
    url.searchParams.set('count', '100');
    if (marker) url.searchParams.set('marker', String(marker));

    const res = await fetch(url.toString(), {
      headers: { Authorization: config.maxBotToken },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MAX API members error: ${res.status} ${text}`);
    }

    const data = await res.json();
    const list = data.members || data;
    if (!Array.isArray(list) || list.length === 0) break;

    for (const m of list) {
      const u = m.user || m;
      const user_id = String(u.user_id || u.id || '');
      if (!user_id) continue;
      const name = u.name || [u.first_name, u.last_name].filter(Boolean).join(' ') || user_id;
      members.push({ user_id, name });
    }

    marker = data.marker;
    if (!marker) break;
  }

  return members;
}

// Получение информации о канале
async function getChannelInfo(chatId) {
  try {
    const endpoint = `${config.maxApiBase}/chats/${encodeURIComponent(chatId)}`;
    const res = await fetch(endpoint, {
      headers: { 
        Authorization: config.maxBotToken,
        'Content-Type': 'application/json'
      },
    });
    
    if (!res.ok) {
      console.error('Channel info error:', res.status);
      return null;
    }
    
    const data = await res.json();
    console.log('📸 FULL CHANNEL INFO:', JSON.stringify(data, null, 2));
    
    // ✅ Извлекаем URL аватарки
    let avatarUrl = '';
    if (data.icon?.url) avatarUrl = data.icon.url;
    else if (typeof data.icon === 'string') avatarUrl = data.icon;
    else if (data.avatar?.url) avatarUrl = data.avatar.url;
    else if (typeof data.avatar === 'string') avatarUrl = data.avatar;
    else if (data.photo_url) avatarUrl = data.photo_url;
    
    console.log('🖼 Avatar URL:', avatarUrl);
    
    return {
      title: data.title || data.name || 'Канал',
      avatar: avatarUrl  // ✅ теперь это строка, а не объект
    };
  } catch (e) {
    console.error('Failed to get channel info:', e);
    return null;
  }
}

module.exports = { updateMessageAddButton, fetchAllChannelMembers, getMessage, getChannelInfo };
