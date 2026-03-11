import { safeSend, stripMd } from '../bot-helpers.js';

export function registerDevAssistant(bot, shared) {
  const { llm, boards, kb, userState, pendingDevRequests, helpers } = shared;

  bot.command('f', async (ctx) => {
    const desc = ctx.message.text.replace(/^\/f\s*/, '').trim();
    if (!desc) return ctx.reply('Usage: /f <feature description>');
    llm.initDefaults(ctx.from.id);
    await handleDevRequest(ctx, ctx.from.id, 'feature', desc);
  });

  bot.command('b', async (ctx) => {
    const desc = ctx.message.text.replace(/^\/b\s*/, '').trim();
    if (!desc) return ctx.reply('Usage: /b <bug description>');
    llm.initDefaults(ctx.from.id);
    await handleDevRequest(ctx, ctx.from.id, 'bugfix', desc);
  });

  bot.command('feature', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const desc = ctx.message.text.replace('/feature', '').trim();
    if (!desc) return ctx.reply(
      '\ud83d\ude80 *Add Feature*\n\nUsage: `/feature <description>`\n\nExamples:\n\u2022 `/feature add search bar to filter workflows`\n\u2022 `/feature dark/light theme toggle`\n\u2022 `/feature export boards as PDF`\n\nI will analyze the project, generate the code, and let you apply it.',
      { parse_mode: 'Markdown' }
    );
    await handleDevRequest(ctx, userId, 'feature', desc);
  });

  bot.command('bugfix', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const desc = ctx.message.text.replace('/bugfix', '').trim();
    if (!desc) return ctx.reply(
      '\ud83d\udc1b *Fix Bug*\n\nUsage: `/bugfix <description>`\n\nExamples:\n\u2022 `/bugfix export crashes on empty workflows`\n\u2022 `/bugfix markdown formatting breaks in long messages`\n\u2022 `/bugfix workflow run skips first node`\n\nI will analyze the project, diagnose the bug, and generate the fix.',
      { parse_mode: 'Markdown' }
    );
    await handleDevRequest(ctx, userId, 'bugfix', desc);
  });

  // --- Dev Assistant callbacks ---
  bot.action('dev_feature', async (ctx) => {
    await ctx.answerCbQuery();
    userState.setAwaiting(ctx.from.id, 'dev_feature');
    await ctx.editMessageText('\ud83d\ude80 *Add Feature*\n\nDescribe the feature you want to add:\n\n_Example: "add search bar to filter workflows" or "add notification sounds"_', { parse_mode: 'Markdown' });
  });

  bot.action('dev_bugfix', async (ctx) => {
    await ctx.answerCbQuery();
    userState.setAwaiting(ctx.from.id, 'dev_bugfix');
    await ctx.editMessageText('\ud83d\udc1b *Fix Bug*\n\nDescribe the bug you want to fix:\n\n_Example: "export crashes on empty workflows" or "markdown breaks in long messages"_', { parse_mode: 'Markdown' });
  });

  bot.action(/dev_apply:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const requestId = parseInt(ctx.match[1]);
    const request = pendingDevRequests.get(requestId);
    if (!request) return ctx.editMessageText('Request expired. Please run the command again.');
    await ctx.editMessageText('\u23f3 *Applying changes...*', { parse_mode: 'Markdown' });
    const fs = await import('fs/promises');
    const path = await import('path');
    const projectDir = process.cwd();
    let applied = 0, errors = 0;
    for (const change of request.changes) {
      try {
        const filePath = path.join(projectDir, change.file);
        if (change.action === 'create') {
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, change.code, 'utf-8');
          applied++;
        } else {
          const currentContent = await fs.readFile(filePath, 'utf-8');
          const applyResult = await llm.chat(request.userId, [
            { role: 'system', content: 'You are a code editor. Apply the described change to the file. Return ONLY the complete modified file content, no markdown fences, no explanations. Just the raw file content.' },
            { role: 'user', content: `File: ${change.file}\nChange to make: ${change.description}\n\nCode to add/modify:\n\`\`\`\n${change.code}\n\`\`\`\n\nCurrent file content:\n\`\`\`\n${currentContent}\n\`\`\`` },
          ]);
          let newContent = applyResult.text;
          newContent = newContent.replace(/^```(?:javascript|js|css|html)?\n?/g, '').replace(/\n?```$/g, '');
          await fs.writeFile(filePath, newContent, 'utf-8');
          applied++;
        }
      } catch (err) {
        errors++;
        await ctx.reply(`\u26a0\ufe0f Error applying ${change.file}: ${err.message}`);
      }
    }
    pendingDevRequests.delete(requestId);
    const summary = errors === 0
      ? `\u2705 *All ${applied} file(s) updated!*\n\nRestart the server to see changes.`
      : `\u26a0\ufe0f Applied ${applied} change(s), ${errors} error(s).`;
    await ctx.reply(summary, { parse_mode: 'Markdown', ...kb.mainMenu() });
  });

  bot.action(/dev_refine:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const requestId = parseInt(ctx.match[1]);
    const request = pendingDevRequests.get(requestId);
    if (!request) return ctx.editMessageText('Request expired.');
    userState.setAwaiting(ctx.from.id, `dev_refine_msg:${requestId}`);
    await ctx.editMessageText('\ud83d\udcac *Refine the plan*\n\nTell me what to change about the plan.\n\n_Send your refinement:_', { parse_mode: 'Markdown' });
  });

  bot.action(/dev_board:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const requestId = parseInt(ctx.match[1]);
    const request = pendingDevRequests.get(requestId);
    if (!request) return ctx.editMessageText('Request expired.');
    const title = `${request.type === 'feature' ? '\ud83d\ude80' : '\ud83d\udc1b'} ${request.description.substring(0, 60)}`;
    const board = boards.create(ctx.from.id, title);
    const tasks = request.changes.map(c => ({
      title: `${c.action === 'create' ? 'Create' : 'Modify'} ${c.file}`,
      description: c.description + (c.code ? `\n\nCode:\n${c.code.substring(0, 500)}` : ''),
    }));
    boards.addTasksFromPlan(board.id, tasks);
    userState.setActiveBoard(ctx.from.id, board.id);
    pendingDevRequests.delete(requestId);
    const boardTasks = boards.getTasks(board.id);
    await ctx.reply(`\ud83d\udccb *Board created: ${title}*\n${boardTasks.length} tasks`, { parse_mode: 'Markdown', ...kb.boardView(board.id, boardTasks, 'planning') });
  });

  // --- handleDevRequest: scan project + LLM code generation ---
  async function handleDevRequest(ctx, userId, type, description) {
    const fs = await import('fs/promises');
    const path = await import('path');
    const projectDir = process.cwd();
    const emoji = type === 'feature' ? '\ud83d\ude80' : '\ud83d\udc1b';
    const label = type === 'feature' ? 'Feature' : 'Bug Fix';
    await ctx.reply(`${emoji} *${label}*\n_${description.substring(0, 200)}_\n\nScanning project files...`, { parse_mode: 'Markdown' });

    const srcDir = path.join(projectDir, 'src');
    let sourceFiles = [];
    try {
      const readDir = async (dir, prefix = '') => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory() && entry.name !== 'node_modules') await readDir(path.join(dir, entry.name), rel);
          else if (entry.isFile() && /\.(js|css|html)$/.test(entry.name)) sourceFiles.push(rel);
        }
      };
      await readDir(srcDir);
    } catch {}

    const fileSummaries = [];
    for (const f of sourceFiles) {
      try {
        const content = await fs.readFile(path.join(srcDir, f), 'utf-8');
        const lines = content.split('\n');
        const exports = lines.filter(l => /^export |module\.exports/.test(l)).join('\n');
        const functions = lines.filter(l => /^\s*(async\s+)?function\s+|^\s*\w+\s*\(|bot\.(command|action)|app\.(get|post|put|delete)/.test(l)).slice(0, 20).join('\n');
        fileSummaries.push({ file: `src/${f}`, lines: lines.length, exports: exports.substring(0, 300), functions: functions.substring(0, 500), preview: lines.slice(0, 15).join('\n') });
      } catch {}
    }

    await ctx.reply('\ud83e\udd16 Analyzing and generating code...');
    const projectOverview = fileSummaries.map(f => `=== ${f.file} (${f.lines} lines) ===\nExports: ${f.exports || 'none'}\nKey functions:\n${f.functions || 'none'}\nPreview:\n${f.preview}\n`).join('\n');

    try {
      const result = await llm.chat(userId, [
        { role: 'system', content: `You are a senior full-stack developer. The user wants to ${type === 'feature' ? 'add a feature' : 'fix a bug'} in their Node.js project.\n\nProject structure and file summaries:\n${projectOverview}\n\nAnalyze the request and generate specific code changes. Return a JSON object:\n{\n  "analysis": "Brief analysis of what needs to be done (2-3 sentences)",\n  "changes": [{"file": "src/filename.js","action": "modify" or "create","description": "What this change does","code": "The actual code"}],\n  "summary": "One-line summary of all changes"\n}\n\nIMPORTANT:\n- Be specific about WHERE in the file the code goes\n- For modifications, show complete functions/blocks\n- Keep code practical and matching the existing codebase style\n- Return ONLY the JSON object, no markdown fences` },
        { role: 'user', content: `${type === 'feature' ? 'Add this feature' : 'Fix this bug'}: ${description}` },
      ]);

      let plan;
      try {
        plan = JSON.parse(result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
      } catch {
        await safeSend(ctx, `${emoji} *${label} Analysis*\n\n${result.text.substring(0, 3500)}\n\n_via ${result.provider}_`);
        return;
      }

      const requestId = Date.now();
      pendingDevRequests.set(requestId, { type, description, changes: plan.changes || [], userId });
      setTimeout(() => pendingDevRequests.delete(requestId), 30 * 60 * 1000);

      let planText = `${emoji} *${label} Plan*\n\n${plan.analysis || 'No analysis'}\n\n*Changes (${(plan.changes || []).length} files):*\n`;
      for (const c of (plan.changes || [])) {
        const actionEmoji = c.action === 'create' ? '\ud83c\udd95' : '\u270f\ufe0f';
        planText += `\n${actionEmoji} \`${c.file}\`\n${c.description}\n`;
        if (c.code) {
          const preview = c.code.substring(0, 300);
          planText += `\`\`\`\n${preview}${c.code.length > 300 ? '\n...' : ''}\n\`\`\`\n`;
        }
      }
      if (plan.summary) planText += `\n_${plan.summary}_\n`;
      planText += `\n_via ${result.provider}_`;

      const buttons = [
        [{ text: '\u2705 Apply All Changes', callback_data: `dev_apply:${requestId}` }],
        [{ text: '\ud83d\udcac Refine Plan', callback_data: `dev_refine:${requestId}` }],
        [{ text: '\ud83d\udccb Create as Board', callback_data: `dev_board:${requestId}` }],
        [{ text: '\u274c Cancel', callback_data: 'main_menu' }],
      ];

      if (planText.length <= 3800) {
        await safeSend(ctx, planText, { reply_markup: { inline_keyboard: buttons } });
      } else {
        const chunks = [];
        let remaining = planText;
        while (remaining.length > 0) {
          let splitAt = 3800;
          const nlPos = remaining.lastIndexOf('\n', 3800);
          if (nlPos > 1900) splitAt = nlPos + 1;
          chunks.push(remaining.substring(0, splitAt));
          remaining = remaining.substring(splitAt);
        }
        for (const chunk of chunks) await safeSend(ctx, chunk);
        await ctx.reply('Choose an action:', { reply_markup: { inline_keyboard: buttons } });
      }
    } catch (err) {
      await ctx.reply(`\u274c Error: ${err.message}`);
    }
  }

  // Expose for use by messages handler
  shared.handleDevRequest = handleDevRequest;
}
