import { exec } from 'child_process';
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
  async runCommand(command, cwd = process.cwd(), timeout = 30000) {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout,
        maxBuffer: 1024 * 1024,
      });
      return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (err) {
      return {
        ok: false,
        stdout: err.stdout?.trim() || '',
        stderr: err.stderr?.trim() || err.message,
        code: err.code,
      };
    }
  },

  // Generate QA test for a task using LLM
  async generateTest(userId, task) {
    const prompt = `You are a QA engineer. Generate a simple test plan for this task:

Task: ${task.title}
Description: ${task.description || 'N/A'}

Return a JSON object with:
{
  "test_type": "cli" | "visual" | "manual",
  "commands": ["command1", "command2"],
  "expected": "what should happen",
  "checks": ["check1", "check2"]
}

If the task involves UI, set test_type to "visual".
If it can be verified via CLI commands, set test_type to "cli".
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
      } else if (testPlan.test_type === 'visual') {
        qaResult = {
          type: 'visual',
          plan: testPlan,
          passed: false,
          notes: 'Visual QA requires manual screenshot upload or URL. Use /qa_screenshot <task_id> <url>',
        };
      } else {
        qaResult = {
          type: 'manual',
          plan: testPlan,
          passed: false,
          notes: 'Manual verification required',
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
