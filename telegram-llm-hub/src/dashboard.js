import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readdir, readFile, stat, writeFile as fsWriteFile, mkdir as fsMkdir, access } from 'fs/promises';
import { spawn, exec as execCb } from 'child_process';
import { existsSync } from 'fs';
import http from 'http';
import db from './db.js';
import { llm } from './llm-manager.js';
import { sessions } from './sessions.js';
import { boards } from './boards.js';
import { drafts } from './drafts.js';
import { workflows, NODE_TYPES } from './workflows.js';
import { gamification } from './gamification.js';
import { qa } from './qa.js';
import { PROVIDER_REGISTRY } from './providers.js';
import { scheduler } from './scheduler.js';
import { costTracker } from './cost-tracker.js';
import { challenges } from './challenges.js';
import { memory } from './memory.js';
import { templates } from './templates.js';
import { plugins } from './plugins.js';
import featureRoutes, { setUserIdResolver } from './routes/features.js';
import { projectManager } from './project-manager.js';
import { autoFixLoop } from './auto-fix.js';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Exported project management ---
const runningProjects = new Map(); // name -> { process, port, logs }
const persistedLogs = new Map();   // "gen-<id>" -> string[] — logs survive after process stops
const dashboardRunning = new Map(); // boardId -> true — tracks dashboard-initiated board executions
let nextProjectPort = 10001;
const freedPorts = []; // reclaim ports from stopped projects

// Cleanup child processes on shutdown
function cleanupProjects() {
  for (const [name, project] of runningProjects) {
    try { project.process.kill(); } catch {}
  }
  runningProjects.clear();
}
process.on('exit', cleanupProjects);
process.on('SIGINT', () => { cleanupProjects(); process.exit(0); });
process.on('SIGTERM', () => { cleanupProjects(); process.exit(0); });

