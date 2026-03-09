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

    // Save outputs to output/<project-name>/ folder
    await this._saveOutputs(workflow, nodeResults);

    return nodeResults;
  },

  // Save workflow execution results to output/<project>/ folder
  async _saveOutputs(workflow, nodeResults) {
    const fs = await import('fs/promises');
    const pathMod = await import('path');

    const safeName = (workflow.title || 'unnamed').replace(/[^a-zA-Z0-9_\- ]/g, '_').replace(/\s+/g, '_').substring(0, 50);
    const outputDir = pathMod.join(process.cwd(), 'output', safeName);

    try {
      await fs.mkdir(outputDir, { recursive: true });

      const summary = {
        workflowId: workflow.id,
        title: workflow.title,
        executedAt: new Date().toISOString(),
        nodeCount: nodeResults.size,
        results: {},
      };

      for (const [nodeId, result] of nodeResults) {
        const node = this.getNode(nodeId);
        const nodeName = node?.name || `node_${nodeId}`;
        summary.results[nodeName] = result;

        // Save code/file/output node results as separate files
        if (node && ['code', 'file', 'output'].includes(node.node_type) && result.result) {
          const safeNodeName = nodeName.replace(/[^a-zA-Z0-9_\-]/g, '_');
          const ext = node.node_type === 'code' ? (result.outputs?.filename ? '' : '.txt') : '.txt';
          const fileName = result.outputs?.filename || `${safeNodeName}${ext}`;
          await fs.writeFile(pathMod.join(outputDir, fileName), result.result, 'utf-8');
        }
      }

      await fs.writeFile(
        pathMod.join(outputDir, 'execution_summary.json'),
        JSON.stringify(summary, null, 2),
        'utf-8'
      );
    } catch (err) {
      console.error('Failed to save outputs:', err.message);
    }
  },

  async executeNode(userId, node, inputData) {
    const config = node._config || {};

    // If node has a custom script, use it instead of hardcoded logic
    if (node.custom_script) {
      return this._executeCustomScript(userId, node, inputData, config);
    }

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
        const pathMod = await import('path');
        if (config.operation === 'write') {
          const filePath = config.path || 'output.txt';
          // Use output directory for the workflow
          const workflow = this.get(node.workflow_id);
          const safeName = (workflow?.title || 'unnamed').replace(/[^a-zA-Z0-9_\- ]/g, '_').replace(/\s+/g, '_').substring(0, 50);
          const outputDir = pathMod.join(process.cwd(), 'output', safeName);
          await fs.mkdir(outputDir, { recursive: true });
          const fullPath = pathMod.join(outputDir, pathMod.basename(filePath));
          await fs.writeFile(fullPath, inputData.default || config.content || '');
          return { result: `Written to ${fullPath}`, outputs: { default: fullPath, filename: pathMod.basename(filePath) } };
        } else {
          const readPath = config.path || inputData.default || '';
          const content = await fs.readFile(readPath, 'utf-8');
          return { result: content, outputs: { default: content } };
        }
      }

      default:
        return { result: 'Unknown node type', outputs: { default: '' } };
    }
  },

  // Execute a custom script saved on a node
  async _executeCustomScript(userId, node, inputData, config) {
    const isPromptType = ['process', 'decision'].includes(node.node_type);

    if (isPromptType) {
      // Custom script is an LLM prompt — fill in inputData placeholder and call LLM
      const prompt = node.custom_script.replace(/\{\{inputData\}\}/g, JSON.stringify(inputData));
      const result = await llm.chat(userId, [
        { role: 'system', content: 'Follow the instructions precisely.' },
        { role: 'user', content: prompt },
      ]);
      if (node.node_type === 'decision') {
        const decision = result.text.trim().toLowerCase().includes('true');
        return {
          result: decision ? 'true' : 'false',
          outputs: { default: inputData.default || '', yes: decision ? inputData.default : '', no: decision ? '' : inputData.default },
        };
      }
      return { result: result.text, outputs: { default: result.text } };
    }

    // Custom script is JavaScript code — execute it
    try {
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      const fn = new AsyncFunction('inputData', 'config', 'fetch', 'llm', 'userId', node.custom_script);
      const result = await fn(inputData, config, globalThis.fetch, llm, userId);
      // Normalize the return value
      if (result && typeof result === 'object' && result.outputs) return result;
      return { result: String(result || ''), outputs: { default: String(result || '') } };
    } catch (err) {
      return { result: `Script error: ${err.message}`, outputs: { default: '', error: err.message } };
    }
  },

  // Generate the readable script/code representation for a node
  getNodeScript(node) {
    const config = node._config || JSON.parse(node.config || '{}');
    const inputs = node._inputs || JSON.parse(node.inputs || '[]');
    const outputs = node._outputs || JSON.parse(node.outputs || '[]');

    // If there's a custom script, return it instead of the generated preview
    if (node.custom_script) {
      const isPromptType = ['process', 'decision'].includes(node.node_type);
      return {
        language: isPromptType ? 'prompt' : (node.node_type === 'cli' ? 'bash' : 'javascript'),
        script: isPromptType ? null : node.custom_script,
        prompt: isPromptType ? node.custom_script : null,
        config,
        isCustom: true,
      };
    }

    switch (node.node_type) {
      case 'input':
        return {
          language: 'javascript',
          script: `// INPUT NODE: ${node.name}\n// Passes configured value or incoming data through\n\nconst value = config.value || inputData.default || "";\n\nreturn {\n  result: value,\n  outputs: { default: value }\n};`,
          prompt: null,
          config,
        };

      case 'process':
        return {
          language: 'prompt',
          script: null,
          prompt: `[SYSTEM] You are a workflow processor. Return only the processed result.\n\n[USER] You are processing data in a workflow node.\nNode: ${node.name}\nDescription: ${node.description || 'Process the input'}\nInput data: {{inputData}}\n\nProcess the input and return the result.`,
          config,
        };

      case 'code':
        return {
          language: 'prompt',
          script: null,
          prompt: `[SYSTEM] You are a code generator. Return only the code with a filename comment.\n\n[USER] Generate code based on:\nNode: ${node.name}\nDescription: ${node.description || 'Generate code'}\nInput context: {{inputData}}\n${config.language ? `Language: ${config.language}` : ''}\n${config.filename ? `Filename: ${config.filename}` : ''}\n\nGenerate clean, production-ready code.`,
          config,
        };

      case 'cli':
        return {
          language: 'bash',
          script: `# CLI NODE: ${node.name}\n# Command to execute:\n\n${config.command || '{{inputData.default}}'}`,
          prompt: null,
          config,
        };

      case 'decision':
        return {
          language: 'prompt',
          script: null,
          prompt: `[SYSTEM] Return only "true" or "false".\n\n[USER] Evaluate this condition:\nCondition: ${node.description || config.condition || 'Check input'}\nInput: {{inputData}}\n\nReturn ONLY "true" or "false".`,
          config,
        };

      case 'merge':
        return {
          language: 'javascript',
          script: `// MERGE NODE: ${node.name}\n// Combines all input values\n\nconst merged = Object.values(inputData).join("\\n\\n---\\n\\n");\n\nreturn {\n  result: merged,\n  outputs: { default: merged }\n};`,
          prompt: null,
          config,
        };

      case 'output':
        return {
          language: 'javascript',
          script: `// OUTPUT NODE: ${node.name}\n// Passes input through as final result\n\nreturn {\n  result: inputData.default || "",\n  outputs: { default: inputData.default || "" }\n};`,
          prompt: null,
          config,
        };

      case 'api':
        return {
          language: 'javascript',
          script: `// API NODE: ${node.name}\n// HTTP request\n\nconst url = ${JSON.stringify(config.url || '')} || inputData.url || "";\nconst method = ${JSON.stringify(config.method || 'GET')};\n\nconst res = await fetch(url, {\n  method,\n  headers: ${JSON.stringify(config.headers ? JSON.parse(config.headers) : {}, null, 2)},\n  ${config.method !== 'GET' ? `body: ${JSON.stringify(config.body || '')} || inputData.default` : '// GET request - no body'}\n});\n\nconst text = await res.text();\nreturn { result: text, outputs: { default: text, status: res.status } };`,
          prompt: null,
          config,
        };

      case 'file':
        return {
          language: 'javascript',
          script: config.operation === 'write'
            ? `// FILE WRITE NODE: ${node.name}\n\nconst path = ${JSON.stringify(config.path || 'output.txt')};\nconst content = inputData.default || ${JSON.stringify(config.content || '')};\n\nawait fs.writeFile(path, content);\nreturn { result: "Written to " + path, outputs: { default: path } };`
            : `// FILE READ NODE: ${node.name}\n\nconst path = ${JSON.stringify(config.path || '')} || inputData.default || "";\nconst content = await fs.readFile(path, "utf-8");\n\nreturn { result: content, outputs: { default: content } };`,
          prompt: null,
          config,
        };

      default:
        return { language: 'text', script: `// Unknown node type: ${node.node_type}`, prompt: null, config };
    }
  },

  // Save a custom script to a node
  saveScript(nodeId, script) {
    db.prepare('UPDATE workflow_nodes SET custom_script = ? WHERE id = ?').run(script, nodeId);
  },

  // Generate a script for a node using LLM
  async generateScript(userId, nodeId) {
    const node = this.getNode(nodeId);
    if (!node) throw new Error('Node not found');

    const config = node._config || {};
    const inputs = node._inputs || [];
    const outputs = node._outputs || [];

    // Gather context from connected nodes — include their output data/schema
    const edges = this.getEdges(node.workflow_id);
    const incoming = edges.filter(e => e.to_node_id === node.id);
    const outgoing = edges.filter(e => e.from_node_id === node.id);

    const connectedInputDetails = incoming.map(e => {
      const src = this.getNode(e.from_node_id);
      if (!src) return '';
      const srcOutputs = JSON.parse(src.outputs || '[]');
      const srcConfig = JSON.parse(src.config || '{}');

      // Try to get the upstream node's last result for schema inference
      let outputSample = '';
      if (src.result) {
        try {
          const parsed = JSON.parse(src.result);
          // Show just a compact example of what this node outputs
          outputSample = `\n    Last output sample: ${JSON.stringify(parsed, null, 2).substring(0, 500)}`;
        } catch {
          outputSample = `\n    Last output (text): ${src.result.substring(0, 300)}`;
        }
      }

      // If upstream has a custom script, show a brief summary
      let scriptHint = '';
      if (src.custom_script) {
        scriptHint = `\n    Script preview: ${src.custom_script.substring(0, 200)}...`;
      }

      return `- From "${src.name}" (${src.node_type}): output "${e.from_output}" → your input "${e.to_input}"
    Description: ${src.description || 'No description'}
    Output ports: [${srcOutputs.join(', ')}]${outputSample}${scriptHint}`;
    }).filter(Boolean).join('\n');

    const connectedOutputDetails = outgoing.map(e => {
      const dst = this.getNode(e.to_node_id);
      if (!dst) return '';
      const dstInputs = JSON.parse(dst.inputs || '[]');
      return `- To "${dst.name}" (${dst.node_type}): your output "${e.from_output}" → input "${e.to_input}"
    Description: ${dst.description || 'No description'}
    Expects input ports: [${dstInputs.join(', ')}]`;
    }).filter(Boolean).join('\n');

    const isPromptType = ['process', 'decision'].includes(node.node_type);

    let systemPrompt, userPrompt;

    if (isPromptType) {
      systemPrompt = 'You are a prompt engineer. Write an optimized LLM prompt for a workflow node. Return ONLY the prompt text, no explanations or markdown fences.';
      userPrompt = `Generate an LLM prompt for this workflow node:

Node: "${node.name}" (type: ${node.node_type})
Description: ${node.description || 'No description'}
Inputs: [${inputs.join(', ')}]
Outputs: [${outputs.join(', ')}]
Config: ${JSON.stringify(config)}
${connectedInputDetails ? `\nUpstream nodes (data coming IN):\n${connectedInputDetails}` : ''}
${connectedOutputDetails ? `\nDownstream nodes (data going OUT to):\n${connectedOutputDetails}` : ''}

The prompt will receive input data as {{inputData}} (a JSON string). It should instruct the LLM to process it and return the result.
${connectedInputDetails ? 'IMPORTANT: Based on the upstream output samples shown above, the prompt should expect and handle that specific data format.' : ''}
${connectedOutputDetails ? 'IMPORTANT: The output must be formatted so the downstream nodes can use it properly.' : ''}
${node.node_type === 'decision' ? 'The prompt must make the LLM return ONLY "true" or "false".' : ''}`;
    } else {
      systemPrompt = `You are a code generator. Write a JavaScript function body for a workflow node.
The function receives these variables:
- inputData: object with input port values (e.g. inputData.default, inputData.somePort)
- config: node configuration object
- fetch: for HTTP requests
- llm: LLM manager (use: await llm.chat(userId, [{role:'user', content:'...'}]))
- userId: current user ID

It must return: { result: string, outputs: { portName: value, ... } }

Return ONLY the JavaScript code, no markdown fences or explanations.`;

      userPrompt = `Generate JavaScript code for this workflow node:

Node: "${node.name}" (type: ${node.node_type})
Description: ${node.description || 'No description'}
Inputs: [${inputs.join(', ')}]
Outputs: [${outputs.join(', ')}]
Config: ${JSON.stringify(config)}
${connectedInputDetails ? `\nUpstream nodes (data coming IN):\n${connectedInputDetails}` : ''}
${connectedOutputDetails ? `\nDownstream nodes (data going OUT to):\n${connectedOutputDetails}` : ''}

${connectedInputDetails ? 'IMPORTANT: Based on the upstream output samples shown above, parse/handle the incoming data format correctly.' : ''}
${connectedOutputDetails ? 'IMPORTANT: Structure the output so downstream nodes can consume it (match their expected input ports).' : ''}
${node.node_type === 'cli' ? 'Use child_process exec to run shell commands.' : ''}
${node.node_type === 'api' ? 'Use fetch() for HTTP requests.' : ''}
${node.node_type === 'file' ? 'Use fs/promises for file operations.' : ''}
${node.node_type === 'merge' ? 'Combine all input values into one output.' : ''}`;
    }

    const result = await llm.chat(userId, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);

    const script = result.text.replace(/^```(?:javascript|js|bash)?\n?/g, '').replace(/```$/g, '').trim();
    this.saveScript(nodeId, script);

    return {
      script,
      language: isPromptType ? 'prompt' : (node.node_type === 'cli' ? 'bash' : 'javascript'),
      node_type: node.node_type,
    };
  },

  // Test a single node with provided input data
  async testNode(userId, nodeId, testInput = {}) {
    const node = this.getNode(nodeId);
    if (!node) throw new Error('Node not found');

    const startTime = Date.now();
    try {
      const result = await this.executeNode(userId, node, testInput);
      const duration = Date.now() - startTime;
      return {
        ok: true,
        duration,
        input: testInput,
        output: result,
        node: { id: node.id, name: node.name, node_type: node.node_type },
      };
    } catch (err) {
      const duration = Date.now() - startTime;
      return {
        ok: false,
        duration,
        input: testInput,
        error: err.message,
        node: { id: node.id, name: node.name, node_type: node.node_type },
      };
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
