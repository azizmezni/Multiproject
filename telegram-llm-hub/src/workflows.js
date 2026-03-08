import db from './db.js';
import { llm } from './llm-manager.js';

// Node types define what a node does
export const NODE_TYPES = {
  input: { emoji: '\ud83d\udce5', label: 'Input', desc: 'Receives data from user or external source' },
  process: { emoji: '\u2699\ufe0f', label: 'Process', desc: 'Transforms or processes data using LLM' },
  code: { emoji: '\ud83d\udcbb', label: 'Code Gen', desc: 'Generates code files' },
  api: { emoji: '\ud83c\udf10', label: 'API Call', desc: 'Makes HTTP requests' },
  file: { emoji: '\ud83d\udcc4', label: 'File I/O', desc: 'Reads or writes files' },
  decision: { emoji: '\ud83d\udd00', label: 'Decision', desc: 'Branches based on condition' },
  output: { emoji: '\ud83d\udce4', label: 'Output', desc: 'Final output or result' },
  cli: { emoji: '\ud83d\udcdf', label: 'CLI', desc: 'Runs shell commands' },
  merge: { emoji: '\ud83d\udd00', label: 'Merge', desc: 'Combines multiple inputs' },
};

export const workflows = {
  // --- Workflow CRUD ---
  create(userId, title, description = '') {
    const result = db.prepare(
      'INSERT INTO workflows (user_id, title, description) VALUES (?, ?, ?)'
    ).run(userId, title, description);
    return this.get(result.lastInsertRowid);
  },

  get(workflowId) {
    return db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId);
  },

  listByUser(userId) {
    return db.prepare('SELECT * FROM workflows WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  },

  updateStatus(workflowId, status) {
    db.prepare('UPDATE workflows SET status = ? WHERE id = ?').run(status, workflowId);
  },

  delete(workflowId) {
    db.prepare('DELETE FROM workflows WHERE id = ?').run(workflowId);
  },

  // --- Node CRUD ---
  addNode(workflowId, name, nodeType = 'process', description = '', inputs = [], outputs = []) {
    const max = db.prepare('SELECT MAX(position) as m FROM workflow_nodes WHERE workflow_id = ?').get(workflowId);
    const position = (max?.m ?? -1) + 1;

    const result = db.prepare(
      'INSERT INTO workflow_nodes (workflow_id, name, description, node_type, inputs, outputs, position) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(workflowId, name, description, nodeType, JSON.stringify(inputs), JSON.stringify(outputs), position);
    return this.getNode(result.lastInsertRowid);
  },

  getNode(nodeId) {
    const node = db.prepare('SELECT * FROM workflow_nodes WHERE id = ?').get(nodeId);
    if (node) {
      node._inputs = JSON.parse(node.inputs || '[]');
      node._outputs = JSON.parse(node.outputs || '[]');
      node._config = JSON.parse(node.config || '{}');
    }
    return node;
  },

  getNodes(workflowId) {
    const nodes = db.prepare('SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY position ASC').all(workflowId);
    return nodes.map(n => ({
      ...n,
      _inputs: JSON.parse(n.inputs || '[]'),
      _outputs: JSON.parse(n.outputs || '[]'),
      _config: JSON.parse(n.config || '{}'),
    }));
  },

  updateNode(nodeId, updates) {
    const sets = [];
    const vals = [];
    for (const [key, val] of Object.entries(updates)) {
      if (key.startsWith('_')) continue; // skip parsed fields
      sets.push(`${key} = ?`);
      vals.push(typeof val === 'object' ? JSON.stringify(val) : val);
    }
    if (sets.length === 0) return;
    vals.push(nodeId);
    db.prepare(`UPDATE workflow_nodes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  },

  deleteNode(nodeId) {
    // Also remove connected edges
    db.prepare('DELETE FROM workflow_edges WHERE from_node_id = ? OR to_node_id = ?').run(nodeId, nodeId);
    db.prepare('DELETE FROM workflow_nodes WHERE id = ?').run(nodeId);
  },

  setNodeInputs(nodeId, inputs) {
    db.prepare('UPDATE workflow_nodes SET inputs = ? WHERE id = ?').run(JSON.stringify(inputs), nodeId);
  },

  setNodeOutputs(nodeId, outputs) {
    db.prepare('UPDATE workflow_nodes SET outputs = ? WHERE id = ?').run(JSON.stringify(outputs), nodeId);
  },

  setNodeConfig(nodeId, config) {
    db.prepare('UPDATE workflow_nodes SET config = ? WHERE id = ?').run(JSON.stringify(config), nodeId);
  },

  // --- Edge (Connection) CRUD ---
  connect(workflowId, fromNodeId, toNodeId, fromOutput = 'default', toInput = 'default') {
    // Prevent duplicate connections
    const existing = db.prepare(
      'SELECT id FROM workflow_edges WHERE workflow_id = ? AND from_node_id = ? AND to_node_id = ? AND from_output = ? AND to_input = ?'
    ).get(workflowId, fromNodeId, toNodeId, fromOutput, toInput);
    if (existing) return existing;

    const result = db.prepare(
      'INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, from_output, to_input) VALUES (?, ?, ?, ?, ?)'
    ).run(workflowId, fromNodeId, toNodeId, fromOutput, toInput);
    return { id: result.lastInsertRowid };
  },

  disconnect(edgeId) {
    db.prepare('DELETE FROM workflow_edges WHERE id = ?').run(edgeId);
  },

  getEdges(workflowId) {
    return db.prepare('SELECT * FROM workflow_edges WHERE workflow_id = ?').all(workflowId);
  },

  getOutgoingEdges(nodeId) {
    return db.prepare('SELECT * FROM workflow_edges WHERE from_node_id = ?').all(nodeId);
  },

  getIncomingEdges(nodeId) {
    return db.prepare('SELECT * FROM workflow_edges WHERE to_node_id = ?').all(nodeId);
  },

  // --- Workflow visualization ---
  renderWorkflow(workflowId) {
    const workflow = this.get(workflowId);
    if (!workflow) return 'Workflow not found.';

    const nodes = this.getNodes(workflowId);
    const edges = this.getEdges(workflowId);

    let text = `\ud83d\udd27 *${workflow.title}*\n`;
    text += `Status: ${workflow.status}\n`;
    text += `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\n`;

    if (nodes.length === 0) {
      text += '_No nodes yet. Use Add Node to start building._\n';
      return text;
    }

    // Build adjacency for display
    const edgeMap = new Map();
    for (const e of edges) {
      if (!edgeMap.has(e.from_node_id)) edgeMap.set(e.from_node_id, []);
      edgeMap.get(e.from_node_id).push(e);
    }

    for (const node of nodes) {
      const type = NODE_TYPES[node.node_type] || NODE_TYPES.process;
      const statusE = node.status === 'done' ? '\u2705' : node.status === 'running' ? '\ud83d\udd35' : '\u2b1c';

      text += `${statusE} ${type.emoji} *${node.name}* (#${node.id})\n`;
      if (node.description) text += `   _${node.description}_\n`;

      // Show inputs
      const ins = node._inputs;
      if (ins.length > 0) {
        text += `   In: ${ins.map(i => `\`${i}\``).join(', ')}\n`;
      }

      // Show outputs
      const outs = node._outputs;
      if (outs.length > 0) {
        text += `   Out: ${outs.map(o => `\`${o}\``).join(', ')}\n`;
      }

      // Show connections
      const outEdges = edgeMap.get(node.id) || [];
      for (const e of outEdges) {
        const targetNode = nodes.find(n => n.id === e.to_node_id);
        if (targetNode) {
          text += `   \u2514\u2500\u27a1\ufe0f ${targetNode.name} (${e.from_output}\u2192${e.to_input})\n`;
        }
      }
      text += '\n';
    }

    return text;
  },

  // --- Topological sort for execution order ---
  getExecutionOrder(workflowId) {
    const nodes = this.getNodes(workflowId);
    const edges = this.getEdges(workflowId);

    // Build adjacency and in-degree
    const inDegree = new Map();
    const adj = new Map();
    for (const n of nodes) {
      inDegree.set(n.id, 0);
      adj.set(n.id, []);
    }
    for (const e of edges) {
      adj.get(e.from_node_id)?.push(e.to_node_id);
      inDegree.set(e.to_node_id, (inDegree.get(e.to_node_id) || 0) + 1);
    }

    // Kahn's algorithm
    const queue = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    const order = [];
    while (queue.length > 0) {
      const curr = queue.shift();
      order.push(curr);
      for (const next of (adj.get(curr) || [])) {
        inDegree.set(next, inDegree.get(next) - 1);
        if (inDegree.get(next) === 0) queue.push(next);
      }
    }

    if (order.length !== nodes.length) {
      throw new Error('Workflow has circular dependencies!');
    }

    return order.map(id => nodes.find(n => n.id === id));
  },

  // --- Execute workflow ---
  async executeWorkflow(userId, workflowId, onProgress) {
    const workflow = this.get(workflowId);
    if (!workflow) throw new Error('Workflow not found');

    this.updateStatus(workflowId, 'running');
    const orderedNodes = this.getExecutionOrder(workflowId);
    const edges = this.getEdges(workflowId);
    const nodeResults = new Map(); // nodeId -> { outputs: { outputName: value } }

    for (const node of orderedNodes) {
      this.updateNode(node.id, { status: 'running' });
      if (onProgress) await onProgress(node, 'running');

      try {
        // Gather inputs from connected nodes
        const incomingEdges = edges.filter(e => e.to_node_id === node.id);
        const inputData = {};
        for (const e of incomingEdges) {
          const sourceResult = nodeResults.get(e.from_node_id);
          if (sourceResult) {
            inputData[e.to_input] = sourceResult.outputs?.[e.from_output] || sourceResult.result || '';
          }
        }

        // Execute node based on type
        const result = await this.executeNode(userId, node, inputData);
        nodeResults.set(node.id, result);

        this.updateNode(node.id, { status: 'done', result: JSON.stringify(result) });
        if (onProgress) await onProgress(node, 'done', result);
      } catch (err) {
        this.updateNode(node.id, { status: 'error', result: JSON.stringify({ error: err.message }) });
        if (onProgress) await onProgress(node, 'error', { error: err.message });
        // Continue with other nodes that don't depend on this one
      }
    }

    const allDone = this.getNodes(workflowId).every(n => n.status === 'done');
    this.updateStatus(workflowId, allDone ? 'completed' : 'partial');
    return nodeResults;
  },

  async executeNode(userId, node, inputData) {
    const config = node._config || {};

    switch (node.node_type) {
      case 'input': {
        // Input nodes just pass through their config or user-provided data
        return {
          result: config.value || inputData.default || '',
          outputs: { default: config.value || inputData.default || '' },
        };
      }

      case 'process': {
        const prompt = `You are processing data in a workflow node.
Node: ${node.name}
Description: ${node.description || 'Process the input'}
Input data: ${JSON.stringify(inputData)}

Process the input and return the result.`;

        const result = await llm.chat(userId, [
          { role: 'system', content: 'You are a workflow processor. Return only the processed result.' },
          { role: 'user', content: prompt },
        ]);
        return { result: result.text, outputs: { default: result.text } };
      }

      case 'code': {
        const prompt = `Generate code based on:
Node: ${node.name}
Description: ${node.description || 'Generate code'}
Input context: ${JSON.stringify(inputData)}
${config.language ? `Language: ${config.language}` : ''}
${config.filename ? `Filename: ${config.filename}` : ''}

Generate clean, production-ready code. Include the filename as a comment at the top.`;

        const result = await llm.chat(userId, [
          { role: 'system', content: 'You are a code generator. Return only the code with a filename comment.' },
          { role: 'user', content: prompt },
        ]);
        return {
          result: result.text,
          outputs: {
            default: result.text,
            code: result.text,
            filename: config.filename || 'output.txt',
          },
        };
      }

      case 'cli': {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        const command = config.command || inputData.default || '';
        try {
          const { stdout, stderr } = await execAsync(command, { timeout: 30000, maxBuffer: 1024 * 1024 });
          return { result: stdout || stderr, outputs: { default: stdout, stderr } };
        } catch (err) {
          return { result: err.message, outputs: { default: '', error: err.message } };
        }
      }

      case 'decision': {
        const prompt = `Evaluate this condition:
Condition: ${node.description || config.condition || 'Check input'}
Input: ${JSON.stringify(inputData)}

Return ONLY "true" or "false".`;

        const result = await llm.chat(userId, [
          { role: 'system', content: 'Return only "true" or "false".' },
          { role: 'user', content: prompt },
        ]);
        const decision = result.text.trim().toLowerCase().includes('true');
        return {
          result: decision ? 'true' : 'false',
          outputs: { default: inputData.default || '', yes: decision ? inputData.default : '', no: decision ? '' : inputData.default },
        };
      }

      case 'merge': {
        const merged = Object.values(inputData).join('\n\n---\n\n');
        return { result: merged, outputs: { default: merged } };
      }

      case 'output': {
        return { result: inputData.default || '', outputs: { default: inputData.default || '' } };
      }

      case 'api': {
        const url = config.url || inputData.url || '';
        const method = config.method || 'GET';
        try {
          const res = await fetch(url, {
            method,
            headers: config.headers ? JSON.parse(config.headers) : {},
            body: method !== 'GET' ? (config.body || inputData.default || undefined) : undefined,
          });
          const text = await res.text();
          return { result: text, outputs: { default: text, status: res.status.toString() } };
        } catch (err) {
          return { result: err.message, outputs: { default: '', error: err.message } };
        }
      }

      case 'file': {
        const fs = await import('fs/promises');
        if (config.operation === 'write') {
          const path = config.path || 'output.txt';
          await fs.writeFile(path, inputData.default || config.content || '');
          return { result: `Written to ${path}`, outputs: { default: path } };
        } else {
          const path = config.path || inputData.default || '';
          const content = await fs.readFile(path, 'utf-8');
          return { result: content, outputs: { default: content } };
        }
      }

      default:
        return { result: 'Unknown node type', outputs: { default: '' } };
    }
  },

  // Auto-generate workflow from description using LLM
  async generateWorkflow(userId, description) {
    const result = await llm.chat(userId, [
      {
        role: 'system',
        content: `You are a workflow architect. Design a workflow (like n8n) for the given task.
Return a JSON object:
{
  "title": "Workflow Title",
  "nodes": [
    {
      "name": "Node Name",
      "type": "input|process|code|api|file|decision|output|cli|merge",
      "description": "What this node does",
      "inputs": ["input_name"],
      "outputs": ["output_name"],
      "config": {}
    }
  ],
  "edges": [
    { "from": 0, "to": 1, "from_output": "default", "to_input": "default" }
  ]
}
Use indices (0-based) for from/to in edges. Only return JSON.`
      },
      { role: 'user', content: description },
    ]);

    try {
      const cleaned = result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      return JSON.parse(cleaned);
    } catch {
      return { title: 'Workflow', nodes: [{ name: 'Review', type: 'process', description: result.text, inputs: [], outputs: ['default'] }], edges: [] };
    }
  },

  // Build workflow from LLM-generated plan
  async buildFromDescription(userId, description) {
    const plan = await this.generateWorkflow(userId, description);
    const workflow = this.create(userId, plan.title || 'Workflow', description);

    const nodeIdMap = []; // index -> db id
    for (const n of plan.nodes) {
      const node = this.addNode(
        workflow.id,
        n.name,
        n.type || 'process',
        n.description || '',
        n.inputs || [],
        n.outputs || ['default']
      );
      if (n.config) this.setNodeConfig(node.id, n.config);
      nodeIdMap.push(node.id);
    }

    for (const e of (plan.edges || [])) {
      if (nodeIdMap[e.from] !== undefined && nodeIdMap[e.to] !== undefined) {
        this.connect(workflow.id, nodeIdMap[e.from], nodeIdMap[e.to], e.from_output || 'default', e.to_input || 'default');
      }
    }

    return workflow;
  },
};
