const Fastify = require('fastify');
const { config, validateConfig } = require('./config');
const { migrate } = require('./db');
const { validateInitData, extractUser } = require('./validation');
const { decodePayload } = require('./payload');
const {
  isMember,
  getThreadByChannelMid,
  getThreadByToken,
  addComment,
  getComments,
  getCommentById,
  getMembersStats,
} = require('./db');
const { addSubscriber, removeSubscriber, publishComment } = require('./realtime');
const {
  handleMessageCreated,
  handleUserAdded,
  handleUserRemoved,
} = require('./webhook_handlers');
const { fetchAllChannelMembers } = require('./max_api');
const { upsertMember } = require('./db');

async function buildServer() {
  const app = Fastify({ logger: true });

  app.post('/api/webhook', async (request, reply) => {
    request.log.info({ body: request.body }, 'Webhook received');
    const updates = Array.isArray(request.body) ? request.body : [request.body];

    const results = [];
    for (const update of updates) {
      const type = update.update_type || update.event_context?.type;
      try {
        request.log.info({ type }, 'Processing update');
        if (type === 'message_created') {
          results.push({ type, ...(await handleMessageCreated(update)) });
        } else if (type === 'user_added') {
          results.push({ type, ...handleUserAdded(update) });
        } else if (type === 'user_removed') {
          results.push({ type, ...handleUserRemoved(update) });
        } else {
          results.push({ type, skipped: true });
        }
      } catch (error) {
        request.log.error({ err: error }, 'Webhook handler error');
        results.push({ type, error: error.message });
      }
    }

    return reply.send({ ok: true, results });
  });

  app.get('/health', async () => ({ ok: true }));

  app.get('/miniapp', async (request, reply) => {
    const html = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
    <title>Комментарии</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: #f2f2f7;
        height: 100dvh;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      /* ── Loading ── */
      #loading {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        color: #8e8e93;
        font-size: 15px;
      }
      .spinner {
        width: 28px; height: 28px;
        border: 3px solid #e0e0e0;
        border-top-color: #007aff;
        border-radius: 50%;
        animation: spin .7s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }

      /* ── Status screens ── */
      #status-screen {
        flex: 1;
        display: none;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 10px;
        padding: 32px 24px;
        text-align: center;
      }
      #status-screen .s-icon { font-size: 52px; }
      #status-screen .s-title { font-size: 20px; font-weight: 600; color: #1c1c1e; }
      #status-screen .s-text  { font-size: 15px; color: #8e8e93; line-height: 1.5; }

      /* ── Chat ── */
      #chat {
        flex: 1;
        display: none;
        flex-direction: column;
        overflow: hidden;
      }
      #messages {
        flex: 1;
        overflow-y: auto;
        padding: 12px 12px 4px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .no-comments {
        margin: auto;
        color: #8e8e93;
        font-size: 14px;
        text-align: center;
        padding: 32px;
      }
      .msg {
        max-width: 78%;
        padding: 8px 12px;
        border-radius: 18px;
        word-break: break-word;
        background: #fff;
        align-self: flex-start;
        box-shadow: 0 1px 1px rgba(0,0,0,.07);
      }
      .msg.own {
        align-self: flex-end;
        background: #007aff;
        color: #fff;
      }
      .msg .author {
        font-size: 11px;
        font-weight: 600;
        color: #007aff;
        margin-bottom: 3px;
      }
      .msg.own .author { display: none; }
      .msg .text { font-size: 15px; line-height: 1.4; }
      .msg .ts {
        font-size: 10px;
        color: rgba(0,0,0,.35);
        text-align: right;
        margin-top: 3px;
      }
      .msg.own .ts { color: rgba(255,255,255,.6); }

      /* ── Reply quote inside message ── */
      .msg .reply-quote {
        border-left: 3px solid #007aff;
        padding: 3px 8px;
        margin-bottom: 5px;
        border-radius: 4px;
        background: rgba(0,122,255,.08);
      }
      .msg.own .reply-quote {
        border-left-color: rgba(255,255,255,.7);
        background: rgba(255,255,255,.15);
      }
      .msg .reply-quote .rq-name {
        font-size: 11px;
        font-weight: 600;
        color: #007aff;
        margin-bottom: 1px;
      }
      .msg.own .reply-quote .rq-name { color: rgba(255,255,255,.9); }
      .msg-highlight {
        transition: box-shadow .15s;
        box-shadow: 0 0 0 3px #007aff88 !important;
      }
      .msg .reply-quote { cursor: pointer; }
      .msg .reply-quote .rq-text {
        font-size: 12px;
        color: #555;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 220px;
      }
      .msg.own .reply-quote .rq-text { color: rgba(255,255,255,.8); }

      /* ── Reply panel above input ── */
      #reply-bar {
        display: none;
        align-items: center;
        background: #f2f2f7;
        border-top: 1px solid rgba(0,0,0,.08);
        padding: 6px 12px 6px 14px;
        gap: 8px;
      }
      #reply-bar .rb-content {
        flex: 1;
        min-width: 0;
      }
      #reply-bar .rb-name {
        font-size: 12px;
        font-weight: 600;
        color: #007aff;
      }
      #reply-bar .rb-text {
        font-size: 12px;
        color: #555;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #reply-cancel {
        flex-shrink: 0;
        width: 22px; height: 22px;
        border-radius: 50%;
        border: none;
        background: #c7c7cc;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        color: #fff;
        line-height: 1;
      }

      /* ── Input area ── */
      #input-bar {
        background: #fff;
        border-top: 1px solid rgba(0,0,0,.1);
        padding: 8px 10px;
        padding-bottom: max(8px, env(safe-area-inset-bottom));
        display: flex;
        align-items: flex-end;
        gap: 8px;
      }
      #msg-input {
        flex: 1;
        border: 1px solid #d1d1d6;
        border-radius: 20px;
        padding: 8px 14px;
        font-size: 15px;
        font-family: inherit;
        outline: none;
        resize: none;
        line-height: 1.4;
        min-height: 36px;
        max-height: 120px;
        overflow-y: auto;
        background: #f2f2f7;
      }
      #msg-input:focus { border-color: #007aff; background: #fff; }
      #send-btn {
        flex-shrink: 0;
        width: 36px; height: 36px;
        border-radius: 50%;
        border: none;
        background: #007aff;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: opacity .15s;
      }
      #send-btn:disabled { opacity: .4; cursor: default; }
      #send-btn svg { width: 17px; height: 17px; fill: #fff; }
    </style>
  </head>
  <body>
    <div id="loading">
      <div class="spinner"></div>
      <span>Загрузка...</span>
    </div>

    <div id="status-screen">
      <div class="s-icon" id="s-icon"></div>
      <div class="s-title" id="s-title"></div>
      <div class="s-text"  id="s-text"></div>
    </div>

    <div id="chat">
      <div id="messages">
        <div class="no-comments" id="no-comments">Комментариев пока нет.<br>Будьте первым!</div>
      </div>
      <div id="reply-bar">
        <div class="rb-content">
          <div class="rb-name" id="rb-name"></div>
          <div class="rb-text" id="rb-text"></div>
        </div>
        <button id="reply-cancel">✕</button>
      </div>
      <div id="input-bar">
        <textarea id="msg-input" rows="1" placeholder="Написать комментарий…"></textarea>
        <button id="send-btn" disabled>
          <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
    </div>

    <script>
      // max-web-app.js intentionally not loaded here:
      // it initializes MAX's SvelteKit runtime which blocks JS for ~40s
      // while loading /_app/immutable/* assets that don't exist on our server.
      // initData is read directly from location.hash instead.

      // ── helpers ──────────────────────────────────────────────
      function esc(s) {
        return String(s)
          .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      }
      function fmt(ts) {
        return new Date(ts).toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit'});
      }
      function showStatus(icon, title, text) {
        const loading = document.getElementById('loading');
        const chat    = document.getElementById('chat');
        const sc      = document.getElementById('status-screen');
        if (!sc) return;
        if (loading) loading.style.display = 'none';
        if (chat)    chat.style.display    = 'none';
        sc.style.display = 'flex';
        const si = document.getElementById('s-icon');
        const st = document.getElementById('s-title');
        const sx = document.getElementById('s-text');
        if (si) si.textContent = icon;
        if (st) st.textContent = title;
        if (sx) sx.textContent = text;
      }
      function showChat() {
        const loading = document.getElementById('loading');
        const sc      = document.getElementById('status-screen');
        const chat    = document.getElementById('chat');
        if (!chat) return;
        if (loading) loading.style.display = 'none';
        if (sc)      sc.style.display      = 'none';
        chat.style.display = 'flex';
      }

      // ── initData & startParam ────────────────────────────────
      const qs         = new URLSearchParams(window.location.search);
      const hashParams  = new URLSearchParams(window.location.hash.replace(/^#/,''));
      const webApp      = window.WebApp;
      const rawHash     = hashParams.get('WebAppData');
      const initData    = webApp?.initData
                          || (rawHash ? decodeURIComponent(rawHash) : '')
                          || '';
      const startParam  = webApp?.initDataUnsafe?.start_param
                          || hashParams.get('WebAppStartParam')
                          || qs.get('WebAppStartParam')
                          || qs.get('start_param')
                          || '';

      // ── session ──────────────────────────────────────────────
      async function fetchSession() {
        const getUrl = '/api/session?initData=' + encodeURIComponent(initData)
          + '&startParam=' + encodeURIComponent(startParam);

        // Try POST with 5s timeout; MAX webview often blocks/hangs JSON POST
        try {
          const ac = new AbortController();
          const tid = setTimeout(() => ac.abort(), 5000);
          const r = await fetch('/api/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData, startParam }),
            signal: ac.signal,
          });
          clearTimeout(tid);
          return await r.json();
        } catch {
          // fall through to GET
        }

        const r = await fetch(getUrl);
        return await r.json();
      }

      // ── comments ─────────────────────────────────────────────
      let myUserId = null;
      const rendered = new Set();

      // Map of id → comment data for reply quotes
      const commentsById = new Map();

      function renderComment(c) {
        if (rendered.has(c.id)) return;
        rendered.add(c.id);
        commentsById.set(c.id, c);

        const nc = document.getElementById('no-comments');
        if (nc) nc.remove();

        const isOwn = String(c.user_id) === String(myUserId);
        const div = document.createElement('div');
        div.className = 'msg' + (isOwn ? ' own' : '');
        div.dataset.id = c.id;
        div.dataset.name = c.name || c.user_id;
        div.dataset.text = c.text;

        let html = '';

        // Reply quote
        if (c.reply_to_id) {
          const rName = c.reply_to_name || c.reply_to_id;
          const rText = c.reply_to_text || '…';
          html += '<div class="reply-quote" data-target="' + c.reply_to_id + '">'
            + '<div class="rq-name">' + esc(String(rName)) + '</div>'
            + '<div class="rq-text">' + esc(String(rText)) + '</div>'
            + '</div>';
        }

        html += '<div class="author">' + esc(c.name || c.user_id) + '</div>'
          + '<div class="text">' + esc(c.text) + '</div>'
          + '<div class="ts">'   + fmt(c.created_at)        + '</div>';

        div.innerHTML = html;

        // Tap on quote → scroll to original message
        if (c.reply_to_id) {
          div.querySelector('.reply-quote').addEventListener('click', (e) => {
            e.stopPropagation();
            const target = document.querySelector('.msg[data-id="' + c.reply_to_id + '"]');
            if (!target) return;
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            target.classList.add('msg-highlight');
            setTimeout(() => target.classList.remove('msg-highlight'), 1200);
          });
        }

        // Tap on message body → reply (skip if user selected text)
        div.addEventListener('click', () => {
          if (window.getSelection && window.getSelection().toString().length > 0) return;
          setReply(c);
        });

        const msgs = document.getElementById('messages');
        msgs.appendChild(div);
        msgs.scrollTop = msgs.scrollHeight;
      }

      let lastId = 0;
      async function loadComments(session) {
        try {
          const r = await fetch(
            '/api/threads/' + session.thread.channel_id + '/' + session.thread.mid
            + '/comments?initData=' + encodeURIComponent(initData)
          );
          const d = await r.json();
          if (d.ok && Array.isArray(d.comments)) {
            d.comments.forEach(c => { renderComment(c); lastId = Math.max(lastId, c.id); });
          }
        } catch {}
      }

      function setupSSE(session) {
        const base = '/api/threads/' + session.thread.channel_id + '/' + session.thread.mid;
        const commentsUrl = base + '/comments?initData=' + encodeURIComponent(initData);

        // Polling fallback: fetch new comments by last seen id
        let pollingTimer = null;
        function startPolling() {
          if (pollingTimer) return;
          pollingTimer = setInterval(async () => {
            try {
              const r = await fetch(commentsUrl + '&after_id=' + lastId);
              const d = await r.json();
              if (d.ok && Array.isArray(d.comments)) {
                d.comments.forEach(c => { renderComment(c); lastId = Math.max(lastId, c.id); });
              }
            } catch {}
          }, 3000);
        }

        // Try SSE first; fall back to polling if ping doesn't arrive in 5s
        const sseUrl = base + '/stream?initData=' + encodeURIComponent(initData);
        let sseOk = false;
        const fallbackTimer = setTimeout(() => { if (!sseOk) startPolling(); }, 5000);

        const es = new EventSource(sseUrl);
        es.addEventListener('ping', () => {
          sseOk = true;
          clearTimeout(fallbackTimer);
        });
        es.addEventListener('comment', (e) => {
          try {
            const c = JSON.parse(e.data);
            renderComment(c);
            lastId = Math.max(lastId, c.id);
          } catch {}
        });
        es.onerror = () => {
          if (!pollingTimer) {
            es.close();
            startPolling();
          }
        };
      }

      // ── reply state ──────────────────────────────────────────
      let replyTo = null; // { id, name, text }

      function setReply(c) {
        replyTo = { id: c.id, name: c.name || c.user_id, text: c.text };
        document.getElementById('rb-name').textContent = replyTo.name;
        document.getElementById('rb-text').textContent = replyTo.text;
        document.getElementById('reply-bar').style.display = 'flex';
        document.getElementById('msg-input').focus();
      }

      function cancelReply() {
        replyTo = null;
        document.getElementById('reply-bar').style.display = 'none';
      }

      document.getElementById('reply-cancel').addEventListener('click', cancelReply);

      // ── send ─────────────────────────────────────────────────
      let currentSession = null;
      const input   = document.getElementById('msg-input');
      const sendBtn = document.getElementById('send-btn');

      input.addEventListener('input', function () {
        sendBtn.disabled = !this.value.trim();
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 120) + 'px';
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
      });
      sendBtn.addEventListener('click', doSend);

      async function doSend() {
        const text = input.value.trim();
        if (!text || !currentSession) return;
        sendBtn.disabled = true;
        const body = { text, initData };
        if (replyTo) body.reply_to_id = replyTo.id;
        try {
          const r = await fetch(
            '/api/threads/' + currentSession.thread.channel_id + '/' + currentSession.thread.mid + '/comments',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }
          );
          const d = await r.json();
          if (d.ok && d.comment) {
            // Attach reply metadata for immediate render (server returns id only)
            if (replyTo) {
              d.comment.reply_to_id   = replyTo.id;
              d.comment.reply_to_name = replyTo.name;
              d.comment.reply_to_text = replyTo.text;
            }
            renderComment(d.comment);
          }
          input.value = '';
          input.style.height = '';
          cancelReply();
        } finally {
          sendBtn.disabled = !input.value.trim();
        }
      }

      // ── main ─────────────────────────────────────────────────
      (async () => {
        if (webApp?.ready) webApp.ready();

        if (!initData) {
          showStatus('🔗', 'Нет данных', 'Откройте приложение через кнопку в канале.');
          return;
        }

        let session;
        try {
          session = await fetchSession();
        } catch {
          showStatus('🔌', 'Нет соединения', 'Не удалось подключиться к серверу.');
          return;
        }

        if (!session?.ok) {
          showStatus('❌', 'Ошибка', session?.error || 'Не удалось открыть комментарии.');
          return;
        }

        if (!session.subscribed) {
          showStatus('🔒', 'Доступ закрыт', 'Комментарии доступны только подписчикам канала.');
          return;
        }

        currentSession = session;
        myUserId = session.user?.user_id;
        try {
          showChat();
          await loadComments(session);
          setupSSE(session);
        } catch (e) {
          console.error('chat init error', e);
        }
      })();
    </script>
  </body>
