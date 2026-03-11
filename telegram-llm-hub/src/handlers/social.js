import { safeSend } from '../bot-helpers.js';

export function registerSocial(bot, shared) {
  const { memory, arena, challenges, costTracker, gamification, templates, vault, collaboration, sessions, llm } = shared;

  // --- Memory ---
  bot.command('remember', async (ctx) => {
    const userId = ctx.from.id;
    const text = ctx.message.text.replace('/remember', '').trim();
    const eqIndex = text.indexOf('=');
    if (eqIndex === -1) return safeSend(ctx, '\ud83d\udcdd Usage: /remember key = value\nExample: /remember my stack = Python + FastAPI');
    const key = text.substring(0, eqIndex).trim();
    const value = text.substring(eqIndex + 1).trim();
    if (!key || !value) return safeSend(ctx, '\u274c Both key and value are required');
    memory.set(userId, key, value);
    challenges.trackAction(userId, 'memory_added');
    gamification.addXP(userId, 'memory_added');
    await safeSend(ctx, `\ud83e\udde0 Remembered: *${key}*`);
  });

  bot.command('recall', async (ctx) => {
    const userId = ctx.from.id;
    const query = ctx.message.text.replace('/recall', '').trim();
    if (!query) {
      const all = memory.list(userId);
      if (!all.length) return safeSend(ctx, '\ud83e\udde0 No memories stored yet.\nUse /remember key = value to save.');
      const list = all.slice(0, 15).map(m => `\u2022 *${m.key}*: ${m.value}`).join('\n');
      return safeSend(ctx, `\ud83e\udde0 *Knowledge Base* (${all.length} items)\n\n${list}`);
    }
    const results = memory.search(userId, query);
    if (!results.length) return safeSend(ctx, `\ud83e\udde0 No memories matching "${query}"`);
    const list = results.map(m => `\u2022 *${m.key}*: ${m.value}`).join('\n');
    await safeSend(ctx, `\ud83e\udde0 Found ${results.length} match(es):\n\n${list}`);
  });

  bot.command('forget', async (ctx) => {
    const idStr = ctx.message.text.split(/\s+/)[1];
    if (!idStr) return safeSend(ctx, '\u274c Usage: /forget <memory_id>\nUse /recall to see your memories.');
    try {
      memory.delete(ctx.from.id, parseInt(idStr));
      await safeSend(ctx, '\ud83d\uddd1 Memory deleted.');
    } catch (err) {
      await safeSend(ctx, `\u274c ${err.message}`);
    }
  });

  // --- Arena ---
  bot.command('arena', async (ctx) => {
    const userId = ctx.from.id;
    const prompt = ctx.message.text.replace('/arena', '').trim();
    if (!prompt) return safeSend(ctx, '\u2694\ufe0f Usage: /arena <prompt>\nSends to all enabled providers simultaneously.');
    await safeSend(ctx, '\u2694\ufe0f Arena battle starting...');
    llm.initDefaults(userId);
    try {
      const result = await arena.battle(userId, prompt);
      let response = `\u2694\ufe0f *Arena Battle*\n_${prompt}_\n\n`;
      for (const [prov, r] of Object.entries(result.responses || {})) {
        const snippet = r.error ? `\u274c ${r.error}` : (r.reply || '').substring(0, 400);
        response += `*${prov}* (${r.latency || 0}ms):\n${snippet}\n\n`;
      }
      response += `Vote: /vote ${result.id} <provider>`;
      await safeSend(ctx, response);
    } catch (err) {
      await safeSend(ctx, `\u274c Arena error: ${err.message}`);
    }
  });

  bot.command('vote', async (ctx) => {
    const parts = ctx.message.text.replace('/vote', '').trim().split(/\s+/);
    if (parts.length < 2) return safeSend(ctx, '\ud83d\udc51 Usage: /vote <battle_id> <provider>');
    try {
      arena.vote(parseInt(parts[0]), parts[1]);
      await safeSend(ctx, `\ud83d\udc51 Voted for *${parts[1]}* in battle #${parts[0]}!`);
    } catch (err) {
      await safeSend(ctx, `\u274c ${err.message}`);
    }
  });

  // --- Gamification & Challenges ---
  bot.command('challenges', async (ctx) => {
    const userId = ctx.from.id;
    const daily = challenges.getDailyChallenges(userId);
    let msg = '\ud83c\udfaf *Daily Challenges*\n\n';
    for (const c of daily) {
      const status = c.completed ? '\u2705' : `${c.progress}/${c.target}`;
      msg += `${c.completed ? '\u2705' : '\u2b1c'} *${c.title}*\n  ${c.description} [${status}] +${c.xp_reward}XP\n`;
    }
    const streak = challenges.getStreak(userId);
    msg += `\n\ud83d\udd25 Streak: ${streak.streak} days`;
    await safeSend(ctx, msg);
  });

  bot.command('stats', async (ctx) => {
    const stats = gamification.getStats(ctx.from.id);
    let msg = '\ud83c\udfc6 *Your Stats*\n\n';
    msg += `\u2b50 Level: ${stats.level || 1}\n\u2728 XP: ${stats.xp || 0}\n\ud83d\udd25 Streak: ${stats.streak || 0} days\n\n`;
    if (stats.achievements?.length) {
      msg += '*Achievements:*\n';
      for (const a of stats.achievements.slice(0, 8)) msg += `\ud83c\udfc5 ${a.name || a.title}\n`;
    }
    await safeSend(ctx, msg);
  });

  bot.command('leaderboard', async (ctx) => {
    const lb = gamification.getLeaderboard();
    if (!lb?.length) return safeSend(ctx, '\ud83c\udfc6 No leaderboard data yet. Start chatting!');
    let msg = '\ud83c\udfc6 *Leaderboard \u2014 Top Users*\n\n';
    const medals = ['\ud83e\udd47', '\ud83e\udd48', '\ud83e\udd49'];
    for (let i = 0; i < lb.length; i++) {
      const u = lb[i];
      msg += `${medals[i] || `${i + 1}.`} Level ${u.level || 1} \u2014 ${u.xp || 0} XP (User ${u.user_id})\n`;
    }
    await safeSend(ctx, msg);
  });

  // --- Cost Tracking ---
  bot.command('costs', async (ctx) => {
    const summary = costTracker.getSummary(ctx.from.id, 30);
    const t = summary.totals;
    let msg = '\ud83d\udcb0 *Cost Summary (30 days)*\n\n';
    msg += `Total: $${(t?.total_cost || 0).toFixed(4)}\nRequests: ${t?.request_count || 0}\nTokens: ${((t?.total_input || 0) + (t?.total_output || 0)).toLocaleString()}\n\n`;
    if (summary.breakdown?.length) {
      msg += '*By Provider:*\n';
      for (const r of summary.breakdown.slice(0, 5)) msg += `\u2022 ${r.provider} (${r.model}): $${r.total_cost.toFixed(4)} \u2014 ${r.request_count} reqs\n`;
    }
    await safeSend(ctx, msg);
  });

  // --- Templates ---
  bot.command('templates', async (ctx) => {
    const list = templates.list().slice(0, 10);
    if (!list.length) return safeSend(ctx, '\ud83d\udce6 No templates yet. Create one from a workflow via the dashboard.');
    let msg = '\ud83d\udce6 *Workflow Templates*\n\n';
    for (const t of list) {
      msg += `*${t.title}* (ID: ${t.id})\n${t.description || 'No description'}\n\u2b50 ${t.rating_avg?.toFixed(1) || 'N/A'} | Used ${t.use_count || 0}x\n\n`;
    }
    msg += 'Use: /usetemplate <id>';
    await safeSend(ctx, msg);
  });

  bot.command('usetemplate', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    let idStr = ctx.message.text.replace(/^\/usetemplate[_ ]?/, '').trim();
    if (!idStr) return safeSend(ctx, '\u274c Usage: /usetemplate <id>\nBrowse templates with /templates');
    try {
      const result = templates.useTemplate(parseInt(idStr), userId);
      challenges.trackAction(userId, 'template_used');
      gamification.addXP(userId, 'template_used');
      await safeSend(ctx, `\u2705 Created workflow from template! ID: ${result.workflowId}\nUse /wfview to see it.`);
    } catch (err) {
      await safeSend(ctx, `\u274c ${err.message}`);
    }
  });

  // --- Vault ---
  bot.command('vault', async (ctx) => {
    const list = vault.list(ctx.from.id);
    if (!list.length) return safeSend(ctx, '\ud83d\udd10 Vault is empty.\nUse /vaultset <name> <value> to store secrets.');
    let msg = '\ud83d\udd10 *Secret Vault*\n\n';
    for (const s of list) msg += `\ud83d\udd11 ID ${s.id}: \`${s.key_name}\` \u2014 ${s.scope} ${s.description ? `(${s.description})` : ''}\n`;
    msg += '\nUse /vaultset to add, /vaultdel <id> to remove.';
    await safeSend(ctx, msg);
  });

  bot.command('vaultset', async (ctx) => {
    const parts = ctx.message.text.split(/\s+/).slice(1);
    if (parts.length < 2) return safeSend(ctx, '\u274c Usage: /vaultset <key_name> <value> [description]');
    const [keyName, value, ...descParts] = parts;
    try {
      vault.set(ctx.from.id, keyName, value, 'global', descParts.join(' '));
      await safeSend(ctx, `\u2705 Secret \`${keyName}\` stored securely.`);
      try { await ctx.deleteMessage(); } catch {}
    } catch (err) {
      await safeSend(ctx, `\u274c ${err.message}`);
    }
  });

  bot.command('vaultdel', async (ctx) => {
    const idStr = ctx.message.text.split(/\s+/)[1];
    if (!idStr) return safeSend(ctx, '\u274c Usage: /vaultdel <id>\nUse /vault to see IDs.');
    try {
      vault.delete(ctx.from.id, parseInt(idStr));
      await safeSend(ctx, '\u2705 Secret deleted.');
    } catch (err) {
      await safeSend(ctx, `\u274c ${err.message}`);
    }
  });

  // --- Collaboration / Sharing ---
  bot.command('share', async (ctx) => {
    const idStr = ctx.message.text.split(/\s+/)[1];
    if (!idStr) return safeSend(ctx, '\u274c Usage: /share <workflow_id>\nShares the workflow publicly.');
    try {
      const result = collaboration.share(parseInt(idStr), ctx.from.id, true);
      gamification.addXP(ctx.from.id, 'workflow_shared');
      await safeSend(ctx, `\ud83e\udd1d Workflow shared!\nToken: \`${result.share_token}\`\nOthers can fork it with: /fork ${result.share_token}`);
    } catch (err) {
      await safeSend(ctx, `\u274c ${err.message}`);
    }
  });

  bot.command('unshare', async (ctx) => {
    const idStr = ctx.message.text.split(/\s+/)[1];
    if (!idStr) return safeSend(ctx, '\u274c Usage: /unshare <workflow_id>');
    try {
      collaboration.unshare(parseInt(idStr), ctx.from.id);
      await safeSend(ctx, '\u2705 Workflow unshared.');
    } catch (err) {
      await safeSend(ctx, `\u274c ${err.message}`);
    }
  });

  bot.command('browse', async (ctx) => {
    const list = collaboration.listPublic(10);
    if (!list?.length) return safeSend(ctx, '\ud83d\udcc2 No public workflows yet. Be the first to /share!');
    let msg = '\ud83d\udcc2 *Public Workflows*\n\n';
    for (const s of list) msg += `*${s.title || 'Untitled'}*\n  Token: \`${s.share_token}\`\n  Fork: /fork ${s.share_token}\n\n`;
    await safeSend(ctx, msg);
  });

  bot.command('fork', async (ctx) => {
    const token = ctx.message.text.split(/\s+/)[1];
    if (!token) return safeSend(ctx, '\u274c Usage: /fork <share_token>\nBrowse with /browse');
    try {
      const result = collaboration.fork(token, ctx.from.id);
      await safeSend(ctx, `\u2705 Workflow forked! New ID: ${result.id}\nUse /wfview to see it.`);
    } catch (err) {
      await safeSend(ctx, `\u274c ${err.message}`);
    }
  });

  bot.command('myshares', async (ctx) => {
    const list = collaboration.listByUser(ctx.from.id);
    if (!list?.length) return safeSend(ctx, '\ud83d\udcc2 No shared workflows. Use /share <id> to share one.');
    let msg = '\ud83d\udcc2 *Your Shared Workflows*\n\n';
    for (const s of list) msg += `\u2022 *${s.title || 'Untitled'}* \u2014 Token: \`${s.share_token}\`\n`;
    await safeSend(ctx, msg);
  });

  // --- Session Management ---
  bot.command('rename', async (ctx) => {
    const title = ctx.message.text.replace('/rename', '').trim();
    if (!title) return safeSend(ctx, '\u274c Usage: /rename <new title>');
    const session = sessions.getActive(ctx.from.id);
    if (!session) return safeSend(ctx, '\u274c No active session. Use /chat first.');
    try {
      sessions.rename(session.id, title);
      await safeSend(ctx, `\u2705 Session renamed to: *${title}*`);
    } catch (err) {
      await safeSend(ctx, `\u274c ${err.message}`);
    }
  });

  bot.command('clear', async (ctx) => {
    const session = sessions.getActive(ctx.from.id);
    if (!session) return safeSend(ctx, '\u274c No active session.');
    sessions.clearMessages(session.id);
    await safeSend(ctx, '\ud83d\uddd1 Session messages cleared. Start fresh!');
  });

  bot.command('export', async (ctx) => {
    const session = sessions.getActive(ctx.from.id);
    if (!session) return safeSend(ctx, '\u274c No active session. Use /chat first.');
    const messages = sessions.getMessages(session.id);
    if (!messages.length) return safeSend(ctx, '\u274c Session is empty.');
    let text = `\ud83d\udcdd Session: ${session.title}\n${'═'.repeat(30)}\n\n`;
    for (const m of messages) {
      const role = m.role === 'user' ? '\ud83d\udc64 You' : '\ud83e\udd16 AI';
      text += `${role}:\n${m.content}\n\n`;
    }
    if (text.length > 4000) {
      const buf = Buffer.from(text, 'utf-8');
      await ctx.replyWithDocument({ source: buf, filename: `session-${session.id}.txt` });
    } else {
      await safeSend(ctx, text);
    }
  });
}
