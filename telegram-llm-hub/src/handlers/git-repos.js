import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { safeSend, stripMd } from '../bot-helpers.js';
import { gitRepoManager, analyzeRepo, generateRunPlan, diagnoseStepFailure } from '../git-repos.js';

const __handlerDir = dirname(fileURLToPath(import.meta.url));
const REPOS_DIR = join(__handlerDir, '..', '..', 'repos');

export function registerGitRepos(bot, shared) {
  const { llm, userState, qa, kb } = shared;
  const runningGitRepos = shared.runningGitRepos;

  // Clone + analyze helper — exposed on shared for use from messages.js
  async function cloneAndAnalyze(ctx, userId, url) {
    // Normalize URL
    let cloneUrl = url.trim();
    if (cloneUrl.includes('github.com') && !cloneUrl.endsWith('.git')) {
      cloneUrl = cloneUrl.replace(/\/$/, '');
    }
    const repoName = cloneUrl.match(/\/([^/]+?)(?:\.git)?$/)?.[1] || 'repo';
    const repoDir = join(REPOS_DIR, repoName);

    // Check if already cloned
    const existing = gitRepoManager.findByUrl(userId, url);
    if (existing) {
      await ctx.reply(`📚 This repo is already tracked: *${stripMd(existing.name)}*\nStatus: ${existing.status}`, { parse_mode: 'Markdown', ...kb.gitRepoView(existing.id, existing) });
      return existing;
    }

    await ctx.reply(`📥 Cloning *${stripMd(repoName)}*...`, { parse_mode: 'Markdown' });

    // Create repos dir if needed
    const { mkdir } = await import('fs/promises');
    await mkdir(REPOS_DIR, { recursive: true });

    // Clone
    const safeUrl = cloneUrl.replace(/[;&|`$"]/g, '');
    const cloneResult = await qa.runCommand(`git clone "${safeUrl}" "${repoDir}"`, REPOS_DIR, 120000);
    if (!cloneResult.ok && !cloneResult.stderr?.includes('already exists')) {
      await ctx.reply(`❌ Clone failed: ${cloneResult.stderr?.substring(0, 500) || 'Unknown error'}`);
      return null;
    }

    // Deep-analyze repo: reads README, package.json, Makefile, etc. + LLM
    await ctx.reply('🔍 Analyzing repo structure...');
    const analysis = await analyzeRepo(repoDir, repoName, llm, userId);
    const { projectType, installCmd, runCmd, skills, readmeSummary } = analysis;

    // Install dependencies
    if (installCmd) {
      await ctx.reply(`📦 Installing dependencies (${projectType})...`);
      const installResult = await qa.runCommand(installCmd, repoDir, 120000);
      if (!installResult.ok) {
        await ctx.reply(`⚠️ Install had issues, will try to run anyway`);
      }
    }

    // Save to DB
    const repo = gitRepoManager.create(userId, url, repoName, repoDir, projectType, installCmd, runCmd, skills, readmeSummary);

    let msg = `✅ *${stripMd(repoName)}* cloned!\n\n`;
    msg += `📦 Type: \`${projectType}\`\n`;
    if (runCmd) msg += `▶️ Run: \`${runCmd}\`\n`;
    if (readmeSummary) msg += `\n📝 ${stripMd(readmeSummary)}\n`;
    if (skills.length > 0) msg += `\n🧠 Skills: ${skills.map(s => `\`${s}\``).join(', ')}`;

    await safeSend(ctx, msg, kb.gitRepoView(repo.id, repo));
    return repo;
  }

  // Expose clone function on shared
  shared.handleGitClone = cloneAndAnalyze;
  shared.gitRepoManager = gitRepoManager;

  // --- Commands ---
  bot.command('repos', async (ctx) => {
    const repos = gitRepoManager.listByUser(ctx.from.id);
    if (repos.length === 0) {
      return ctx.reply('📚 No repos cloned yet. Send a GitHub URL or tap below:', kb.gitRepoList([]));
    }
    let msg = '📚 *Your Git Repos:*\n\n';
    repos.forEach((r, i) => {
      const typeE = { node: '🟢', python: '🐍', rust: '🦀', go: '🔵' }[r.project_type] || '📦';
      const statusE = { cloned: '✅', running: '▶️', error: '❌' }[r.status] || '📁';
      msg += `${i + 1}. ${statusE}${typeE} *${stripMd(r.name)}*`;
      if (r.readme_summary) msg += ` — ${stripMd(r.readme_summary).substring(0, 60)}`;
      msg += '\n';
    });
    await safeSend(ctx, msg, kb.gitRepoList(repos));
  });

  // --- Actions ---
  bot.action('list_git_repos', async (ctx) => {
    await ctx.answerCbQuery();
    const repos = gitRepoManager.listByUser(ctx.from.id);
    if (repos.length === 0) {
      return ctx.editMessageText('📚 No repos cloned yet.\n\nSend a GitHub URL or tap Clone below:', kb.gitRepoList([]));
    }
    let msg = '📚 *Your Git Repos:*\n\n';
    repos.forEach((r, i) => {
      const typeE = { node: '🟢', python: '🐍', rust: '🦀', go: '🔵' }[r.project_type] || '📦';
      const statusE = { cloned: '✅', running: '▶️', error: '❌' }[r.status] || '📁';
      msg += `${i + 1}. ${statusE}${typeE} *${stripMd(r.name)}*\n`;
    });
    await safeSend(ctx, msg, kb.gitRepoList(repos));
  });

  bot.action('git_clone_new', async (ctx) => {
    await ctx.answerCbQuery();
    userState.setAwaiting(ctx.from.id, 'git_clone_url');
    await ctx.editMessageText('📥 *Clone a Git Repo*\n\nSend the repository URL (GitHub, GitLab, etc.):', { parse_mode: 'Markdown' });
  });

  bot.action(/git_view:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const repo = gitRepoManager.get(parseInt(ctx.match[1]));
    if (!repo) return ctx.editMessageText('Repo not found.');

    const typeE = { node: '🟢 Node.js', python: '🐍 Python', rust: '🦀 Rust', go: '🔵 Go' }[repo.project_type] || '📦 Unknown';
    let msg = `📚 *${stripMd(repo.name)}*\n\n`;
    msg += `🔗 ${repo.url}\n`;
    msg += `📦 ${typeE}\n`;
    if (repo.run_cmd) msg += `▶️ Run: \`${repo.run_cmd}\`\n`;
    if (repo.install_cmd) msg += `📥 Install: \`${repo.install_cmd}\`\n`;
    if (repo.readme_summary) msg += `\n📝 ${stripMd(repo.readme_summary)}\n`;
    if (repo.skills.length > 0) msg += `\n🧠 Skills: ${repo.skills.map(s => `\`${s}\``).join(', ')}\n`;
    msg += `\n📁 ${repo.clone_dir}`;
    msg += `\nStatus: ${repo.status}`;

    await safeSend(ctx, msg, kb.gitRepoView(repo.id, repo));
  });

  // Run — LLM-driven: ask the LLM to read the repo and give step-by-step commands
  bot.action(/git_run:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const repo = gitRepoManager.get(parseInt(ctx.match[1]));
    if (!repo) return;
    if (!existsSync(repo.clone_dir)) return ctx.reply('❌ Repo directory not found. Re-clone it.');
    if (runningGitRepos.has(repo.id)) return ctx.reply('▶️ Already running.');

    await ctx.editMessageText(`🧠 Asking LLM how to run *${stripMd(repo.name)}*...`, { parse_mode: 'Markdown' });

    // Step 1: Ask LLM for a run plan
    let plan;
    try {
      plan = await generateRunPlan(repo.clone_dir, repo.name, repo.project_type, llm, ctx.from.id);
    } catch (err) {
      await ctx.reply(`❌ LLM couldn't generate a run plan: ${err.message}`);
      return;
    }

    if (!plan.steps || plan.steps.length === 0) {
      await ctx.reply('❌ LLM returned no steps. Try Re-analyze first.');
      return;
    }

    // Show the plan
    let planMsg = `📋 *Run plan for ${stripMd(repo.name)}:*\n\n`;
    plan.steps.forEach((s, i) => { planMsg += `${i + 1}. ${stripMd(s.label)}: \`${s.cmd}\`\n`; });
    await safeSend(ctx, planMsg);

    // Step 2: Execute each step sequentially (unlimited fix attempts)
    let lastStepOk = true;
    let lastError = '';

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const isLastStep = i === plan.steps.length - 1;
      await ctx.reply(`⚡ Step ${i + 1}/${plan.steps.length}: ${step.label}\n> \`${step.cmd}\``);

      let fixAttempts = 0;
      let currentCmd = step.cmd;
      let succeeded = false;
      const prevAttempts = [];
      const seenErrors = new Map();

      while (true) {
        const timeout = isLastStep ? 30000 : 120000;
        const result = await qa.runCommand(currentCmd, repo.clone_dir, timeout);

        if (result.ok) {
          const out = (result.stdout || '').substring(0, 500);
          if (out.trim()) await ctx.reply(`✅ ${out.length > 200 ? out.substring(0, 200) + '...' : out}`);
          else await ctx.reply('✅ Done');
          succeeded = true;
          break;
        }

        // Step failed — check for repeated errors
        const errOutput = (result.stderr || result.stdout || 'Unknown error').substring(0, 2000);
        lastError = errOutput;
        const errKey = errOutput.substring(0, 200).trim();
        const errCount = (seenErrors.get(errKey) || 0) + 1;
        seenErrors.set(errKey, errCount);
        fixAttempts++;

        if (errCount >= 3) {
          await ctx.reply(`🛑 Same error repeated ${errCount} times — LLM cannot fix this. Skipping step.`);
          break;
        }
        if (fixAttempts > 10) {
          await ctx.reply(`🛑 Too many fix attempts (${fixAttempts}). Giving up on this step.`);
          break;
        }

        await ctx.reply(`⚠️ Step failed (attempt ${fixAttempts}). Asking LLM to fix...\n\`${errOutput.substring(0, 200)}\``);

        try {
          prevAttempts.push(`Attempt ${fixAttempts}: "${currentCmd}" → ${errOutput.substring(0, 300)}`);
          const fix = await diagnoseStepFailure(repo.clone_dir, repo.name, repo.project_type, step, errOutput, prevAttempts, llm, ctx.from.id);
          await ctx.reply(`🔧 ${fix.diagnosis || 'Fixing...'}`);

          if (fix.give_up) {
            await ctx.reply(`🛑 LLM says this is unfixable: ${fix.diagnosis}`);
            break;
          }

          for (const fc of (fix.fix_commands || [])) {
            await ctx.reply(`> \`${fc}\``);
            const fcResult = await qa.runCommand(fc, repo.clone_dir, 60000);
            if (!fcResult.ok && fcResult.stderr) {
              await ctx.reply(`⚠️ \`${fcResult.stderr.substring(0, 150)}\``);
            }
          }

          if (fix.retry_cmd && fix.retry_cmd !== 'null') {
            currentCmd = fix.retry_cmd;
            await ctx.reply(`🔧 Retrying with: \`${currentCmd}\``);
          }
        } catch (fixErr) {
          await ctx.reply(`⚠️ LLM fix failed: ${fixErr.message}`);
        }
      }

      if (!succeeded) {
        lastStepOk = false;
        break;
      }
    }

    // Save the run/install commands from the plan for future use
    if (plan.run_cmd) gitRepoManager.update(repo.id, { run_cmd: plan.run_cmd });
    if (plan.install_cmd) gitRepoManager.update(repo.id, { install_cmd: plan.install_cmd });

    const updatedRepo = gitRepoManager.get(repo.id);
    if (lastStepOk) {
      gitRepoManager.update(repo.id, { status: 'cloned' });
      await safeSend(ctx, `✅ *${stripMd(repo.name)}* executed successfully!`, kb.gitRepoView(updatedRepo.id, updatedRepo));
    } else {
      gitRepoManager.update(repo.id, { status: 'error' });
      await safeSend(ctx, `❌ *${stripMd(repo.name)}* failed.\n\nLast error:\n\`\`\`\n${lastError.substring(0, 800)}\n\`\`\``, kb.gitRepoView(updatedRepo.id, updatedRepo));
    }
  });

  // Re-analyze: re-detect run/install commands with improved LLM analysis
  bot.action(/git_reanalyze:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const repo = gitRepoManager.get(parseInt(ctx.match[1]));
    if (!repo) return;
    if (!existsSync(repo.clone_dir)) return ctx.reply('❌ Repo directory not found.');

    await ctx.editMessageText(`🔍 Re-analyzing *${stripMd(repo.name)}*...`, { parse_mode: 'Markdown' });

    try {
      const analysis = await analyzeRepo(repo.clone_dir, repo.name, llm, ctx.from.id);
      gitRepoManager.update(repo.id, {
        project_type: analysis.projectType,
        install_cmd: analysis.installCmd,
        run_cmd: analysis.runCmd,
        skills: analysis.skills,
        readme_summary: analysis.readmeSummary,
      });
      const updated = gitRepoManager.get(repo.id);

      let msg = `✅ Re-analyzed *${stripMd(repo.name)}*\n\n`;
      msg += `📦 Type: \`${analysis.projectType}\`\n`;
      msg += `▶️ Run: \`${analysis.runCmd || 'N/A'}\`\n`;
      msg += `📥 Install: \`${analysis.installCmd || 'N/A'}\`\n`;
      if (analysis.readmeSummary) msg += `\n📝 ${stripMd(analysis.readmeSummary)}`;
      if (analysis.skills.length > 0) msg += `\n🧠 Skills: ${analysis.skills.map(s => `\`${s}\``).join(', ')}`;

      await safeSend(ctx, msg, kb.gitRepoView(updated.id, updated));
    } catch (err) {
      await ctx.reply(`❌ Re-analysis failed: ${err.message}`);
    }
  });

  bot.action(/git_stop:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const repo = gitRepoManager.get(parseInt(ctx.match[1]));
    if (!repo) return;
    const proc = runningGitRepos.get(repo.id);
    if (proc) {
      try { proc.kill(); } catch {}
      runningGitRepos.delete(repo.id);
    }
    gitRepoManager.update(repo.id, { status: 'cloned' });
    await ctx.editMessageText(`⏹ Stopped *${stripMd(repo.name)}*`, { parse_mode: 'Markdown', ...kb.gitRepoView(repo.id, repo) });
  });

  bot.action(/git_pull:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const repo = gitRepoManager.get(parseInt(ctx.match[1]));
    if (!repo) return;
    await ctx.editMessageText(`🔄 Pulling *${stripMd(repo.name)}*...`, { parse_mode: 'Markdown' });
    const result = await qa.runCommand('git pull', repo.clone_dir, 60000);
    const output = (result.stdout || result.stderr || 'Done').substring(0, 500);
    await safeSend(ctx, `${result.ok ? '✅' : '⚠️'} Pull result:\n\`\`\`\n${output}\n\`\`\``, kb.gitRepoView(repo.id, repo));
  });

  bot.action(/git_delete:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const repo = gitRepoManager.get(parseInt(ctx.match[1]));
    if (!repo) return;
    // Stop if running
    const proc = runningGitRepos.get(repo.id);
    if (proc) { try { proc.kill(); } catch {} runningGitRepos.delete(repo.id); }
    // Delete from DB
    gitRepoManager.delete(repo.id);
    await ctx.editMessageText(`🗑 Deleted *${stripMd(repo.name)}*`, { parse_mode: 'Markdown' });
    // Show updated list
    const repos = gitRepoManager.listByUser(ctx.from.id);
    if (repos.length > 0) {
      await ctx.reply('📚 Remaining repos:', kb.gitRepoList(repos));
    }
  });
}
