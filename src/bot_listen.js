require('dotenv').config();
const { Bot, Webhook } = require('@maxhub/max-bot-api');
const { config, validateConfig } = require('./config');
const { migrate } = require('./db');
const { handleMessageCreated, handleUserAdded, handleUserRemoved } = require('./webhook_handlers');

validateConfig();
migrate();

const token = process.env.MAX_BOT_TOKEN || process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing MAX_BOT_TOKEN or BOT_TOKEN in env');
  process.exit(1);
}

const bot = new Bot(token);

// Обработчики событий (те же самые)
bot.on('message_created', async (ctx) => {
  try {
    const msg = ctx.message;
    console.log('📨 message_created', {
      chat_id: msg?.recipient?.chat_id,
      chat_type: msg?.recipient?.chat_type,
      mid: msg?.body?.mid,
      text: msg?.body?.text,
    });
    const result = await handleMessageCreated(ctx.update);
    console.log('✅ message_created result', result);
  } catch (error) {
    console.error('❌ message_created handler error', error);
  }
});

bot.on('user_added', (ctx) => {
  try {
    handleUserAdded(ctx.update);
    console.log('✅ user_added processed');
  } catch (error) {
    console.error('❌ user_added handler error', error);
  }
});

bot.on('user_removed', (ctx) => {
  try {
    handleUserRemoved(ctx.update);
    console.log('✅ user_removed processed');
  } catch (error) {
    console.error('❌ user_removed handler error', error);
  }
});

// Запуск бота в режиме webhook
const PORT = process.env.WEBHOOK_PORT || 4000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || `https://${config.domain}/api/webhook`;

async function startWebhook() {
  try {
    // Устанавливаем webhook
    await bot.api.setWebhook({ url: WEBHOOK_URL });
    console.log(`✅ Webhook set to: ${WEBHOOK_URL}`);
    
    // Запускаем сервер для приёма webhook
    const webhook = new Webhook({ bot, path: '/api/webhook', port: PORT });
    await webhook.listen();
    console.log(`🚀 Webhook server listening on port ${PORT}`);
  } catch (error) {
    console.error('❌ Failed to start webhook:', error);
    process.exit(1);
  }
}

startWebhook();