import db from './db.js';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

function parse(row) {
  if (!row) return null;
  row.skills = JSON.parse(row.skills || '[]');
  return row;
}

// Fix python/pip commands for Windows
function fixPythonCmds(cmd) {
  if (!cmd) return cmd;
  return cmd.replace(/^python3?\b/, 'py').replace(/^pip3?\b/, 'py -m pip');
}

// Read a file from repo, return content or empty string
async function safeRead(repoDir, filename) {
  try { return await readFile(join(repoDir, filename), 'utf-8'); } catch { return ''; }
}

/**
 * Deep-analyze a cloned repo to determine how to install and run it.
 * Reads README, package.json, Makefile, docker-compose, Procfile, pyproject.toml, etc.
 * Sends all context to LLM for accurate install/run command detection.
 *
 * @param {string} repoDir - absolute path to the cloned repo
 * @param {string} repoName - repo name
 * @param {object} llm - LLM manager
 * @param {number} userId - user ID for LLM session
 * @returns {{ projectType, installCmd, runCmd, skills, readmeSummary }}
 */
export async function analyzeRepo(repoDir, repoName, llm, userId) {
  const files = await readdir(repoDir).catch(() => []);

  // --- Basic type detection as fallback ---
  let projectType = 'unknown';
  if (files.includes('package.json')) projectType = 'node';
  else if (files.includes('requirements.txt') || files.includes('setup.py') || files.includes('pyproject.toml')) projectType = 'python';
  else if (files.includes('Cargo.toml')) projectType = 'rust';
  else if (files.includes('go.mod')) projectType = 'go';
  else if (files.includes('Gemfile')) projectType = 'ruby';
  else if (files.includes('pom.xml') || files.includes('build.gradle')) projectType = 'java';

  // --- Gather all config files for LLM context ---
  const configContext = {};

  // README
  for (const f of ['README.md', 'readme.md', 'README.txt', 'README', 'readme.rst', 'README.rst']) {
    const content = await safeRead(repoDir, f);
    if (content) { configContext.readme = content.substring(0, 5000); break; }
  }

  // package.json (full scripts section is critical for node projects)
  if (files.includes('package.json')) {
    const raw = await safeRead(repoDir, 'package.json');
    if (raw) {
      try {
        const pkg = JSON.parse(raw);
        configContext.packageJson = {
          name: pkg.name, main: pkg.main, bin: pkg.bin,
          scripts: pkg.scripts || {},
          dependencies: Object.keys(pkg.dependencies || {}),
          devDependencies: Object.keys(pkg.devDependencies || {}),
        };
      } catch {}
    }
  }

  // Python configs
  if (files.includes('pyproject.toml')) {
    configContext.pyprojectToml = (await safeRead(repoDir, 'pyproject.toml')).substring(0, 3000);
  }
  if (files.includes('setup.py')) {
    configContext.setupPy = (await safeRead(repoDir, 'setup.py')).substring(0, 2000);
  }
  if (files.includes('setup.cfg')) {
    configContext.setupCfg = (await safeRead(repoDir, 'setup.cfg')).substring(0, 2000);
  }

  // Makefile
  if (files.includes('Makefile') || files.includes('makefile')) {
    configContext.makefile = (await safeRead(repoDir, files.includes('Makefile') ? 'Makefile' : 'makefile')).substring(0, 3000);
  }

  // Docker
  if (files.includes('docker-compose.yml') || files.includes('docker-compose.yaml')) {
    const f = files.includes('docker-compose.yml') ? 'docker-compose.yml' : 'docker-compose.yaml';
    configContext.dockerCompose = (await safeRead(repoDir, f)).substring(0, 2000);
  }
  if (files.includes('Dockerfile')) {
    configContext.dockerfile = (await safeRead(repoDir, 'Dockerfile')).substring(0, 2000);
  }

  // Procfile (Heroku-style)
  if (files.includes('Procfile')) {
    configContext.procfile = await safeRead(repoDir, 'Procfile');
  }

  // .env.example / .env.sample (to know required env vars)
  for (const f of ['.env.example', '.env.sample', 'env.example']) {
    if (files.includes(f)) {
      configContext.envExample = await safeRead(repoDir, f);
      break;
    }
  }

  // Cargo.toml for Rust
  if (files.includes('Cargo.toml')) {
    configContext.cargoToml = (await safeRead(repoDir, 'Cargo.toml')).substring(0, 2000);
  }

  // go.mod
  if (files.includes('go.mod')) {
    configContext.goMod = (await safeRead(repoDir, 'go.mod')).substring(0, 1000);
  }

  // Build the LLM prompt with all gathered context
  let contextBlock = `Repository: ${repoName}\nDetected type: ${projectType}\nTop-level files: ${files.slice(0, 60).join(', ')}\n`;

  if (configContext.readme) contextBlock += `\n=== README ===\n${configContext.readme}\n`;
  if (configContext.packageJson) contextBlock += `\n=== package.json ===\n${JSON.stringify(configContext.packageJson, null, 2)}\n`;
  if (configContext.pyprojectToml) contextBlock += `\n=== pyproject.toml ===\n${configContext.pyprojectToml}\n`;
  if (configContext.setupPy) contextBlock += `\n=== setup.py ===\n${configContext.setupPy}\n`;
  if (configContext.setupCfg) contextBlock += `\n=== setup.cfg ===\n${configContext.setupCfg}\n`;
  if (configContext.makefile) contextBlock += `\n=== Makefile ===\n${configContext.makefile}\n`;
  if (configContext.dockerCompose) contextBlock += `\n=== docker-compose.yml ===\n${configContext.dockerCompose}\n`;
  if (configContext.dockerfile) contextBlock += `\n=== Dockerfile ===\n${configContext.dockerfile}\n`;
  if (configContext.procfile) contextBlock += `\n=== Procfile ===\n${configContext.procfile}\n`;
  if (configContext.envExample) contextBlock += `\n=== .env.example ===\n${configContext.envExample}\n`;
  if (configContext.cargoToml) contextBlock += `\n=== Cargo.toml ===\n${configContext.cargoToml}\n`;
  if (configContext.goMod) contextBlock += `\n=== go.mod ===\n${configContext.goMod}\n`;

  // Defaults in case LLM fails
  let installCmd = '';
  let runCmd = '';
  let skills = [];
  let readmeSummary = '';

  try {
    llm.initDefaults(userId);
    const result = await llm.chat(userId, [
      {
        role: 'system',
        content: `You are a DevOps expert. Analyze this cloned repository and determine EXACTLY how to install dependencies and run it.

Return ONLY valid JSON (no markdown fences, no explanation):
{
  "summary": "One sentence: what this repo does",
  "skills": ["capability1", "capability2", "capability3"],
  "project_type": "node|python|rust|go|ruby|java|unknown",
  "install_cmd": "exact command to install dependencies (e.g. npm install, py -m pip install -r requirements.txt)",
  "run_cmd": "exact command to run/start the project",
  "env_vars": ["VAR1=default", "VAR2=default"],
  "notes": "any important setup notes (optional)"
}

RULES:
- For Node.js: check package.json scripts — prefer "dev" script, then "start", then "main" field. Use npm/npx.
- For Python: use "py" not "python" (Windows). Use "py -m pip" not "pip". Check for entry points in pyproject.toml [tool.poetry.scripts] or [project.scripts], manage.py (Django), app.py (Flask), main.py, bot.py, server.py.
- For Rust: cargo build / cargo run
- For Go: go run . or check Makefile
- Check Procfile for the exact run command (web: line)
- Check Makefile for "run", "start", "dev", "serve" targets
- Check docker-compose for main service command
- If README has "Getting Started" or "Usage" section, follow those instructions
- install_cmd and run_cmd must be concrete shell commands, not descriptions
- If you truly cannot determine run_cmd, set it to null`
      },
      { role: 'user', content: contextBlock }
    ]);

    try {
      const parsed = JSON.parse(result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
      skills = parsed.skills || [];
      readmeSummary = parsed.summary || '';
      if (parsed.project_type && parsed.project_type !== 'unknown') projectType = parsed.project_type;
      if (parsed.install_cmd) installCmd = fixPythonCmds(parsed.install_cmd);
      if (parsed.run_cmd && parsed.run_cmd !== 'null') runCmd = fixPythonCmds(parsed.run_cmd);

      // Copy .env.example to .env if needed and env vars are specified
      if (parsed.env_vars?.length > 0 && configContext.envExample) {
        const { copyFile } = await import('fs/promises');
        const { existsSync } = await import('fs');
        const envPath = join(repoDir, '.env');
        if (!existsSync(envPath)) {
          const exampleFile = files.find(f => ['.env.example', '.env.sample', 'env.example'].includes(f));
          if (exampleFile) {
            try { await copyFile(join(repoDir, exampleFile), envPath); } catch {}
          }
        }
      }
    } catch {}
  } catch {}

  // Hardcoded fallbacks if LLM returned nothing
  if (!installCmd) {
    if (projectType === 'node') installCmd = 'npm install';
    else if (projectType === 'python' && files.includes('requirements.txt')) installCmd = 'py -m pip install -r requirements.txt';
    else if (projectType === 'python' && files.includes('pyproject.toml')) installCmd = 'py -m pip install -e .';
    else if (projectType === 'rust') installCmd = 'cargo build';
    else if (projectType === 'go') installCmd = 'go mod download';
  }
  if (!runCmd) {
    if (projectType === 'node') {
      // Quick package.json check
      const pkgScripts = configContext.packageJson?.scripts || {};
      if (pkgScripts.dev) runCmd = 'npm run dev';
      else if (pkgScripts.start) runCmd = 'npm start';
      else if (configContext.packageJson?.main) runCmd = `node ${configContext.packageJson.main}`;
      else runCmd = 'node index.js';
    } else if (projectType === 'python') {
      if (files.includes('manage.py')) runCmd = 'py manage.py runserver';
      else if (files.includes('app.py')) runCmd = 'py app.py';
      else if (files.includes('main.py')) runCmd = 'py main.py';
      else if (files.includes('bot.py')) runCmd = 'py bot.py';
      else if (files.includes('server.py')) runCmd = 'py server.py';
      else runCmd = 'py main.py';
    } else if (projectType === 'rust') runCmd = 'cargo run';
    else if (projectType === 'go') runCmd = 'go run .';
  }

  return { projectType, installCmd, runCmd, skills, readmeSummary, files };
}

/**
 * Gather repo context for LLM auto-fix: README, config files, file listing.
 * Lighter than analyzeRepo — just collects text, no LLM call.
 */
export async function gatherRepoContext(repoDir) {
  const files = await readdir(repoDir).catch(() => []);
  const parts = [`Top-level files: ${files.slice(0, 60).join(', ')}`];

  // README (truncated)
  for (const f of ['README.md', 'readme.md', 'README.txt', 'README']) {
    const content = await safeRead(repoDir, f);
    if (content) {
      // Extract just install/usage sections if possible
      const sections = content.match(/#{1,3}\s*(install|setup|usage|getting started|quick start|running|run)[^\n]*\n[\s\S]*?(?=\n#{1,3}\s|\n$)/gi);
      if (sections) {
        parts.push(`=== README (relevant sections) ===\n${sections.join('\n').substring(0, 3000)}`);
      } else {
        parts.push(`=== README ===\n${content.substring(0, 2000)}`);
      }
      break;
    }
  }

  // package.json scripts
  if (files.includes('package.json')) {
    const raw = await safeRead(repoDir, 'package.json');
    if (raw) {
      try {
        const pkg = JSON.parse(raw);
        parts.push(`=== package.json scripts ===\n${JSON.stringify(pkg.scripts || {}, null, 2)}`);
        if (pkg.main) parts.push(`main: ${pkg.main}`);
      } catch {}
    }
  }

  // Python configs
  if (files.includes('pyproject.toml')) {
    parts.push(`=== pyproject.toml ===\n${(await safeRead(repoDir, 'pyproject.toml')).substring(0, 2000)}`);
  }
  if (files.includes('requirements.txt')) {
    parts.push(`=== requirements.txt (first 30 lines) ===\n${(await safeRead(repoDir, 'requirements.txt')).split('\n').slice(0, 30).join('\n')}`);
  }

  // Makefile
  const mf = files.includes('Makefile') ? 'Makefile' : files.includes('makefile') ? 'makefile' : null;
  if (mf) parts.push(`=== ${mf} ===\n${(await safeRead(repoDir, mf)).substring(0, 2000)}`);

  // Procfile
  if (files.includes('Procfile')) parts.push(`=== Procfile ===\n${await safeRead(repoDir, 'Procfile')}`);

  // Docker
  const dc = files.find(f => f.startsWith('docker-compose'));
  if (dc) parts.push(`=== ${dc} ===\n${(await safeRead(repoDir, dc)).substring(0, 1500)}`);
  if (files.includes('Dockerfile')) parts.push(`=== Dockerfile ===\n${(await safeRead(repoDir, 'Dockerfile')).substring(0, 1500)}`);

  // .env.example
  const envEx = files.find(f => ['.env.example', '.env.sample', 'env.example'].includes(f));
  if (envEx) parts.push(`=== ${envEx} ===\n${await safeRead(repoDir, envEx)}`);

  // config examples
  const configEx = files.find(f => /config\.example|config\.sample|example\.config/i.test(f));
  if (configEx) parts.push(`=== ${configEx} ===\n${(await safeRead(repoDir, configEx)).substring(0, 1500)}`);

  return parts.join('\n\n');
}

/**
 * Ask LLM to generate a step-by-step run plan for a repo.
 * Instead of hardcoded commands, the LLM reads the full repo context
 * and decides what setup/install/run steps are needed.
 *
 * @returns {{ steps: Array<{label: string, cmd: string}>, run_cmd: string, install_cmd: string }}
 */
export async function generateRunPlan(repoDir, repoName, projectType, llm, userId) {
  const context = await gatherRepoContext(repoDir);

  llm.initDefaults(userId);
  const result = await llm.chat(userId, [
    {
      role: 'system',
      content: `You are a DevOps expert. I cloned a git repo and need to run it on Windows.
Read the repo's README, config files, and file listing below. Then give me the EXACT step-by-step commands to set it up and run it.

Return ONLY valid JSON (no markdown fences):
{
  "steps": [
    { "label": "Copy config template", "cmd": "copy config.example.json config.json" },
    { "label": "Install dependencies", "cmd": "py -m pip install -r requirements.txt" },
    { "label": "Start application", "cmd": "py src/main.py" }
  ],
  "run_cmd": "the final start/run command (for future quick-start)",
  "install_cmd": "the install dependencies command (for future quick-start)"
}

RULES:
- This is Windows. Use "py" not "python", "py -m pip" not "pip", "copy" not "cp"
- Read the README Installation/Setup/Usage sections carefully — follow them exactly
- If README says to copy/rename a config file, include that as a step
- If README says to create a virtualenv, include "py -m venv venv" then "venv\\Scripts\\activate" steps
- Include dependency installation as a step
- The LAST step should be the actual run command (the thing that starts the app)
- Each cmd must be a single shell command (no && chaining, no multiline)
- Order matters — steps run sequentially
- If install might fail due to Python version incompatibility, add "--ignore-requires-python" flag
- Be specific: use exact file paths from the file listing (e.g. "py src/main.py" not "py main.py")
- CRITICAL: All commands MUST be non-interactive. Never use commands that prompt for Y/N or any user input.
  - pip: always add "--yes" or use "py -m pip install" (pip install doesn't prompt, but pip uninstall does — add "-y")
  - npm: add "--yes" if prompted
  - For any destructive command, add the force/yes flag (e.g. "rmdir /s /q", "del /f /q")
  - For git: add "--no-input" or configure non-interactive mode
- Typically 2-5 steps total`
    },
    {
      role: 'user',
      content: `Repo: ${repoName}\nType: ${projectType}\n\n${context}`
    }
  ]);

  const parsed = JSON.parse(result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim());

  // Fix python commands in all steps
  if (parsed.steps) {
    for (const step of parsed.steps) {
      step.cmd = fixPythonCmds(step.cmd);
    }
  }
  if (parsed.run_cmd) parsed.run_cmd = fixPythonCmds(parsed.run_cmd);
  if (parsed.install_cmd) parsed.install_cmd = fixPythonCmds(parsed.install_cmd);

  return parsed;
}

/**
 * Ask LLM to diagnose a failed step and suggest a fix.
 * Returns fix commands + optionally a corrected step command.
 */
export async function diagnoseStepFailure(repoDir, repoName, projectType, failedStep, errorOutput, prevAttempts, llm, userId) {
  const context = await gatherRepoContext(repoDir);

  llm.initDefaults(userId);
  const result = await llm.chat(userId, [
    {
      role: 'system',
      content: `You are a DevOps expert. A setup step for a cloned git repo failed on Windows.
Read the error, cross-reference with the repo docs, and figure out the fix.

Return ONLY valid JSON (no markdown fences):
{
  "diagnosis": "What went wrong (1-2 sentences)",
  "fix_commands": ["shell command 1", "shell command 2"],
  "retry_cmd": "corrected version of the failed command (or null if original is fine after fixes)",
  "give_up": false
}

RULES:
- This is Windows. Use "py" not "python", "py -m pip" not "pip", "copy" not "cp"
- If a package has Python version incompatibility, try: "py -m pip install <pkg> --ignore-requires-python"
- If a module is missing, install it
- Each fix_command is a single shell command
- CRITICAL: All commands MUST be non-interactive. Never use commands that prompt for Y/N or user input.
  - pip uninstall: always add "-y" flag
  - Use force/quiet flags for destructive operations (e.g. "rmdir /s /q", "del /f /q")
- IMPORTANT: Look at PREVIOUS ATTEMPTS carefully. If the same error keeps repeating, your previous fix didn't work.
  Try a FUNDAMENTALLY DIFFERENT approach, not the same fix again.
  Examples of different approaches: use a different package version, skip optional deps, use --no-deps,
  install from source, use a different tool, modify config files, set env vars.
- If you believe this error is UNFIXABLE (e.g. requires manual setup, GUI interaction, paid API key,
  unsupported OS, hardware requirement), set "give_up": true and explain why in diagnosis.
- Don't repeat previous failed fixes`
    },
    {
      role: 'user',
      content: `Repo: ${repoName} (${projectType})
Failed step: ${failedStep.label} → ${failedStep.cmd}

=== ERROR ===
${errorOutput.substring(0, 2000)}

=== PREVIOUS ATTEMPTS ===
${prevAttempts.length > 0 ? prevAttempts.join('\n') : 'None'}

=== REPO CONTEXT ===
${context}`
    }
  ]);

  const parsed = JSON.parse(result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
  if (parsed.fix_commands) {
    parsed.fix_commands = parsed.fix_commands.map(c => fixPythonCmds(c));
  }
  if (parsed.retry_cmd) parsed.retry_cmd = fixPythonCmds(parsed.retry_cmd);
  return parsed;
}

export const gitRepoManager = {
  create(userId, url, name, cloneDir, projectType, installCmd, runCmd, skills, readmeSummary) {
    const result = db.prepare(
      'INSERT INTO git_repos (user_id, url, name, clone_dir, project_type, install_cmd, run_cmd, skills, readme_summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(userId, url, name, cloneDir, projectType || 'unknown', installCmd || '', runCmd || '', JSON.stringify(skills || []), readmeSummary || '');
    return this.get(result.lastInsertRowid);
  },

  get(id) {
    return parse(db.prepare('SELECT * FROM git_repos WHERE id = ?').get(id));
  },

  listByUser(userId) {
    return db.prepare('SELECT * FROM git_repos WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId).map(r => parse(r));
  },

  listAll() {
    return db.prepare('SELECT * FROM git_repos ORDER BY created_at DESC')
      .all().map(r => parse(r));
  },

  update(id, fields) {
    const sets = [];
    const vals = [];
    for (const [key, val] of Object.entries(fields)) {
      sets.push(`${key} = ?`);
      vals.push(typeof val === 'object' ? JSON.stringify(val) : val);
    }
    if (sets.length === 0) return;
    vals.push(id);
    db.prepare(`UPDATE git_repos SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  },

  findByUrl(userId, url) {
    return parse(db.prepare('SELECT * FROM git_repos WHERE user_id = ? AND url = ?').get(userId, url));
  },

  delete(id) {
    db.prepare('DELETE FROM git_repos WHERE id = ?').run(id);
  },
};
