import dotenv from 'dotenv';
dotenv.config({ override: true });
import { createBot } from './bot.js';
import { createDashboard } from './dashboard.js';

const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '9999');

// Start dashboard (always available)
createDashboard(DASHBOARD_PORT).catch(err => {
  console.error('\u274c Dashboard failed:', err.message);
});

// Start Telegram bot
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token || token === 'YOUR_BOT_TOKEN_HERE') {
  console.log('\n\u26a0\ufe0f  TELEGRAM_BOT_TOKEN not set - bot disabled, dashboard-only mode.');
  console.log('   To enable the bot:');
  console.log('   1. Message @BotFather on Telegram');
  console.log('   2. Send /newbot and follow instructions');
  console.log('   3. Set token in .env file');
  console.log(`\n\u2705 Dashboard available at http://localhost:${DASHBOARD_PORT}\n`);
} else {
  const bot = createBot(token);

  bot.launch()
    .then(() => {
      console.log('\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
      console.log('\u2705 Telegram LLM Hub is running!');
      console.log(`\u2705 Dashboard: http://localhost:${DASHBOARD_PORT}`);
      console.log('\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
      console.log('Send /start to your bot to begin.\n');
    })
    .catch((err) => {
      console.error('\u274c Bot failed:', err.message);
    });

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
