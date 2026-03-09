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
