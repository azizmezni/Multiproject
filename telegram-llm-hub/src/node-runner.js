/**
 * Node execution engine — each node type is a separate, testable function.
 * The primary input to each runner is `inputData` (output from previous node).
 */
import { llm } from './llm-manager.js';

// ─── Node runner registry ───────────────────────────────────────
// Each runner: async (userId, node, inputData, config) => { result, outputs }

const runners = {};

// INPUT: pass through configured value or incoming data
runners.input = async (_userId, node, inputData, config) => {
  const value = config.value || inputData.default || '';
  return { result: value, outputs: { default: value } };
};

// PROCESS: send data to LLM for processing
runners.process = async (userId, node, inputData, _config) => {
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
};

// CODE: generate code via LLM
runners.code = async (userId, node, inputData, config) => {
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
};

// CLI: execute shell command
runners.cli = async (_userId, _node, inputData, config) => {
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
};

// DECISION: LLM evaluates a condition → true/false
runners.decision = async (userId, node, inputData, config) => {
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
    outputs: {
      default: inputData.default || '',
      yes: decision ? inputData.default : '',
      no: decision ? '' : inputData.default,
    },
  };
};

// MERGE: combine multiple inputs
runners.merge = async (_userId, _node, inputData) => {
  const merged = Object.values(inputData).join('\n\n---\n\n');
  return { result: merged, outputs: { default: merged } };
};

// OUTPUT: pass-through
runners.output = async (_userId, _node, inputData) => {
  return { result: inputData.default || '', outputs: { default: inputData.default || '' } };
};

// API: HTTP request
runners.api = async (_userId, _node, inputData, config) => {
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
};

// FILE: read or write files
runners.file = async (_userId, node, inputData, config) => {
  const fs = await import('fs/promises');
  const pathMod = await import('path');

  if (config.operation === 'write') {
    const filePath = config.path || 'output.txt';
    const safeName = ('unnamed').replace(/[^a-zA-Z0-9_\- ]/g, '_').substring(0, 50);
    const outputDir = pathMod.join(process.cwd(), 'output', safeName);
    await fs.mkdir(outputDir, { recursive: true });
    const fullPath = pathMod.join(outputDir, pathMod.basename(filePath));
    await fs.writeFile(fullPath, inputData.default || config.content || '');
    return { result: `Written to ${fullPath}`, outputs: { default: fullPath, filename: pathMod.basename(filePath) } };
  }

  const readPath = config.path || inputData.default || '';
  const content = await fs.readFile(readPath, 'utf-8');
  return { result: content, outputs: { default: content } };
};

// CONDITION (if/else): evaluate expression against input
runners.condition = async (userId, node, inputData, config) => {
  // Reuse decision runner
  return runners.decision(userId, node, inputData, config);
};

// SWITCH: route to named path based on matching value
runners.switch_node = async (_userId, node, inputData, config) => {
  const value = inputData.default || '';
  const cases = config.cases || {};
  const matchedCase = Object.keys(cases).find(k => value.includes(k));
  const outputs = { default: value };
  if (matchedCase) outputs[matchedCase] = value;
  return { result: matchedCase || 'default', outputs };
};

// ─── Custom script runner ───────────────────────────────────────

async function runCustomScript(userId, node, inputData, config) {
  const env = config.env || {};
  const isPromptType = ['process', 'decision'].includes(node.node_type);

  if (isPromptType) {
    let prompt = node.custom_script.replace(/\{\{inputData\}\}/g, JSON.stringify(inputData));
    for (const [key, val] of Object.entries(env)) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      prompt = prompt.replace(new RegExp(`\\{\\{${escaped}\\}\\}`, 'g'), () => val);
    }
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

  // JS code execution
  try {
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    const fn = new AsyncFunction('inputData', 'config', 'env', 'fetch', 'llm', 'userId', node.custom_script);
    const result = await fn(inputData, config, env, globalThis.fetch, llm, userId);
    if (result && typeof result === 'object' && result.outputs) return result;
    return { result: String(result || ''), outputs: { default: String(result || '') } };
  } catch (err) {
    return { result: `Script error: ${err.message}`, outputs: { default: '', error: err.message } };
  }
}

// ─── Main entry point ───────────────────────────────────────────

/**
 * Execute a single node. If the node has a custom_script, use that.
 * Otherwise, use the built-in runner for the node type.
 *
 * @param {string} userId
 * @param {object} node — DB row with _config parsed
 * @param {object} inputData — key/value from upstream nodes
 * @returns {Promise<{result: string, outputs: object}>}
 */
export async function executeNode(userId, node, inputData) {
  const config = node._config || {};

  // Custom script takes priority
  if (node.custom_script) {
    return runCustomScript(userId, node, inputData, config);
  }

  const runner = runners[node.node_type];
  if (!runner) {
    return { result: `Unknown node type: ${node.node_type}`, outputs: { default: '' } };
  }

  return runner(userId, node, inputData, config);
}

// Export individual runners for direct testing
export { runners };
