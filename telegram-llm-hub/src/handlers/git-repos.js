import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { safeSend, stripMd } from '../bot-helpers.js';
import { gitRepoManager, analyzeRepo, generateRunPlan, diagnoseStepFailure } from '../git-repos.js';
import { matchKnownError, isStepSkippable } from '../smart-fix.js';

const __handlerDir = dirname(fileURLToPath(import.meta.url));
const REPOS_DIR = join(__handlerDir, '..', '..', 'repos');

// Port detection regex — matches common server output patterns
const PORT_RE = /(?:listening|started|running|server|serving|open|available|ready)\s+(?:on|at)\s+(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)[:\s]+(\d{3,5})|(?:port|PORT)\s*[=:]\s*(\d{3,5})|localhost:(\d{3,5})|127\.0\.0\.1:(\d{3,5})|0\.0\.0\.0:(\d{3,5})/i;

function detectPort(output) {
  const m = output.match(PORT_RE);
  if (!m) return null;
  return m[1] || m[2] || m[3] || m[4] || m[5];
}

/**
 * Spawn the final "run" step as a background server process.
 * Watches stdout/stderr for ~8s to detect port or crash.
 */
function spawnServerStep(cmd, repo, runningGitRepos, ctx) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, {
      cwd: repo.clone_dir, shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let output = '';
    let detectedPort = null;
    let crashed = false;

    const collect = (data) => {
      output += data.toString();
      if (!detectedPort) {
        detectedPort = detectPort(output);
      }
    };

    proc.stdout?.on('data', collect);
    proc.stderr?.on('data', collect);

    proc.on('close', (code) => {
      if (code !== 0 && !detectedPort) {
        crashed = true;
        resolve({ ok: false, output });
      }
    });

    proc.on('error', (err) => {
      crashed = true;
      resolve({ ok: false, output: err.message });
    });

    // Try stdin close
    try { proc.stdin.end(); } catch {}

    // Store the process
    runningGitRepos.set(repo.id, proc);

    // Wait up to 8 seconds for port detection or crash
    let checks = 0;
    const interval = setInterval(() => {
      checks++;
      if (crashed) {
        clearInterval(interval);
        return; // already resolved
      }
      if (detectedPort) {
        clearInterval(interval);
        resolve({ ok: true, port: detectedPort });
        return;
      }
      if (checks >= 16) { // 8 seconds (16 × 500ms)
        clearInterval(interval);
        // Process is still alive but no port detected — still OK (could be a non-server process)
        resolve({ ok: true, port: null });
      }
    }, 500);
  });
}

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

    // If target dir already exists (leftover from failed clone), remove it first
    const safeUrl = cloneUrl.replace(/[;&|`$"]/g, '');
    if (existsSync(repoDir)) {
      await qa.runCommand(`rmdir /s /q "${repoDir}"`, REPOS_DIR, 10000);
    }

    // Clone
    const cloneResult = await qa.runCommand(`git clone "${safeUrl}" "${repoDir}"`, REPOS_DIR, 120000);
    if (!cloneResult.ok) {
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

    // Step 2: Execute each step with smart fix engine
    let lastStepOk = true;
    let lastError = '';
    let skippedSteps = [];

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const isLastStep = i === plan.steps.length - 1;
      const skippable = isStepSkippable(step, isLastStep);
      await ctx.reply(`⚡ Step ${i + 1}/${plan.steps.length}: ${step.label}\n> \`${step.cmd}\``);

      let fixAttempts = 0;
      let currentCmd = step.cmd;
      let succeeded = false;
      const prevAttempts = [];
      const seenErrors = new Map();

      while (true) {
        // For the final step (likely a server), spawn as background and detect port
        if (isLastStep) {
          const serverResult = await spawnServerStep(currentCmd, repo, runningGitRepos, ctx);
          if (serverResult.ok) {
            succeeded = true;
            if (serverResult.port) {
              gitRepoManager.update(repo.id, { status: 'running', port: parseInt(serverResult.port) });
              const link = `http://localhost:${serverResult.port}`;
              await ctx.reply(`✅ Server running!\n\n🌐 *${stripMd(repo.name)}*: [${link}](${link})`, { parse_mode: 'Markdown', disable_web_page_preview: true });
            } else {
              await ctx.reply('✅ Process started (no port detected)');
            }
            break;
          }
          // If server crashed immediately, fall through to error handling
        }

        const timeout = isLastStep ? 15000 : 120000;
        const result = isLastStep ? { ok: false, stderr: 'Server failed to start', stdout: '', code: -1 } : await qa.runCommand(currentCmd, repo.clone_dir, timeout);

        if (result.ok) {
          const out = (result.stdout || '').substring(0, 500);
          if (out.trim()) await ctx.reply(`✅ ${out.length > 200 ? out.substring(0, 200) + '...' : out}`);
          else await ctx.reply('✅ Done');
          succeeded = true;
          break;
        }

        // Step failed
        const errOutput = (result.stderr || result.stdout || 'Unknown error').substring(0, 2000);
        lastError = errOutput;
        const errKey = errOutput.substring(0, 200).trim();
        const errCount = (seenErrors.get(errKey) || 0) + 1;
        seenErrors.set(errKey, errCount);
        fixAttempts++;

        // --- Phase 1: Try known error patterns first (no LLM needed) ---
        if (fixAttempts === 1) {
          const knownFix = matchKnownError(errOutput);
          if (knownFix) {
            await ctx.reply(`🔍 Known issue: ${knownFix.diagnosis}`);

            if (knownFix.unfixable_reason) {
              await ctx.reply(`🛑 ${knownFix.unfixable_reason}`);
              if (skippable) {
                await ctx.reply(`⏭ Skipping non-critical step and continuing...`);
                skippedSteps.push(step.label);
              }
              break;
            }

            for (const fc of (knownFix.fix_commands || [])) {
              await ctx.reply(`> \`${fc}\``);
              await qa.runCommand(fc, repo.clone_dir, 60000);
            }
            if (knownFix.retry_cmd) {
              currentCmd = knownFix.retry_cmd;
              await ctx.reply(`🔧 Retrying with: \`${currentCmd}\``);
            }
            continue;
          }
        }

        // --- Phase 2: LLM fix (with limits) ---
        if (errCount >= 3) {
          if (skippable) {
            await ctx.reply(`⏭ Same error 3x on non-critical step — skipping and continuing...`);
            skippedSteps.push(step.label);
          } else {
            await ctx.reply(`🛑 Same error repeated ${errCount} times — cannot auto-fix.`);
          }
          break;
        }
        if (fixAttempts > 5) {
          if (skippable) {
            await ctx.reply(`⏭ Too many attempts on non-critical step — skipping...`);
            skippedSteps.push(step.label);
          } else {
            await ctx.reply(`🛑 ${fixAttempts} fix attempts failed. Giving up on this step.`);
          }
          break;
        }

        await ctx.reply(`⚠️ Step failed (attempt ${fixAttempts}). Asking LLM to fix...\n\`${errOutput.substring(0, 200)}\``);

        try {
          prevAttempts.push(`Attempt ${fixAttempts}: "${currentCmd}" → ${errOutput.substring(0, 300)}`);
          const fix = await diagnoseStepFailure(repo.clone_dir, repo.name, repo.project_type, step, errOutput, prevAttempts, llm, ctx.from.id);
          await ctx.reply(`🔧 ${fix.diagnosis || 'Fixing...'}`);

          if (fix.give_up) {
            if (skippable) {
              await ctx.reply(`⏭ LLM says unfixable — skipping non-critical step: ${fix.diagnosis}`);
              skippedSteps.push(step.label);
            } else {
              await ctx.reply(`🛑 LLM says this is unfixable: ${fix.diagnosis}`);
            }
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
          if (skippable) {
            await ctx.reply(`⏭ Skipping non-critical step...`);
            skippedSteps.push(step.label);
            break;
          }
        }
      }

      if (!succeeded && !skippable) {
        lastStepOk = false;
        break;
      }
      // If skippable step failed, keep going to next step
    }

    // Save the run/install commands from the plan for future use
    if (plan.run_cmd) gitRepoManager.update(repo.id, { run_cmd: plan.run_cmd });
    if (plan.install_cmd) gitRepoManager.update(repo.id, { install_cmd: plan.install_cmd });

    const updatedRepo = gitRepoManager.get(repo.id);
    const skipNote = skippedSteps.length > 0 ? `\n\n⏭ Skipped steps: ${skippedSteps.map(s => `_${stripMd(s)}_`).join(', ')}` : '';
    if (lastStepOk) {
      gitRepoManager.update(repo.id, { status: 'cloned' });
      await safeSend(ctx, `✅ *${stripMd(repo.name)}* executed successfully!${skipNote}`, kb.gitRepoView(updatedRepo.id, updatedRepo));
    } else {
      gitRepoManager.update(repo.id, { status: 'error' });
      await safeSend(ctx, `❌ *${stripMd(repo.name)}* failed.\n\nLast error:\n\`\`\`\n${lastError.substring(0, 800)}\n\`\`\`${skipNote}`, kb.gitRepoView(updatedRepo.id, updatedRepo));
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
