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
  getAllReactionsWithUsers,
  getUserReaction,
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

  // ✅ Добавляем проверку secret для безопасности
  const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

  app.post('/api/webhook', async (request, reply) => {
    // Проверяем секрет
    const receivedSecret = request.headers['x-max-bot-api-secret'];
    if (WEBHOOK_SECRET && receivedSecret !== WEBHOOK_SECRET) {
      console.error('❌ Invalid webhook secret');
      return reply.code(403).send({ ok: false, error: 'Invalid secret' });
    }
    
    console.log('📨 Webhook received:', JSON.stringify(request.body, null, 2));
    
    // ✅ Поддерживаем как одиночные события, так и массив
    const updates = Array.isArray(request.body) ? request.body : [request.body];
    
    for (const update of updates) {
      const type = update.update_type || update.event_context?.type;
      
      try {
        if (type === 'message_created') {
          await handleMessageCreated(update);
        } else if (type === 'user_added') {
          handleUserAdded(update);
        } else if (type === 'user_removed') {
          handleUserRemoved(update);
        } else if (type === 'bot_started') {
          console.log('🤖 Bot started event received');
        } else {
          console.log(`⚠️ Unknown event type: ${type}`);
        }
      } catch (error) {
        console.error(`Webhook error for ${type}:`, error);
        // Не возвращаем ошибку, продолжаем обработку остальных событий
      }
    }
    
    // Всегда возвращаем 200 OK, даже если были ошибки
    return reply.code(200).send({ ok: true });
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
      
      /* ── CSS переменные для единой системы цветов ── */
      :root {
        --bg-glass: rgba(255, 255, 255, 0.92);
        --bg-dark-glass: rgba(28, 28, 30, 0.85);
        --accent: #007aff;
        --accent-glass: rgba(0, 122, 255, 0.9);
        --text-primary: #1c1c1e;
        --text-secondary: #8e8e93;
        --border-light: rgba(0, 0, 0, 0.05);
        --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
      }

      /* ── Космический фон как в MAX ── */
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: linear-gradient(135deg, #a8d4f8 0%, #86c2f5 100%);
        height: 100dvh;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        position: relative;
      }

      /* Звёздный фон */
      body::before {
        content: '';
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        pointer-events: none;
        background-image: 
          radial-gradient(2px 2px at 20px 30px, #ffffff, rgba(0,0,0,0)),
          radial-gradient(1px 1px at 60px 70px, #ffffff, rgba(0,0,0,0)),
          radial-gradient(1px 1px at 100px 150px, #ffffff, rgba(0,0,0,0)),
          radial-gradient(3px 3px at 200px 250px, #ffffff, rgba(0,0,0,0)),
          radial-gradient(2px 2px at 350px 100px, #ffffff, rgba(0,0,0,0)),
          radial-gradient(1px 1px at 500px 400px, #ffffff, rgba(0,0,0,0)),
          radial-gradient(2px 2px at 650px 200px, #ffffff, rgba(0,0,0,0)),
          radial-gradient(1px 1px at 800px 500px, #ffffff, rgba(0,0,0,0)),
          radial-gradient(3px 3px at 950px 300px, #ffffff, rgba(0,0,0,0));
        background-repeat: no-repeat;
        background-size: 200px 200px;
        opacity: 0.6;
        z-index: 0;
      }

      /* Дополнительные узоры */
      body::after {
        content: '🚀 ✨ 🪐 🌟 ⭐ 📡';
        position: fixed;
        bottom: 20px;
        right: 20px;
        font-size: 24px;
        opacity: 0.3;
        pointer-events: none;
        white-space: pre;
        z-index: 0;
      }

      /* Парящие элементы */
      .star {
        position: fixed;
        color: rgba(255,255,255,0.4);
        font-size: 14px;
        pointer-events: none;
        animation: float 20s infinite linear;
        z-index: 0;
      }

      @keyframes float {
        0% { transform: translateY(100vh) rotate(0deg); opacity: 0; }
        10% { opacity: 0.5; }
        90% { opacity: 0.5; }
        100% { transform: translateY(-20vh) rotate(360deg); opacity: 0; }
      }

      /* ── Контейнеры ── */
      #chat, #status-screen {
        position: relative;
        z-index: 1;
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      #status-screen {
        display: none;
        align-items: center;
        justify-content: center;
        gap: 10px;
        padding: 32px 24px;
        text-align: center;
        background: var(--bg-glass);
        backdrop-filter: blur(10px);
        border-radius: 20px;
        margin: 12px;
      }

      /* ── Loading ── */
      #loading {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        color: var(--text-secondary);
        font-size: 15px;
      }
      
      .spinner {
        width: 28px;
        height: 28px;
        border: 3px solid #e0e0e0;
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: spin .7s linear infinite;
      }
      
      @keyframes spin { to { transform: rotate(360deg); } }

      /* ── Контейнер сообщений ── */
      #messages-container {
        flex: 1;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        scroll-behavior: smooth;
        padding: 12px;
      }

      /* Скроллбар */
      #messages-container::-webkit-scrollbar {
        width: 6px;
      }
      #messages-container::-webkit-scrollbar-track {
        background: rgba(255,255,255,0.3);
        border-radius: 3px;
      }
      #messages-container::-webkit-scrollbar-thumb {
        background: rgba(0,0,0,0.3);
        border-radius: 3px;
      }

      /* ── Шапка поста ── */
      #post-header {
        flex-shrink: 0;
        margin-bottom: 12px;
        background: var(--bg-glass);
        backdrop-filter: blur(10px);
        border-radius: 20px;
        padding: 16px;
        border: 1px solid var(--border-light);
        box-shadow: var(--shadow-sm);
      }

      .post-top {
        display: flex;
        align-items: center;
        margin-bottom: 10px;
      }

      .post-avatar {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: #e5e5ea;
        margin-right: 12px;
        flex-shrink: 0;
        overflow: hidden;
      }

      .post-avatar img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .post-meta {
        display: flex;
        flex-direction: column;
      }

      .post-channel {
        font-size: 15px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .post-time {
        font-size: 12px;
        color: var(--text-secondary);
      }

      .post-text {
        font-size: 15px;
        line-height: 1.4;
        color: var(--text-primary);
        max-height: 80px;
        overflow: hidden;
        position: relative;
      }

      .post-text.expanded {
        max-height: none;
      }

      .post-expand {
        margin-top: 8px;
        font-size: 13px;
        color: var(--accent);
        cursor: pointer;
        user-select: none;
      }

      .post-image {
        margin: 12px -4px;
        border-radius: 16px;
        overflow: hidden;
      }

      .post-image img {
        width: 100%;
        max-height: 220px;
        object-fit: cover;
        display: block;
      }

      /* ── Сообщения ── */
      #messages {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .no-comments {
        margin: auto;
        color: var(--text-secondary);
        font-size: 14px;
        text-align: center;
        padding: 32px;
      }

      .msg {
        max-width: 85%;
        padding: 10px 14px;
        border-radius: 20px;
        word-break: break-word;
        background: var(--bg-glass);
        backdrop-filter: blur(10px);
        align-self: flex-start;
        box-shadow: var(--shadow-sm);
        border: 1px solid var(--border-light);
        position: relative;
      }

      .msg.own {
        align-self: flex-end;
        background: var(--accent-glass);
        color: #fff;
        border: none;
        box-shadow: 0 2px 8px rgba(0, 122, 255, 0.3);
      }

      .msg .author {
        font-size: 11px;
        font-weight: 600;
        color: var(--accent);
        margin-bottom: 4px;
      }

      .msg.own .author { display: none; }

      .msg .text {
        font-size: 15px;
        line-height: 1.4;
      }

      .msg .ts {
        font-size: 10px;
        color: rgba(0,0,0,0.35);
        text-align: right;
        margin-top: 4px;
      }

      .msg.own .ts {
        color: rgba(255,255,255,0.6);
      }

      /* ── Reply quote ── */
      .msg .reply-quote {
        border-left: 3px solid var(--accent);
        padding: 4px 10px;
        margin-bottom: 6px;
        border-radius: 10px;
        background: rgba(0, 122, 255, 0.08);
      }

      .msg.own .reply-quote {
        border-left-color: rgba(255,255,255,0.7);
        background: rgba(255,255,255,0.15);
      }

      .msg .reply-quote .rq-name {
        font-size: 11px;
        font-weight: 600;
        color: var(--accent);
        margin-bottom: 2px;
      }

      .msg.own .reply-quote .rq-name {
        color: rgba(255,255,255,0.9);
      }

      .msg .reply-quote .rq-text {
        font-size: 12px;
        color: #555;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 220px;
      }

      .msg.own .reply-quote .rq-text {
        color: rgba(255,255,255,0.8);
      }

      .msg-highlight {
        transition: box-shadow .15s;
        box-shadow: 0 0 0 3px var(--accent) !important;
      }

      /* ── Reply panel ── */
      #reply-bar {
        display: none;
        align-items: center;
        background: var(--bg-glass);
        backdrop-filter: blur(10px);
        border-top: 0.5px solid var(--border-light);
        padding: 8px 12px;
        gap: 10px;
      }

      #reply-bar .rb-content {
        flex: 1;
      }

      #reply-bar .rb-name {
        font-size: 12px;
        font-weight: 600;
        color: var(--accent);
      }

      #reply-bar .rb-text {
        font-size: 12px;
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      #reply-cancel {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        border: none;
        background: #c7c7cc;
        cursor: pointer;
        font-size: 14px;
        color: #fff;
      }

      /* ── Input area ── */
      #input-bar {
        background: var(--bg-glass);
        backdrop-filter: blur(10px);
        border-top: 0.5px solid var(--border-light);
        padding: 8px 12px;
        padding-bottom: max(8px, env(safe-area-inset-bottom));
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .input-wrapper {
        flex: 1;
        position: relative;
        display: flex;
        align-items: center;
      }

      #msg-input {
        flex: 1;
        border: 0.5px solid var(--border-light);
        border-radius: 22px;
        padding: 10px 48px 10px 16px;
        font-size: 15px;
        font-family: inherit;
        outline: none;
        resize: none;
        line-height: 1.4;
        min-height: 40px;
        max-height: 120px;
        overflow-y: auto;
        background: rgba(242, 242, 247, 0.9);
      }

      #msg-input:focus {
        border-color: var(--accent);
        background: #fff;
      }

      #send-btn {
        position: absolute;
        right: 6px;
        top: 50%;
        transform: translateY(-50%);
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: none;
        background: var(--accent);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      #send-btn:disabled {
        opacity: 0.4;
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
        background: rgba(242, 242, 247, 0.9);
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

      /* ── Реакции ── */
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
        background: rgba(0, 122, 255, 0.2);
        color: var(--accent);
      }

      .reaction-count {
        margin-left: 4px;
        font-size: 12px;
      }

      /* ── Модальное окно реакций ── */
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
        min-width: 260px;
        max-width: 90vw;
        z-index: 100000;
      }

      .modal-reactions {
        display: flex;
        gap: 12px;
        padding: 12px 16px;
        border-bottom: 0.5px solid rgba(255,255,255,0.1);
        flex-wrap: wrap;
        justify-content: center;
      }

      .modal-reaction-btn {
        background: transparent;
        border: none;
        font-size: 32px;
        cursor: pointer;
        padding: 6px 10px;
      }

      .modal-actions {
        display: flex;
        flex-direction: column;
      }

      .modal-action-btn {
        background: transparent;
        border: none;
        padding: 14px 20px;
        text-align: left;
        font-size: 16px;
        color: #ffffff;
        cursor: pointer;
      }

      .reaction-users-tooltip {
        position: fixed;
        background: #1c1c1e;
        border-radius: 12px;
        padding: 8px 0;
        min-width: 150px;
        max-width: 250px;
        max-height: 200px;
        overflow-y: auto;
        z-index: 10001;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        pointer-events: none;
      }

      .tooltip-title {
        padding: 8px 12px;
        font-size: 13px;
        font-weight: 600;
        color: #8e8e93;
        border-bottom: 0.5px solid rgba(255,255,255,0.1);
      }

      .tooltip-list {
        padding: 4px 0;
      }

      .tooltip-user {
        padding: 6px 12px;
        font-size: 14px;
        color: #ffffff;
      }

      .reaction-users-tooltip::-webkit-scrollbar {
        width: 4px;
      }

      .reaction-users-tooltip::-webkit-scrollbar-track {
        background: rgba(255,255,255,0.1);
        border-radius: 2px;
      }

      .reaction-users-tooltip::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.3);
        border-radius: 2px;
      }  
        
      .reaction-users-modal {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: #1c1c1e;
        border-radius: 16px;
        min-width: 260px;
        max-width: 320px;
        max-height: 70vh;
        overflow: hidden;
        z-index: 100000;
        box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      }

      .reaction-users-header {
        padding: 14px 16px;
        font-size: 15px;
        font-weight: 600;
        color: #8e8e93;
        border-bottom: 0.5px solid rgba(255,255,255,0.1);
        text-align: center;
        background: #1c1c1e;
      }

      .reaction-users-list {
        max-height: 60vh;
        overflow-y: auto;
        background: #1c1c1e;
      }

      .reaction-user-item {
        padding: 12px 16px;
        font-size: 14px;
        color: #ffffff;
        border-bottom: 0.5px solid rgba(255,255,255,0.05);
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }

      .reaction-user-item:last-child {
        border-bottom: none;
      }

      .reaction-user-name {
        flex: 1;
        font-weight: 500;
      }

      .reaction-user-emojis {
        font-size: 18px;
        letter-spacing: 2px;
      }      

      .reaction-users-list::-webkit-scrollbar {
        width: 4px;
      }

      .reaction-users-list::-webkit-scrollbar-track {
        background: rgba(255,255,255,0.1);
      }

      .reaction-users-list::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.3);
        border-radius: 2px;
      }     

      /* ── Toast ── */
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
        text-align: center;
        pointer-events: none;
      }

      /* ── Emoji picker ── */
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
      }

      /* ── Мобильная адаптация ── */
      @media (max-width: 768px) {
        #post-header {
          margin: 8px;
          padding: 12px;
        }
        
        #messages-container {
          padding: 8px;
        }
        
        .msg {
          -webkit-touch-callout: none;  /* Отключает меню "Копировать/Выделить" на iOS */
          -webkit-user-select: none;    /* Отключает выделение на iOS/Android */
          user-select: none;            /* Отключает выделение на Android */        
          max-width: 90%;
        }
        
        .post-avatar {
          width: 36px;
          height: 36px;
        }
        
        .emoji-btn {
          width: 36px;
          height: 36px;
          font-size: 20px;
        }
        
        .reactions-modal {
          min-width: 240px;
        }
        
        .modal-reaction-btn {
          font-size: 28px;
          padding: 4px 8px;
        }

        .reaction-users-modal {
          min-width: 280px;
          max-width: 90vw;
        }
        
        .reaction-user-item {
          padding: 10px 14px;
        }
        
        .reaction-user-emojis {
          font-size: 16px;
        }

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
        <div id="messages-container">
          <div id="post-header" class="post-header" style="display: none;"></div>
          <div id="messages">
            <div class="no-comments" id="no-comments">Комментариев пока нет.<br>Будьте первым!</div>
          </div>
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

      function showToast(message) {
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2000);
      }        
        
      // ✅ ФУНКЦИЯ ДЛЯ ОТКРЫТИЯ ПОСТА В MAX
      function openOriginalPost(postUrl) {
        if (postUrl) {
          window.open(postUrl, '_blank');
        } else {
          showToast('Ссылка на пост недоступна');
        }
      }

    // ── Космические звёзды ──────────────────────────────────────────────
    function createStars() {
      // Удаляем старые звёзды
      document.querySelectorAll('.star').forEach(function(el) { el.remove(); });
      
      const icons = ['⭐', '🌟', '✨', '🚀', '🪐', '🌙', '☄️', '💫'];
      
      for (let i = 0; i < 30; i++) {
        const star = document.createElement('div');
        star.className = 'star';
        star.textContent = icons[Math.floor(Math.random() * icons.length)];
        star.style.left = Math.random() * 100 + '%';
        star.style.fontSize = (Math.random() * 16 + 10) + 'px';
        star.style.animationDuration = (Math.random() * 15 + 10) + 's';
        star.style.animationDelay = Math.random() * 15 + 's';
        star.style.opacity = Math.random() * 0.5 + 0.2;
        document.body.appendChild(star);
      }
    }

      // ✅ ОБНОВЛЕННАЯ ФУНКЦИЯ showChat
      function showChat(session) {
        const loading = document.getElementById('loading');
        const sc = document.getElementById('status-screen');
        const chat = document.getElementById('chat');
        const messagesContainer = document.getElementById('messages-container');
        if (!chat) return;
        
        // Удаляем существующий header из messages-container
        const existingHeader = document.getElementById('post-header');
        if (existingHeader) {
          existingHeader.remove();
        }

        if (session?.thread) {
          const header = document.createElement('div');
          header.id = 'post-header';
          header.className = 'post-header';

          const text = session.thread.text || '';
          const attachments = session.thread.attachments || [];
          const channelName = session.channel?.title || 'Канал';
          const channelAvatar = session.channel?.avatar || '';

          // Только фото, видео игнорируем
          let mediaHtml = '';
          attachments.forEach(function(att) {
            if (att.type === 'photo') {
              mediaHtml += '<div class="post-image"><img src="' + att.url + '" loading="lazy" /></div>';
            }
          });

          header.innerHTML =
            '<div class="post-top">' +
              '<div class="post-avatar">' +
                (channelAvatar ? '<img src="' + channelAvatar + '" />' : '') +
              '</div>' +
              '<div class="post-meta">' +
                '<div class="post-channel">' + esc(channelName) + '</div>' +
                '<div class="post-time">' + fmt(Date.now()) + '</div>' +
              '</div>' +
            '</div>' +
            mediaHtml +
            (text ? 
              '<div class="post-text-wrapper">' +
                '<div class="post-text" id="post-text">' + esc(text) + '</div>' +
                '<div class="post-expand" id="post-expand" style="display:none;">Показать ещё</div>' +
              '</div>'
            : '');

          // Вставляем header в начало messages-container
          const messagesContainerElem = document.getElementById('messages-container');
          messagesContainerElem.insertBefore(header, messagesContainerElem.firstChild);

          // Логика expand
          const postTextEl = header.querySelector('#post-text');
          const expandBtn = header.querySelector('#post-expand');

          if (postTextEl && expandBtn) {
            setTimeout(function() {
              const lineHeight = parseInt(getComputedStyle(postTextEl).lineHeight) || 20;
              const maxHeight = lineHeight * 3.5;
              
              if (postTextEl.scrollHeight > maxHeight) {
                expandBtn.style.display = 'block';
                postTextEl.style.maxHeight = maxHeight + 'px';
                postTextEl.style.overflow = 'hidden';

                expandBtn.addEventListener('click', function() {
                  const expanded = postTextEl.style.maxHeight !== 'none';
                  if (expanded) {
                    postTextEl.style.maxHeight = 'none';
                    expandBtn.textContent = 'Скрыть';
                  } else {
                    postTextEl.style.maxHeight = maxHeight + 'px';
                    expandBtn.textContent = 'Показать ещё';
                  }
                });
              }
            }, 100);
          }
        }
        
        if (loading) loading.style.display = 'none';
        if (sc) sc.style.display = 'none';
        chat.style.display = 'flex';
          // ✅ ВЫЗЫВАЕМ СОЗДАНИЕ ЗВЁЗД ПОСЛЕ ОТОБРАЖЕНИЯ ЧАТА
        createStars();
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
      
      async function init() {
        const startParam = new URLSearchParams(window.location.search).get('WebAppStartParam');
        const token = startParam?.replace('t_', '');

        const res = await fetch('/api/thread/' + token);
        const data = await res.json();

        console.log('THREAD DATA:', data);

        renderChannel(data.channel);
        renderPost(data.post);
      }      
      
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
        const emojis = [
          '👍', '👎',     // thumbs up/down
          '❤️', '💔',     // love/broken heart
          '😂', '😢',     // laugh/cry
          '😮', '😡',     // shock/anger
          '🔥', '💩',     // fire/poop
          '🎉', '💀',     // party/skull
          '👏', '🙏',     // clap/pray
          '🤔', '😎'      // thinking/cool
        ];
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
        
        // Ждем рендеринга модалки для получения ее размеров
        setTimeout(() => {
          const modalRect = modal.getBoundingClientRect();
          const modalHeight = modalRect.height;
          const modalWidth = modalRect.width;
          
          // Центрирование по экрану
          let left = (window.innerWidth - modalWidth) / 2;
          let top = (window.innerHeight - modalHeight) / 2 + window.scrollY;
          
          // Проверяем выход за границы
          if (left < 10) left = 10;
          if (left + modalWidth > window.innerWidth - 10) {
            left = window.innerWidth - modalWidth - 10;
          }
          if (top < 10 + window.scrollY) {
            top = 10 + window.scrollY;
          }
          if (top + modalHeight > window.innerHeight + window.scrollY - 10) {
            top = window.innerHeight + window.scrollY - modalHeight - 10;
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
        let isLongPress = false;
        
        // ✅ Короткий тап (мобильные) - показать список пользователей с реакциями
        div.addEventListener('click', (e) => {
          // Если клик по кнопке реакции - не обрабатываем
          if (e.target.closest('.reaction-btn')) return;
          // Если клик по цитате - не обрабатываем
          if (e.target.closest('.reply-quote')) return;
          // Если выделен текст - не обрабатываем
          if (window.getSelection && window.getSelection().toString().length > 0) return;
          
          // Проверяем, есть ли реакции у комментария
          const hasReactions = c.reactions && Object.keys(c.reactions).length > 0;
          if (hasReactions) {
            showAllReactionsUsers(c, div);
          } else {
            // Если нет реакций, открываем меню выбора реакций
            showReactionsModal(c, div);
          }
        });
        
        // ✅ Длинный тап (мобильные) - показать меню выбора реакций
        div.addEventListener('touchstart', (e) => {
          isLongPress = false;
          pressTimer = setTimeout(() => {
            isLongPress = true;
            const touch = e.touches[0];
            showReactionsModal(c, div, touch.clientX, touch.clientY);
          }, 500);
        });
        
        div.addEventListener('touchend', (e) => {
          clearTimeout(pressTimer);
          // Если был длинный тап - предотвращаем короткий
          if (isLongPress) {
            e.preventDefault();
            isLongPress = false;
          }
        });
        
        div.addEventListener('touchmove', () => {
          clearTimeout(pressTimer);
        });
        
        // ✅ Правый клик (ПК) - меню выбора реакций
        div.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showReactionsModal(c, div, e.clientX, e.clientY);
        });
        
        // ✅ Обработчик для цитаты
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

      // Показать всех пользователей, поставивших реакции на комментарий
      function showAllReactionsUsers(c, element) {
        // Собираем всех пользователей со всех реакций
        const allUsers = [];
        const reactions = c.reactions || {};
        
        for (const [emoji, data] of Object.entries(reactions)) {
          if (data.users && data.users.length > 0) {
            data.users.forEach(user => {
              allUsers.push({
                ...user,
                emoji: emoji
              });
            });
          }
        }
        
        if (allUsers.length === 0) {
          showToast('Нет реакций на этом комментарии');
          return;
        }
        
        // Удаляем предыдущее меню
        const existing = document.querySelector('.reaction-users-modal');
        if (existing) existing.remove();
        
        const modal = document.createElement('div');
        modal.className = 'reaction-users-modal';
        
        const header = document.createElement('div');
        header.className = 'reaction-users-header';
        header.innerHTML = 'Реакции — ' + allUsers.length + ' ' + getDeclension(allUsers.length, 'человек', 'человека', 'человек');
        modal.appendChild(header);
        
        const list = document.createElement('div');
        list.className = 'reaction-users-list';
        
        // Группируем по пользователям (если пользователь поставил несколько реакций)
        const usersMap = new Map();
        allUsers.forEach(user => {
          const key = user.user_id;
          if (!usersMap.has(key)) {
            usersMap.set(key, {
              name: user.name,
              emojis: []
            });
          }
          usersMap.get(key).emojis.push(user.emoji);
        });
        
        for (const [userId, userData] of usersMap) {
          const item = document.createElement('div');
          item.className = 'reaction-user-item';
          const emojisStr = userData.emojis.join(' ');
          item.innerHTML = '<span class="reaction-user-name">' + esc(userData.name) + '</span>' +
            '<span class="reaction-user-emojis">' + emojisStr + '</span>';
          list.appendChild(item);
        }
        
        modal.appendChild(list);
        document.body.appendChild(modal);
        
        // Позиционирование по центру экрана
        const modalRect = modal.getBoundingClientRect();
        modal.style.position = 'fixed';
        modal.style.top = '50%';
        modal.style.left = '50%';
        modal.style.transform = 'translate(-50%, -50%)';
        
        // Закрытие по клику вне
        setTimeout(() => {
          document.addEventListener('click', function closeModal(e) {
            if (!modal.contains(e.target)) {
              modal.remove();
              document.removeEventListener('click', closeModal);
            }
          });
        }, 100);
      }      

      function renderReactions(c, container) {
        if (!container) return;

        const reactions = c.reactions || {};

        if (Object.keys(reactions).length === 0) {
          container.style.display = 'none';
          return;
        }

        container.style.display = 'flex';
        container.innerHTML = '';

        for (const [emoji, data] of Object.entries(reactions)) {
          const btn = document.createElement('button');
          btn.className = 'reaction-btn';
          if (data.liked) btn.classList.add('active');
          
          btn.innerHTML = emoji + ' <span class="reaction-count">' + data.count + '</span>';
          
          // ✅ Левый клик - ставим/удаляем реакцию
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            
            // Анимация
            const rect = btn.getBoundingClientRect();
            showFloatingEmoji(emoji, rect.left + rect.width / 2, rect.top);
            btn.animate([
              { transform: 'scale(1)' },
              { transform: 'scale(1.3)' },
              { transform: 'scale(1)' }
            ], { duration: 200, easing: 'ease-out' });
            
            // Отправляем реакцию (если уже есть - удалится)
            await sendReaction(c.id, emoji);
          });
          
          // ✅ Правый клик / долгий тап - показываем список пользователей
          btn.addEventListener('contextmenu', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (data.users && data.users.length > 0) {
              showReactionUsersList(emoji, data.users);
            } else {
              showToast('Нет пользователей с этой реакцией');
            }
          });
          
          // Для мобильных - долгий тап
          let pressTimer;
          btn.addEventListener('touchstart', (e) => {
            pressTimer = setTimeout(() => {
              if (data.users && data.users.length > 0) {
                showReactionUsersList(emoji, data.users);
              }
            }, 500);
          });
          btn.addEventListener('touchend', () => {
            clearTimeout(pressTimer);
          });
          btn.addEventListener('touchmove', () => {
            clearTimeout(pressTimer);
          });

          container.appendChild(btn);
        }
      }

      function showReactionUsersList(emoji, users) {
        // Удаляем предыдущее меню
        const existing = document.querySelector('.reaction-users-modal');
        if (existing) existing.remove();
        
        const modal = document.createElement('div');
        modal.className = 'reaction-users-modal';
        
        const header = document.createElement('div');
        header.className = 'reaction-users-header';
        header.innerHTML = emoji + ' — ' + users.length + ' ' + getDeclension(users.length, 'человек', 'человека', 'человек');
        modal.appendChild(header);
        
        const list = document.createElement('div');
        list.className = 'reaction-users-list';
        
        users.forEach(user => {
          const item = document.createElement('div');
          item.className = 'reaction-user-item';
          item.textContent = user.name;
          list.appendChild(item);
        });
        
        modal.appendChild(list);
        
        document.body.appendChild(modal);
        
        // Закрытие по клику вне
        setTimeout(() => {
          document.addEventListener('click', function closeModal(e) {
            if (!modal.contains(e.target)) {
              modal.remove();
              document.removeEventListener('click', closeModal);
            }
          });
        }, 100);
        
        // Закрытие через 5 секунд
        setTimeout(() => {
          if (modal.parentNode) modal.remove();
        }, 5000);
      }

      // ✅ Показать список пользователей, поставивших реакцию
      function showReactionUsers(btn, emoji, users) {
        // Удаляем предыдущий тултип
        const existingTooltip = document.querySelector('.reaction-users-tooltip');
        if (existingTooltip) existingTooltip.remove();
        
        if (!users || users.length === 0) return;
        
        const tooltip = document.createElement('div');
        tooltip.className = 'reaction-users-tooltip';
        
        const title = document.createElement('div');
        title.className = 'tooltip-title';
        title.textContent = emoji + ' — ' + users.length + ' ' + getDeclension(users.length, 'человек', 'человека', 'человек');
        tooltip.appendChild(title);
        
        const list = document.createElement('div');
        list.className = 'tooltip-list';
        users.forEach(user => {
          const item = document.createElement('div');
          item.className = 'tooltip-user';
          item.textContent = user.name;
          list.appendChild(item);
        });
        tooltip.appendChild(list);
        
        const rect = btn.getBoundingClientRect();
        tooltip.style.position = 'fixed';
        tooltip.style.left = rect.left + 'px';
        tooltip.style.bottom = (window.innerHeight - rect.top + 10) + 'px';
        
        document.body.appendChild(tooltip);
        
        btn.addEventListener('mouseleave', () => {
          tooltip.remove();
        });
      }

      function showReactionUsersToast(emoji, users) {
        if (!users || users.length === 0) return;
        
        const names = users.map(u => u.name).join(', ');
        showToast(emoji + ' — ' + names);
      }

      function getDeclension(number, one, two, five) {
        const n = Math.abs(number);
        n %= 100;
        if (n >= 5 && n <= 20) return five;
        n %= 10;
        if (n === 1) return one;
        if (n >= 2 && n <= 4) return two;
        return five;
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

      function getDeclension(number, one, two, five) {
        const n = Math.abs(number);
        if (n >= 5 && n <= 20) return five;
        if (n % 10 === 1) return one;
        if (n % 10 >= 2 && n % 10 <= 4) return two;
        return five;
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
          
          const emojis = [
            '👍', '👎',      // thumbs
            '❤️', '💔',      // heart
            '😂', '😢',      // laugh/cry
            '😮', '😡',      // shock/anger
            '🔥', '💩',      // fire/poop
            '🎉', '💀',      // party/skull
            '👏', '🙏',      // clap/pray
            '🤔', '😎',      // thinking/cool
            '🥰', '😤',      // love/annoyed
            '👎', '💯'       // thumbs down/100
          ];
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
      // ── Глобальные обработчики ─────────────────────────────────
      document.addEventListener('click', function(e) {
        const card = e.target.closest('.video-card');
        if (card) {
          const postUrl = card.getAttribute('data-post-url');
          if (postUrl && postUrl !== 'undefined') {
            window.open(postUrl, '_blank');
            e.stopPropagation();
          }
        }
      });
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
      console.log('Request params:', request.params);
      console.log('Request body:', request.body);
      
      const initData = request.body?.initData;
      const emoji = request.body?.emoji || '👍';
      const validation = validateInitData(initData, config.maxBotToken);
      if (!validation.ok) {
        console.log('❌ Validation failed:', validation);
        return reply.code(401).send(validation);
      }

      const user = extractUser(validation.data);
      if (!user?.user_id) {
        console.log('❌ No user_id');
        return reply.code(401).send({ ok: false, error: 'user_missing' });
      }
      console.log('👤 User:', user.user_id);

      const commentId = Number(request.params.id);
      console.log('💬 Comment ID:', commentId);
      
      const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId);
      if (!comment) {
        console.log('❌ Comment not found:', commentId);
        return reply.code(404).send({ ok: false, error: 'comment_not_found' });
      }
      console.log('📝 Comment found, thread_id:', comment.thread_id);
      
      const thread = db.prepare(`SELECT id, channel_id, mid FROM threads WHERE id = ?`).get(comment.thread_id);
      if (!thread) {
        console.log('❌ Thread not found for thread_id:', comment.thread_id);
        return reply.code(404).send({ ok: false, error: 'thread_not_found', threadId: comment.thread_id });
      }
      console.log('📌 Thread found:', thread.channel_id, thread.mid);

      const result = toggleReaction({
        commentId,
        userId: String(user.user_id),
        emoji,
      });
      console.log('🔄 Toggle reaction result:', result);

      // ✅ Получаем реакции с информацией о пользователях
      let reactionsWithUsers = [];
      try {
        reactionsWithUsers = getAllReactionsWithUsers(commentId);
        console.log('👥 Reactions with users:', reactionsWithUsers.length);
      } catch (err) {
        console.error('❌ getAllReactionsWithUsers error:', err.message);
      }
      
      // Группируем для удобства фронтенда
      const reactions = {};
      for (const r of reactionsWithUsers) {
        if (!reactions[r.emoji]) {
          reactions[r.emoji] = { 
            count: 0, 
            liked: false,
            users: []
          };
        }
        reactions[r.emoji].count++;
        reactions[r.emoji].users.push({
          user_id: r.user_id,
          name: r.name || String(r.user_id),
          created_at: r.created_at
        });
        if (String(r.user_id) === String(user.user_id)) {
          reactions[r.emoji].liked = true;
        }
      }
      console.log('📊 Grouped reactions:', Object.keys(reactions));

      // Broadcast через SSE
      try {
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
        console.log('📡 Reaction broadcasted');
      } catch (err) {
        console.error('❌ publishReaction error:', err.message);
      }

      return reply.send({
        ok: true,
        liked: result.liked,
        emoji: result.emoji,
        reactions,
      });
    } catch (err) {
      console.error('❌ Reaction endpoint error:', err);
      console.error('Stack:', err.stack);
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

    // ✅ Безопасный парсинг attachments
    let attachments = [];
    try {
      if (typeof thread.attachments === 'string') {
        attachments = JSON.parse(thread.attachments || '[]');
      } else if (Array.isArray(thread.attachments)) {
        attachments = thread.attachments;
      }
    } catch (e) {
      console.error('Failed to parse attachments:', e);
      attachments = [];
    }

    // ✅ Формируем ссылку на оригинальный пост в канале
    const postUrl = `https://max.ru/channels/${thread.channel_id}/messages/${thread.mid}`;

    return reply.send({
      ok: true,
      subscribed,
      
      // Добавляем информацию о канале
      channel: {
        id: thread.channel_id,
        title: thread.channel_title || 'Канал',
        avatar: thread.channel_avatar || ''
      },
      
      thread: {
        channel_id: thread.channel_id,
        mid: thread.mid,
        text: thread.text || '',
        created_at: thread.created_at,
        attachments: attachments,  // ✅ Теперь attachments это массив объектов с video_id
        image_url: thread.image_url || '',
        post_url: postUrl  // ✅ Ссылка на пост в канале
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

  app.get("/api/thread/:mid", (req, reply) => {
  const thread = db.prepare(`
    SELECT * FROM threads WHERE mid = ?
  `).get(req.params.mid);

  if (!thread) {
    return reply.code(404).send({ error: "Not found" });
  }

  reply.send({
    channel: {
      title: thread.channel_title,
      avatar: thread.channel_avatar
    },
    post: {
      text: thread.text,
      attachments: JSON.parse(thread.attachments || "[]")
    }
  });
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
  
  // Запускаем основной сервер на порту 3000
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`✅ Main server listening on http://0.0.0.0:${config.port}`);
  
  // ✅ Запускаем дополнительный сервер для webhook на порту 4000
  // Fastify не может слушать несколько портов из одного инстанса,
  // поэтому создаем отдельный http сервер
  const http = require('http');
  
  // Создаем отдельный сервер для webhook
  const webhookHandler = async (req, res) => {
    // Устанавливаем CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
      return;
    }
    
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const update = JSON.parse(body);
        console.log('📨 Webhook received:', JSON.stringify(update, null, 2));
        
        const updates = Array.isArray(update) ? update : [update];
        
        for (const upd of updates) {
          const type = upd.update_type || upd.event_context?.type;
          try {
            if (type === 'message_created') {
              await handleMessageCreated(upd);
            } else if (type === 'user_added') {
              handleUserAdded(upd);
            } else if (type === 'user_removed') {
              handleUserRemoved(upd);
            }
          } catch (error) {
            console.error(`Webhook handler error for ${type}:`, error);
          }
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('Webhook parse error:', err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      }
    });
  };
  
  const webhookServer = http.createServer(webhookHandler);
  const WEBHOOK_PORT = process.env.WEBHOOK_PORT || 4000;
  
  webhookServer.listen(WEBHOOK_PORT, '0.0.0.0', () => {
    console.log(`✅ Webhook server listening on http://0.0.0.0:${WEBHOOK_PORT}`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});