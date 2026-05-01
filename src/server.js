const Fastify = require('fastify');
const { config, validateConfig } = require('./config');
const { migrate } = require('./db');
const { validateInitData, extractUser } = require('./validation');
const { decodePayload } = require('./payload');
const {
  isMember,
  getThreadByChannelMid,
  getThreadByToken,
  getThreadById,
  addComment,
  getComments,
  getCommentById,
  getMembersStats,
  toggleReaction,
  getReactionsByCommentIdWithUser,
  db
} = require('./db');
const { addSubscriber, removeSubscriber, publishComment, publishReaction } = require('./realtime');
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
    console.log('🔥 FULL UPDATE:', JSON.stringify(request.body, null, 2));

    return reply.send({
      ok: true,
      received: request.body
    });
  });

  app.get('/', async (request, reply) => {
  const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
  return reply.redirect('/miniapp' + query);
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
        -webkit-touch-callout: none;
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
        width: 100%;
        max-width: 100%;
      }

      #messages {
        flex: 1;
        overflow-y: auto;
        padding: 12px 12px 4px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        width: 100%;
      }
      .no-comments {
        margin: auto;
        color: #8e8e93;
        font-size: 14px;
        text-align: center;
        padding: 32px;
      }
      .msg {
        max-width: 85%;
        padding: 8px 12px;
        border-radius: 18px;
        word-break: break-word;
        background: #fff;
        align-self: flex-start;
        box-shadow: 0 1px 1px rgba(0,0,0,.07);
        position: relative;
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
      .reactions {
        margin-top: 4px;
      }

      .like-btn {
        background: transparent;
        border: none;
        font-size: 13px;
        cursor: pointer;
        color: #8e8e93;
      }

      .like-btn.liked {
        color: #007aff;
        font-weight: 600;
      }

      .reactions-container {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 6px;
      }

      .reaction-btn, .reaction-add-btn {
        background: rgba(0,0,0,0.05);
        border: none;
        border-radius: 20px;
        padding: 3px 8px;
        font-size: 13px;
        cursor: pointer;
        transition: all 0.2s;
      }

      .reaction-btn.active {
        background: #007aff20;
        color: #007aff;
      }

      .reaction-btn:hover, .reaction-add-btn:hover {
        background: rgba(0,0,0,0.1);
      }

      .reaction-count {
        margin-left: 3px;
        font-size: 11px;
      }

      .reactions-menu {
        position: fixed;
        background: #1c1c1e;
        border-radius: 30px;
        padding: 8px 12px;
        display: flex;
        gap: 12px;
        z-index: 10000;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      }

      .reactions-menu span {
        font-size: 28px;
        cursor: pointer;
        padding: 4px;
        transition: transform 0.1s;
      }

      .reactions-menu span:hover {
        transform: scale(1.2);
      }

      /* Post header */
      .post-header {
        margin: 10px 12px 6px;
        padding: 12px 14px;
        background: #ffffff;
        border-radius: 14px;
        box-shadow: 0 2px 6px rgba(0,0,0,0.08);
        font-size: 15px;
        color: #1c1c1e;
        line-height: 1.45;
        flex-shrink: 0;
        word-break: break-word;
        position: relative;
      }
      .post-header strong {
        display: block;
        margin-bottom: 4px;
        color: #8e8e93;
        font-weight: 500;
      }
      .post-title {
        font-size: 12px;
        color: #8e8e93;
        margin-bottom: 6px;
        font-weight: 500;
      }
      .post-text {
        font-size: 15px;
        color: #1c1c1e;
        max-height: 80px;
        overflow: hidden;
        position: relative;
      }

      .post-text.expanded {
        max-height: none;
      }
      .post-expand {
        margin-top: 6px;
        font-size: 13px;
        color: #007aff;
        cursor: pointer;
        user-select: none;
      }
      .post-text:not(.expanded)::after {
        content: "";
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        height: 24px;
        background: linear-gradient(to bottom, rgba(255,255,255,0), #fff);
      }
      .post-top {
        display: flex;
        align-items: center;
        margin-bottom: 8px;
      }

      .post-avatar {
        width: 34px;
        height: 34px;
        border-radius: 50%;
        background: #e5e5ea;
        margin-right: 10px;
        flex-shrink: 0;
      }

      .post-meta {
        display: flex;
        flex-direction: column;
      }

      .post-channel {
        font-size: 14px;
        font-weight: 600;
        color: #1c1c1e;
      }

      .post-time {
        font-size: 12px;
        color: #8e8e93;
      }

      /* Модальное окно с затемнением */
      .modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(4px);
        z-index: 99999;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .reactions-modal {
        position: absolute;
        background: #2c2c2e;
        border-radius: 14px;
        overflow: hidden;
        box-shadow: 0 8px 20px rgba(0,0,0,0.3);
        min-width: 260px;
        max-width: 90vw;
        z-index: 100000;
      }

      .modal-reactions {
        display: flex;
        gap: 12px;
        padding: 12px 16px;
        border-bottom: 0.5px solid rgba(255,255,255,0.1);
        background: #2c2c2e;
        flex-wrap: wrap;
        justify-content: center;
      }

      .modal-reaction-btn {
        background: transparent;
        border: none;
        font-size: 32px;
        cursor: pointer;
        padding: 6px 10px;
        transition: transform 0.1s;
      }

      .modal-reaction-btn:active {
        transform: scale(1.2);
      }

      .modal-actions {
        display: flex;
        flex-direction: column;
        background: #1c1c1e;
      }

      .modal-action-btn {
        background: transparent;
        border: none;
        padding: 14px 20px;
        text-align: left;
        font-size: 16px;
        color: #ffffff;
        cursor: pointer;
        transition: background 0.1s;
      }

      .modal-action-btn:active {
        background: rgba(255,255,255,0.1);
      }

      .post-image {
        margin-top: 10px;
        border-radius: 12px;
        overflow: hidden;
      }

      .post-image img {
        width: 100%;
        max-height: 220px;
        object-fit: cover;
        display: block;
      }      

      /* Toast уведомления */
      .toast {
        position: fixed;
        bottom: 100px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0,0,0,0.85);
        color: white;
        padding: 10px 20px;
        border-radius: 25px;
        font-size: 14px;
        z-index: 10002;
        white-space: nowrap;
        max-width: 90vw;
        white-space: normal;
        text-align: center;
        pointer-events: none;
      }

      /* Кнопка смайлика */
      .emoji-btn {
        flex-shrink: 0;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        border: none;
        background: #f2f2f7;
        cursor: pointer;
        font-size: 22px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s;
      }

      .emoji-btn:hover {
        background: #e5e5ea;
      }

      /* Панель выбора эмодзи */
      .emoji-picker {
        position: fixed;
        background: #1c1c1e;
        border-radius: 30px;
        padding: 10px 16px;
        display: flex;
        gap: 12px;
        z-index: 10000;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        flex-wrap: wrap;
        max-width: 90vw;
      }

      .emoji-picker-btn {
        background: transparent;
        border: none;
        font-size: 28px;
        cursor: pointer;
        padding: 6px;
        transition: transform 0.1s;
      }

      .emoji-picker-btn:hover {
        transform: scale(1.2);
      }

      /* Реакции под комментарием */
      .reactions-container {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 6px;
      }

      .reaction-btn {
        background: rgba(0,0,0,0.05);
        border: none;
        border-radius: 20px;
        padding: 4px 10px;
        font-size: 14px;
        cursor: pointer;
        transition: all 0.2s;
      }

      .reaction-btn.active {
        background: #007aff20;
        color: #007aff;
      }

      .reaction-count {
        margin-left: 4px;
        font-size: 12px;
      }

      /* Мобильная адаптация */
      @media (max-width: 768px) {

        .msg {
          max-width: 90%;
          -webkit-user-select: none;
          user-select: none;
        }

        .msg .text {
          -webkit-user-select: text;
          user-select: text;
        }
        
        .reactions-modal {
          min-width: 240px;
        }
        
        .modal-reaction-btn {
          font-size: 28px;
          padding: 4px 8px;
        }
        
        .modal-action-btn {
          padding: 12px 16px;
          font-size: 15px;
        }
        
        .emoji-picker {
          padding: 8px 12px;
          gap: 8px;
        }
        
        .emoji-picker-btn {
          font-size: 24px;
        }
      }
      
      /* Улучшенный скролл */
      #messages::-webkit-scrollbar {
        width: 6px;
      }

      #messages::-webkit-scrollbar-track {
        background: #f1f1f1;
        border-radius: 3px;
      }

      #messages::-webkit-scrollbar-thumb {
        background: #c1c1c1;
        border-radius: 3px;
      }

      #messages::-webkit-scrollbar-thumb:hover {
        background: #a8a8a8;
      }

      /* ── Input area ── */
      #input-bar {
        background: #fff;
        border-top: 1px solid rgba(0,0,0,.1);
        padding: 8px 12px;
        padding-bottom: max(8px, env(safe-area-inset-bottom));
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
      }

      .input-wrapper {
        flex: 1;
        position: relative;
        display: flex;
        align-items: center;
      }

      #msg-input {
        flex: 1;
        border: 1px solid #d1d1d6;
        border-radius: 20px;
        padding: 10px 48px 10px 14px;
        font-size: 15px;
        font-family: inherit;
        outline: none;
        resize: none;
        line-height: 1.4;
        min-height: 40px;
        max-height: 120px;
        overflow-y: auto;
        background: #f2f2f7;
        width: 100%;
      }

      #msg-input:focus { 
        border-color: #007aff; 
        background: #fff; 
      }


      #send-btn:disabled { 
        opacity: .4; 
        cursor: default; 
      }

      #send-btn svg { 
        width: 16px; 
        height: 16px; 
        fill: #fff; 
      }

      .emoji-btn {
        flex-shrink: 0;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        border: none;
        background: #f2f2f7;
        cursor: pointer;
        font-size: 22px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s;
      }

      /* Кнопка смайлика */
      .emoji-btn {
        flex-shrink: 0;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        border: none;
        background: #f2f2f7;
        cursor: pointer;
        font-size: 22px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s;
      }

      .emoji-btn:hover {
        background: #e5e5ea;
      }

      #msg-input {
        flex: 1;
        border: 1px solid #d1d1d6;
        border-radius: 20px;
        padding: 10px 14px;
        font-size: 15px;
        font-family: inherit;
        outline: none;
        resize: none;
        line-height: 1.4;
        min-height: 40px;
        max-height: 120px;
        overflow-y: auto;
        background: #f2f2f7;
        width: 100%;
      }
      #msg-input:focus { 
        border-color: #007aff; 
        background: #fff; 
      }

      #send-btn {
        flex-shrink: 0;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        border: none;
        background: #007aff;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: opacity .15s;
      }

      #send-btn:disabled { 
        opacity: .4; 
        cursor: default; 
      }

      #send-btn svg { 
        width: 18px; 
        height: 18px; 
        fill: #fff; 
      }

      .reaction {
        position: fixed;
        font-size: 24px;
        pointer-events: none;
        transition: transform 0.7s ease-out, opacity 0.7s ease-out;
      }
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
        <button id="emoji-btn" class="emoji-btn">😊</button>
        <div class="input-wrapper">
          <textarea id="msg-input" rows="1" placeholder="Написать комментарий…"></textarea>
          <button id="send-btn" disabled>
            <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </div>
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

      document.addEventListener('selectstart', (e) => {
        if (e.target.closest('.msg')) {
          e.preventDefault();
        }
      });

      function showFloatingEmoji(emoji, x, y) {
        const el = document.createElement('div');
        el.textContent = emoji;

        el.style.position = 'fixed';
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        el.style.fontSize = '28px';
        el.style.pointerEvents = 'none';
        el.style.zIndex = '99999';

        // Рандомная длительность
        const duration = 0.5 + Math.random() * 0.3;
        el.style.transition = 'transform ' + duration + 's ease-out, opacity ' + duration + 's ease-out';

        document.body.appendChild(el);

        // Рандом по X и вращение
        const offsetX = (Math.random() - 0.5) * 30;
        const rotate = (Math.random() - 0.5) * 60;

        requestAnimationFrame(function() {
          el.style.transform = 'translate(' + offsetX + 'px, -60px) scale(1.3) rotate(' + rotate + 'deg)';
          el.style.opacity = '0';
        });

        setTimeout(function() { el.remove(); }, duration * 1000);
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
      function showChat(session) {
        const loading = document.getElementById('loading');
        const sc      = document.getElementById('status-screen');
        const chat    = document.getElementById('chat');
        if (!chat) return;
        
        // Удаляем существующий header
        const existingHeader = document.querySelector('.post-header');
        if (existingHeader) existingHeader.remove();

        if (session?.thread) {
          const header = document.createElement('div');
          header.className = 'post-header';

          const text = session.thread.text || '';
          const image = session.thread.image_url || '';

          header.innerHTML =
            '<div class="post-top">' +
              '<div class="post-avatar"></div>' +
              '<div class="post-meta">' +
                '<div class="post-channel">Канал</div>' +
                '<div class="post-time">' + fmt(Date.now()) + '</div>' +
              '</div>' +
            '</div>' +

            // 🖼 КАРТИНКА
            (image ? 
              '<div class="post-image">' +
                '<img src="' + image + '" />' +
              '</div>'
            : '') +

            // 📝 ТЕКСТ
            (text ? 
              '<div class="post-text" id="post-text">' + esc(text) + '</div>' +
              '<div class="post-expand" id="post-expand" style="display:none;">Показать ещё</div>'
            : '');

          // expand логика
          const postTextEl = header.querySelector('#post-text');
          const expandBtn = header.querySelector('#post-expand');

          if (postTextEl && expandBtn && postTextEl.scrollHeight > 80) {
            expandBtn.style.display = 'block';

            expandBtn.addEventListener('click', () => {
              const expanded = postTextEl.classList.toggle('expanded');
              expandBtn.textContent = expanded ? 'Скрыть' : 'Показать ещё';
            });
          }

          document.body.prepend(header);
        }
        
        if (loading) loading.style.display = 'none';
        if (sc)      sc.style.display      = 'none';
        chat.style.display = 'flex';
      }

      function showToast(message) {
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2000);
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
      const commentsById = new Map();
      let activeModal = null;

      function closeModal() {
        if (activeModal) {
          document.querySelectorAll('.msg-highlight').forEach(el => {
            el.classList.remove('msg-highlight');
          });
          activeModal.remove();
          activeModal = null;
        }
      }

      function showReactionsModal(c, element, clientX = null, clientY = null) {
        closeModal();
        
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        
        const modal = document.createElement('div');
        modal.className = 'reactions-modal';
        
        const reactionsRow = document.createElement('div');
        reactionsRow.className = 'modal-reactions';
        const emojis = ['👍', '❤️', '😂', '🔥', '😢', '😮'];
        emojis.forEach(emoji => {
          const btn = document.createElement('button');
          btn.className = 'modal-reaction-btn';
          btn.textContent = emoji;
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await sendReaction(c.id, emoji);
            closeModal();
          });
          reactionsRow.appendChild(btn);
        });
        
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'modal-actions';
        
        const replyBtn = document.createElement('button');
        replyBtn.className = 'modal-action-btn';
        replyBtn.innerHTML = '💬 Ответить';
        replyBtn.addEventListener('click', () => {
          setReply(c);
          closeModal();
        });
        
        const copyTextBtn = document.createElement('button');
        copyTextBtn.className = 'modal-action-btn';
        copyTextBtn.innerHTML = '📋 Копировать текст';
        copyTextBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(c.text);
          showToast('Текст скопирован');
          closeModal();
        });
        
        const copyLinkBtn = document.createElement('button');
        copyLinkBtn.className = 'modal-action-btn';
        copyLinkBtn.innerHTML = '🔗 Копировать ссылку';
        copyLinkBtn.addEventListener('click', () => {
          const link = window.location.href + '?comment=' + c.id;
          navigator.clipboard.writeText(link);
          showToast('Ссылка скопирована');
          closeModal();
        });
        
        actionsDiv.appendChild(replyBtn);
        actionsDiv.appendChild(copyTextBtn);
        actionsDiv.appendChild(copyLinkBtn);
        
        modal.appendChild(reactionsRow);
        modal.appendChild(actionsDiv);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        
        // Получаем позицию элемента и размеры окна
        const rect = element.getBoundingClientRect();
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
        
        // Ждем рендеринга модалки для получения ее размеров
        setTimeout(() => {
          const modalRect = modal.getBoundingClientRect();
          const modalHeight = modalRect.height;
          const modalWidth = modalRect.width;
          
          let top, left;
          
          if (clientX && clientY) {
            // ПК: позиционируем относительно курсора
            left = clientX - modalWidth / 2;
            top = clientY - modalHeight - 10;
          } else {
            // Мобильные: под комментарием
            left = rect.left + (rect.width - modalWidth) / 2;
            top = rect.bottom + scrollTop + 10;
          }
          
          // Проверяем выход за левый край
          if (left < 10) left = 10;
          // Проверяем выход за правый край
          if (left + modalWidth > window.innerWidth - 10) {
            left = window.innerWidth - modalWidth - 10;
          }
          // Если не помещается снизу, показываем сверху
          if (top + modalHeight > window.innerHeight + scrollTop - 50) {
            if (clientX && clientY) {
              top = clientY + 10;
            } else {
              top = rect.top + scrollTop - modalHeight - 10;
            }
          }
          // Проверяем выход за верхний край
          if (top < scrollTop + 10) {
            top = scrollTop + 10;
          }
          
          modal.style.left = left + 'px';
          modal.style.top = top + 'px';
        }, 10);
        
        activeModal = overlay;
        
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) closeModal();
        });
        
        element.classList.add('msg-highlight');
      }

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
          + '<div class="ts">' + fmt(c.created_at) + '</div>'
          + '<div class="reactions-container" data-id="' + c.id + '"></div>';

        div.innerHTML = html;
        
        const reactionsContainer = div.querySelector('.reactions-container');
        if (reactionsContainer && c.reactions && Object.keys(c.reactions).length > 0) {
          renderReactions(c, reactionsContainer);
        } else if (reactionsContainer) {
          reactionsContainer.style.display = 'none';
        }
        
        let pressTimer;
        
        div.addEventListener('touchstart', (e) => {
          pressTimer = setTimeout(() => {
            const touch = e.touches[0];
            showReactionsModal(c, div, touch.clientX, touch.clientY);
          }, 500);
        });
        
        div.addEventListener('touchend', () => {
          clearTimeout(pressTimer);
        });
        
        div.addEventListener('touchmove', () => {
          clearTimeout(pressTimer);
        });
        
        div.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showReactionsModal(c, div, e.clientX, e.clientY);
        });
        
        if (c.reply_to_id) {
          const quote = div.querySelector('.reply-quote');
          if (quote) {
            quote.addEventListener('click', (e) => {
              e.stopPropagation();
              const target = document.querySelector('.msg[data-id="' + c.reply_to_id + '"]');
              if (!target) return;
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              target.classList.add('msg-highlight');
              setTimeout(() => target.classList.remove('msg-highlight'), 1200);
            });
          }
        }

        const msgs = document.getElementById('messages');
        msgs.appendChild(div);
        msgs.scrollTop = msgs.scrollHeight;
      }

      function renderReactions(c, container) {
        if (!container) return;

        const reactions = c.reactions || {};

        // если нет реакций — скрываем блок
        if (Object.keys(reactions).length === 0) {
          container.style.display = 'none';
          return;
        }

        container.style.display = 'flex';
        container.innerHTML = '';

        for (const [emoji, data] of Object.entries(reactions)) {
          const btn = document.createElement('button');
          btn.className = 'reaction-btn';

          if (data.liked) {
            btn.classList.add('active');
          }

          // используем textContent и createElement вместо innerHTML
          btn.textContent = emoji + ' ';
          const countSpan = document.createElement('span');
          countSpan.className = 'reaction-count';
          countSpan.textContent = data.count;
          btn.appendChild(countSpan);

          btn.addEventListener('click', async (e) => {
            e.stopPropagation();

            // 💥 координаты клика
            const rect = btn.getBoundingClientRect();

            // 🎈 показываем "вылетающий" emoji
            showFloatingEmoji(
              emoji,
              rect.left + rect.width / 2,
              rect.top
            );

            // 💥 анимация кнопки
            btn.animate([
              { transform: 'scale(1)' },
              { transform: 'scale(1.3)' },
              { transform: 'scale(1)' }
            ], {
              duration: 200,
              easing: 'ease-out'
            });

            await sendReaction(c.id, emoji);
          });

          container.appendChild(btn);
        }
      }

      async function sendReaction(commentId, emoji) {
        console.log('Sending reaction:', { commentId, emoji, initData: !!initData });
        try {
          const res = await fetch('/api/comments/' + commentId + '/reaction', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData, emoji })
          });
          const data = await res.json();
          console.log('Reaction response:', data);
          if (data.ok) {
            const msgDiv = document.querySelector('.msg[data-id="' + commentId + '"]');
            if (msgDiv) {
              const comment = commentsById.get(commentId);
              if (comment) {
                // Обновляем реакции из ответа сервера
                comment.reactions = data.reactions;
                const container = msgDiv.querySelector('.reactions-container');
                if (container) {
                  renderReactions(comment, container);
                }
              }
            }
          } else {
            console.error('Failed to send reaction:', data);
            showToast('Ошибка при отправке реакции');
          }
        } catch (err) {
          console.error('Failed to send reaction:', err);
          showToast('Ошибка соединения');
        }
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

        es.addEventListener('reaction', (e) => {
          try {
            const r = JSON.parse(e.data);
            const msg = document.querySelector('.msg[data-id="' + r.commentId + '"]');
            if (!msg) return;
            
            const comment = commentsById.get(r.commentId);
            if (comment) {
              comment.reactions = r.reactions;
              const container = msg.querySelector('.reactions-container');
              if (container) {
                renderReactions(comment, container);
              }
            }
          } catch (err) {
            console.error('Failed to process reaction event:', err);
          }
        });

        es.onerror = () => {
          if (!pollingTimer) {
            es.close();
            startPolling();
          }
        };
      }

      // ── reply state ──────────────────────────────────────────
      let replyTo = null;

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

      // ── emoji button ─────────────────────────────────────────
      const emojiBtn = document.getElementById('emoji-btn');
      let emojiPickerActive = false;
      let emojiPickerModal = null;

      function closeEmojiPicker() {
        if (emojiPickerModal) {
          emojiPickerModal.remove();
          emojiPickerModal = null;
        }
        emojiPickerActive = false;
      }

      if (emojiBtn) {
        emojiBtn.addEventListener('click', () => {
          if (emojiPickerActive) {
            closeEmojiPicker();
            return;
          }
          
          const picker = document.createElement('div');
          picker.className = 'emoji-picker';
          
          const emojis = ['👍', '❤️', '😂', '🔥', '😢', '😮', '🎉', '👏', '💯', '🙏'];
          emojis.forEach(emoji => {
            const btn = document.createElement('button');
            btn.className = 'emoji-picker-btn';
            btn.textContent = emoji;
            btn.addEventListener('click', () => {
              input.value += emoji;
              input.dispatchEvent(new Event('input'));
              closeEmojiPicker();
            });
            picker.appendChild(btn);
          });
          
          const rect = emojiBtn.getBoundingClientRect();
          picker.style.position = 'fixed';
          picker.style.bottom = (window.innerHeight - rect.top + 10) + 'px';
          picker.style.left = rect.left + 'px';
          
          document.body.appendChild(picker);
          emojiPickerActive = true;
          emojiPickerModal = picker;
          
          setTimeout(() => {
            document.addEventListener('click', function closePicker(e) {
              if (!picker.contains(e.target) && e.target !== emojiBtn) {
                closeEmojiPicker();
                document.removeEventListener('click', closePicker);
              }
            });
          }, 0);
        });
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
          showChat(session);
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

  app.addHook('onRequest', async (req) => {
    console.log('➡️ INCOMING:', req.method, req.url);
  });

  app.post('/api/comments/:id/reaction', async (request, reply) => {
    try {
      console.log('🔥 REACTION ENDPOINT CALLED');
      const initData = request.body?.initData;
      const emoji = request.body?.emoji || '👍';
      
      const validation = validateInitData(initData, config.maxBotToken);
      if (!validation.ok) return reply.code(401).send(validation);

      const user = extractUser(validation.data);
      if (!user?.user_id) return reply.code(401).send({ ok: false });

      const commentId = Number(request.params.id);
      
      // Получаем комментарий с thread_id
      const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId);
      
      if (!comment) {
        return reply.code(404).send({ ok: false, error: 'comment_not_found' });
      }
      
      // Получаем thread
      const thread = db.prepare(`
        SELECT id, channel_id, mid 
        FROM threads 
        WHERE id = ?
      `).get(comment.thread_id);
      
      if (!thread) {
        return reply.code(404).send({ 
          ok: false, 
          error: 'thread_not_found', 
          commentId, 
          threadId: comment.thread_id 
        });
      }

      const result = toggleReaction({
        commentId,
        userId: String(user.user_id),
        emoji,
      });

      // Получаем все реакции для комментария
      const reactions = getReactionsByCommentIdWithUser(
        commentId,
        String(user.user_id)
      );
      
      // Проверяем, какую реакцию поставил пользователь
      const userReaction = db.prepare(`
        SELECT emoji FROM reactions 
        WHERE comment_id = ? AND user_id = ?
      `).get(commentId, String(user.user_id));
      
      if (userReaction && reactions[userReaction.emoji]) {
        reactions[userReaction.emoji].liked = true;
      }

      // Broadcast через SSE
      publishReaction({
        channelId: thread.channel_id,
        mid: thread.mid,
        reaction: {
          commentId,
          userId: String(user.user_id),
          liked: result.liked,
          emoji: result.emoji,
          reactions,
        },
      });

      return reply.send({
        ok: true,
        liked: result.liked,
        emoji: result.emoji,
        reactions,
      });
    } catch (err) {
      console.error('Reaction error:', err);
      return reply.code(500).send({ ok: false, error: err.message });
    }
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
    console.log('🔥 THREAD FROM DB:', thread);
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
        text: thread.text || '',
        created_at: thread.created_at,
        attachments: thread.attachments ? JSON.parse(thread.attachments) : [],
        image_url: thread.image_url || ''
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

    const enriched = comments.map(c => ({
      ...c,
      reactions: getReactionsByCommentIdWithUser(
        c.id,
        String(user.user_id)
      )
    }));

    return reply.send({ ok: true, comments: enriched });
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
