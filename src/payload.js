const crypto = require('crypto');

function generateToken() {
  return crypto.randomBytes(16).toString('base64url');
}

function encodePayload({ token }) {
  return `t_${token}`;
}

function decodePayload(payload) {
  if (!payload || !payload.startsWith('t_')) return null;
  return { token: payload.slice(2) };
}

module.exports = {
  generateToken,
  encodePayload,
  decodePayload,
};
