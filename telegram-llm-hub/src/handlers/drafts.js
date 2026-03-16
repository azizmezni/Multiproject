import { Markup } from 'telegraf';
import { safeSend, stripMd } from '../bot-helpers.js';
import { projectManager } from '../project-manager.js';

export function registerDrafts(bot, shared) {
  const { llm, drafts, boards, kb, userState, qa, helpers } = shared;
  const { detectLinkType } = shared.draftUtils;

  bot.command('drafts', async (ctx) => {
    await helpers.showDrafts(ctx, ctx.from.id);
  });

  // --- Draft callback queries ---
  bot.action('list_drafts', async (ctx) => {
    await ctx.answerCbQuery();
    await helpers.showDraftsEdit(ctx, ctx.from.id);
  });

  bot.action(/draft_view:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;
    let text = `\ud83d\udce5 *${draft.title || 'Untitled Draft'}*\n\n`;
    if (draft.url) text += `\ud83d\udd17 ${draft.url}\n\n`;
    if (draft.description) text += `${draft.description.substring(0, 500)}\n\n`;
    text += `Status: ${draft.status} | Added: ${draft.created_at}`;
    const linkType = draft.url ? detectLinkType(draft.url) : 'website';
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...kb.draftActions(draft.id, linkType) });
  });

  bot.action(/draft_clone:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;
    const title = draft.title || 'Cloned Project';
    await ctx.editMessageText(`\ud83d\udccb Creating board from draft: *${title}*...`, { parse_mode: 'Markdown' });
    try {
      const result = await llm.chat(ctx.from.id, [
        { role: 'system', content: 'Create a project plan based on this reference. Return a JSON array of tasks:\n[{"title":"...", "description":"...", "requires_input": false, "input_question": null, "tools_needed": []}]\nOnly return JSON, no markdown.' },
        { role: 'user', content: `Clone and plan this idea:\nURL: ${draft.url || 'N/A'}\nTitle: ${draft.title}\nDescription: ${draft.description || draft.content || 'No description'}` }
      ]);
      let taskList;
      try { taskList = JSON.parse(result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim()); }
      catch { taskList = [{ title: 'Review cloned project', description: result.text }]; }
      const board = boards.create(ctx.from.id, title);
      boards.addTasksFromPlan(board.id, taskList);
      drafts.updateStatus(draft.id, 'processed');
      userState.setActiveBoard(ctx.from.id, board.id);
      const tasks = boards.getTasks(board.id);
      await ctx.reply(`\u2705 Board created with ${tasks.length} tasks!`, kb.boardView(board.id, tasks, 'planning'));
    } catch (err) {
      await ctx.reply(`\u274c Error: ${err.message}`);
    }
  });

  bot.action(/draft_expand:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;
    await ctx.editMessageText('\ud83d\udca1 Analyzing and generating plans...');
    const pageContent = (draft.content || '').substring(0, 2000);
    try {
      const result = await llm.chat(ctx.from.id, [
        { role: 'system', content: 'You are an expert product strategist and software architect. Analyze the given link/resource and generate 3-5 actionable project plans.\n\nReturn ONLY a valid JSON array. Each item:\n{"title":"Plan Title","description":"What to build (2-3 sentences)","features":["feature1","feature2","feature3"],"techStack":["tech1","tech2"],"skills":["api/skill1","api/skill2"],"difficulty":"Easy|Medium|Hard"}\n\nReturn ONLY the JSON array. No markdown, no extra text, no code fences.' },
        { role: 'user', content: `Analyze this resource and generate project plans:\n\nURL: ${draft.url || 'N/A'}\nTitle: ${draft.title}\nDescription: ${draft.description || 'No description'}\n${pageContent ? `\nPage Content:\n${pageContent}` : ''}` }
      ]);

      let plans = [];
      try {
        const cleaned = result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
        if (jsonMatch) plans = JSON.parse(jsonMatch[0]);
      } catch {
        plans = [{ title: draft.title || 'Plan', description: result.text.substring(0, 500), features: [], techStack: [], skills: [], difficulty: 'Medium' }];
      }

      drafts.updateContent(draft.id, draft.title, JSON.stringify(plans), draft.content || pageContent);
      const header = `Plans for: ${stripMd(draft.title || 'Draft')}\n\n`;
      let plansText = '';
      for (let i = 0; i < plans.length; i++) {
        const p = plans[i];
        plansText += `${i + 1}. ${stripMd(p.title || 'Untitled')}\n`;
        plansText += `   ${stripMd(p.description || 'No description')}\n`;
        if (p.features?.length) plansText += `   Features: ${p.features.map(f => stripMd(f)).join(', ')}\n`;
        if (p.techStack?.length) plansText += `   Tech: ${p.techStack.map(t => stripMd(t)).join(', ')}\n`;
        if (p.skills?.length) plansText += `   Skills/APIs: ${p.skills.map(s => stripMd(s)).join(', ')}\n`;
        plansText += `   Difficulty: ${p.difficulty || 'Medium'}\n\n`;
      }

      const fullMsg = header + plansText + 'Select a plan below to build it:';
      const planButtons = plans.map((p, i) => [Markup.button.callback(`${i + 1}. ${(p.title || 'Plan').substring(0, 40)} (${p.difficulty || '?'})`, `draft_select_plan:${draft.id}:${i}`)]);
      planButtons.push([Markup.button.callback('\ud83d\udccb Clone All as Board', `draft_clone:${draft.id}`)]);
      planButtons.push([Markup.button.callback('\ud83d\udca1 Re-Expand', `draft_expand:${draft.id}`), Markup.button.callback('\u25c0\ufe0f Back', 'list_drafts')]);

      if (fullMsg.length <= 3800) {
        await ctx.reply(fullMsg, Markup.inlineKeyboard(planButtons));
      } else {
        const chunks = [];
        let remaining = plansText;
        while (remaining.length > 0) {
          let splitAt = 3800;
          const nlPos = remaining.lastIndexOf('\n', 3800);
          if (nlPos > 1900) splitAt = nlPos + 1;
          chunks.push(remaining.substring(0, splitAt));
          remaining = remaining.substring(splitAt);
        }
        for (const chunk of chunks) await ctx.reply(chunk);
        await ctx.reply('Select a plan to build:', Markup.inlineKeyboard(planButtons));
      }
    } catch (err) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  bot.action(/draft_select_plan:(\d+):(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draftId = parseInt(ctx.match[1]);
    const planIndex = parseInt(ctx.match[2]);
    const draft = drafts.get(draftId);
    if (!draft) return;
    let plans = [];
    try { plans = JSON.parse(draft.description || '[]'); } catch { try { plans = JSON.parse(draft.content || '[]'); } catch {} }
    const plan = plans[planIndex];
    if (!plan) return ctx.reply('Plan not found. Try expanding the idea again.');

    await ctx.editMessageText(`Building: ${stripMd(plan.title || 'Plan')}...\n\nGenerating tasks from this plan...`);
    try {
      const planContext = `Title: ${plan.title}\nDescription: ${plan.description}\nFeatures: ${(plan.features || []).join(', ')}\nTech: ${(plan.techStack || []).join(', ')}\nSkills/APIs: ${(plan.skills || []).join(', ')}`;
      const result = await llm.chat(ctx.from.id, [
        { role: 'system', content: 'You are a project planner. Create a detailed task breakdown for the given plan. Return a JSON array of tasks: [{"title":"...","description":"...","requires_input":false,"input_question":null,"tools_needed":[]}]. Only return JSON, no markdown.' },
        { role: 'user', content: `Create a project board with tasks for this plan:\n\n${planContext}\n\nOriginal source: ${draft.url || 'N/A'}` },
      ]);
      let taskList;
      try { taskList = JSON.parse(result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim()); }
      catch { taskList = [{ title: 'Review and plan', description: result.text.substring(0, 500) }]; }
      const board = boards.create(ctx.from.id, plan.title || 'Project');
      boards.addTasksFromPlan(board.id, taskList);
      drafts.updateStatus(draftId, 'processed');
      userState.setActiveBoard(ctx.from.id, board.id);
      const tasks = boards.getTasks(board.id);
      await ctx.reply(`Board created: ${stripMd(plan.title)}\n${tasks.length} tasks generated!`, kb.boardView(board.id, tasks, 'planning'));
    } catch (err) {
      await ctx.reply(`Error creating board: ${err.message}`);
    }
  });

  // --- Link → Project: create a gen_project from a shared link ---
  bot.action(/draft_to_project:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;
    const userId = ctx.from.id;
    llm.initDefaults(userId);

    await ctx.editMessageText(`🚀 Creating project from: *${stripMd(draft.title || 'Link')}*...\n\n_Analyzing content and extracting keypoints..._`, { parse_mode: 'Markdown' });

    try {
      const pageContent = (draft.content || '').substring(0, 3000);
      const result = await llm.chat(userId, [
        {
          role: 'system',
          content: `You are a project architect. The user shared a link. Analyze its content and create a project based on it.

Return a JSON object (no markdown fences):
{
  "title": "Short project name inspired by the link content",
  "description": "2-3 sentence description of the project to build",
  "tech_stack": "nodejs" or "python",
  "keypoints": ["feature 1", "feature 2", ...],
  "run_command": "node index.js" or "py main.py",
  "install_command": "npm install" or "py -m pip install -r requirements.txt"
}

Rules:
- 5-10 keypoints that turn this link's content into an actionable project
- If it's a tutorial: turn steps into features to implement
- If it's an API/docs: build a project that integrates with it
- If it's a repo: build something similar or complementary
- If it's an article: extract the core idea and make it buildable
- Only return the JSON, nothing else`
        },
        { role: 'user', content: `Create a project from this link:\n\nURL: ${draft.url || 'N/A'}\nTitle: ${draft.title}\nDescription: ${draft.description || 'No description'}\n\nPage content:\n${pageContent}` }
      ]);

      let parsed;
      try {
        parsed = JSON.parse(result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
      } catch {
        parsed = {
          title: draft.title || 'Link Project',
          description: `Project inspired by ${draft.url || 'shared link'}`,
          tech_stack: 'nodejs', keypoints: [draft.title || 'Implement project'],
          run_command: 'node index.js', install_command: 'npm install'
        };
      }

      const project = projectManager.create(
        userId, parsed.title, parsed.description,
        parsed.tech_stack, parsed.keypoints,
        parsed.run_command, parsed.install_command
      );

      // Mark draft as processed
      drafts.updateStatus(draft.id, 'processed');

      let text = `🚀 *Project Created: ${stripMd(project.title)}*\n\n`;
      text += `📝 ${stripMd(project.description)}\n\n`;
      text += `⚙️ Tech: \`${project.tech_stack}\`\n`;
      text += `🔗 Source: ${draft.url || 'N/A'}\n\n`;
      text += `*Keypoints:*\n`;
      project.keypoints.forEach((k, i) => { text += `${i + 1}. ${stripMd(k)}\n`; });
      text += `\n_via ${result.provider}_`;

      await safeSend(ctx, text, kb.projectView(project.id, project));
    } catch (err) {
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  });

  bot.action(/draft_plan:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    await ctx.editMessageText(`\ud83d\udcdd Planning project from: *${stripMd(draft.title || 'Draft')}*...`, { parse_mode: 'Markdown' });
    try {
      const result = await llm.chat(userId, [
        { role: 'system', content: 'You are a project planner. Return a JSON array of tasks: [{"title":"...","description":"...","requires_input":false,"input_question":null,"tools_needed":[]}]. Only JSON.' },
        { role: 'user', content: `Create a project plan for: ${draft.title}\n\nContext: ${(draft.description || draft.content || '').substring(0, 1500)}` },
      ]);
      let taskList;
      try { taskList = JSON.parse(result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim()); }
      catch { taskList = [{ title: 'Review requirements', description: result.text }]; }
      const board = boards.create(userId, draft.title || 'Draft Project');
      boards.addTasksFromPlan(board.id, taskList);
      drafts.updateStatus(draft.id, 'processed');
      userState.setActiveBoard(userId, board.id);
      const tasks = boards.getTasks(board.id);
      await ctx.reply(`\u2705 Board created: ${stripMd(draft.title)}\n${tasks.length} tasks generated!`, kb.boardView(board.id, tasks, 'planning'));
    } catch (err) {
      await ctx.reply(`\u274c Error creating plan: ${err.message}`);
    }
  });

  bot.action(/draft_cli:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    userState.setAwaiting(ctx.from.id, `draft_cli:${ctx.match[1]}`);
    await ctx.editMessageText('\ud83d\udcbb Send the CLI command to run:');
  });

  bot.action(/draft_delete:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery('Deleted');
    drafts.delete(parseInt(ctx.match[1]));
    await helpers.showDraftsEdit(ctx, ctx.from.id);
  });

  // --- Smart Link Actions ---
  bot.action(/smart_clone:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;
    let cloneUrl = draft.url;
    if (cloneUrl.includes('github.com') && !cloneUrl.endsWith('.git')) cloneUrl = cloneUrl.replace(/\/$/, '') + '.git';
    const repoName = cloneUrl.match(/\/([^/]+?)(?:\.git)?$/)?.[1] || 'repo';
    await ctx.editMessageText(`\ud83d\udce5 *Cloning:* \`${repoName}\`...`, { parse_mode: 'Markdown' });
    try {
      const safeUrl = cloneUrl.replace(/[;&|`$"]/g, '');
      const cloneResult = await qa.runCommand(`git clone "${safeUrl}"`, process.cwd(), 60000);
      if (!cloneResult.ok) return safeSend(ctx, `\u274c Clone failed:\n\`${cloneResult.stderr.substring(0, 500)}\``);
      await ctx.reply(`\u2705 Cloned to \`${repoName}/\``, { parse_mode: 'Markdown' });
      const fs = await import('fs/promises');
      const path = await import('path');
      const repoDir = path.join(process.cwd(), repoName);
      const files = await fs.readdir(repoDir).catch(() => []);
      let projectType = 'unknown', installCmd = null;
      if (files.includes('package.json')) { projectType = 'node'; installCmd = `cd "${repoDir}" && npm install`; }
      else if (files.includes('requirements.txt')) { projectType = 'python'; installCmd = `cd "${repoDir}" && pip install -r requirements.txt`; }
      else if (files.includes('Cargo.toml')) { projectType = 'rust'; installCmd = `cd "${repoDir}" && cargo build`; }
      else if (files.includes('go.mod')) { projectType = 'go'; installCmd = `cd "${repoDir}" && go mod download`; }

      let readmeContent = '';
      for (const f of ['README.md', 'readme.md', 'README.txt', 'README']) {
        try { readmeContent = await fs.readFile(path.join(repoDir, f), 'utf-8'); break; } catch {}
      }
      if (installCmd) {
        await ctx.reply(`\ud83d\udce6 Detected *${projectType}* project. Installing dependencies...`, { parse_mode: 'Markdown' });
        const installResult = await qa.runCommand(installCmd, repoDir, 120000);
        const output = (installResult.stdout || installResult.stderr || 'Done').substring(0, 500);
        await ctx.reply(`${installResult.ok ? '\u2705' : '\u26a0\ufe0f'} Install:\n\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
      }
      const userId = ctx.from.id;
      llm.initDefaults(userId);
      const analysis = await llm.chat(userId, [
        { role: 'system', content: 'You are a software analyst. Analyze the cloned repo and give a brief summary: what it does, how to run it, key files. Keep it short and actionable (under 500 chars). No markdown.' },
        { role: 'user', content: `Repo: ${repoName}\nProject type: ${projectType}\nFiles: ${files.slice(0, 30).join(', ')}\nREADME preview:\n${readmeContent.substring(0, 1500)}` },
      ]);
      await safeSend(ctx, `\ud83c\udfc1 *${repoName}* cloned and ready!\n\nType: ${projectType}\n${analysis.text.substring(0, 800)}\n\n_via ${analysis.provider}_`);
      drafts.updateStatus(draft.id, 'processed');
    } catch (err) {
      await ctx.reply(`\u274c Error: ${err.message}`);
    }
  });

  bot.action(/smart_clone_run:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;
    let cloneUrl = draft.url;
    if (cloneUrl.includes('github.com') && !cloneUrl.endsWith('.git')) cloneUrl = cloneUrl.replace(/\/$/, '') + '.git';
    const repoName = cloneUrl.match(/\/([^/]+?)(?:\.git)?$/)?.[1] || 'repo';
    await ctx.editMessageText(`\u26a1 *Clone & Run:* \`${repoName}\`\n\nCloning...`, { parse_mode: 'Markdown' });
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      const repoDir = path.join(process.cwd(), repoName);
      const safeUrl = cloneUrl.replace(/[;&|`$"]/g, '');
      const cloneResult = await qa.runCommand(`git clone "${safeUrl}"`, process.cwd(), 60000);
      if (!cloneResult.ok && !cloneResult.stderr?.includes('already exists')) return safeSend(ctx, `\u274c Clone failed:\n\`${cloneResult.stderr?.substring(0, 500)}\``);
      await ctx.reply('\u2705 Cloned. Installing dependencies...');
      const files = await fs.readdir(repoDir).catch(() => []);
      let startCmd = null;
      if (files.includes('package.json')) {
        await qa.runCommand('npm install', repoDir, 120000);
        try {
          const pkg = JSON.parse(await fs.readFile(path.join(repoDir, 'package.json'), 'utf-8'));
          if (pkg.scripts?.dev) startCmd = 'npm run dev';
          else if (pkg.scripts?.start) startCmd = 'npm start';
          else if (pkg.main) startCmd = `node ${pkg.main}`;
        } catch {}
      } else if (files.includes('requirements.txt')) {
        await qa.runCommand('pip install -r requirements.txt', repoDir, 120000);
        if (files.includes('app.py')) startCmd = 'python app.py';
        else if (files.includes('main.py')) startCmd = 'python main.py';
      } else if (files.includes('go.mod')) {
        await qa.runCommand('go mod download', repoDir, 60000);
        startCmd = 'go run .';
      } else if (files.includes('Cargo.toml')) {
        startCmd = 'cargo run';
      }
      await ctx.reply('\u2705 Dependencies installed.');
      if (startCmd) {
        await ctx.reply(`\ud83d\ude80 Starting with \`${startCmd}\`...`, { parse_mode: 'Markdown' });
        const { spawn } = await import('child_process');
        const child = spawn(startCmd.split(' ')[0], startCmd.split(' ').slice(1), { cwd: repoDir, shell: true, stdio: 'ignore', detached: true });
        child.unref();
        await safeSend(ctx, `\u26a1 *${repoName}* is running!\n\nStart command: \`${startCmd}\`\nDirectory: \`${repoDir}\`\nPID: ${child.pid}`);
      } else {
        await safeSend(ctx, `\u2705 *${repoName}* cloned and installed!\n\nCould not auto-detect start command.\nDirectory: \`${repoDir}\``);
      }
      drafts.updateStatus(draft.id, 'processed');
    } catch (err) {
      await ctx.reply(`\u274c Error: ${err.message}`);
    }
  });

  bot.action(/smart_analyze:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;
    await ctx.editMessageText('\ud83e\udde0 Analyzing link...', { parse_mode: 'Markdown' });
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const linkType = detectLinkType(draft.url);
    const pageContent = (draft.content || '').substring(0, 3000);
    try {
      const result = await llm.chat(userId, [
        { role: 'system', content: `You are a smart assistant analyzing a shared link. The user shared this ${linkType} link because they want to USE it, LEARN from it, or BUILD something with it.\n\nAnalyze the link and provide:\n1. **What it is** \u2014 brief summary (2 sentences)\n2. **Why they probably shared it** \u2014 what they want to do with it\n3. **Actionable steps** \u2014 3-5 concrete things they can do right now\n4. **Dependencies/requirements** \u2014 what they need to get started\n5. **Quick start commands** \u2014 actual CLI commands to get started (if applicable)\n\nBe practical and specific. Use short sentences.` },
        { role: 'user', content: `URL: ${draft.url}\nTitle: ${draft.title}\nDescription: ${draft.description || 'N/A'}\n\nPage content:\n${pageContent}` },
      ]);
      await safeSend(ctx, `\ud83e\udde0 *Smart Analysis*\n\n${result.text.substring(0, 3500)}\n\n_via ${result.provider}_`, kb.draftActions(draft.id, linkType));
    } catch (err) {
      await ctx.reply(`\u274c Error: ${err.message}`);
    }
  });

  bot.action(/smart_summarize:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;
    const linkType = detectLinkType(draft.url);
    const isVideo = linkType.startsWith('youtube');
    await ctx.editMessageText(isVideo ? '\ud83d\udcfa Analyzing video...' : '\ud83d\udcd6 Summarizing content...');
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const pageContent = (draft.content || '').substring(0, 3000);
    try {
      const prompt = isVideo
        ? `This is a YouTube video page. Extract and summarize:\n1. **Video Title & Channel**\n2. **Main Topic** (1-2 sentences)\n3. **Key Points** (5-7 bullet points)\n4. **Technologies/Tools mentioned** (list them)\n5. **Dependencies to install** (if it's a tutorial)\n6. **Step-by-step plan** (if tutorial)\n\nURL: ${draft.url}\nTitle: ${draft.title}\nPage content: ${pageContent}`
        : `Summarize this article/documentation:\n1. **Title & Author**\n2. **Summary** (2-3 sentences)\n3. **Key Takeaways** (5-7 bullet points)\n4. **Code snippets / commands** (if any)\n5. **Dependencies** (tools/packages mentioned)\n6. **Action items** (what to do next)\n\nURL: ${draft.url}\nTitle: ${draft.title}\nPage content: ${pageContent}`;
      const result = await llm.chat(userId, [
        { role: 'system', content: 'You are an expert content analyst. Extract actionable information. Be concise and practical.' },
        { role: 'user', content: prompt },
      ]);
      drafts.updateContent(draft.id, draft.title, result.text.substring(0, 2000), draft.content);
      await safeSend(ctx, `${isVideo ? '\ud83d\udcfa' : '\ud83d\udcd6'} *Summary*\n\n${result.text.substring(0, 3500)}\n\n_via ${result.provider}_`, kb.draftActions(draft.id, linkType));
    } catch (err) {
      await ctx.reply(`\u274c Error: ${err.message}`);
    }
  });

  bot.action(/smart_tutorial:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;
    await ctx.editMessageText('\ud83d\udccb Extracting tutorial steps...');
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const pageContent = (draft.content || '').substring(0, 3000);
    try {
      const result = await llm.chat(userId, [
        { role: 'system', content: 'You are a tutorial parser. Extract a step-by-step plan from this content.\n\nReturn a JSON object:\n{"title": "Tutorial/Project title","prerequisites": ["prerequisite1"],"install_commands": ["npm install x"],"steps": [{"title": "Step title", "description": "What to do", "commands": ["cmd1"], "code": "code snippet if any"}],"test_commands": ["npm test"]}\n\nReturn ONLY valid JSON.' },
        { role: 'user', content: `Extract tutorial steps from:\nURL: ${draft.url}\nTitle: ${draft.title}\n\nContent:\n${pageContent}` },
      ]);
      let tutorial;
      try { tutorial = JSON.parse(result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim()); }
      catch { return safeSend(ctx, `\ud83d\udccb Could not parse tutorial steps. Here's the raw analysis:\n\n${result.text.substring(0, 2000)}`); }
      if (tutorial.install_commands?.length > 0) {
        drafts.updateContent(draft.id, tutorial.title || draft.title, JSON.stringify(tutorial), draft.content);
        let previewText = `\ud83d\udccb *${stripMd(tutorial.title || 'Tutorial')}*\n\n`;
        if (tutorial.prerequisites?.length) previewText += `*Prerequisites:*\n${tutorial.prerequisites.map(p => `\u2022 ${stripMd(p)}`).join('\n')}\n\n`;
        previewText += `*Steps (${tutorial.steps?.length || 0}):*\n`;
        for (let i = 0; i < (tutorial.steps || []).length && i < 8; i++) previewText += `${i + 1}. ${stripMd(tutorial.steps[i].title)}\n`;
        if ((tutorial.steps?.length || 0) > 8) previewText += `... and ${tutorial.steps.length - 8} more\n`;
        if (tutorial.install_commands?.length) previewText += `\n*Install commands:*\n${tutorial.install_commands.map(c => `\`${c}\``).join('\n')}\n`;
        return safeSend(ctx, previewText, { reply_markup: { inline_keyboard: [
          [{ text: '\ud83d\udce6 Install All Dependencies', callback_data: `smart_install_cmds:${draft.id}` }],
          [{ text: '\ud83d\udccb Just Create Board', callback_data: `smart_tutorial_board:${draft.id}` }],
          [{ text: '\u25c0\ufe0f Back', callback_data: 'list_drafts' }],
        ]}});
      }
      drafts.updateContent(draft.id, tutorial.title || draft.title, JSON.stringify(tutorial), draft.content);
      await helpers.createTutorialBoard(ctx, userId, draft, tutorial);
    } catch (err) {
      await ctx.reply(`\u274c Error: ${err.message}`);
    }
  });

  bot.action(/smart_install:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;
    const linkType = detectLinkType(draft.url);
    await ctx.editMessageText('\ud83d\udce6 Installing...');
    try {
      let installCmd;
      if (linkType === 'npm') { const pkgName = draft.url.match(/npmjs\.com\/package\/([@\w/-]+)/)?.[1]; if (!pkgName) return ctx.reply('Could not extract package name.'); installCmd = `npm install ${pkgName}`; }
      else if (linkType === 'pypi') { const pkgName = draft.url.match(/pypi\.org\/project\/([\w-]+)/)?.[1]; if (!pkgName) return ctx.reply('Could not extract package name.'); installCmd = `pip install ${pkgName}`; }
      else if (linkType === 'docker') { const imgName = draft.url.match(/hub\.docker\.com\/r\/([\w/-]+)/)?.[1] || draft.url.match(/hub\.docker\.com\/_\/([\w-]+)/)?.[1]; if (!imgName) return ctx.reply('Could not extract image name.'); installCmd = `docker pull ${imgName}`; }
      else { installCmd = `npm install ${draft.title || 'unknown'}`; }
      await ctx.reply(`\u25b6\ufe0f Running: \`${installCmd}\``, { parse_mode: 'Markdown' });
      const result = await qa.runCommand(installCmd, process.cwd(), 120000);
      let output = result.stdout || result.stderr || 'Done';
      if (output.length > 2000) output = output.substring(0, 2000) + '...(truncated)';
      await safeSend(ctx, `${result.ok ? '\u2705' : '\u274c'} Install result:\n\`\`\`\n${output}\n\`\`\``);
      if (result.ok) drafts.updateStatus(draft.id, 'processed');
    } catch (err) {
      await ctx.reply(`\u274c Error: ${err.message}`);
    }
  });

  bot.action(/smart_install_cmds:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;
    let tutorial;
    try { tutorial = JSON.parse(draft.description); } catch { return ctx.reply('Tutorial data expired. Try extracting again.'); }
    await ctx.editMessageText('\ud83d\udce6 Installing dependencies...');
    for (const cmd of (tutorial.install_commands || [])) {
      await ctx.reply(`\u25b6\ufe0f \`${cmd}\``, { parse_mode: 'Markdown' });
      const result = await qa.runCommand(cmd, process.cwd(), 120000);
      const output = (result.stdout || result.stderr || 'Done').substring(0, 500);
      await ctx.reply(`${result.ok ? '\u2705' : '\u274c'}\n\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
      if (!result.ok) break;
    }
    await helpers.createTutorialBoard(ctx, ctx.from.id, draft, tutorial);
  });

  bot.action(/smart_tutorial_board:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;
    let tutorial;
    try { tutorial = JSON.parse(draft.description); } catch { return ctx.reply('Tutorial data expired.'); }
    await helpers.createTutorialBoard(ctx, ctx.from.id, draft, tutorial);
  });

  bot.action(/smart_testapi:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;
    await ctx.editMessageText('\ud83c\udf10 Testing API endpoint...');
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(draft.url, { signal: controller.signal, headers: { 'Accept': 'application/json', 'User-Agent': 'TelegramLLMHub/1.0' } });
      clearTimeout(timeout);
      const contentType = res.headers.get('content-type') || '';
      let body = await res.text();
      if (body.length > 2000) body = body.substring(0, 2000) + '...';
      try { body = JSON.stringify(JSON.parse(body), null, 2); } catch {}
      await safeSend(ctx, `\ud83c\udf10 *API Test Result*\n\nStatus: ${res.status}\nContent-Type: ${contentType}\n\n\`\`\`\n${body.substring(0, 1500)}\n\`\`\``);
    } catch (err) {
      await ctx.reply(`\u274c API test failed: ${err.message}`);
    }
  });
}
