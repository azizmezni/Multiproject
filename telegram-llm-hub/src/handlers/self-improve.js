import { readdir, readFile, writeFile, mkdir, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { safeSend } from '../bot-helpers.js';
import db from '../db.js';

const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git', 'venv', '.venv', 'dist', 'build', '.cache', '.next']);
const SKIP_EXT = new Set(['.db', '.db-shm', '.db-wal', '.lock', '.png', '.jpg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.pyc']);

async function collectSrcFiles(srcDir, baseDir) {
  const files = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else {
        if (SKIP_EXT.has(e.name.substring(e.name.lastIndexOf('.')))) continue;
        const rel = full.replace(baseDir, '').replace(/\\/g, '/').replace(/^\//, '');
        try {
          const s = await stat(full);
          if (s.size > 80000) continue; // skip huge files
          const content = await readFile(full, 'utf-8');
          files.push({ path: rel, content: content.length > 5000 ? content.substring(0, 5000) + '\n...TRUNCATED...' : content });
        } catch {}
      }
    }
  }
  await walk(srcDir);
  return files;
}

function parseFileBlocks(text) {
  const files = [];
  let match;
  // Format 1: ===FILE: path===...===ENDFILE===
  const r1 = /===FILE:\s*(.+?)\s*===\n([\s\S]*?)===ENDFILE===/g;
  while ((match = r1.exec(text)) !== null) {
    let p = match[1].trim().replace(/\\/g, '/');
    if (p.includes('..') || p.startsWith('/')) continue;
    files.push({ path: p, content: match[2].trimEnd() + '\n' });
  }
  // Format 2: ```path\ncode\n```
  if (files.length === 0) {
    const r2 = /```([a-zA-Z0-9_\-./]+\.(?:py|js|ts|json|html|css|yml|yaml|md|bat|sh|jsx|tsx))\n([\s\S]*?)```/g;
    while ((match = r2.exec(text)) !== null) {
      let p = match[1].trim().replace(/\\/g, '/');
      if (p.includes('..') || p.startsWith('/')) continue;
      files.push({ path: p, content: match[2].trimEnd() + '\n' });
    }
  }
  return files;
}

export function registerSelfImprove(bot, shared) {
  const { llm, userState, kb } = shared;

  // Telegram button callback
  bot.action('self_improve', async (ctx) => {
    await ctx.answerCbQuery();
    userState.setAwaiting(ctx.from.id, 'self_improve');
    await ctx.editMessageText(
      '🧬 *Self-Improve*\n\n' +
      'Describe a feature to add or a bug to fix.\n' +
      'I will read all source files, generate changes, and apply them.\n\n' +
      '_Examples:_\n' +
      '• "add /ping command that replies pong"\n' +
      '• "fix the terminal button not opening"\n' +
      '• "add dark mode toggle to dashboard"\n\n' +
      '_Send your request:_',
      { parse_mode: 'Markdown' }
    );
  });

  bot.action('self_improve_history', async (ctx) => {
    await ctx.answerCbQuery();
    const rows = db.prepare('SELECT * FROM self_improvements WHERE user_id = ? ORDER BY created_at DESC LIMIT 10').all(ctx.from.id);
    if (rows.length === 0) {
      return ctx.editMessageText('📜 No self-improvements yet.\n\nUse 🧬 Self-Improve to make your first one!', { parse_mode: 'Markdown', ...kb.mainMenu() });
    }
    let text = '📜 *Recent Self-Improvements*\n\n';
    for (const r of rows) {
      const files = JSON.parse(r.files_changed || '[]');
      const date = new Date(r.created_at).toLocaleDateString();
      text += `• *${r.request.substring(0, 60)}*${r.request.length > 60 ? '...' : ''}\n`;
      text += `  📁 ${files.length} file(s) changed — ${date}\n`;
      if (files.length > 0) text += `  _${files.slice(0, 3).join(', ')}${files.length > 3 ? '...' : ''}_\n`;
      text += '\n';
    }
    await safeSend(ctx, text, kb.mainMenu());
  });

  // The actual self-improve logic — called from messages handler
  shared.handleSelfImprove = async function handleSelfImprove(ctx, userId, request) {
    const projectDir = process.cwd();
    const srcDir = join(projectDir, 'src');

    await ctx.reply('🧬 *Self-Improve*\n_Scanning source files..._', { parse_mode: 'Markdown' });

    const files = await collectSrcFiles(srcDir, projectDir + (projectDir.endsWith('/') || projectDir.endsWith('\\') ? '' : '/'));
    if (files.length === 0) {
      return ctx.reply('❌ No source files found in src/ directory.');
    }

    let fileContext = '';
    for (const f of files) {
      fileContext += `--- ${f.path} ---\n${f.content}\n\n`;
    }

    await ctx.reply(`📂 Found ${files.length} files. 🤖 Generating changes...`);

    llm.initDefaults(userId);

    try {
      const result = await llm.chat(userId, [
        {
          role: 'system',
          content: `You are a Node.js code generator modifying an existing project.

SOURCE CODE:
${fileContext}

When making changes, output the COMPLETE modified source file using this format:

===FILE: relative/path/to/file===
complete file content here
===ENDFILE===

RULES:
- Output the ENTIRE source code of each changed file
- Only include files that actually need changes
- Keep all existing functionality intact
- Match the existing code style (ESM imports, async/await)
- Brief explanation before the code blocks (1-2 sentences)
- You CAN create new files or modify existing ones`
        },
        { role: 'user', content: request }
      ]);

      const fixedFiles = parseFileBlocks(result.text);

      if (fixedFiles.length > 0) {
        // Safety: only allow files under src/ or root config files
        const safeFiles = fixedFiles.filter(f => {
          const p = f.path.toLowerCase();
          return p.startsWith('src/') || p.startsWith('src\\') ||
                 p === 'package.json' || p === 'start.bat' ||
                 p === '.env.example';
        });

        for (const f of safeFiles) {
          const fullPath = join(projectDir, ...f.path.split('/'));
          await mkdir(dirname(fullPath), { recursive: true });
          await writeFile(fullPath, f.content, 'utf-8');
        }

        // Store in DB
        db.prepare('INSERT INTO self_improvements (user_id, request, files_changed, llm_response, provider) VALUES (?, ?, ?, ?, ?)')
          .run(userId, request, JSON.stringify(safeFiles.map(f => f.path)), result.text.substring(0, 10000), result.provider || '');

        let summary = `✅ *Self-Improve Complete*\n\n`;
        summary += `📝 _${request.substring(0, 100)}_\n\n`;
        summary += `📁 *Files changed (${safeFiles.length}):*\n`;
        for (const f of safeFiles) {
          summary += `• \`${f.path}\`\n`;
        }
        summary += `\n⚠️ *Restart the bot to apply changes*\n`;
        summary += `_via ${result.provider}_`;

        await safeSend(ctx, summary, kb.mainMenu());
      } else {
        // No file blocks — show raw response
        let display = result.text;
        if (display.length > 3500) display = display.substring(0, 3500) + '...';

        db.prepare('INSERT INTO self_improvements (user_id, request, files_changed, llm_response, provider) VALUES (?, ?, ?, ?, ?)')
          .run(userId, request, '[]', result.text.substring(0, 10000), result.provider || '');

        await safeSend(ctx, `🧬 *Response*\n\n${display}\n\n_via ${result.provider}_\n\n_No file changes detected in output._`, kb.mainMenu());
      }
    } catch (err) {
      await ctx.reply(`❌ Error: ${err.message}`, kb.mainMenu());
    }
  };
}
