import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import db from './db.js';
import { llm } from './llm-manager.js';
import { sessions } from './sessions.js';
import { boards } from './boards.js';
import { drafts } from './drafts.js';
import { workflows, NODE_TYPES } from './workflows.js';
import { gamification } from './gamification.js';
import { qa } from './qa.js';
import { PROVIDER_REGISTRY } from './providers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createDashboard(port = 9999) {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, 'public')));

  // Resolve userId: use query param or first known user, or default 1
  function getUserId(req) {
    if (req.query.userId) return parseInt(req.query.userId);
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
    boards.delete(parseInt(req.params.id));
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

  app.post('/api/boards/:id/execute', async (req, res) => {
    const userId = getUserId(req);
    const boardId = parseInt(req.params.id);
    boards.updateStatus(boardId, 'executing');
    res.json({ status: 'started' }); // Respond immediately, execution is async
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
    if (req.body.config) workflows.setNodeConfig(nodeId, req.body.config);
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
    const connectedInputs = {};
    for (const e of incoming) {
      const srcNode = workflows.getNode(e.from_node_id);
      if (srcNode?.result) {
        try {
          const parsed = JSON.parse(srcNode.result);
          connectedInputs[e.to_input] = parsed.outputs?.[e.from_output] || parsed.result || '';
        } catch { connectedInputs[e.to_input] = ''; }
      }
    }
    res.json({ ...script, connectedInputs, node: { id: node.id, name: node.name, node_type: node.node_type, description: node.description } });
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

  // Save a custom script to a node
  app.put('/api/workflows/nodes/:id/script', (req, res) => {
    const nodeId = parseInt(req.params.id);
    workflows.saveScript(nodeId, req.body.script);
    res.json({ ok: true });
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

  app.post('/api/workflows/:id/execute', async (req, res) => {
    const userId = getUserId(req);
    const wfId = parseInt(req.params.id);
    try {
      const results = await workflows.executeWorkflow(userId, wfId);
      gamification.addXP(userId, 'workflow_run');
      const wf = workflows.get(wfId);
      const nodes = workflows.getNodes(wfId);
      const edges = workflows.getEdges(wfId);
      res.json({ ...wf, nodes, edges, results: Object.fromEntries(results) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/node-types', (req, res) => {
    res.json(NODE_TYPES);
  });

  // ==================== DRAFTS ====================
  app.get('/api/drafts', (req, res) => {
    res.json(drafts.listByUser(getUserId(req)));
  });

  app.delete('/api/drafts/:id', (req, res) => {
    drafts.delete(parseInt(req.params.id));
    res.json({ ok: true });
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

    try {
      const result = await llm.chat(userId, chatMessages);
      sessions.addMessage(session.id, 'assistant', result.text);
      gamification.addXP(userId, 'message_sent');
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
    const result = await qa.runCommand(req.body.command, req.body.cwd);
    res.json(result);
  });

  // SPA fallback
  app.get('*', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'index.html'));
  });

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`\u2705 Dashboard running at http://localhost:${port}`);
      resolve(server);
    });
  });
}
