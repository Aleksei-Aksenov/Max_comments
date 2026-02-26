const crypto = require('crypto');

function parseInitData(initData) {
  const params = new URLSearchParams(initData);
  const data = {};
  for (const [key, value] of params.entries()) {
    data[key] = value;
  }
  return data;
}

function buildDataCheckString(data) {
  const keys = Object.keys(data)
    .filter((k) => k !== 'hash')
    .sort();

  return keys.map((key) => `${key}=${data[key]}`).join('\n');
}

function validateInitData(initData, botToken) {
  if (!initData) return { ok: false, error: 'init_data_missing' };
  if (!botToken) return { ok: false, error: 'bot_token_missing' };

  const data = parseInitData(initData);
  const receivedHash = data.hash;
  if (!receivedHash) return { ok: false, error: 'hash_missing' };

  const dataCheckString = buildDataCheckString(data);

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (computedHash !== receivedHash) {
    return { ok: false, error: 'hash_mismatch' };
  }

  // Check auth_date freshness: reject initData older than 24 hours
  const authDate = Number(data.auth_date);
  if (!authDate || Date.now() / 1000 - authDate > 86400) {
    return { ok: false, error: 'auth_date_expired' };
  }

  return { ok: true, data };
}

function extractUser(data) {
  if (!data) return null;

  // Standard: user is a JSON-encoded string field (Telegram/MAX WebApp style)
  if (data.user) {
    try {
      const user = JSON.parse(data.user);
      // Normalize: Telegram uses 'id', MAX may use 'user_id' or 'id'
      if (user && user.id != null && user.user_id == null) {
        user.user_id = user.id;
      }
      return user;
    } catch {
      // fall through
    }
  }

  // Flat: user_id is a top-level field in initData
  if (data.user_id) {
    return {
      user_id: data.user_id,
      name: [data.first_name, data.last_name].filter(Boolean).join(' ') || data.name || '',
    };
  }

  return null;
}

module.exports = {
  validateInitData,
  parseInitData,
  extractUser,
};