export function createDashboard(port = 9999) {
  const app = express();

  // --- Subdomain proxy MUST be before express.json() so body stream is intact ---
  app.use((req, res, next) => {
    const host = req.hostname || '';
    const parts = host.split('.');
    if (parts.length >= 2 && parts[parts.length - 1] === 'localhost') {
      const subdomain = parts.slice(0, -1).join('.').toLowerCase();
      if (subdomain && subdomain !== 'localhost') {
        const project = runningProjects.get(subdomain);
        if (project) {
          const proxyReq = http.request({
            hostname: '127.0.0.1', port: project.port,
            path: req.originalUrl, method: req.method,
            headers: { ...req.headers, host: `localhost:${project.port}` },
          }, (proxyRes) => {
            proxyRes.on('error', () => {
              if (!res.headersSent) res.status(502).json({ error: 'Proxy response error' });
            });
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
          });
          proxyReq.on('error', () => {
            if (!res.headersSent) {
              res.status(502).json({ error: `Project "${subdomain}" is not responding on port ${project.port}` });
            }
          });
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            req.pipe(proxyReq);
          } else {
            proxyReq.end();
          }
          return;
        }
        return res.status(404).json({ error: `Project "${subdomain}" is not running. Start it from the Projects tab.` });
      }
    }
    next();
  });

  app.use(express.json({ limit: '5mb' }));
  app.use(express.static(join(__dirname, 'public')));

  // Resolve userId: use query param or first known user, or default 1
  function getUserId(req) {
    if (req.query.userId) {
      const parsed = parseInt(req.query.userId);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    const row = db.prepare('SELECT DISTINCT user_id FROM providers LIMIT 1').get();
    return row?.user_id || 1;
  }

  // ==================== PROVIDERS ====================
  app.get('/api/providers', (req, res) => {
    const userId = getUserId(req);
    llm.initDefaults(userId);
    const providers = llm.getProviders(userId);
    const registry = Object.entries(PROVIDER_REGISTRY).map(([k, v]) => ({
      name: k, displayName: v.name, models: v.models, docs: v.docs,
      description: v.description, isLocal: !!v.isLocal,
    }));
    res.json({ providers, registry });
  });

  app.put('/api/providers/:name/toggle', (req, res) => {
    const userId = getUserId(req);
    llm.toggleProvider(userId, req.params.name);
    res.json({ ok: true });
  });

  app.put('/api/providers/:name/reorder', (req, res) => {
    const userId = getUserId(req);
    llm.reorderProvider(userId, req.params.name, req.body.direction);
    res.json({ ok: true });
  });

  app.put('/api/providers/:name/key', (req, res) => {
    const userId = getUserId(req);
    llm.setApiKey(userId, req.params.name, req.body.apiKey);
    gamification.addXP(userId, 'message_sent'); // small XP for config
    res.json({ ok: true });
  });

  app.put('/api/providers/:name/model', (req, res) => {
    const userId = getUserId(req);
    llm.setModel(userId, req.params.name, req.body.model);
    res.json({ ok: true });
  });

  // Test provider connection and latency
  app.post('/api/providers/:name/test', async (req, res) => {
    try {
      const userId = getUserId(req);
      const result = await llm.testProvider(userId, req.params.name);
      res.json(result);
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  // ==================== BOARDS ====================
  app.get('/api/boards', (req, res) => {
    const userId = getUserId(req);
    const list = boards.listByUser(userId).map(b => ({
      ...b,
      tasks: boards.getTasks(b.id),
    }));
    res.json(list);
  });

  app.post('/api/boards', async (req, res) => {
    const userId = getUserId(req);
    llm.initDefaults(userId);
    const { title, auto } = req.body;

    if (auto) {
      try {
        const result = await llm.chat(userId, [
          { role: 'system', content: 'You are a project planner. Return a JSON array of tasks: [{"title":"...","description":"...","requires_input":false,"input_question":null,"tools_needed":[]}]. Only JSON.' },
          { role: 'user', content: `Create a project plan for: ${title}` },
        ]);
        let taskList;
        try {
          taskList = JSON.parse(result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
        } catch { taskList = [{ title: 'Review requirements', description: result.text }]; }

        const board = boards.create(userId, title);
        boards.addTasksFromPlan(board.id, taskList);
        gamification.addXP(userId, 'board_created');
        res.json({ board, tasks: boards.getTasks(board.id) });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    } else {
      const board = boards.create(userId, title, req.body.description || '');
      gamification.addXP(userId, 'board_created');
      res.json({ board, tasks: [] });
    }
  });

  app.get('/api/boards/:id', (req, res) => {
    const summary = boards.getSummary(parseInt(req.params.id));
    if (!summary) return res.status(404).json({ error: 'Not found' });
    res.json(summary);
  });

  app.delete('/api/boards/:id', (req, res) => {
    const boardId = parseInt(req.params.id);
    dashboardRunning.delete(boardId);
    boards.deleteWithTasks(boardId);
    res.json({ ok: true });
  });

  app.post('/api/boards/:id/tasks', (req, res) => {
    const task = boards.addTask(parseInt(req.params.id), req.body.title, req.body.description || '');
    res.json(task);
  });

  app.put('/api/tasks/:id', (req, res) => {
    boards.updateTask(parseInt(req.params.id), req.body);
    if (req.body.status === 'done') {
      gamification.addXP(getUserId(req), 'task_completed');
    }
    res.json({ ok: true });
  });

  app.put('/api/tasks/:id/answer', (req, res) => {
    boards.answerTaskInput(parseInt(req.params.id), req.body.answer);
    res.json({ ok: true });
  });

  app.post('/api/tasks/:id/qa', async (req, res) => {
    const userId = getUserId(req);
    try {
      const result = await qa.runTaskQA(userId, parseInt(req.params.id));
      if (result.passed) gamification.addXP(userId, 'qa_passed');
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Run all pending tasks in a board sequentially (background)
  app.post('/api/boards/:id/execute', async (req, res) => {
    const userId = getUserId(req);
    const boardId = parseInt(req.params.id);

    if (dashboardRunning.has(boardId)) {
      return res.json({ status: 'already_running' });
    }

    boards.updateStatus(boardId, 'executing');
    dashboardRunning.set(boardId, true);
    res.json({ status: 'started' });

    // Background sequential execution
    (async () => {
      try {
        llm.initDefaults(userId);
        const allTasks = boards.getTasks(boardId);
        const completedOutputs = [];

        for (const t of allTasks) {
          if (t.status === 'done' && t.execution_log) {
            completedOutputs.push({ title: t.title, output: t.execution_log });
          }
        }

        for (let i = 0; i < allTasks.length; i++) {
          const task = allTasks[i];
          if (task.status === 'done') continue;
          if (!dashboardRunning.has(boardId)) break;

          boards.setTaskStatus(task.id, 'in_progress');

          try {
            const isLastTask = !allTasks.slice(i + 1).some(t => t.status !== 'done');
            let systemPrompt;

            if (isLastTask && completedOutputs.length > 0) {
              const prevSummary = completedOutputs.map((o, idx) =>
                `--- Module ${idx + 1}: ${o.title} ---\n${o.output.substring(0, 2000)}`
              ).join('\n\n');

              systemPrompt = `You are executing the FINAL integration task of a project. Previous tasks produced these modules:\n\n${prevSummary}\n\nYour job: ${task.title}\nPlan: ${task.description || 'Integrate all modules into a working system.'}\n${task.input_answer ? `User Input: ${task.input_answer}` : ''}\n\nProduce a COMPLETE integration script that imports/uses all previous modules. Include imports, configuration, main entry point, and error handling. Make it production-ready.`;
            } else {
              const prevContext = completedOutputs.length > 0
                ? `\n\nCompleted modules so far:\n${completedOutputs.map(o => `- ${o.title}`).join('\n')}`
                : '';

              systemPrompt = `You are executing a project task. Generate a COMPLETE, STANDALONE script or module.\n\nTask: ${task.title}\nExecution Plan: ${task.description || 'No plan \u2014 use your best judgment.'}\n${task.input_answer ? `User Input: ${task.input_answer}` : ''}\n${task.output_type && task.output_type !== 'text' ? `Expected output type: ${task.output_type}` : ''}${prevContext}\n\nRequirements:\n- Generate a complete, self-contained script/module\n- Include all necessary imports and exports\n- Add error handling\n- Make it production-ready`;
            }

            const result = await llm.chat(userId, [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: `Execute: ${task.title}` }
            ]);

            boards.updateTask(task.id, { execution_log: result.text, status: 'done' });
            completedOutputs.push({ title: task.title, output: result.text });
          } catch (err) {
            console.error(`Dashboard exec failed: ${task.title}`, err.message);
            boards.setTaskStatus(task.id, 'pending');
            dashboardRunning.delete(boardId);
            boards.updateStatus(boardId, 'planning');
            return;
          }
        }

        const finalTasks = boards.getTasks(boardId);
        boards.updateStatus(boardId, finalTasks.every(t => t.status === 'done') ? 'completed' : 'planning');
      } finally {
        dashboardRunning.delete(boardId);
      }
    })();
  });

  // Pause a running board
  app.post('/api/boards/:id/pause', (req, res) => {
    const boardId = parseInt(req.params.id);
    dashboardRunning.delete(boardId);
    boards.updateStatus(boardId, 'planning');
    res.json({ ok: true });
  });

  // Execute a single task
  app.post('/api/tasks/:id/execute', async (req, res) => {
    const userId = getUserId(req);
    const taskId = parseInt(req.params.id);
    const task = boards.getTask(taskId);
    if (!task) return res.status(404).json({ error: 'Not found' });

    boards.setTaskStatus(taskId, 'in_progress');
    res.json({ status: 'started' });

    (async () => {
      try {
        llm.initDefaults(userId);
        const allTasks = boards.getTasks(task.board_id);
        const completedModules = allTasks
          .filter(t => t.status === 'done' && t.execution_log && t.id !== taskId)
          .map(t => `- ${t.title}`);
        const contextNote = completedModules.length > 0
          ? `\n\nCompleted modules so far:\n${completedModules.join('\n')}`
          : '';

        const result = await llm.chat(userId, [
          {
            role: 'system',
            content: `You are executing a project task. Generate a COMPLETE, STANDALONE script or module.\n\nTask: ${task.title}\nExecution Plan: ${task.description || 'No plan \u2014 use your best judgment.'}\n${task.input_answer ? `User Input: ${task.input_answer}` : ''}\n${task.output_type && task.output_type !== 'text' ? `Expected output type: ${task.output_type}` : ''}${contextNote}\n\nRequirements:\n- Generate a complete, self-contained script/module\n- Include all necessary imports and exports\n- Add error handling\n- Make it production-ready`
          },
          { role: 'user', content: `Execute: ${task.title}` }
        ]);

        boards.updateTask(taskId, { execution_log: result.text, status: 'done' });
        gamification.addXP(userId, 'task_completed');
      } catch (err) {
        console.error(`Dashboard task exec failed: ${task.title}`, err.message);
        boards.setTaskStatus(taskId, 'pending');
      }
    })();
  });

  // ==================== BUILD / EXPORT PROJECT ====================

  // Build project — LLM assembles all task outputs into proper file structure
  app.post('/api/boards/:id/build', async (req, res) => {
    const userId = getUserId(req);
    const boardId = parseInt(req.params.id);
    const board = boards.get(boardId);
    if (!board) return res.status(404).json({ error: 'Board not found' });

    const tasks = boards.getTasks(boardId);
    const doneTasks = tasks.filter(t => t.status === 'done' && t.execution_log);
    if (doneTasks.length === 0) return res.status(400).json({ error: 'No completed tasks to build from' });

    // Create project directory
    const slug = board.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').substring(0, 50);
    const projectDir = join(__dirname, '..', 'projects', slug);
    await fsMkdir(projectDir, { recursive: true });

    try {
      llm.initDefaults(userId);

      // Summarize all task outputs for the LLM
      const taskSummaries = doneTasks.map((t, i) => {
        const content = t.execution_log.substring(0, 3000);
        return `=== MODULE ${i + 1}: ${t.title} ===\n${content}\n=== END MODULE ${i + 1} ===`;
      }).join('\n\n');

      const result = await llm.chat(userId, [
        {
          role: 'system',
          content: `You are a project assembler. You receive outputs from multiple project tasks and must combine them into a REAL, RUNNABLE project.

You MUST output ONLY a series of files in this EXACT format — no other text before or after:

===FILE: path/to/file.ext===
actual file content here
===ENDFILE===

===FILE: another/file.ext===
more content
===ENDFILE===

Rules:
- Extract actual code from each module output (strip markdown formatting, explanations, backticks)
- Create proper file names and directory structure (src/, config/, tests/, etc.)
- Create a main entry point file (index.js, main.py, app.js, etc.)
- Create package.json or requirements.txt with all dependencies
- Create a README.md with setup instructions, what each file does, and how to run
- Make sure imports/exports between files are correct and consistent
- Use ONE consistent language/framework (prefer JavaScript/Node.js unless the modules are clearly Python)
- The project must be runnable after "npm install && node index.js" or "pip install -r requirements.txt && python main.py"
- Keep it practical — remove placeholder/dummy logic, make real connections between modules`
        },
        {
          role: 'user',
          content: `Assemble this project "${board.title}" from these ${doneTasks.length} completed modules:\n\n${taskSummaries}`
        }
      ]);

      // Parse the ===FILE:...===ENDFILE=== blocks
      const fileRegex = /===FILE:\s*(.+?)\s*===\n([\s\S]*?)===ENDFILE===/g;
      const files = [];
      let match;

      while ((match = fileRegex.exec(result.text)) !== null) {
        const filePath = match[1].trim().replace(/\\/g, '/');
        const content = match[2].trimEnd() + '\n';

        // Security: prevent path traversal
        if (filePath.includes('..') || filePath.startsWith('/')) continue;

        const fullPath = join(projectDir, ...filePath.split('/'));
        const dir = dirname(fullPath);
        await fsMkdir(dir, { recursive: true });
        await fsWriteFile(fullPath, content, 'utf-8');

        files.push({
          path: filePath,
          size: content.length,
          lines: content.split('\n').length
        });
      }

      // Fallback: if LLM didn't use the format, save raw outputs as individual files
      if (files.length === 0) {
        for (let i = 0; i < doneTasks.length; i++) {
          const t = doneTasks[i];
          const taskSlug = t.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 40);
          const ext = detectExtension(t.execution_log);
          const filename = `${String(i + 1).padStart(2, '0')}-${taskSlug}${ext}`;
          await fsWriteFile(join(projectDir, filename), t.execution_log, 'utf-8');
          files.push({ path: filename, size: t.execution_log.length, lines: t.execution_log.split('\n').length });
        }
        // Save a README
        const readme = `# ${board.title}\n\nGenerated by Telegram LLM Hub\n\n## Modules\n\n${doneTasks.map((t, i) => `${i + 1}. **${t.title}**`).join('\n')}\n`;
        await fsWriteFile(join(projectDir, 'README.md'), readme, 'utf-8');
        files.unshift({ path: 'README.md', size: readme.length, lines: readme.split('\n').length });
      }

      res.json({ ok: true, projectDir, slug, files, provider: result.provider, model: result.model });
    } catch (err) {
      console.error('Build failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Get project file tree and contents
  app.get('/api/boards/:id/project', async (req, res) => {
    const boardId = parseInt(req.params.id);
    const board = boards.get(boardId);
    if (!board) return res.status(404).json({ error: 'Board not found' });

    const slug = board.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').substring(0, 50);
    const projectDir = join(__dirname, '..', 'projects', slug);

    try {
      const files = await walkDir(projectDir, projectDir);
      res.json({ ok: true, slug, projectDir, files });
    } catch {
      res.json({ ok: false, files: [], message: 'Project not built yet. Click "Build Project" to assemble.' });
    }
  });

  // Read a specific project file
  app.get('/api/boards/:id/project/file', async (req, res) => {
    const boardId = parseInt(req.params.id);
    const board = boards.get(boardId);
    if (!board) return res.status(404).json({ error: 'Board not found' });

    const filePath = req.query.path;
    if (!filePath || filePath.includes('..')) return res.status(400).json({ error: 'Invalid path' });

    const slug = board.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').substring(0, 50);
    const fullPath = join(__dirname, '..', 'projects', slug, ...filePath.split('/'));

    try {
      const content = await readFile(fullPath, 'utf-8');
      res.json({ ok: true, path: filePath, content });
    } catch {
      res.status(404).json({ error: 'File not found' });
    }
  });

  // Helper: detect file extension from content
  function detectExtension(content) {
    if (!content) return '.md';
    if (content.includes('```python') || content.match(/^(import |from .+ import |def |class )/m)) return '.py';
    if (content.includes('```javascript') || content.includes('```js') || content.match(/^(const |let |var |function |import .+ from)/m)) return '.js';
    if (content.includes('```typescript') || content.includes('```ts')) return '.ts';
    if (content.includes('```json') || content.trim().startsWith('{')) return '.json';
    if (content.includes('```yaml') || content.includes('```yml')) return '.yaml';
    if (content.includes('```html')) return '.html';
    if (content.includes('```css')) return '.css';
    if (content.includes('```sql')) return '.sql';
    return '.md';
  }

  // Helper: recursively list files in a directory
  const SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git', 'venv', '.venv', 'env', '.env', 'dist', 'build', '.next', '.cache', '.pytest_cache', 'egg-info']);
  async function walkDir(dir, baseDir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await walkDir(fullPath, baseDir);
        files.push(...subFiles);
      } else {
        const relPath = fullPath.replace(baseDir, '').replace(/\\/g, '/').replace(/^\//, '');
        const s = await stat(fullPath);
        files.push({ path: relPath, size: s.size, lines: 0 });
      }
    }
    return files;
  }

  // ==================== AI PROJECTS ====================

  // List projects
  app.get('/api/gen', (req, res) => {
    res.json(projectManager.listByUser(getUserId(req)));
  });

  // Create project from idea — LLM analyzes and suggests keypoints + tech
  app.post('/api/gen', async (req, res) => {
    const userId = getUserId(req);
    const { idea } = req.body;
    if (!idea) return res.status(400).json({ error: 'Provide an idea' });

    llm.initDefaults(userId);
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
- Each keypoint = one concrete feature/component (e.g. "REST API with Express", "SQLite database with user/product tables")
- Choose tech_stack based on what fits best (Node.js for web apps/APIs, Python for data/ML/scripts)
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

      res.json({ project, provider: result.provider });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get project detail
  app.get('/api/gen/:id', (req, res) => {
    const proj = projectManager.get(parseInt(req.params.id));
    if (!proj) return res.status(404).json({ error: 'Not found' });
    res.json(proj);
  });

  // Update keypoints
  app.put('/api/gen/:id/keypoints', (req, res) => {
    projectManager.update(parseInt(req.params.id), { keypoints: req.body.keypoints });
    res.json({ ok: true });
  });

  // Chat about project — refine with LLM
  app.post('/api/gen/:id/chat', async (req, res) => {
    const userId = getUserId(req);
    const id = parseInt(req.params.id);
    const proj = projectManager.get(id);
    if (!proj) return res.status(404).json({ error: 'Not found' });

    const { message } = req.body;
    projectManager.addChat(id, 'user', message);

    llm.initDefaults(userId);
    try {
      const context = [
        {
          role: 'system',
          content: `You are helping refine a ${proj.tech_stack} project called "${proj.title}".
Description: ${proj.description}
Current keypoints:\n${proj.keypoints.map((k, i) => `${i + 1}. ${k}`).join('\n')}

Help the user refine this project. You can suggest adding/removing/modifying keypoints, changing tech stack, or answer questions about implementation.
If you suggest keypoint changes, be specific about what to add/remove.`
        },
        // Include recent chat for context
        ...proj.chat_history.slice(-10).map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: message }
      ];

      const result = await llm.chat(userId, context);
      projectManager.addChat(id, 'assistant', result.text);
      res.json({ reply: result.text, provider: result.provider });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Clear chat history for a project
  app.post('/api/gen/:id/clear-chat', (req, res) => {
    const id = parseInt(req.params.id);
    const proj = projectManager.get(id);
    if (!proj) return res.status(404).json({ error: 'Not found' });
    projectManager.update(id, { chat_history: [] });
    res.json({ ok: true });
  });

  // Code-aware chat: sends message with all project files as context, can apply fixes
  app.post('/api/gen/:id/code-chat', async (req, res) => {
    const userId = getUserId(req);
    const id = parseInt(req.params.id);
    console.log(`[code-chat] Request for project ${id}, userId=${userId}`);
    const proj = projectManager.get(id);
    if (!proj) return res.status(404).json({ error: 'Not found' });

    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'No message' });

    console.log(`[code-chat] Project: "${proj.title}", path: ${proj.project_path}, msg length: ${message.length}`);
    projectManager.addChat(id, 'user', message);
    llm.initDefaults(userId);
    const providers = llm.getEnabledProviders(userId);
    console.log(`[code-chat] Enabled providers: ${providers.map(p => `${p.display_name} (${p.name})`).join(', ')}`);

    try {
      // Collect all project files for context
      let fileContext = '';
      if (proj.project_path) {
        try {
          const files = await walkDir(proj.project_path, proj.project_path);
          console.log(`[code-chat] Found ${files.length} files in ${proj.project_path}`);
          for (const f of files) {
            // Skip large/binary files
            if (f.size > 50000) continue;
            const ext = f.path.split('.').pop()?.toLowerCase() || '';
            if (['png','jpg','jpeg','gif','ico','woff','woff2','ttf','eot','zip','tar','gz','exe','dll','so','pyc','class'].includes(ext)) continue;
            try {
              const content = await readFile(join(proj.project_path, ...f.path.split('/')), 'utf-8');
              const truncated = content.length > 4000 ? content.substring(0, 4000) + '\n...TRUNCATED...' : content;
              fileContext += `--- ${f.path} ---\n${truncated}\n\n`;
            } catch {}
          }
          console.log(`[code-chat] File context length: ${fileContext.length} chars`);
        } catch (e) {
          console.log(`[code-chat] walkDir error: ${e.message}`);
        }
      }

      const isPython = proj.tech_stack === 'python';
      const runCmd = proj.run_command || (isPython ? 'py main.py' : 'node index.js');
      const entryFile = runCmd.split(' ').pop();

      // Filter out poisoned history where LLM previously refused
      const cleanHistory = proj.chat_history.slice(-10)
        .filter(m => !(m.role === 'assistant' && /cannot (access|edit|modify|directly)|can't (access|edit|modify|directly)|don't have (access|direct)|do not have access|Manual Steps Required|manual|I'm unable to/i.test(m.content)))
        .map(m => ({ role: m.role, content: m.content }));

      const context = [
        {
          role: 'system',
          content: `You are a ${isPython ? 'Python' : 'Node.js'} code generator. You write complete, working source code.

SOURCE CODE OF THE PROJECT "${proj.title}":

${fileContext || '(empty project)'}

---
Run command: ${runCmd}
${isPython ? 'Use "py" not "python", "py -m pip" not "pip" for any shell commands.' : 'Use ESM imports.'}

RESPONSE FORMAT:
When providing code changes, wrap each complete source code in this markup (an automated script reads your output):

===FILE: relative/path===
entire source code
===ENDFILE===

Example response:
The issue is a missing import. Here is the corrected code:

===FILE: main.py===
import sys
import os

def main():
    print("fixed")

if __name__ == "__main__":
    main()
===ENDFILE===

IMPORTANT:
- Always include the ENTIRE source code of each changed module, not snippets
- Only include modules that need changes
- The code blocks above are written to disk automatically by the system
- For questions that don't need code changes, just answer normally`
        },
        ...cleanHistory,
        { role: 'user', content: message }
      ];

      console.log(`[code-chat] Calling LLM for user ${userId}, context messages: ${context.length}, system prompt length: ${context[0]?.content?.length || 0}`);
      const result = await llm.chat(userId, context, { max_tokens: 16384 });
      console.log(`[code-chat] LLM responded via ${result.provider} (${result.model}), ${result.text?.length || 0} chars`);

      // Parse file fixes from response — supports multiple formats:
      // 1. ===FILE: path===...===ENDFILE=== (primary — same as generation/auto-fix)
      // 2. ```filename.ext\n...code...\n```  (fallback — models sometimes use this)
      const fixedFiles = [];
      let match;

      // Format 1: ===FILE: path===...===ENDFILE=== (primary)
      const fileRegex = /===FILE:\s*(.+?)\s*===\n([\s\S]*?)===ENDFILE===/g;
      while ((match = fileRegex.exec(result.text)) !== null) {
        let filePath = match[1].trim().replace(/\\/g, '/');
        const content = match[2].trimEnd() + '\n';
        if (filePath.includes('..') || filePath.startsWith('/')) continue;
        fixedFiles.push({ path: filePath, content });
      }

      // Format 2: ```filename.ext code fences (fallback)
      if (fixedFiles.length === 0) {
        const fenceRegex = /```([a-zA-Z0-9_\-./]+\.(?:py|js|ts|json|txt|html|css|yml|yaml|toml|cfg|ini|md|sh|bat|env|jsx|tsx))\n([\s\S]*?)```/g;
        while ((match = fenceRegex.exec(result.text)) !== null) {
          let filePath = match[1].trim().replace(/\\/g, '/');
          const content = match[2].trimEnd() + '\n';
          if (filePath.includes('..') || filePath.startsWith('/')) continue;
          fixedFiles.push({ path: filePath, content });
        }
      }

      console.log(`[code-chat] Parsed ${fixedFiles.length} file fix(es): ${fixedFiles.map(f => f.path).join(', ') || 'none'}`);

      // Apply fixes if any
      if (fixedFiles.length > 0 && proj.project_path) {
        for (const f of fixedFiles) {
          const fullPath = join(proj.project_path, ...f.path.split('/'));
          await fsMkdir(dirname(fullPath), { recursive: true });
          await fsWriteFile(fullPath, f.content, 'utf-8');
        }
      }

      // Clean response text: remove file blocks for display, keep explanation
      let displayText = result.text;
      if (fixedFiles.length > 0) {
        // Remove both formats from display
        displayText = displayText
          .replace(/```[a-zA-Z0-9_\-./]+\.(?:py|js|ts|json|txt|html|css|yml|yaml|toml|cfg|ini|md|sh|bat|env|jsx|tsx)\n[\s\S]*?```/g, '')
          .replace(/===FILE:\s*.+?\s*===\n[\s\S]*?===ENDFILE===/g, '')
          .trim();
        if (!displayText) {
          displayText = `✅ Fixed ${fixedFiles.length} file(s): ${fixedFiles.map(f => f.path).join(', ')}`;
        } else {
          displayText += `\n\n✅ Applied fixes to ${fixedFiles.length} file(s): ${fixedFiles.map(f => f.path).join(', ')}`;
        }
      }

      projectManager.addChat(id, 'assistant', displayText);
      res.json({
        reply: displayText,
        provider: result.provider,
        filesFixed: fixedFiles.map(f => f.path),
      });
    } catch (err) {
      console.error(`[code-chat] ERROR: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // Generate project — LLM creates all files in one shot
  app.post('/api/gen/:id/generate', async (req, res) => {
    const userId = getUserId(req);
    const id = parseInt(req.params.id);
    const proj = projectManager.get(id);
    if (!proj) return res.status(404).json({ error: 'Not found' });

    projectManager.update(id, { status: 'generating' });

    const slug = proj.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').substring(0, 50);
    const projectDir = join(__dirname, '..', 'projects', slug);

    try {
      llm.initDefaults(userId);
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
        { role: 'user', content: `Generate the complete ${proj.title} project. Start with ${entryFile} as the first file.` }
      ]);

      // Clean old files before writing new ones (on regenerate)
      try {
        const oldFiles = await walkDir(projectDir, projectDir);
        for (const f of oldFiles) {
          try { await import('fs/promises').then(fs => fs.unlink(join(projectDir, ...f.split('/')))); } catch {}
        }
      } catch {}

      // Parse ===FILE:...===ENDFILE=== blocks
      const fileRegex = /===FILE:\s*(.+?)\s*===\n([\s\S]*?)===ENDFILE===/g;
      const files = [];
      let match;
      while ((match = fileRegex.exec(result.text)) !== null) {
        let filePath = match[1].trim().replace(/\\/g, '/');
        const content = match[2].trimEnd() + '\n';
        if (filePath.includes('..') || filePath.startsWith('/')) continue;

        // Strip project-name prefix if the LLM nested files (e.g. "ProjectName/main.py" → "main.py")
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

      // Validate: does the entry point file exist?
      const entryExists = files.some(f => f.path === entryFile || f.path.endsWith('/' + entryFile));
      let warnings = [];
      if (!entryExists) {
        warnings.push(`⚠️ Entry point "${entryFile}" was not generated — project may not run correctly`);
      }

      projectManager.update(id, { status: 'ready', project_path: projectDir });

      // Auto-fix: try running the project, if it crashes send error to LLM for repair
      let fixResult = null;
      if (entryExists) {
        try {
          fixResult = await autoFixLoop(llm, userId, proj, projectDir, files, {
            onProgress: (msg) => { /* dashboard doesn't stream progress yet */ },
          });
          if (fixResult.warnings.length > 0) warnings.push(...fixResult.warnings);
          if (fixResult.fixes.length > 0) {
            warnings.unshift(`🔧 Auto-fixed ${fixResult.fixes.length} issue(s) after generation`);
          }
        } catch (fixErr) {
          warnings.push(`⚠️ Auto-fix skipped: ${fixErr.message}`);
        }
      }

      res.json({ ok: true, files, projectDir, slug, provider: result.provider, warnings, fixes: fixResult?.fixes || [] });
    } catch (err) {
      projectManager.update(id, { status: 'draft' });
      res.status(500).json({ error: err.message });
    }
  });

  // Auto-fix a generated project — tries to run, sends crash to LLM for repair
  app.post('/api/gen/:id/fix', async (req, res) => {
    const userId = getUserId(req);
    const id = parseInt(req.params.id);
    const proj = projectManager.get(id);
    if (!proj?.project_path) return res.status(400).json({ error: 'Project not generated yet' });

    try {
      llm.initDefaults(userId);
      const isPython = proj.tech_stack === 'python';
      const runCmd = proj.run_command || (isPython ? 'py main.py' : 'node index.js');
      const existingFiles = await walkDir(proj.project_path, proj.project_path);
      const files = existingFiles.map(f => ({ path: f, size: 0 }));

      const fixResult = await autoFixLoop(llm, userId, proj, proj.project_path, files, {
        onProgress: () => {},
      });

      res.json({
        ok: fixResult.ok,
        fixes: fixResult.fixes,
        warnings: fixResult.warnings,
        filesFixed: fixResult.fixes.flatMap(f => f.filesFixed),
        lastError: fixResult.lastError || null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // List generated files
  app.get('/api/gen/:id/files', async (req, res) => {
    const proj = projectManager.get(parseInt(req.params.id));
    if (!proj) return res.status(404).json({ error: 'Not found' });
    if (!proj.project_path) return res.json({ ok: false, files: [], message: 'Not generated yet' });
    try {
      const files = await walkDir(proj.project_path, proj.project_path);
      res.json({ ok: true, files, projectDir: proj.project_path });
    } catch {
      res.json({ ok: false, files: [], message: 'Project files not found' });
    }
  });

  // Read a specific file
  app.get('/api/gen/:id/file', async (req, res) => {
    const proj = projectManager.get(parseInt(req.params.id));
    if (!proj?.project_path) return res.status(404).json({ error: 'Not found' });
    const fp = req.query.path;
    if (!fp || fp.includes('..')) return res.status(400).json({ error: 'Invalid path' });
    try {
      const content = await readFile(join(proj.project_path, ...fp.split('/')), 'utf-8');
      res.json({ ok: true, path: fp, content });
    } catch { res.status(404).json({ error: 'File not found' }); }
  });

  // Run the generated project
  // Windows-safe command fixer: pip → py -m pip, python → py on Windows
  const isWindows = process.platform === 'win32';
  function fixPythonCmd(cmd) {
    if (!isWindows) return cmd;
    return cmd
      .replace(/^pip3?\b/, 'py -m pip')
      .replace(/^python3?\b/, 'py');
  }

  // Known Python stdlib modules (won't be in requirements.txt)
  const PY_STDLIB = new Set([
    'os', 'sys', 'json', 'time', 'datetime', 'math', 'random', 're', 'io',
    'pathlib', 'typing', 'collections', 'itertools', 'functools', 'operator',
    'string', 'textwrap', 'struct', 'copy', 'enum', 'abc', 'contextlib',
    'dataclasses', 'threading', 'multiprocessing', 'subprocess', 'shutil',
    'tempfile', 'glob', 'fnmatch', 'stat', 'logging', 'warnings', 'traceback',
    'unittest', 'doctest', 'pdb', 'argparse', 'configparser', 'csv', 'sqlite3',
    'hashlib', 'hmac', 'secrets', 'base64', 'uuid', 'socket', 'http',
    'urllib', 'email', 'html', 'xml', 'webbrowser', 'pprint', 'pickle',
    'shelve', 'marshal', 'ast', 'dis', 'inspect', 'importlib', 'pkgutil',
    'zipfile', 'tarfile', 'gzip', 'bz2', 'lzma', 'zlib', 'signal',
    'asyncio', 'concurrent', 'queue', 'sched', 'select', 'selectors',
    'platform', 'ctypes', 'types', 'weakref', 'gc', 'resource',
    '__future__', 'builtins', 'array', 'decimal', 'fractions', 'statistics',
  ]);

  // Common import-name → pip-package mappings
  const PY_IMPORT_MAP = {
    'flask': 'flask', 'fastapi': 'fastapi', 'uvicorn': 'uvicorn',
    'requests': 'requests', 'httpx': 'httpx', 'aiohttp': 'aiohttp',
    'pydantic': 'pydantic', 'dotenv': 'python-dotenv',
    'PIL': 'Pillow', 'cv2': 'opencv-python', 'sklearn': 'scikit-learn',
    'bs4': 'beautifulsoup4', 'yaml': 'pyyaml', 'toml': 'toml',
    'pandas': 'pandas', 'numpy': 'numpy', 'matplotlib': 'matplotlib',
    'scipy': 'scipy', 'torch': 'torch', 'transformers': 'transformers',
    'openai': 'openai', 'anthropic': 'anthropic', 'gradio': 'gradio',
    'streamlit': 'streamlit', 'rich': 'rich', 'click': 'click',
    'typer': 'typer', 'colorama': 'colorama', 'tqdm': 'tqdm',
    'jinja2': 'Jinja2', 'sqlalchemy': 'SQLAlchemy', 'redis': 'redis',
    'celery': 'celery', 'pymongo': 'pymongo', 'psycopg2': 'psycopg2-binary',
    'websockets': 'websockets', 'starlette': 'starlette', 'pytest': 'pytest',
  };

  // Scan .py files for imports and build a requirements.txt
  async function autoDetectPythonDeps(projectDir) {
    const deps = new Set();
    const pyFiles = [];

    // Collect all .py files
    async function scan(dir) {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = join(dir, e.name);
          if (e.isDirectory() && !e.name.startsWith('.') && e.name !== '__pycache__' && e.name !== 'node_modules') {
            await scan(full);
          } else if (e.isFile() && e.name.endsWith('.py')) {
            pyFiles.push(full);
          }
        }
      } catch {}
    }
    await scan(projectDir);

    for (const fp of pyFiles) {
      try {
        const code = await readFile(fp, 'utf-8');
        // Match: import foo / import foo.bar / from foo import bar / from foo.bar import baz
        const importRe = /^(?:import|from)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm;
        let m;
        while ((m = importRe.exec(code)) !== null) {
          const mod = m[1];
          if (!PY_STDLIB.has(mod)) {
            const pkg = PY_IMPORT_MAP[mod] || mod;
            deps.add(pkg);
          }
        }
      } catch {}
    }
    return [...deps].sort();
  }

  app.post('/api/gen/:id/run', (req, res) => {
    const proj = projectManager.get(parseInt(req.params.id));
    if (!proj?.project_path) return res.status(400).json({ error: 'Project not generated yet' });

    const name = `gen-${proj.id}`;
    if (runningProjects.has(name)) {
      return res.json({ status: 'already_running', port: runningProjects.get(name).port });
    }

    // Respond immediately — install + run happens in background so UI doesn't freeze
    const port = freedPorts.pop() || nextProjectPort++;
    // Persist logs across runs — add separator if previous logs exist
    if (!persistedLogs.has(name)) persistedLogs.set(name, []);
    const allLogs = persistedLogs.get(name);
    if (allLogs.length > 0) {
      allLogs.push(`\n${'━'.repeat(50)}\n`);
      allLogs.push(`▶️  New run — ${new Date().toLocaleTimeString()}\n`);
      allLogs.push(`${'━'.repeat(50)}\n\n`);
    }
    allLogs.push('📦 Installing dependencies...\n');
    // Cap persisted logs so they don't grow unbounded
    if (allLogs.length > 500) allLogs.splice(0, allLogs.length - 300);
    const logs = allLogs;
    runningProjects.set(name, { process: null, port, logs, projectDir: proj.project_path, phase: 'installing' });
    projectManager.update(proj.id, { status: 'running' });
    res.json({ status: 'installing', port, name });

    // Background: install deps then start project
    (async () => {
      let installCmd = proj.install_command || (proj.tech_stack === 'python' ? 'py -m pip install -r requirements.txt' : 'npm install');
      installCmd = fixPythonCmd(installCmd);

      // Check if dependency file actually exists before running install
      const isPython = proj.tech_stack === 'python';
      const depFile = isPython ? 'requirements.txt' : 'package.json';
      const depFilePath = join(proj.project_path, depFile);
      let hasDeps = existsSync(depFilePath);

      // Auto-generate requirements.txt from Python imports if missing
      if (!hasDeps && isPython) {
        try {
          const reqs = await autoDetectPythonDeps(proj.project_path);
          if (reqs.length > 0) {
            await fsWriteFile(depFilePath, reqs.join('\n') + '\n', 'utf-8');
            logs.push(`📋 Auto-generated requirements.txt (${reqs.length} deps detected)\n`);
            hasDeps = true;
          } else {
            logs.push('ℹ️ No external dependencies detected — skipping install\n');
          }
        } catch {
          logs.push('ℹ️ No requirements.txt found — skipping install\n');
        }
      } else if (!hasDeps) {
        logs.push(`ℹ️ No ${depFile} found — skipping install\n`);
      }

      if (hasDeps) {
        try {
          logs.push(`> ${installCmd}\n`);
          await new Promise((resolve, reject) => {
            const proc = spawn(installCmd, { cwd: proj.project_path, shell: true });
            proc.stdout?.on('data', d => { logs.push(d.toString()); if (logs.length > 300) logs.shift(); });
            proc.stderr?.on('data', d => { logs.push(d.toString()); if (logs.length > 300) logs.shift(); });
            proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Install exited with code ${code}`)));
            setTimeout(() => { try { proc.kill(); } catch {} reject(new Error('Install timed out (2 min)')); }, 120000);
          });
          logs.push('\n✅ Dependencies installed\n\n');
        } catch (err) {
          logs.push(`\n⚠️ Install had issues: ${err.message}\n`);
          logs.push('⏩ Attempting to run anyway...\n\n');
          // Don't bail out — try running the project even if install partially failed
        }
      }

      // Start the project
      let runCmd = proj.run_command || (proj.tech_stack === 'python' ? 'py main.py' : 'node index.js');
      runCmd = fixPythonCmd(runCmd);
      logs.push(`🚀 Starting: ${runCmd}\n`);

      try {
        const proc = spawn(runCmd, { cwd: proj.project_path, shell: true, env: { ...process.env, PORT: String(port) } });
        proc.stdout?.on('data', d => { logs.push(d.toString()); if (logs.length > 300) logs.shift(); });
        proc.stderr?.on('data', d => { logs.push(`[ERR] ${d}`); if (logs.length > 300) logs.shift(); });
        proc.on('close', (code) => {
          logs.push(`\n⏹ Process exited (code ${code})\n`);
          // Snapshot logs into persistedLogs so they survive runningProjects cleanup
          persistedLogs.set(name, [...logs]);
          // Keep entry for a bit so user can read logs, then clean up
          const entry = runningProjects.get(name);
          if (entry) entry.phase = 'stopped';
          setTimeout(() => {
            runningProjects.delete(name);
            freedPorts.push(port);
            projectManager.update(proj.id, { status: 'ready' });
          }, 5000);
        });

        const entry = runningProjects.get(name);
        if (entry) { entry.process = proc; entry.phase = 'running'; }
      } catch (err) {
        logs.push(`\n❌ Failed to start: ${err.message}\n`);
        persistedLogs.set(name, [...logs]);
        runningProjects.delete(name);
        freedPorts.push(port);
        projectManager.update(proj.id, { status: 'ready' });
      }
    })();
  });

  // Stop a running project
  app.post('/api/gen/:id/stop', (req, res) => {
    const proj = projectManager.get(parseInt(req.params.id));
    if (!proj) return res.status(404).json({ error: 'Not found' });
    const name = `gen-${proj.id}`;
    const running = runningProjects.get(name);
    if (running) {
      // Snapshot logs before cleanup
      if (running.logs?.length) {
        running.logs.push('\n⏹ Stopped by user\n');
        persistedLogs.set(name, [...running.logs]);
      }
      try { if (running.process) running.process.kill(); } catch {}
      runningProjects.delete(name);
      freedPorts.push(running.port);
    }
    projectManager.update(proj.id, { status: 'ready' });
    res.json({ ok: true });
  });

  // Get project run logs
  app.get('/api/gen/:id/logs', (req, res) => {
    const proj = projectManager.get(parseInt(req.params.id));
    if (!proj) return res.status(404).json({ error: 'Not found' });
    const name = `gen-${proj.id}`;
    const running = runningProjects.get(name);
    const saved = persistedLogs.get(name);
    res.json({
      running: !!running,
      port: running?.port,
      logs: running?.logs?.join('') || saved?.join('') || ''
    });
  });

  // Clear persisted logs
  app.post('/api/gen/:id/clear-logs', (req, res) => {
    const proj = projectManager.get(parseInt(req.params.id));
    if (!proj) return res.status(404).json({ error: 'Not found' });
    persistedLogs.delete(`gen-${proj.id}`);
    res.json({ ok: true });
  });

  // Open terminal in project directory and run the project command
  app.post('/api/gen/:id/open-terminal', (req, res) => {
    const proj = projectManager.get(parseInt(req.params.id));
    if (!proj?.project_path) return res.status(400).json({ error: 'Project not generated yet' });
    const runCmd = proj.run_command || (proj.tech_stack === 'python' ? 'py main.py' : 'node index.js');
    try {
      if (isWindows) {
        // start opens a new window, /k keeps it open after command finishes
        const safeTitle = proj.title.replace(/[&|<>^"]/g, '');
        execCb(`start "${safeTitle}" cmd.exe /k "cd /d ${proj.project_path} && ${runCmd}"`,
          { cwd: proj.project_path, windowsHide: false },
          (err) => { if (err) console.log('[open-terminal] error:', err.message); });
      } else if (process.platform === 'darwin') {
        execCb(`open -a Terminal "${proj.project_path}"`);
      } else {
        execCb(`x-terminal-emulator -e "cd '${proj.project_path}' && bash"`, { cwd: proj.project_path });
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Open project folder in file explorer
  app.post('/api/gen/:id/open-folder', (req, res) => {
    const proj = projectManager.get(parseInt(req.params.id));
    if (!proj?.project_path) return res.status(400).json({ error: 'Project not generated yet' });
    try {
      const openCmd = isWindows ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(openCmd, [proj.project_path], { detached: true, shell: true }).unref();
      res.json({ ok: true, path: proj.project_path });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete project
  app.delete('/api/gen/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const proj = projectManager.get(id);
    if (proj) {
      const name = `gen-${id}`;
      if (runningProjects.has(name)) {
        try { runningProjects.get(name).process.kill(); } catch {}
        runningProjects.delete(name);
      }
    }
    projectManager.delete(id);
    res.json({ ok: true });
  });

  // ==================== WORKFLOWS ====================
  app.get('/api/workflows', (req, res) => {
    const userId = getUserId(req);
    const list = workflows.listByUser(userId).map(w => ({
      ...w,
      nodes: workflows.getNodes(w.id),
      edges: workflows.getEdges(w.id),
    }));
    res.json(list);
  });

  app.post('/api/workflows', async (req, res) => {
    const userId = getUserId(req);
    llm.initDefaults(userId);
    const { title, description, auto } = req.body;

    if (auto && description) {
      try {
        const workflow = await workflows.buildFromDescription(userId, description);
        const nodes = workflows.getNodes(workflow.id);
        const edges = workflows.getEdges(workflow.id);
        res.json({ ...workflow, nodes, edges });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    } else {
      const workflow = workflows.create(userId, title || 'New Workflow', description || '');
      res.json({ ...workflow, nodes: [], edges: [] });
    }
  });

  app.get('/api/workflows/:id', (req, res) => {
    const wf = workflows.get(parseInt(req.params.id));
    if (!wf) return res.status(404).json({ error: 'Not found' });
    const nodes = workflows.getNodes(wf.id);
    const edges = workflows.getEdges(wf.id);
    res.json({ ...wf, nodes, edges });
  });

  app.delete('/api/workflows/:id', (req, res) => {
    workflows.delete(parseInt(req.params.id));
    res.json({ ok: true });
  });

  app.post('/api/workflows/:id/nodes', (req, res) => {
    const { name, type, description, inputs, outputs } = req.body;
    const node = workflows.addNode(
      parseInt(req.params.id), name, type || 'process',
      description || '', inputs || ['default'], outputs || ['default']
    );
    if (req.body.config) workflows.setNodeConfig(node.id, req.body.config);
    res.json(workflows.getNode(node.id));
  });

  app.put('/api/workflows/nodes/:id', (req, res) => {
    const nodeId = parseInt(req.params.id);
    if (req.body.inputs) workflows.setNodeInputs(nodeId, req.body.inputs);
    if (req.body.outputs) workflows.setNodeOutputs(nodeId, req.body.outputs);
    if (req.body.config) {
      // Merge new config into existing (so env vars don't wipe other config)
      const existing = workflows.getNode(nodeId)?._config || {};
      workflows.setNodeConfig(nodeId, { ...existing, ...req.body.config });
    }
    if (req.body.name || req.body.description) {
      workflows.updateNode(nodeId, {
        ...(req.body.name && { name: req.body.name }),
        ...(req.body.description && { description: req.body.description }),
      });
    }
    res.json(workflows.getNode(nodeId));
  });

  // Get node script/code representation
  app.get('/api/workflows/nodes/:id/script', (req, res) => {
    const node = workflows.getNode(parseInt(req.params.id));
    if (!node) return res.status(404).json({ error: 'Not found' });
    const script = workflows.getNodeScript(node);
    // Also gather real input from connected nodes
    const edges = workflows.getEdges(node.workflow_id);
    const incoming = edges.filter(e => e.to_node_id === node.id);
    const outgoing = edges.filter(e => e.from_node_id === node.id);
    const connectedInputs = {};
    const connections = { incoming: [], outgoing: [] };
    for (const e of incoming) {
      const srcNode = workflows.getNode(e.from_node_id);
      if (srcNode) {
        connections.incoming.push({
          nodeId: srcNode.id, name: srcNode.name, type: srcNode.node_type,
          fromOutput: e.from_output, toInput: e.to_input,
          hasResult: !!srcNode.result,
        });
        if (srcNode.result) {
          try {
            const parsed = JSON.parse(srcNode.result);
            connectedInputs[e.to_input] = parsed.outputs?.[e.from_output] || parsed.result || '';
          } catch { connectedInputs[e.to_input] = ''; }
        }
      }
    }
    for (const e of outgoing) {
      const dstNode = workflows.getNode(e.to_node_id);
      if (dstNode) {
        connections.outgoing.push({
          nodeId: dstNode.id, name: dstNode.name, type: dstNode.node_type,
          fromOutput: e.from_output, toInput: e.to_input,
        });
      }
    }
    res.json({ ...script, connectedInputs, connections, node: { id: node.id, name: node.name, node_type: node.node_type, description: node.description } });
  });

  // Test a single node with custom input
  app.post('/api/workflows/nodes/:id/test', async (req, res) => {
    const userId = getUserId(req);
    llm.initDefaults(userId);
    try {
      const result = await workflows.testNode(userId, parseInt(req.params.id), req.body.input || {});
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Generate a script for a node using LLM
  app.post('/api/workflows/nodes/:id/generate', async (req, res) => {
    const userId = getUserId(req);
    llm.initDefaults(userId);
    try {
      const result = await workflows.generateScript(userId, parseInt(req.params.id));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Chat with LLM about a node's script (test/fix assistant)
  app.post('/api/workflows/nodes/:id/chat', async (req, res) => {
    const userId = getUserId(req);
    llm.initDefaults(userId);
    const node = workflows.getNode(parseInt(req.params.id));
    if (!node) return res.status(404).json({ error: 'Not found' });

    const { message, script, history } = req.body;
    const currentScript = script || node.custom_script || '// No script yet';

    const chatMessages = [
      { role: 'system', content: `You are a code assistant helping debug and fix a workflow node script.
The node "${node.name}" is of type "${node.node_type}" and does: "${node.description || 'No description'}".

Current script:
\`\`\`
${currentScript}
\`\`\`

Help the user test, debug, and fix this script. When suggesting code changes, wrap the complete fixed script in a \`\`\`fix code block so it can be applied directly. Always return the entire corrected script, not just the changed lines.` },
      ...(history || []),
      { role: 'user', content: message },
    ];

    try {
      const result = await llm.chat(userId, chatMessages);
      // Extract fixed code if present
      let fixedScript = null;
      const fixMatch = result.text.match(/```fix\n?([\s\S]*?)```/);
      if (fixMatch) {
        fixedScript = fixMatch[1].trim();
      } else {
        const codeMatch = result.text.match(/```(?:javascript|js|bash)?\n?([\s\S]*?)```/);
        if (codeMatch && codeMatch[1].trim().length > 20) fixedScript = codeMatch[1].trim();
      }
      res.json({ reply: result.text, fixedScript, provider: result.provider, model: result.model });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Save a custom script to a node
  app.put('/api/workflows/nodes/:id/script', (req, res) => {
    const nodeId = parseInt(req.params.id);
    workflows.saveScript(nodeId, req.body.script);
    res.json({ ok: true });
  });

  // Get a node's last execution result
  app.get('/api/workflows/nodes/:id/result', (req, res) => {
    const node = workflows.getNode(parseInt(req.params.id));
    if (!node) return res.status(404).json({ error: 'Not found' });
    let result = null;
    if (node.result) {
      try { result = JSON.parse(node.result); } catch { result = node.result; }
    }
    res.json({ result, nodeId: node.id, name: node.name, node_type: node.node_type, status: node.status });
  });

  app.delete('/api/workflows/nodes/:id', (req, res) => {
    workflows.deleteNode(parseInt(req.params.id));
    res.json({ ok: true });
  });

  app.post('/api/workflows/:id/edges', (req, res) => {
    const { fromNodeId, toNodeId, fromOutput, toInput } = req.body;
    const edge = workflows.connect(
      parseInt(req.params.id), fromNodeId, toNodeId,
      fromOutput || 'default', toInput || 'default'
    );
    res.json(edge);
  });

  app.delete('/api/workflows/edges/:id', (req, res) => {
    workflows.disconnect(parseInt(req.params.id));
    res.json({ ok: true });
  });

  app.get('/api/node-types', (req, res) => {
    res.json(NODE_TYPES);
  });

  // Export workflow in various formats
  app.post('/api/workflows/:id/export', async (req, res) => {
    const wfId = parseInt(req.params.id);
    const { format } = req.body;
    const wf = workflows.get(wfId);
    if (!wf) return res.status(404).json({ error: 'Not found' });

    const nodes = workflows.getNodes(wfId);
    const edges = workflows.getEdges(wfId);
    const safeName = (wf.title || 'workflow').replace(/[^a-zA-Z0-9_\- ]/g, '_').replace(/\s+/g, '_').substring(0, 50);

    // JSON export — return inline
    if (format === 'json') {
      const data = {
        workflow: wf,
        nodes: nodes.map(n => ({ ...n, custom_script: n.custom_script || null })),
        edges,
        exportedAt: new Date().toISOString(),
        version: '1.0',
      };
      return res.json({ data, filename: `${safeName}.json` });
    }

    const exportDir = join(process.cwd(), 'output', safeName, `export-${format}`);
    await fsMkdir(exportDir, { recursive: true });
    const files = [];

    async function writeExportFile(name, content) {
      const dir = dirname(join(exportDir, name));
      await fsMkdir(dir, { recursive: true });
      await fsWriteFile(join(exportDir, name), content, 'utf-8');
      files.push(name);
    }

    // Build node script info
    const nodeScripts = {};
    for (const node of nodes) {
      const script = workflows.getNodeScript(node);
      const safe = node.name.replace(/[^a-zA-Z0-9_]/g, '_');
      nodeScripts[node.id] = {
        filename: `nodes/${safe}.js`,
        name: node.name,
        type: node.node_type,
        raw: node.custom_script || script.script || script.prompt || '',
        isPrompt: script.language === 'prompt',
      };
    }

    // Get execution order
    let orderedNodes;
    try { orderedNodes = workflows.getExecutionOrder(wfId); }
    catch { orderedNodes = nodes; }

    // ---- Common files for nodejs/api/docker ----
    const pkgDeps = {};
    if (format === 'api' || format === 'docker') pkgDeps.express = '^4.18.2';

    await writeExportFile('package.json', JSON.stringify({
      name: safeName.toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
      version: '1.0.0',
      type: 'module',
      description: `Exported workflow: ${wf.title}`,
      main: (format === 'api' || format === 'docker') ? 'server.js' : 'index.js',
      scripts: { start: (format === 'api' || format === 'docker') ? 'node server.js' : 'node index.js' },
      dependencies: pkgDeps,
    }, null, 2));

    // Write individual node scripts
    for (const [nodeId, ns] of Object.entries(nodeScripts)) {
      if (ns.isPrompt) {
        await writeExportFile(ns.filename, [
          `// LLM Prompt Node: ${ns.name}`,
          `// Type: ${ns.type}`,
          `// This node requires an LLM provider\n`,
          `export const prompt = ${JSON.stringify(ns.raw)};\n`,
          `export default async function execute(inputData, config) {`,
          `  const filled = prompt.replace(/\\{\\{inputData\\}\\}/g, JSON.stringify(inputData));`,
          `  // TODO: Replace with your LLM call`,
          `  console.log('[LLM Prompt]', filled.substring(0, 200) + '...');`,
          `  return { result: 'LLM response placeholder', outputs: { default: '' } };`,
          `}\n`,
        ].join('\n'));
      } else {
        const body = ns.raw ? ns.raw.split('\n').map(l => '  ' + l).join('\n') : '  return { result: inputData.default || "", outputs: { default: inputData.default || "" } };';
        await writeExportFile(ns.filename, [
          `// Node: ${ns.name}`,
          `// Type: ${ns.type}\n`,
          `export default async function execute(inputData, config) {`,
          body,
          `}\n`,
        ].join('\n'));
      }
    }

    // Workflow definition
    await writeExportFile('workflow.json', JSON.stringify({ workflow: wf, nodes, edges }, null, 2));

    // ---- Runner (index.js) ----
    const imports = orderedNodes.map((n, i) => `import node${i} from './${nodeScripts[n.id].filename}';`).join('\n');
    const nodeList = orderedNodes.map((n, i) => `  { id: ${n.id}, name: ${JSON.stringify(n.name)}, execute: node${i} }`).join(',\n');
    const runner = `${imports}

const nodes = [\n${nodeList}\n];
const edges = ${JSON.stringify(edges, null, 2)};

export async function runWorkflow(initialInput = {}) {
  console.log('🔀 Running workflow: ${wf.title.replace(/'/g, "\\'")}');
  const results = new Map();

  for (const node of nodes) {
    const incoming = edges.filter(e => e.to_node_id === node.id);
    const inputData = {};
    for (const e of incoming) {
      const src = results.get(e.from_node_id);
      if (src) inputData[e.to_input] = src.outputs?.[e.from_output] || src.result || '';
    }
    if (Object.keys(inputData).length === 0) Object.assign(inputData, initialInput);

    console.log(\`  ⚙️  \${node.name}...\`);
    try {
      const result = await node.execute(inputData, {});
      results.set(node.id, result);
      console.log(\`  ✅ \${node.name}: done\`);
    } catch (err) {
      console.error(\`  ❌ \${node.name}: \${err.message}\`);
      results.set(node.id, { result: err.message, outputs: { default: '', error: err.message } });
    }
  }

  console.log('\\n✅ Workflow complete!');
  return Object.fromEntries(results);
}

// CLI entry
runWorkflow({ default: process.argv[2] || '' }).catch(console.error);
`;
    await writeExportFile('index.js', runner);

    // ---- API Server (for api and docker) ----
    if (format === 'api' || format === 'docker') {
      const server = `import express from 'express';
${imports}

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

const nodeList = [\n${nodeList}\n];
const edges = ${JSON.stringify(edges, null, 2)};

app.post('/run', async (req, res) => {
  const initialInput = req.body.input || { default: '' };
  const results = new Map();

  for (const node of nodeList) {
    const incoming = edges.filter(e => e.to_node_id === node.id);
    const inputData = {};
    for (const e of incoming) {
      const src = results.get(e.from_node_id);
      if (src) inputData[e.to_input] = src.outputs?.[e.from_output] || src.result || '';
    }
    if (Object.keys(inputData).length === 0) Object.assign(inputData, initialInput);

    try {
      const result = await node.execute(inputData, {});
      results.set(node.id, result);
    } catch (err) {
      results.set(node.id, { result: err.message, outputs: { default: '', error: err.message } });
    }
  }

  res.json({ results: Object.fromEntries(results) });
});

app.get('/health', (req, res) => res.json({ status: 'ok', workflow: ${JSON.stringify(wf.title)} }));
app.listen(PORT, () => console.log(\`🌐 Workflow API on port \${PORT}\`));
`;
      await writeExportFile('server.js', server);
    }

    // ---- Docker files ----
    if (format === 'docker') {
      await writeExportFile('Dockerfile', `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
`);
      await writeExportFile('docker-compose.yml', `version: '3.8'
services:
  workflow:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
    restart: unless-stopped
`);
      await writeExportFile('.dockerignore', `node_modules
.env
*.db
`);
    }

    res.json({ files, outputDir: exportDir, format });
  });

  // ==================== DRAFTS ====================
  app.get('/api/drafts', (req, res) => {
    res.json(drafts.listByUser(getUserId(req)));
  });

  app.delete('/api/drafts/:id', (req, res) => {
    drafts.delete(parseInt(req.params.id));
    res.json({ ok: true });
  });

  app.post('/api/drafts/:id/expand', async (req, res) => {
    const userId = getUserId(req);
    llm.initDefaults(userId);
    const draft = drafts.get(parseInt(req.params.id));
    if (!draft) return res.status(404).json({ error: 'Not found' });

    const pageContent = (draft.content || '').substring(0, 2000);

    try {
      const result = await llm.chat(userId, [
        { role: 'system', content: `You are an expert product strategist and software architect. Analyze the given link/resource and generate 3-5 actionable project plans.

For each plan, provide:
1. **Plan Title** — short name
2. **What to Build** — concrete description of the project
3. **Key Features** — bullet list of 3-5 features
4. **Tech Stack** — suggested technologies
5. **APIs/Skills to Extract** — what can be reused as skills, knowledge, or integrations
6. **Difficulty** — Easy / Medium / Hard

Also include a section at the end:
**Knowledge & Skills to Extract:**
- List APIs, libraries, patterns, or data that can be extracted from this resource and reused as skills or knowledge base entries.

Return the plans as valid JSON array:
[{"title":"...","description":"...","features":["..."],"techStack":["..."],"skills":["..."],"difficulty":"Easy|Medium|Hard"}]

After the JSON array, add a markdown section starting with "---\\n**Knowledge & Skills to Extract:**" listing extractable items.` },
        { role: 'user', content: `Analyze this resource and generate project plans:\n\nURL: ${draft.url || 'N/A'}\nTitle: ${draft.title}\nDescription: ${draft.description || 'No description'}\n${pageContent ? `\nPage Content:\n${pageContent}` : ''}` }
      ]);

      // Try to parse structured plans from LLM response
      let plans = [];
      let knowledgeSection = '';
      const text = result.text;

      // Split on knowledge section
      const knowledgeSplit = text.split(/---\s*\n\*\*Knowledge/i);
      const plansText = knowledgeSplit[0];
      if (knowledgeSplit[1]) knowledgeSection = '**Knowledge' + knowledgeSplit[1];

      // Try JSON parse
      try {
        const jsonMatch = plansText.match(/\[[\s\S]*\]/);
        if (jsonMatch) plans = JSON.parse(jsonMatch[0]);
      } catch {
        // Fallback: return raw text as single plan
        plans = [{ title: draft.title, description: text.substring(0, 2000), features: [], techStack: [], skills: [], difficulty: 'Medium' }];
      }

      drafts.updateContent(draft.id, draft.title, text, draft.content || pageContent);
      res.json({ plans, knowledge: knowledgeSection, raw: text, provider: result.provider, model: result.model });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/drafts/:id/clone', async (req, res) => {
    const userId = getUserId(req);
    llm.initDefaults(userId);
    const draft = drafts.get(parseInt(req.params.id));
    if (!draft) return res.status(404).json({ error: 'Not found' });

    // Use specific plan from request body, or the draft itself
    const planDesc = req.body.planTitle || draft.title;
    const planContext = req.body.planDescription || draft.description || draft.content || '';

    try {
      const result = await llm.chat(userId, [
        { role: 'system', content: 'You are a project planner. Return a JSON array of tasks: [{"title":"...","description":"...","requires_input":false,"input_question":null,"tools_needed":[]}]. Only JSON.' },
        { role: 'user', content: `Create a project plan for: ${planDesc}\n\nContext: ${planContext.substring(0, 1500)}` },
      ]);

      let taskList;
      try {
        taskList = JSON.parse(result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
      } catch { taskList = [{ title: 'Review requirements', description: result.text }]; }

      const board = boards.create(userId, planDesc);
      boards.addTasksFromPlan(board.id, taskList);
      drafts.updateStatus(draft.id, 'processed');
      gamification.addXP(userId, 'board_created');
      res.json({ board, tasks: boards.getTasks(board.id) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== SESSIONS ====================
  app.get('/api/sessions', (req, res) => {
    res.json(sessions.listByUser(getUserId(req)));
  });

  app.get('/api/sessions/:id/messages', (req, res) => {
    res.json(sessions.getMessages(parseInt(req.params.id)));
  });

  app.post('/api/chat', async (req, res) => {
    const userId = getUserId(req);
    llm.initDefaults(userId);
    const { message, sessionId } = req.body;

    let session;
    if (sessionId) {
      session = sessions.get(sessionId);
    }
    if (!session) {
      session = sessions.create(userId, 'Dashboard Chat');
    }

    sessions.addMessage(session.id, 'user', message);
    const history = sessions.getRecentMessages(session.id);
    const chatMessages = history.map(m => ({ role: m.role, content: m.content }));

    // Inject relevant memories as system context
    const memoryContext = memory.buildContext(userId, message);
    if (memoryContext) {
      chatMessages.unshift({ role: 'system', content: `You are a helpful AI assistant. Here is relevant knowledge about the user:${memoryContext}` });
    }

    try {
      const result = await llm.chat(userId, chatMessages);
      sessions.addMessage(session.id, 'assistant', result.text);
      gamification.addXP(userId, 'message_sent');
      costTracker.log(userId, result.provider, result.model, message, result.text, 'chat');
      challenges.trackAction(userId, 'message_sent');
      res.json({ reply: result.text, provider: result.provider, model: result.model, sessionId: session.id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== GAMIFICATION ====================
  app.get('/api/stats', (req, res) => {
    const userId = getUserId(req);
    const stats = gamification.getStats(userId);
    const achievements = gamification.getAllAchievements(userId);
    const levels = gamification.LEVELS;
    res.json({ stats, achievements, levels });
  });

  // ==================== CLI ====================
  app.post('/api/run', async (req, res) => {
    try {
      if (!req.body.command) return res.status(400).json({ error: 'Command required' });
      const result = await qa.runCommand(req.body.command, req.body.cwd);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== PROJECTS (Exported) ====================
  const outputDir = join(__dirname, '..', 'output');

  // List all exported projects with their types and running status
  app.get('/api/projects', async (req, res) => {
    try {
      const entries = await readdir(outputDir, { withFileTypes: true }).catch(() => []);
      const projects = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const projDir = join(outputDir, entry.name);
        const subEntries = await readdir(projDir).catch(() => []);

        // Find export types
        const types = [];
        let fileCount = 0;
        for (const sub of subEntries) {
          if (sub === 'export-nodejs') { types.push('nodejs'); fileCount += (await readdir(join(projDir, sub)).catch(() => [])).length; }
          if (sub === 'export-api') { types.push('api'); fileCount += (await readdir(join(projDir, sub)).catch(() => [])).length; }
          if (sub === 'export-docker') { types.push('docker'); fileCount += (await readdir(join(projDir, sub)).catch(() => [])).length; }
        }

        if (types.length === 0) continue; // No export directories

        const safeName = entry.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
        const running = runningProjects.has(safeName);
        const runInfo = running ? runningProjects.get(safeName) : null;

        projects.push({
          name: entry.name,
          safeName,
          types,
          files: fileCount,
          running,
          port: runInfo?.port || null,
        });
      }

      res.json({ projects });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Start an exported project
  app.post('/api/projects/:name/start', async (req, res) => {
    const name = req.params.name;
    if (runningProjects.has(name)) {
      return res.json({ ok: true, message: 'Already running', port: runningProjects.get(name).port });
    }

    // Find the project directory (match safeName against output dirs)
    const entries = await readdir(outputDir, { withFileTypes: true }).catch(() => []);
    const projEntry = entries.find(e =>
      e.isDirectory() && e.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase() === name
    );
    if (!projEntry) return res.status(404).json({ error: 'Project not found' });

    const projDir = join(outputDir, projEntry.name);
    // Prefer api export (has server.js), then docker, then nodejs
    let runDir = null;
    let runCmd = 'node';
    let runArgs = ['server.js'];

    if (await stat(join(projDir, 'export-api', 'server.js')).catch(() => null)) {
      runDir = join(projDir, 'export-api');
      runArgs = ['server.js'];
    } else if (await stat(join(projDir, 'export-docker', 'server.js')).catch(() => null)) {
      runDir = join(projDir, 'export-docker');
      runArgs = ['server.js'];
    } else if (await stat(join(projDir, 'export-nodejs', 'index.js')).catch(() => null)) {
      runDir = join(projDir, 'export-nodejs');
      runArgs = ['index.js'];
    }

    if (!runDir) return res.status(400).json({ error: 'No runnable export found (need api or nodejs export)' });

    // Install deps if node_modules missing
    try {
      await stat(join(runDir, 'node_modules'));
    } catch {
      const installResult = await qa.runCommand('npm install', runDir, 60000);
      if (!installResult.ok) {
        return res.status(500).json({ error: `npm install failed: ${(installResult.stderr || '').substring(0, 500)}` });
      }
    }

    const port = freedPorts.pop() || nextProjectPort++;
    const logBuffer = [];

    try {
      const child = spawn(runCmd, runArgs, {
        cwd: runDir,
        env: { ...process.env, PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (d) => {
        const line = d.toString();
        logBuffer.push(line);
        if (logBuffer.length > 200) logBuffer.shift();
      });
      child.stderr.on('data', (d) => {
        const line = '[ERR] ' + d.toString();
        logBuffer.push(line);
        if (logBuffer.length > 200) logBuffer.shift();
      });
      child.on('exit', (code) => {
        logBuffer.push(`\n[Process exited with code ${code}]`);
        runningProjects.delete(name);
        freedPorts.push(port);
      });

      runningProjects.set(name, { process: child, port, logs: logBuffer, dir: runDir });

      res.json({ ok: true, port, url: `http://${name}.localhost:${req.socket.localPort || 9999}` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Stop an exported project
  app.post('/api/projects/:name/stop', (req, res) => {
    const name = req.params.name;
    const project = runningProjects.get(name);
    if (!project) return res.status(404).json({ error: 'Not running' });

    try {
      project.process.kill();
      freedPorts.push(project.port);
      runningProjects.delete(name);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get project logs
  app.get('/api/projects/:name/logs', (req, res) => {
    const name = req.params.name;
    const project = runningProjects.get(name);
    if (!project) return res.json({ logs: 'Project is not running.' });
    res.json({ logs: project.logs.join('') });
  });

  // ==================== WORKFLOW WEBHOOKS ====================
  // Generate or get webhook URL for a workflow
  app.post('/api/workflows/:id/webhook', (req, res) => {
    const wfId = parseInt(req.params.id);
    const wf = workflows.get(wfId);
    if (!wf) return res.status(404).json({ error: 'Not found' });

    let webhookId = wf.webhook_id;
    if (!webhookId) {
      webhookId = crypto.randomUUID().replace(/-/g, '').substring(0, 16);
      db.prepare('UPDATE workflows SET webhook_id = ? WHERE id = ?').run(webhookId, wfId);
    }
    res.json({ webhookId, url: `/api/webhook/${webhookId}` });
  });

  // Delete webhook
  app.delete('/api/workflows/:id/webhook', (req, res) => {
    const wfId = parseInt(req.params.id);
    db.prepare('UPDATE workflows SET webhook_id = NULL WHERE id = ?').run(wfId);
    res.json({ ok: true });
  });

  // Trigger workflow via webhook
  app.post('/api/webhook/:webhookId', async (req, res) => {
    const wf = db.prepare('SELECT * FROM workflows WHERE webhook_id = ?').get(req.params.webhookId);
    if (!wf) return res.status(404).json({ error: 'Webhook not found' });

    const userId = wf.user_id;
    try {
      const result = await scheduler.executeWithTracking(userId, wf.id, 'webhook');
      gamification.addXP(userId, 'workflow_run');
      res.json({ ok: true, workflowId: wf.id, runId: result.runId, passed: result.passed, failed: result.failed });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== SSE EXECUTION STREAM ====================
  app.get('/api/workflows/:id/stream', (req, res) => {
    const wfId = parseInt(req.params.id);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ workflowId: wfId })}\n\n`);
    scheduler.addSSEClient(wfId, res);
  });

  // Execute workflow with SSE tracking
  app.post('/api/workflows/:id/execute', async (req, res) => {
    const userId = getUserId(req);
    const wfId = parseInt(req.params.id);
    try {
      const result = await scheduler.executeWithTracking(userId, wfId, 'manual');
      gamification.addXP(userId, 'workflow_run');
      const wf = workflows.get(wfId);
      const nodes = workflows.getNodes(wfId);
      const edges = workflows.getEdges(wfId);
      res.json({ ...wf, nodes, edges, runId: result.runId, passed: result.passed, failed: result.failed });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== SCHEDULER ====================
  app.get('/api/schedules', (req, res) => {
    const userId = getUserId(req);
    const schedules = scheduler.listByUser(userId).map(s => ({
      ...s,
      description: scheduler.describeCron(s.cron_expression),
      nextRun: s.next_run_at,
    }));
    res.json(schedules);
  });

  app.post('/api/workflows/:id/schedule', (req, res) => {
    const userId = getUserId(req);
    const wfId = parseInt(req.params.id);
    const { cronExpression } = req.body;
    if (!cronExpression) return res.status(400).json({ error: 'cronExpression required' });

    // Check if schedule already exists
    const existing = scheduler.getByWorkflow(wfId);
    if (existing) {
      scheduler.update(existing.id, {
        cron_expression: cronExpression,
        next_run_at: scheduler.getNextRunTime(cronExpression)?.toISOString() || null,
      });
      return res.json(scheduler.get(existing.id));
    }

    const schedule = scheduler.create(wfId, userId, cronExpression);
    res.json(schedule);
  });

  app.put('/api/schedules/:id/toggle', (req, res) => {
    scheduler.toggle(parseInt(req.params.id));
    res.json({ ok: true });
  });

  app.delete('/api/schedules/:id', (req, res) => {
    scheduler.delete(parseInt(req.params.id));
    res.json({ ok: true });
  });

  // ==================== RUN HISTORY ====================
  app.get('/api/workflows/:id/history', (req, res) => {
    const history = scheduler.getRunHistory(parseInt(req.params.id));
    res.json(history);
  });

  // ==================== WORKFLOW IMPORT ====================
  app.post('/api/workflows/import', async (req, res) => {
    const userId = getUserId(req);
    const { data } = req.body;
    if (!data || !data.workflow) return res.status(400).json({ error: 'Invalid import data' });

    try {
      const imported = data.workflow;
      const wf = workflows.create(userId, `${imported.title || 'Imported'} (copy)`, imported.description || '');

      const nodeIdMap = {};
      for (const node of (data.nodes || [])) {
        const newNode = workflows.addNode(
          wf.id, node.name, node.node_type || 'process',
          node.description || '',
          JSON.parse(node.inputs || '[]'),
          JSON.parse(node.outputs || '[]')
        );
        if (node.config) workflows.setNodeConfig(newNode.id, JSON.parse(node.config));
        if (node.custom_script) workflows.saveScript(newNode.id, node.custom_script);
        nodeIdMap[node.id] = newNode.id;
      }

      for (const edge of (data.edges || [])) {
        const fromId = nodeIdMap[edge.from_node_id];
        const toId = nodeIdMap[edge.to_node_id];
        if (fromId && toId) {
          workflows.connect(wf.id, fromId, toId, edge.from_output || 'default', edge.to_input || 'default');
        }
      }

      const nodes = workflows.getNodes(wf.id);
      const edges = workflows.getEdges(wf.id);
      res.json({ ...wf, nodes, edges });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==================== SEARCH ====================
  app.get('/api/search', (req, res) => {
    const userId = getUserId(req);
    const q = (req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({ boards: [], workflows: [], drafts: [] });

    const boardResults = boards.listByUser(userId).filter(b =>
      b.title.toLowerCase().includes(q) || (b.description || '').toLowerCase().includes(q)
    ).slice(0, 10);

    const wfResults = workflows.listByUser(userId).filter(w =>
      w.title.toLowerCase().includes(q) || (w.description || '').toLowerCase().includes(q)
    ).slice(0, 10);

    const draftResults = drafts.listByUser(userId).filter(d =>
      (d.title || '').toLowerCase().includes(q) || (d.url || '').toLowerCase().includes(q) || (d.description || '').toLowerCase().includes(q)
    ).slice(0, 10);

    res.json({ boards: boardResults, workflows: wfResults, drafts: draftResults });
  });

  // ==================== FEATURE ROUTES (extracted to routes/features.js) ====================
  setUserIdResolver(getUserId);
  app.use('/api', featureRoutes);

  // SPA fallback — don't catch API routes
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(join(__dirname, 'public', 'index.html'));
  });

  // Seed defaults and start scheduler
  templates.seedDefaults();
  challenges.seedDefaults();
  plugins.scan().catch(err => console.log('Plugin scan:', err.message));
  scheduler.start();

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`\u2705 Dashboard running at http://localhost:${port}`);
      resolve(server);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\u26a0\ufe0f  Dashboard port ${port} already in use — dashboard disabled, bot continues.`);
        resolve(null);
      } else {
        reject(err);
      }
    });
  });
}
