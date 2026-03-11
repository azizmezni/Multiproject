import { safeSend } from '../bot-helpers.js';

export function registerAITools(bot, shared) {
  const { llm, sessions, qa } = shared;

  bot.command('ask', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const question = ctx.message.text.replace('/ask', '').trim();
    if (!question) return safeSend(ctx, '\u2753 Usage: /ask <question>\nQuick one-shot question, no session context.');
    try {
      const result = await llm.chat(userId, [{ role: 'user', content: question }]);
      let answer = (result.text || '').substring(0, 3800);
      answer += `\n\n_via ${result.provider} (${result.model})_`;
      await safeSend(ctx, answer);
    } catch (err) {
      await safeSend(ctx, `\u274c ${err.message}`);
    }
  });

  bot.command('explain', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const text = ctx.message.text.replace('/explain', '').trim();
    if (!text) return safeSend(ctx, '\ud83d\udca1 Usage: /explain <concept or code>\nGet a clear explanation.');
    try {
      const result = await llm.chat(userId, [
        { role: 'system', content: 'Explain the following clearly and concisely. Use examples if helpful. Keep it under 500 words.' },
        { role: 'user', content: text },
      ]);
      await safeSend(ctx, `\ud83d\udca1 *Explanation:*\n\n${(result.text || '').substring(0, 3500)}`);
    } catch (err) {
      await safeSend(ctx, `\u274c ${err.message}`);
    }
  });

  bot.command('code', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const text = ctx.message.text.replace('/code', '').trim();
    if (!text) return safeSend(ctx, '\ud83d\udcbb Usage: /code <description>\nGenerate code from a description.');
    try {
      const result = await llm.chat(userId, [
        { role: 'system', content: 'Generate clean, production-ready code based on the description. Include brief comments. Return only the code.' },
        { role: 'user', content: text },
      ]);
      await safeSend(ctx, `\ud83d\udcbb *Generated Code:*\n\n${(result.text || '').substring(0, 3800)}`);
    } catch (err) {
      await safeSend(ctx, `\u274c ${err.message}`);
    }
  });

  bot.command('review', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const replyMsg = ctx.message.reply_to_message;
    const codeText = replyMsg?.text || ctx.message.text.replace('/review', '').trim();
    if (!codeText) return safeSend(ctx, '\ud83d\udd0d Usage: /review <code>\nOr reply to a code message with /review');
    try {
      const result = await llm.chat(userId, [
        { role: 'system', content: 'Review this code. Point out bugs, security issues, performance problems, and suggest improvements. Be concise.' },
        { role: 'user', content: codeText },
      ]);
      await safeSend(ctx, `\ud83d\udd0d *Code Review:*\n\n${(result.text || '').substring(0, 3500)}`);
    } catch (err) {
      await safeSend(ctx, `\u274c ${err.message}`);
    }
  });

  bot.command('translate', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const text = ctx.message.text.replace('/translate', '').trim();
    if (!text) return safeSend(ctx, '\ud83c\udf10 Usage: /translate <text>\nTranslates to English. Add "to <lang>" at end for other languages.');
    let targetLang = 'English';
    let toTranslate = text;
    const toMatch = text.match(/(.+?)\s+to\s+(\w+)$/i);
    if (toMatch) { toTranslate = toMatch[1]; targetLang = toMatch[2]; }
    try {
      const result = await llm.chat(userId, [
        { role: 'system', content: `Translate the following text to ${targetLang}. Return only the translation.` },
        { role: 'user', content: toTranslate },
      ]);
      await safeSend(ctx, `\ud83c\udf10 *Translation (${targetLang}):*\n\n${(result.text || '').substring(0, 3500)}`);
    } catch (err) {
      await safeSend(ctx, `\u274c ${err.message}`);
    }
  });

  bot.command('summarize', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const session = sessions.getActive(userId);
    if (!session) return safeSend(ctx, '\u274c No active session.');
    const messages = sessions.getMessages(session.id);
    if (messages.length < 2) return safeSend(ctx, '\u274c Not enough messages to summarize.');
    await safeSend(ctx, '\ud83d\udcdd Summarizing...');
    const chatLog = messages.map(m => `${m.role}: ${m.content}`).join('\n').substring(0, 6000);
    try {
      const result = await llm.chat(userId, [
        { role: 'system', content: 'Summarize this conversation concisely. Highlight key decisions, questions, and outcomes.' },
        { role: 'user', content: chatLog },
      ]);
      await safeSend(ctx, `\ud83d\udcdd *Session Summary*\n\n${(result.text || '').substring(0, 3500)}`);
    } catch (err) {
      await safeSend(ctx, `\u274c ${err.message}`);
    }
  });

  // --- QA & CLI ---
  bot.command('qa', async (ctx) => {
    const taskId = parseInt(ctx.message.text.replace('/qa', '').trim());
    if (!taskId) return ctx.reply('Usage: /qa <task_id>');
    await ctx.reply('\ud83e\uddea Running QA tests...');
    const result = await qa.runTaskQA(ctx.from.id, taskId);
    const emoji = result.passed ? '\u2705' : '\u274c';
    await ctx.reply(`${emoji} QA Result:\n\`\`\`\n${JSON.stringify(result, null, 2)}\n\`\`\``, { parse_mode: 'Markdown' });
  });

  bot.command('run', async (ctx) => {
    const command = ctx.message.text.replace('/run', '').trim();
    if (!command) return ctx.reply('Usage: /run <command>\nExample: /run npm test');
    await ctx.reply(`\u25b6\ufe0f Running: \`${command}\``, { parse_mode: 'Markdown' });
    const result = await qa.runCommand(command);
    const emoji = result.ok ? '\u2705' : '\u274c';
    let output = result.stdout || result.stderr || 'No output';
    if (output.length > 3500) output = output.substring(0, 3500) + '\n...(truncated)';
    await ctx.reply(`${emoji} \`${command}\`\n\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
  });
}