</html>`;

    reply.type('text/html').send(html);
  });

  app.post('/api/client-log', async (request, reply) => {
    request.log.info({ body: request.body }, 'Client log');
    return reply.send({ ok: true });
  });

  app.get('/api/ping', async (request, reply) => {
    request.log.info({ query: request.query }, 'Ping');
    return reply.send({ ok: true });
  });

  const handleSession = async (request, reply, source) => {
    request.log.info({ body: request.body }, 'Session request');
    const initData = request.body?.initData || request.query?.initData || '';
    const startParam = request.body?.startParam || request.query?.startParam || '';
    const validation = validateInitData(initData, config.maxBotToken);
    request.log.info({ validation }, 'Session validation');
    if (!validation.ok) return reply.code(401).send(validation);

    const user = extractUser(validation.data);
    request.log.info({ user }, 'Session user');
    if (!user?.user_id) return reply.code(401).send({ ok: false, error: 'user_missing' });

    const payload = decodePayload(startParam || validation.data.start_param);
    request.log.info({ payload }, 'Session payload');
    if (!payload?.token) return reply.code(400).send({ ok: false, error: 'payload_invalid' });

    const thread = getThreadByToken(payload.token);
    if (!thread) return reply.code(404).send({ ok: false, error: 'thread_not_found' });

    const subscribed = isMember({
      channelId: thread.channel_id,
      userId: String(user.user_id),
    });
    request.log.info({ subscribed, channelId: thread.channel_id, userId: String(user.user_id) }, 'Session subscribed');

    return reply.send({
      ok: true,
      subscribed,
      thread: {
        channel_id: thread.channel_id,
        mid: thread.mid,
      },
      user: {
        user_id: user.user_id,
        name: user.name,
      },
    });
  };

  app.post('/api/session', async (request, reply) => handleSession(request, reply, 'post'));
  app.get('/api/session', async (request, reply) => handleSession(request, reply, 'get'));

  app.get('/api/threads/:channelId/:mid/comments', async (request, reply) => {
    const initData = request.query?.initData || request.headers['x-init-data'];
    const validation = validateInitData(initData, config.maxBotToken);
    if (!validation.ok) return reply.code(401).send(validation);

    const user = extractUser(validation.data);
    if (!user?.user_id) return reply.code(401).send({ ok: false, error: 'user_missing' });

    const { channelId, mid } = request.params;
    const thread = getThreadByChannelMid({ channelId, mid });
    if (!thread) return reply.code(404).send({ ok: false, error: 'thread_not_found' });

    const subscribed = isMember({ channelId, userId: String(user.user_id) });
    if (!subscribed) return reply.code(403).send({ ok: false, error: 'not_subscribed' });

    const limit = Number(request.query?.limit || 100);
    const afterId = Number(request.query?.after_id || 0);
    const comments = getComments({ threadId: thread.id, limit, afterId });

    return reply.send({ ok: true, comments });
  });

  app.post('/api/threads/:channelId/:mid/comments', async (request, reply) => {
    const initData = request.body?.initData || request.headers['x-init-data'];
    const validation = validateInitData(initData, config.maxBotToken);
    if (!validation.ok) return reply.code(401).send(validation);

    const user = extractUser(validation.data);
    if (!user?.user_id) return reply.code(401).send({ ok: false, error: 'user_missing' });

    const { channelId, mid } = request.params;
    const thread = getThreadByChannelMid({ channelId, mid });
    if (!thread) return reply.code(404).send({ ok: false, error: 'thread_not_found' });

    const subscribed = isMember({ channelId, userId: String(user.user_id) });
    if (!subscribed) return reply.code(403).send({ ok: false, error: 'not_subscribed' });

    const text = String(request.body?.text || '').trim();
    if (!text) return reply.code(400).send({ ok: false, error: 'text_required' });

    const replyToId = request.body?.reply_to_id ? Number(request.body.reply_to_id) : null;
    const replyTo = replyToId ? getCommentById(replyToId) : null;
    const commentId = addComment({ threadId: thread.id, userId: String(user.user_id), text, replyToId });
    const comment = {
      id: commentId,
      thread_id: thread.id,
      user_id: String(user.user_id),
      name: user.name || user.first_name || String(user.user_id),
      text,
      created_at: Date.now(),
      reply_to_id: replyToId,
      reply_to_name: replyTo?.name || null,
      reply_to_text: replyTo?.text || null,
    };

    publishComment({ channelId, mid, comment });

    return reply.send({ ok: true, comment });
  });

  app.get('/api/threads/:channelId/:mid/stream', async (request, reply) => {
    const initData = request.query?.initData;
    const validation = validateInitData(initData, config.maxBotToken);
    if (!validation.ok) return reply.code(401).send(validation);

    const user = extractUser(validation.data);
    if (!user?.user_id) return reply.code(401).send({ ok: false, error: 'user_missing' });

    const { channelId, mid } = request.params;
    const thread = getThreadByChannelMid({ channelId, mid });
    if (!thread) return reply.code(404).send({ ok: false, error: 'thread_not_found' });

    const subscribed = isMember({ channelId, userId: String(user.user_id) });
    if (!subscribed) return reply.code(403).send({ ok: false, error: 'not_subscribed' });

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    reply.raw.write('event: ping\ndata: {}\n\n');
    addSubscriber({ channelId, mid, reply });

    const heartbeat = setInterval(() => {
      if (!reply.raw.writable) { clearInterval(heartbeat); return; }
      reply.raw.write(': heartbeat\n\n');
    }, 20000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      removeSubscriber({ channelId, mid, reply });
    });
  });

  // Admin: stats — members count per channel.
  // Usage: GET /api/admin/stats?token=<MAX_BOT_TOKEN>
  app.get('/api/admin/stats', async (request, reply) => {
    if (request.query?.token !== config.maxBotToken) {
      return reply.code(403).send({ ok: false, error: 'forbidden' });
    }
    const stats = getMembersStats();
    return reply.send({ ok: true, channels: stats });
  });

  // Admin: sync all channel members from MAX API into local DB.
  // Usage: GET /api/admin/sync/:channelId
  // Protected by bot token via ?token= query param.
  app.get('/api/admin/sync/:channelId', async (request, reply) => {
    const { channelId } = request.params;
    if (request.query?.token !== config.maxBotToken) {
      return reply.code(403).send({ ok: false, error: 'forbidden' });
    }
    try {
      const members = await fetchAllChannelMembers(channelId);
      for (const m of members) {
        upsertMember({ channelId, userId: m.user_id, name: m.name });
      }
      return reply.send({ ok: true, synced: members.length });
    } catch (err) {
      request.log.error({ err }, 'Sync failed');
      return reply.code(500).send({ ok: false, error: err.message });
    }
  });

  return app;
}

async function start() {
  validateConfig();
  migrate();

  const app = await buildServer();
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
