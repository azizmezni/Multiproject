import { Markup } from 'telegraf';
import { safeSend, stripMd } from '../bot-helpers.js';
import { projectManager } from '../project-manager.js';
import { autoFixLoop } from '../auto-fix.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdir as fsMkdir, writeFile as fsWriteFile, readdir, stat, readFile } from 'fs/promises';

const __gpDirname = dirname(fileURLToPath(import.meta.url));

export function registerGenProjects(bot, shared) {
  const { llm, userState, kb } = shared;

  // ================ COMMANDS ================

  // /project <idea> — create a new project from an idea
  bot.command('project', async (ctx) => {
    const userId = ctx.from.id;
    const idea = ctx.message.text.replace(/^\/project\s*/i, '').trim();
    if (!idea) {
      return ctx.reply(
        '🚀 *Create a Project*\n\nDescribe your project idea:\n`/project <your idea here>`\n\nExample:\n`/project Todo app with Express API and SQLite`',
        { parse_mode: 'Markdown' }
      );
    }

    llm.initDefaults(userId);
    await ctx.reply('🧠 Analyzing your project idea...');

    try {
      const result = await llm.chat(userId, [
        {
          role: 'system',
          content: `You are a project architect. The user describes a project idea. Analyze it and return a JSON object (no markdown fences):
{
  "title": "Short project name",
  "description": "2-3 sentence project description",
  "tech_stack": "nodejs" or "python",
  "keypoints": ["feature 1", "feature 2", ...],
  "run_command": "node index.js" or "py main.py",
  "install_command": "npm install" or "py -m pip install -r requirements.txt"
}

Rules:
- 5-10 keypoints covering all major features
- Each keypoint = one concrete feature/component
- Choose tech_stack based on what fits best
- For Python: use "py" instead of "python", and "py -m pip" instead of "pip" (Windows compatible)
- Only return the JSON, nothing else`
        },
        { role: 'user', content: idea }
      ]);

      let parsed;
      try {
        parsed = JSON.parse(result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
      } catch {
        parsed = { title: idea.substring(0, 50), description: idea, tech_stack: 'nodejs', keypoints: [idea], run_command: 'node index.js', install_command: 'npm install' };
      }

      const project = projectManager.create(
        userId, parsed.title, parsed.description,
        parsed.tech_stack, parsed.keypoints,
        parsed.run_command, parsed.install_command
      );

      let text = `🚀 *Project Created: ${stripMd(project.title)}*\n\n`;
      text += `📝 ${stripMd(project.description)}\n\n`;
      text += `⚙️ Tech: \`${project.tech_stack}\`\n`;
      text += `▶️ Run: \`${project.run_command}\`\n\n`;
      text += `*Keypoints:*\n`;
      project.keypoints.forEach((k, i) => { text += `${i + 1}. ${stripMd(k)}\n`; });
      text += `\n_via ${result.provider}_`;

      await safeSend(ctx, text, kb.projectView(project.id, project));
    } catch (err) {
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  });

  // /projects — list all projects
  bot.command('projects', async (ctx) => {
    const userId = ctx.from.id;
    const projects = projectManager.listByUser(userId);
    if (projects.length === 0) {
      return ctx.reply('🚀 No projects yet.\n\nCreate one with `/project <your idea>`', { parse_mode: 'Markdown' });
    }

    let text = '🚀 *Your Projects*\n\n';
    for (const p of projects) {
      const statusE = { draft: '📝', generating: '⏳', ready: '✅', running: '▶️' }[p.status] || '📝';
      text += `${statusE} *${stripMd(p.title)}* — \`${p.tech_stack}\`\n`;
    }
    await safeSend(ctx, text, kb.projectList(projects));
  });

  // ================ CALLBACK QUERIES ================

  // List projects
  bot.action('list_projects', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const projects = projectManager.listByUser(userId);
    if (projects.length === 0) {
      try { return ctx.editMessageText('🚀 No projects yet.\nUse `/project <idea>` to create one.', { parse_mode: 'Markdown' }); }
      catch { return ctx.reply('🚀 No projects yet.\nUse `/project <idea>` to create one.', { parse_mode: 'Markdown' }); }
    }

    let text = '🚀 *Your Projects*\n\n';
    for (const p of projects) {
      const statusE = { draft: '📝', generating: '⏳', ready: '✅', running: '▶️' }[p.status] || '📝';
      text += `${statusE} *${stripMd(p.title)}* — \`${p.tech_stack}\`\n`;
    }
    try { await ctx.editMessageText(text, { parse_mode: 'Markdown', ...kb.projectList(projects) }); }
    catch { await ctx.reply(text, { parse_mode: 'Markdown', ...kb.projectList(projects) }); }
  });

  // View project detail
  bot.action(/proj_view:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const proj = projectManager.get(parseInt(ctx.match[1]));
    if (!proj) return ctx.reply('Project not found.');
    await showProjectDetail(ctx, proj);
  });

  // Add keypoint — prompt user
  bot.action(/proj_addkp:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const id = parseInt(ctx.match[1]);
    userState.setAwaiting(ctx.from.id, `proj_addkp:${id}`);
    await ctx.reply('📌 Type the new keypoint to add:');
  });

  // Remove keypoint — show list to pick
  bot.action(/proj_rmkp:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const proj = projectManager.get(parseInt(ctx.match[1]));
    if (!proj || proj.keypoints.length === 0) return ctx.reply('No keypoints to remove.');

    const buttons = proj.keypoints.map((k, i) => [
      Markup.button.callback(`❌ ${k.substring(0, 45)}`, `proj_rmkp_confirm:${proj.id}:${i}`)
    ]);
    buttons.push([Markup.button.callback('◀️ Back', `proj_view:${proj.id}`)]);
    await ctx.reply('Select a keypoint to remove:', Markup.inlineKeyboard(buttons));
  });

  // Confirm remove keypoint
  bot.action(/proj_rmkp_confirm:(\d+):(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const id = parseInt(ctx.match[1]);
    const idx = parseInt(ctx.match[2]);
    const proj = projectManager.get(id);
    if (!proj) return;
    const kps = [...proj.keypoints];
    const removed = kps.splice(idx, 1);
    projectManager.update(id, { keypoints: kps });
    await ctx.reply(`✅ Removed: ${removed[0]}`);
    const updated = projectManager.get(id);
    await showProjectDetail(ctx, updated, true);
  });

  // Chat about project
  bot.action(/proj_chat:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const id = parseInt(ctx.match[1]);
    userState.setAwaiting(ctx.from.id, `proj_chat:${id}`);
    await ctx.reply('💬 Type your message to refine this project:');
  });

  // Fix bugs in generated project
  bot.action(/proj_fix:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const id = parseInt(ctx.match[1]);
    const proj = projectManager.get(id);
    if (!proj?.project_path) return ctx.reply('Project not generated yet — generate first.');

    await ctx.reply('🔧 *Auto-fixing project...*\n\nRunning the project to detect bugs, then sending errors to LLM for repair.', { parse_mode: 'Markdown' });

    try {
      llm.initDefaults(userId);
      const existingFiles = await walkDir(proj.project_path, proj.project_path);
      const files = existingFiles.map(f => ({ path: f, size: 0 }));

      const fixResult = await autoFixLoop(llm, userId, proj, proj.project_path, files, {
        onProgress: async (msg) => {
          try { await ctx.reply(msg.substring(0, 300)); } catch {}
        },
      });

      let text = '';
      if (fixResult.ok && fixResult.fixes.length === 0) {
        text = '✅ *No bugs found* — project runs correctly!';
      } else if (fixResult.ok) {
        text = `✅ *Fixed ${fixResult.fixes.length} issue(s):*\n\n`;
        for (const fix of fixResult.fixes) {
          text += `🔧 Fixed: \`${fix.filesFixed.join('`, `')}\`\n`;
        }
      } else {
        text = `⚠️ *Partial fix* — ${fixResult.fixes.length} issue(s) fixed but some may remain.\n`;
        if (fixResult.lastError) text += `\nRemaining error:\n\`\`\`\n${fixResult.lastError.substring(0, 500)}\n\`\`\``;
      }

      const updated = projectManager.get(id);
      await safeSend(ctx, text, kb.projectView(id, updated));
    } catch (err) {
      await ctx.reply(`❌ Auto-fix failed: ${err.message}`);
    }
  });

  // Generate project
  bot.action(/proj_generate:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const id = parseInt(ctx.match[1]);
    const proj = projectManager.get(id);
    if (!proj) return ctx.reply('Project not found.');

    projectManager.update(id, { status: 'generating' });
    await ctx.reply(`⚡ *Generating ${stripMd(proj.title)}...*\n\nThis may take a minute.`, { parse_mode: 'Markdown' });

    try {
      llm.initDefaults(userId);
      const slug = proj.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').substring(0, 50);
      const projectDir = join(__gpDirname, '..', '..', 'projects', slug);
      await fsMkdir(projectDir, { recursive: true });

      // Determine entry point file from run command
      const isPython = proj.tech_stack === 'python';
      const runCmd = proj.run_command || (isPython ? 'py main.py' : 'node index.js');
      const entryFile = runCmd.split(' ').pop(); // e.g. "main.py" or "index.js"

      const result = await llm.chat(userId, [
        {
          role: 'system',
          content: `You are a senior software engineer. Create a COMPLETE, RUNNABLE ${isPython ? 'Python' : 'Node.js'} project.

Project: ${proj.title}
Description: ${proj.description}
Tech Stack: ${isPython ? 'Python 3' : 'Node.js (ESM)'}

Key Features:
${proj.keypoints.map((k, i) => `${i + 1}. ${k}`).join('\n')}

Output ALL project files in this EXACT format (no other text):

===FILE: path/to/file.ext===
complete file content here
===ENDFILE===

CRITICAL RULES:
- THE VERY FIRST FILE MUST BE "${entryFile}" — this is the main entry point, the program starts here
- ${isPython ? 'THE SECOND FILE MUST BE "requirements.txt" — list ALL third-party pip packages used (one per line, no version pins unless critical). If the project uses no external packages, still create an empty requirements.txt.' : 'THE SECOND FILE MUST BE "package.json" with "type":"module" and all dependencies listed.'}
- All files must be in the project root or simple subdirectories (e.g. "utils/helper.py", NOT "ProjectName/main.py")
- EVERY file needed to run the project — no placeholders, no TODOs, no "implement this later"
- README.md with setup + run instructions
- Run command: ${runCmd}
- Install command: ${isPython ? 'py -m pip install -r requirements.txt' : 'npm install'}
- All imports must match the actual file paths you create
- Production-quality code with error handling and comments
- All ${proj.keypoints.length} features from the keypoints must be fully implemented
- Do NOT nest files inside a project-named subdirectory — all paths are relative to project root
- ${isPython ? 'Use "py" not "python" and "py -m pip" not "pip" in any commands or documentation' : 'Use ESM imports (import/export), not CommonJS (require/module.exports)'}`
        },
        { role: 'user', content: `Generate the complete ${proj.title} project. Start with ${entryFile} as the first file, then ${isPython ? 'requirements.txt' : 'package.json'}.` }
      ]);

      // Clean old files on regenerate
      try {
        const oldFiles = await walkDir(projectDir, projectDir);
        const { unlink: fsUnlink } = await import('fs/promises');
        for (const f of oldFiles) {
          try { await fsUnlink(join(projectDir, ...f.split('/'))); } catch {}
        }
      } catch {}

      // Parse files
      const fileRegex = /===FILE:\s*(.+?)\s*===\n([\s\S]*?)===ENDFILE===/g;
      const files = [];
      let match;
      while ((match = fileRegex.exec(result.text)) !== null) {
        let filePath = match[1].trim().replace(/\\/g, '/');
        const content = match[2].trimEnd() + '\n';
        if (filePath.includes('..') || filePath.startsWith('/')) continue;

        // Strip project-name prefix if the LLM nested files
        const slugPrefix = slug + '/';
        if (filePath.toLowerCase().startsWith(slugPrefix)) filePath = filePath.substring(slugPrefix.length);
        const nameParts = proj.title.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        if (filePath.startsWith(nameParts + '/')) filePath = filePath.substring(nameParts.length + 1);

        const fullPath = join(projectDir, ...filePath.split('/'));
        await fsMkdir(dirname(fullPath), { recursive: true });
        await fsWriteFile(fullPath, content, 'utf-8');
        files.push({ path: filePath, size: content.length });
      }

      if (files.length === 0) {
        await fsWriteFile(join(projectDir, 'output.md'), result.text, 'utf-8');
        files.push({ path: 'output.md', size: result.text.length });
      }

      // Validate entry point exists
      const entryExists = files.some(f => f.path === entryFile || f.path.endsWith('/' + entryFile));

      projectManager.update(id, { status: 'ready', project_path: projectDir });

      // Auto-fix: try running the project, if it crashes send error to LLM for repair
      let fixInfo = '';
      if (entryExists) {
        try {
          const fixResult = await autoFixLoop(llm, userId, proj, projectDir, files, {
            onProgress: async (msg) => {
              try { await ctx.reply(msg.substring(0, 300)); } catch {}
            },
          });
          if (fixResult.fixes.length > 0) {
            fixInfo = `\n\n🔧 *Auto-fixed ${fixResult.fixes.length} issue(s):*\n`;
            for (const fix of fixResult.fixes) {
              fixInfo += `  • Fixed: ${fix.filesFixed.join(', ')}\n`;
            }
          }
          if (!fixResult.ok && fixResult.lastError) {
            fixInfo += `\n⚠️ Some issues may remain — check manually`;
          }
        } catch (fixErr) {
          fixInfo = `\n⚠️ Auto-fix skipped: ${fixErr.message}`;
        }
      }

      let text = `✅ *Project Generated: ${stripMd(proj.title)}*\n\n`;
      if (!entryExists) text += `⚠️ *Warning:* Entry point \`${entryFile}\` was not generated — run may fail\n\n`;
      text += `📁 ${files.length} file(s) created:\n`;
      for (const f of files.slice(0, 15)) {
        const fixTag = f.fixed ? ' 🔧' : '';
        text += `  • \`${f.path}\` (${f.size} bytes)${fixTag}\n`;
      }
      if (files.length > 15) text += `  ...and ${files.length - 15} more\n`;
      text += fixInfo;
      text += `\n📂 Path: \`${slug}/\`\n_via ${result.provider}_`;

      const updated = projectManager.get(id);
      await safeSend(ctx, text, kb.projectView(id, updated));
    } catch (err) {
      projectManager.update(id, { status: 'draft' });
      await ctx.reply(`❌ Generation failed: ${err.message}`);
    }
  });

  // View generated files
  bot.action(/proj_files:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const proj = projectManager.get(parseInt(ctx.match[1]));
    if (!proj?.project_path) return ctx.reply('Project not generated yet.');

    try {
      const files = await walkDir(proj.project_path, proj.project_path);
      if (files.length === 0) return ctx.reply('No files found.');

      let text = `📁 *${stripMd(proj.title)} — Files*\n\n`;
      const buttons = [];
      for (const f of files.slice(0, 20)) {
        text += `• \`${f}\`\n`;
        buttons.push([Markup.button.callback(`📄 ${f.substring(0, 40)}`, `proj_readfile:${proj.id}:${f.substring(0, 50)}`)]);
      }
      if (files.length > 20) text += `...and ${files.length - 20} more`;
      buttons.push([Markup.button.callback('◀️ Back', `proj_view:${proj.id}`)]);
      await safeSend(ctx, text, Markup.inlineKeyboard(buttons));
    } catch (err) {
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // Read a file
  bot.action(/proj_readfile:(\d+):(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const proj = projectManager.get(parseInt(ctx.match[1]));
    const filePath = ctx.match[2];
    if (!proj?.project_path || filePath.includes('..')) return ctx.reply('Invalid file.');

    try {
      const content = await readFile(join(proj.project_path, ...filePath.split('/')), 'utf-8');
      let text = `📄 *${filePath}*\n\n\`\`\`\n${content.substring(0, 3500)}\n\`\`\``;
      if (content.length > 3500) text += '\n...(truncated)';
      await safeSend(ctx, text, Markup.inlineKeyboard([
        [Markup.button.callback('◀️ Back to Files', `proj_files:${proj.id}`)],
        [Markup.button.callback('◀️ Back to Project', `proj_view:${proj.id}`)],
      ]));
    } catch {
      await ctx.reply('❌ Could not read file.');
    }
  });

  // Delete project
  bot.action(/proj_delete:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    projectManager.delete(parseInt(ctx.match[1]));
    await ctx.reply('🗑️ Project deleted.');
    // Refresh list
    const projects = projectManager.listByUser(ctx.from.id);
    if (projects.length > 0) {
      let text = '🚀 *Your Projects*\n\n';
      for (const p of projects) {
        const statusE = { draft: '📝', generating: '⏳', ready: '✅', running: '▶️' }[p.status] || '📝';
        text += `${statusE} *${stripMd(p.title)}* — \`${p.tech_stack}\`\n`;
      }
      await safeSend(ctx, text, kb.projectList(projects));
    }
  });

  // ================ TEXT INPUT HANDLERS ================
  // These are handled in messages.js via awaiting_input routing

  // ================ HELPER FUNCTIONS ================

  async function showProjectDetail(ctx, proj, asNew = false) {
    let text = `🚀 *${stripMd(proj.title)}*\n\n`;
    text += `📝 ${stripMd(proj.description)}\n\n`;
    text += `⚙️ Tech: \`${proj.tech_stack}\` | Status: ${proj.status}\n`;
    text += `▶️ Run: \`${proj.run_command}\`\n\n`;
    text += `*Keypoints:*\n`;
    proj.keypoints.forEach((k, i) => { text += `  ${i + 1}. ${stripMd(k)}\n`; });

    if (proj.chat_history.length > 0) {
      text += `\n💬 Chat history: ${proj.chat_history.length} messages`;
    }

    if (asNew) {
      await ctx.reply(text, { parse_mode: 'Markdown', ...kb.projectView(proj.id, proj) });
    } else {
      try {
        await ctx.editMessageText(text, { parse_mode: 'Markdown', ...kb.projectView(proj.id, proj) });
      } catch {
        await ctx.reply(text, { parse_mode: 'Markdown', ...kb.projectView(proj.id, proj) });
      }
    }
  }

  // Recursive directory walker
  async function walkDir(dir, base) {
    const entries = await readdir(dir, { withFileTypes: true });
    let files = [];
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '__pycache__') continue;
      if (entry.isDirectory()) {
        files = files.concat(await walkDir(fullPath, base));
      } else {
        const rel = fullPath.replace(base, '').replace(/\\/g, '/').replace(/^\//, '');
        files.push(rel);
      }
    }
    return files;
  }
}
