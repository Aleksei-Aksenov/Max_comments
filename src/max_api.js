const { config } = require('./config');

async function updateMessageAddButton({ chatId, mid, buttonText, url }) {
  const endpoint = `${config.maxApiBase}/messages?message_id=${encodeURIComponent(mid)}`;

  const body = {
    attachments: [
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

module.exports = { updateMessageAddButton, fetchAllChannelMembers };
