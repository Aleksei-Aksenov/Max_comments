require('dotenv').config();
const { Bot } = require('@maxhub/max-bot-api');

const token = process.env.MAX_BOT_TOKEN || process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing MAX_BOT_TOKEN or BOT_TOKEN in env');
  process.exit(1);
}

const bot = new Bot(token);

bot.on('bot_started', (ctx) => {
  console.log('bot_started', ctx.update);
});

bot.on('message_created', (ctx) => {
  const msg = ctx.message;
  console.log('message_created', {
    chat_id: msg?.recipient?.chat_id,
    chat_type: msg?.recipient?.chat_type,
    mid: msg?.body?.mid,
    text: msg?.body?.text,
  });
});

bot.on('message_edited', (ctx) => {
  console.log('message_edited', ctx.update);
});

bot.on('message_removed', (ctx) => {
  console.log('message_removed', ctx.update);
});

bot.on('user_added', (ctx) => {
  console.log('user_added', ctx.update);
});

bot.on('user_removed', (ctx) => {
  console.log('user_removed', ctx.update);
});

bot.start();
console.log('Bot listener started');
