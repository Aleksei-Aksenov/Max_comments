require('dotenv').config();
const { config, validateConfig } = require('./config');
const { migrate } = require('./db');

validateConfig();
migrate();

const token = process.env.MAX_BOT_TOKEN || process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing MAX_BOT_TOKEN or BOT_TOKEN in env');
  process.exit(1);
}

const WEBHOOK_URL = process.env.WEBHOOK_URL || `https://${config.domain}/api/webhook`;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.randomBytes(32).toString('base64url');

async function setupWebhook() {
  try {
    // Правильный URL для подписки на webhook
    const subscriptionUrl = `${config.maxApiBase}/subscriptions`;
    console.log(`🔗 Setting webhook to: ${subscriptionUrl}`);
    
    const response = await fetch(subscriptionUrl, {
      method: 'POST',
      headers: { 
        'Authorization': token,  // ← токен без Bearer, просто строка
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: WEBHOOK_URL,
        update_types: ['message_created', 'user_added', 'user_removed', 'bot_started'],
        secret: WEBHOOK_SECRET
      })
    });
    
    const result = await response.json();
    console.log('✅ Webhook setup result:', result);
    
    if (result.success) {
      console.log(`📡 Webhook active: ${WEBHOOK_URL}`);
      console.log(`🔐 Webhook secret: ${WEBHOOK_SECRET}`);
    }
  } catch (error) {
    console.error('❌ Failed to setup webhook:', error);
  }
}

setupWebhook();

// Держим процесс живым
console.log('🚀 Bot worker started (webhook mode)');
console.log(`📡 Webhook URL: ${WEBHOOK_URL}`);
console.log('💡 Events will be sent to this URL');

setInterval(() => {}, 60000);