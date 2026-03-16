/**
 * Auto-fix: validates generated projects and sends errors to LLM for repair.
 *
 * Flow:
 *  1. tryRun()  — runs the entry point with a short timeout, captures crash output
 *  2. fixWithLLM() — sends crash + file contents to LLM, gets patched files back
 *  3. autoFixLoop() — orchestrates up to MAX_FIX_ATTEMPTS rounds of try→fix
 */

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { readFile, writeFile, mkdir as fsMkdir, readdir, stat } from 'fs/promises';

const MAX_FIX_ATTEMPTS = 2;
const RUN_TIMEOUT_MS = 8000; // 8 seconds — enough to hit import/syntax errors

/**
 * Try running the entry point. Returns { ok, error, stderr }
 */
export async function tryRun(projectDir, runCmd) {
  return new Promise((resolve) => {
    let stderr = '';
    let stdout = '';
    let finished = false;

    const proc = spawn(runCmd, {
      cwd: projectDir,
      shell: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });

    proc.stdout?.on('data', d => { stdout += d.toString(); });
    proc.stderr?.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        try { proc.kill(); } catch {}
        // If it ran for 8s without crashing, it's probably fine
        resolve({ ok: true, stdout, stderr, timedOut: true });
      }
    }, RUN_TIMEOUT_MS);

    proc.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve({ ok: true, stdout, stderr });
      } else {
        // Extract the meaningful error from stderr
        const errorText = (stderr || stdout).trim();
        resolve({ ok: false, code, error: errorText, stderr, stdout });
      }
    });

    proc.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, error: err.message, stderr: '', stdout: '' });
    });
  });
}

/**
 * Collect all source files in a project directory
 */
async function collectFiles(projectDir) {
  const result = [];
  async function scan(dir) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === '__pycache__' || e.name === '.venv') continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          await scan(full);
        } else {
          const rel = full.replace(projectDir, '').replace(/\\/g, '/').replace(/^\//, '');
          try {
            const content = await readFile(full, 'utf-8');
            result.push({ path: rel, content });
          } catch {} // skip binary files
        }
      }
    } catch {}
  }
  await scan(projectDir);
  return result;
}

/**
 * Parse ===FILE:===...===ENDFILE=== blocks from LLM response
 */
function parseFileBlocks(text) {
  const fileRegex = /===FILE:\s*(.+?)\s*===\n([\s\S]*?)===ENDFILE===/g;
  const files = [];
  let match;
  while ((match = fileRegex.exec(text)) !== null) {
    let filePath = match[1].trim().replace(/\\/g, '/');
    const content = match[2].trimEnd() + '\n';
    if (filePath.includes('..') || filePath.startsWith('/')) continue;
    files.push({ path: filePath, content });
  }
  return files;
}

/**
 * Send error + file contents to LLM, get fixed files back
 */
async function fixWithLLM(llm, userId, proj, projectDir, errorText, attempt) {
  const existingFiles = await collectFiles(projectDir);

  // Build file listing for context
  let fileContext = '';
  for (const f of existingFiles) {
    // Limit file content to prevent exceeding context
    const truncated = f.content.length > 3000 ? f.content.substring(0, 3000) + '\n...TRUNCATED...' : f.content;
    fileContext += `===FILE: ${f.path}===\n${truncated}\n===ENDFILE===\n\n`;
  }

  const isPython = proj.tech_stack === 'python';
  const runCmd = proj.run_command || (isPython ? 'py main.py' : 'node index.js');
  const entryFile = runCmd.split(' ').pop();

  const result = await llm.chat(userId, [
    {
      role: 'system',
      content: `You are a senior software engineer debugging a ${isPython ? 'Python' : 'Node.js'} project.

The project was generated but CRASHES on startup with this error:

\`\`\`
${errorText.substring(0, 2000)}
\`\`\`

Here are ALL the current project files:

${fileContext}

FIX THE BUG. Common issues:
- Importing from modules/files that don't exist → create the missing files OR change imports to match existing files
- Missing __init__.py for Python packages → add them
- Wrong import paths → fix to match actual file structure
- Using unavailable libraries → replace with stdlib alternatives or simpler code
- Syntax errors → fix the syntax

RULES:
- Output ONLY the files that need to be CREATED or MODIFIED (don't repeat unchanged files)
- Use the same ===FILE: path===...===ENDFILE=== format
- The entry point is "${entryFile}" — it must work after your fixes
- Keep the project functional — don't gut features, fix the actual issues
- If the project uses a src/ directory structure, make sure __init__.py files exist
- ${isPython ? 'All commands should use "py" not "python", "py -m pip" not "pip"' : 'Use ESM imports'}
- This is fix attempt ${attempt}/${MAX_FIX_ATTEMPTS} — be thorough`
    },
    {
      role: 'user',
      content: `Fix this crash. The project "${proj.title}" fails with:\n${errorText.substring(0, 1000)}\n\nOutput only the fixed/new files.`
    }
  ]);

  return { text: result.text, provider: result.provider };
}

