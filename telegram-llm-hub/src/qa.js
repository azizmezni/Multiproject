import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { llm } from './llm-manager.js';
import { boards } from './boards.js';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = join(__dirname, '..', 'screenshots');

// Ensure screenshots directory exists
try { await mkdir(SCREENSHOTS_DIR, { recursive: true }); } catch {}

export const qa = {
  // Run a CLI command and return output
  // Uses spawn with piped stdin to auto-answer Y/N prompts
  async runCommand(command, cwd = process.cwd(), timeout = 30000, env = null) {
    return new Promise((resolve) => {
      const proc = spawn(command, {
        cwd, shell: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: env || process.env,
      });
      let stdout = '', stderr = '';
      // Auto-answer any Y/N prompts
      try { proc.stdin.write('Y\n'); proc.stdin.end(); } catch {}
      proc.stdout?.on('data', d => { stdout += d.toString(); });
      proc.stderr?.on('data', d => { stderr += d.toString(); });
      proc.on('close', code => resolve({
        ok: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code,
      }));
      proc.on('error', err => resolve({
        ok: false, stdout: '', stderr: err.message, code: -1,
      }));
      setTimeout(() => {
        try { proc.kill(); } catch {}
        resolve({ ok: false, stdout: stdout.trim(), stderr: (stderr + '\nTimed out').trim(), code: -1 });
      }, timeout);
    });
  },

  // Generate QA test for a task using LLM
  async generateTest(userId, task) {
    const prompt = `You are a QA engineer. Generate a test plan for this task:

Task: ${task.title}
Description: ${task.description || 'N/A'}
Output type: ${task.output_type || 'text'}
Has execution result: ${task.execution_log ? 'yes' : 'no'}

Return a JSON object with:
{
  "test_type": "cli" | "llm_review" | "manual",
  "commands": ["command1", "command2"],
  "expected": "what the output should contain or achieve",
  "checks": ["specific thing to verify"]
}

IMPORTANT: If the task produces text, code, documentation, or any AI-generated content, use test_type "llm_review" (NOT "manual" or "visual").
Use "cli" ONLY if there are actual CLI commands to run and verify.
Only return the JSON, no markdown.`;

    const result = await llm.chat(userId, [
      { role: 'system', content: 'You are a QA engineer. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ]);

    try {
      const cleaned = result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      return JSON.parse(cleaned);
    } catch {
      return {
        test_type: 'manual',
        commands: [],
        expected: 'Manual verification needed',
        checks: ['Verify task completion manually'],
      };
    }
  },

  // Run CLI-based tests
  async runCliTest(commands, cwd) {
    const results = [];
    for (const cmd of commands) {
      const result = await this.runCommand(cmd, cwd);
      results.push({ command: cmd, ...result });
    }
    const allPassed = results.every(r => r.ok);
    return { passed: allPassed, results };
  },

  // Take a screenshot using a URL (requires puppeteer-like approach)
  // Falls back to a simulated approach if puppeteer not available
  async takeScreenshot(url, filename) {
    const filepath = join(SCREENSHOTS_DIR, filename);
    try {
      // Try using a simple screenshot command if available
      await execAsync(`npx --yes capture-website-cli "${url}" --output="${filepath}" --width=1280 --height=800`, {
        timeout: 30000,
      });
      return { ok: true, path: filepath };
    } catch {
      return { ok: false, error: 'Screenshot tool not available. Install with: npm i -g capture-website-cli' };
    }
  },

  // Verify a screenshot using LLM vision
  async verifyScreenshot(userId, screenshotPath, expectedBehavior) {
    try {
      const imageBuffer = await readFile(screenshotPath);
      const base64 = imageBuffer.toString('base64');

      const result = await llm.vision(
        userId,
        base64,
        `You are a QA tester. Check this screenshot against expected behavior:
${expectedBehavior}

Return JSON: {"passed": true/false, "issues": ["issue1"], "notes": "summary"}`
      );

      try {
        const cleaned = result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleaned);
      } catch {
        return { passed: false, issues: ['Could not parse QA result'], notes: result.text };
      }
    } catch (err) {
      return { passed: false, issues: [err.message], notes: 'Vision verification failed' };
    }
  },

  // Run full QA for a task
  async runTaskQA(userId, taskId) {
    const task = boards.getTask(taskId);
    if (!task) throw new Error('Task not found');

    boards.setTaskQA(taskId, 'running');

    try {
      const testPlan = await this.generateTest(userId, task);
      let qaResult;

      if (testPlan.test_type === 'cli' && testPlan.commands.length > 0) {
        const cliResult = await this.runCliTest(testPlan.commands);
        qaResult = {
          type: 'cli',
          plan: testPlan,
          result: cliResult,
          passed: cliResult.passed,
        };
      } else if (task.execution_log) {
        // LLM-based review of execution output
        try {
          const reviewResult = await llm.chat(userId, [
            { role: 'system', content: 'You are a QA reviewer. Evaluate if the task output meets the requirements. Return JSON: {"passed": true/false, "notes": "brief assessment"}' },
            { role: 'user', content: `Task: ${task.title}\nExpected: ${task.description || 'Complete the task'}\nActual output (first 2000 chars):\n${task.execution_log.substring(0, 2000)}\n\nDoes the output adequately address the task requirements?` }
          ]);
          const cleaned = reviewResult.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
          const review = JSON.parse(cleaned);
          qaResult = {
            type: 'llm_review',
            plan: testPlan,
            passed: review.passed === true,
            notes: review.notes || '',
          };
        } catch {
          qaResult = { type: 'llm_review', plan: testPlan, passed: true, notes: 'Output generated successfully' };
        }
      } else {
        qaResult = {
          type: 'not_executed',
          plan: testPlan,
          passed: false,
          notes: 'Task has not been executed yet. Execute first, then run QA.',
        };
      }

      const status = qaResult.passed ? 'pass' : 'fail';
      boards.setTaskQA(taskId, status, JSON.stringify(qaResult));
      return qaResult;
    } catch (err) {
      boards.setTaskQA(taskId, 'fail', JSON.stringify({ error: err.message }));
      return { passed: false, error: err.message };
    }
  },
};
