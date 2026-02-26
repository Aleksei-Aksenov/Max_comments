require('dotenv').config();
const { Bot } = require('@maxhub/max-bot-api');
const { config, validateConfig } = require('./config');
const { migrate } = require('./db');
const {
  handleMessageCreated,
  handleUserAdded,
  handleUserRemoved,
} = require('./webhook_handlers');

const token = process.env.MAX_BOT_TOKEN || process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing MAX_BOT_TOKEN or BOT_TOKEN in env');
  process.exit(1);
}

validateConfig();
migrate();

const bot = new Bot(token);

bot.on('message_created', async (ctx) => {
  try {
    const msg = ctx.message;
    console.log('message_created', {
      chat_id: msg?.recipient?.chat_id,
      chat_type: msg?.recipient?.chat_type,
      mid: msg?.body?.mid,
      text: msg?.body?.text,
    });
    const result = await handleMessageCreated(ctx.update);
    console.log('message_created result', result);
  } catch (error) {
    console.error('message_created handler error', error);
  }
});

bot.on('user_added', (ctx) => {
  try {
    handleUserAdded(ctx.update);
  } catch (error) {
    console.error('user_added handler error', error);
  }
});

bot.on('user_removed', (ctx) => {
  try {
    handleUserRemoved(ctx.update);
  } catch (error) {
    console.error('user_removed handler error', error);
  }
});

bot.start();
console.log('Bot worker (long-polling) started');
