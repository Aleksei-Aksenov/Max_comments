const channels = new Map();

function getChannelKey(channelId, mid) {
  return `${channelId}:${mid}`;
}

function addSubscriber({ channelId, mid, reply }) {
  const key = getChannelKey(channelId, mid);
  if (!channels.has(key)) channels.set(key, new Set());
  channels.get(key).add(reply);
}

function removeSubscriber({ channelId, mid, reply }) {
  const key = getChannelKey(channelId, mid);
  const set = channels.get(key);
  if (!set) return;
  set.delete(reply);
  if (set.size === 0) channels.delete(key);
}

function publishComment({ channelId, mid, comment }) {
  const key = getChannelKey(channelId, mid);
  const set = channels.get(key);
  if (!set) return;
  const payload = `event: comment\ndata: ${JSON.stringify(comment)}\n\n`;
  for (const reply of set) {
    reply.raw.write(payload);
  }
}

module.exports = {
  addSubscriber,
  removeSubscriber,
  publishComment,
};