/**
 * Main auto-fix loop: try run → if crash → LLM fix → write files → retry
 * Returns { ok, attempts, fixes[], warnings[], files[] }
 */
export async function autoFixLoop(llm, userId, proj, projectDir, files, opts = {}) {
  const isPython = proj.tech_stack === 'python';
  const runCmd = proj.run_command || (isPython ? 'py main.py' : 'node index.js');
  const onProgress = opts.onProgress || (() => {});
  const fixes = [];
  const warnings = [];

  for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
    onProgress(`🔍 Validating project (attempt ${attempt})...`);

    const result = await tryRun(projectDir, runCmd);

    if (result.ok) {
      if (attempt > 1) {
        onProgress(`✅ Auto-fix successful after ${attempt - 1} fix(es)`);
      }
      return { ok: true, attempts: attempt, fixes, warnings, files };
    }

    // It crashed — try to fix
    const errorText = result.error || 'Unknown error';
    onProgress(`⚠️ Crash detected:\n${errorText.substring(0, 300)}\n\n🔧 Sending to LLM for auto-fix (attempt ${attempt}/${MAX_FIX_ATTEMPTS})...`);

    try {
      const fixResult = await fixWithLLM(llm, userId, proj, projectDir, errorText, attempt);
      const fixedFiles = parseFileBlocks(fixResult.text);

      if (fixedFiles.length === 0) {
        warnings.push(`Fix attempt ${attempt}: LLM returned no file changes`);
        onProgress(`⚠️ LLM returned no fixes`);
        break;
      }

      // Write fixed files
      for (const f of fixedFiles) {
        const fullPath = join(projectDir, ...f.path.split('/'));
        await fsMkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, f.content, 'utf-8');

        // Track in files array
        const existing = files.findIndex(ef => ef.path === f.path);
        if (existing >= 0) {
          files[existing].size = f.content.length;
          files[existing].fixed = true;
        } else {
          files.push({ path: f.path, size: f.content.length, fixed: true });
        }
      }

      fixes.push({
        attempt,
        error: errorText.substring(0, 500),
        filesFixed: fixedFiles.map(f => f.path),
        provider: fixResult.provider,
      });

      onProgress(`📝 Fixed ${fixedFiles.length} file(s): ${fixedFiles.map(f => f.path).join(', ')}`);
    } catch (fixErr) {
      warnings.push(`Fix attempt ${attempt} failed: ${fixErr.message}`);
      onProgress(`❌ Auto-fix error: ${fixErr.message}`);
      break;
    }
  }

  // Final check after all fix attempts
  const finalResult = await tryRun(projectDir, runCmd);
  if (finalResult.ok) {
    onProgress(`✅ Project validated successfully after ${fixes.length} fix(es)`);
    return { ok: true, attempts: fixes.length + 1, fixes, warnings, files };
  }

  // Still broken — report but don't block
  const finalError = finalResult.error || 'Unknown error';
  warnings.push(`Project still has issues after ${fixes.length} fix attempt(s): ${finalError.substring(0, 200)}`);
  onProgress(`⚠️ Project may still have issues — ${fixes.length} fix(es) applied but errors remain`);

  return { ok: false, attempts: fixes.length + 1, fixes, warnings, files, lastError: finalError };
}
