import { safeSend } from '../bot-helpers.js';

export function registerCore(bot, shared) {
  const { llm, sessions, userState, kb, challenges, costTracker, gamification, workflows, boards } = shared;

  bot.command('start', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    userState.get(userId);
    await ctx.reply(
      `*Welcome to Telegram LLM Hub* \u26a1\n\n` +
      `Multi-model AI assistant with project boards, QA testing, and smart drafts.\n\n` +
      `*Quick Start:*\n` +
      `\u2022 Just type to chat with AI\n` +
      `\u2022 /new <project> \u2014 Create a project board\n` +
      `\u2022 Share a link \u2014 Goes to your draft board\n` +
      `\u2022 /settings \u2014 Configure API keys & models\n\n` +
      `Your default provider is *Claude* (Anthropic).`,
      { parse_mode: 'Markdown', ...kb.mainMenu() }
    );
  });

  bot.command('help', async (ctx) => {
    await safeSend(ctx,
      `*Commands:*\n\n` +
      `*\ud83d\udccb Boards & Tasks:*\n` +
      `/new <name> \u2014 Create project board\n` +
      `/boards \u2014 List boards\n` +
      `/board \u2014 Active board\n` +
      `/task <desc> \u2014 Add task to board\n` +
      `/done <id> \u2014 Mark task done\n\n` +
      `*\ud83d\udd27 Workflows:*\n` +
      `/workflow <desc> \u2014 Auto-generate\n` +
      `/wfnew <title> \u2014 Create empty\n` +
      `/wflist \u2014 List | /wfview \u2014 View\n` +
      `/wfrun \u2014 Execute | /wffix \u2014 Fix\n` +
      `/wfdelete <id> \u2014 Delete workflow\n` +
      `/templates \u2014 Browse templates\n` +
      `/usetemplate <id> \u2014 Use template\n\n` +
      `*\ud83d\udcac Chat & AI:*\n` +
      `/chat <title> \u2014 New session\n` +
      `/sessions \u2014 List sessions\n` +
      `/rename <title> \u2014 Rename session\n` +
      `/clear \u2014 Clear session messages\n` +
      `/export \u2014 Export session\n` +
      `/arena <prompt> \u2014 Battle providers\n\n` +
      `*\ud83e\udde0 Memory:*\n` +
      `/remember <k> = <v> \u2014 Save\n` +
      `/recall <query> \u2014 Search\n` +
      `/forget <id> \u2014 Delete memory\n\n` +
      `*\ud83e\udd16 Providers:*\n` +
      `/providers \u2014 Manage LLMs\n` +
      `/models \u2014 All models\n` +
      `/setkey <prov> <key> \u2014 API key\n` +
      `/setmodel <prov> <model> \u2014 Model\n` +
      `/test <prov> \u2014 Test connection\n\n` +
      `*\ud83d\udcca Stats & Gamification:*\n` +
      `/status \u2014 Quick overview\n` +
      `/stats \u2014 XP, level, badges\n` +
      `/leaderboard \u2014 Top users\n` +
      `/challenges \u2014 Daily quests\n` +
      `/costs \u2014 Usage costs\n\n` +
      `*\ud83e\udd1d Sharing:*\n` +
      `/share <wf id> \u2014 Share workflow\n` +
      `/unshare <wf id> \u2014 Unshare\n` +
      `/browse \u2014 Public workflows\n` +
      `/fork <token> \u2014 Fork shared\n\n` +
      `*\ud83d\udd10 Vault:*\n` +
      `/vault \u2014 View secrets\n` +
      `/vaultset <k> <v> \u2014 Store secret\n` +
      `/vaultdel <id> \u2014 Delete secret\n\n` +
      `*\u26a1 Shortcuts:*\n` +
      `/m \u2014 Main menu\n` +
      `/f <desc> \u2014 Quick feature\n` +
      `/b <desc> \u2014 Quick bugfix\n` +
      `/ping \u2014 Check bot is alive`
    );
  });

  bot.command('menu', (ctx) => ctx.reply('Main Menu:', kb.mainMenu()));
  bot.command('main', (ctx) => ctx.reply('Main Menu:', kb.mainMenu()));
  bot.command('m', (ctx) => ctx.reply('Main Menu:', kb.mainMenu()));

  bot.command('chat', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const title = ctx.message.text.replace('/chat', '').trim() || 'New Chat';
    const session = sessions.create(userId, title);
    userState.setMode(userId, 'chat');
    await ctx.reply(`\ud83d\udcac *New chat session:* ${session.title}\n\nJust type your message.`, { parse_mode: 'Markdown' });
  });

  bot.command('sessions', async (ctx) => {
    const list = sessions.listByUser(ctx.from.id);
    if (list.length === 0) return ctx.reply('No sessions yet. Start chatting or use /chat.');
    await ctx.reply('Your chat sessions:', kb.sessionList(list));
  });

  bot.command('settings', async (ctx) => {
    await ctx.reply('\u2699\ufe0f *Settings*', { parse_mode: 'Markdown', ...kb.settingsMenu() });
  });

  bot.command('ping', async (ctx) => {
    const start = Date.now();
    const msg = await ctx.reply('\ud83c\udfd3 Pong!');
    const latency = Date.now() - start;
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `\ud83c\udfd3 Pong! (${latency}ms)`);
    } catch {}
  });

  bot.command('id', async (ctx) => {
    await safeSend(ctx, `\ud83d\udc64 Your user ID: \`${ctx.from.id}\`\n\ud83d\udcac Chat ID: \`${ctx.chat.id}\``);
  });

  bot.command('dashboard', async (ctx) => {
    await safeSend(ctx, `\ud83c\udf10 Dashboard: http://localhost:${process.env.DASHBOARD_PORT || 9999}\n\nOpen in your browser to access the full UI.`);
  });

  bot.command('status', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const provs = llm.getEnabledProviders(userId);
    const activeProvs = provs.filter(p => p.api_key || p.is_local).length;
    const streak = challenges.getStreak(userId);
    const costSummary = costTracker.getSummary(userId, 7);
    const daily = challenges.getDailyChallenges(userId);
    const completed = daily.filter(c => c.completed).length;
    const stats = gamification.getStats(userId);
    const wfList = workflows.listByUser(userId);
    const boardList = boards.listByUser(userId);

    let msg = '\ud83d\udcca *Status Overview*\n\n';
    msg += `\ud83e\udd16 Providers: ${activeProvs}/${provs.length} active\n`;
    msg += `\u2b50 Level: ${stats.level || 1} | XP: ${stats.xp || 0}\n`;
    msg += `\ud83d\udd25 Streak: ${streak.streak} days\n`;
    msg += `\ud83c\udfaf Challenges: ${completed}/${daily.length} today\n`;
    msg += `\ud83d\udcb0 7-day cost: $${(costSummary.totals?.total_cost || 0).toFixed(4)}\n`;
    msg += `\ud83d\udce8 7-day requests: ${costSummary.totals?.request_count || 0}\n`;
    msg += `\ud83d\udccb Boards: ${boardList.length} | Workflows: ${wfList.length}\n`;
    await safeSend(ctx, msg);
  });

  // --- Core callback queries ---
  bot.action('main_menu', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('Main Menu:', kb.mainMenu());
  });

  bot.action('help', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      'Use /help for full command list.\n\n' +
      '\u2022 Type to chat with AI\n' +
      '\u2022 /new to create project boards\n' +
      '\u2022 Share links to draft board\n' +
      '\u2022 /providers to manage AI models'
    );
  });

  bot.action('settings', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('\u2699\ufe0f *Settings*', { parse_mode: 'Markdown', ...kb.settingsMenu() });
  });

  bot.action('new_chat', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const session = sessions.create(userId, 'New Chat');
    userState.setMode(userId, 'chat');
    await ctx.editMessageText(`\ud83d\udcac *New chat started*\n\nJust type your message.`, { parse_mode: 'Markdown' });
  });

  bot.action('list_sessions', async (ctx) => {
    await ctx.answerCbQuery();
    const list = sessions.listByUser(ctx.from.id);
    if (list.length === 0) return ctx.editMessageText('No sessions. Use /chat to start one.');
    await ctx.editMessageText('Your sessions:', kb.sessionList(list));
  });

  bot.action(/switch_session:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const sessionId = parseInt(ctx.match[1]);
    const userId = ctx.from.id;
    sessions.setActive(userId, sessionId);
    userState.setMode(userId, 'chat');
    const session = sessions.get(sessionId);
    await ctx.editMessageText(`\ud83d\udcac Switched to: *${session.title}*\n\nContinue chatting.`, { parse_mode: 'Markdown' });
  });
}
