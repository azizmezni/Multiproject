import { safeSend } from '../bot-helpers.js';

export function registerWorkflows(bot, shared) {
  const { llm, workflows, NODE_TYPES, userState, helpers } = shared;

  bot.command('workflow', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const desc = ctx.message.text.replace('/workflow', '').trim();
    if (!desc) return ctx.reply(
      '*Workflow Builder*\n\n' +
      '/workflow <description> \u2014 Auto-generate workflow\n' +
      '/wfnew <title> \u2014 Create empty workflow\n' +
      '/wflist \u2014 List workflows\n' +
      '/wfnode <name> | <type> | <desc> \u2014 Add node to active workflow\n' +
      '/wfconnect <from_id> <to_id> \u2014 Connect two nodes\n' +
      '/wfview \u2014 View active workflow\n' +
      '/wfrun \u2014 Execute workflow\n' +
      '/wffix [problem] \u2014 Auto-fix failing nodes\n\n' +
      '*Dev Assistant:*\n' +
      '/feature <desc> \u2014 Add a feature\n' +
      '/bugfix <desc> \u2014 Fix a bug\n\n' +
      `*Node Types:* ${Object.entries(NODE_TYPES).map(([k, v]) => `${v.emoji} ${k}`).join(', ')}`,
      { parse_mode: 'Markdown' }
    );

    await ctx.reply(`\ud83d\udd27 Generating workflow for: *${desc}*...`, { parse_mode: 'Markdown' });
    try {
      const workflow = await workflows.buildFromDescription(userId, desc);
      helpers.db_setActiveWorkflow(userId, workflow.id);
      const text = workflows.renderWorkflow(workflow.id);
      const nodes = workflows.getNodes(workflow.id);
      await ctx.reply(text, { parse_mode: 'Markdown', ...helpers.workflowKeyboard(workflow.id, nodes) });
    } catch (err) {
      await ctx.reply(`\u274c Error: ${err.message}`);
    }
  });

  bot.command('wfnew', async (ctx) => {
    const title = ctx.message.text.replace('/wfnew', '').trim() || 'New Workflow';
    const workflow = workflows.create(ctx.from.id, title);
    helpers.db_setActiveWorkflow(ctx.from.id, workflow.id);
    await ctx.reply(
      `\ud83d\udd27 *Workflow created: ${title}*\n\nAdd nodes with /wfnode <name> | <type> | <description>\nNode types: ${Object.entries(NODE_TYPES).map(([k]) => `\`${k}\``).join(', ')}`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('wflist', async (ctx) => {
    const list = workflows.listByUser(ctx.from.id);
    if (list.length === 0) return ctx.reply('No workflows. Use /workflow <desc> or /wfnew <title>.');
    let text = '\ud83d\udd27 *Your Workflows:*\n\n';
    const buttons = [];
    for (const w of list) {
      const nodes = workflows.getNodes(w.id);
      text += `\u2022 *${w.title}* (${nodes.length} nodes) - ${w.status}\n`;
      buttons.push([{ text: `\ud83d\udd27 ${w.title}`, callback_data: `wf_view:${w.id}` }]);
    }
    buttons.push([{ text: '\u25c0\ufe0f Back', callback_data: 'main_menu' }]);
    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  });

  bot.command('wfnode', async (ctx) => {
    const wfId = helpers.getActiveWorkflow(ctx.from.id);
    if (!wfId) return ctx.reply('No active workflow. Use /wfnew or /wflist first.');
    const args = ctx.message.text.replace('/wfnode', '').trim();
    if (!args) return ctx.reply('Usage: /wfnode <name> | <type> | <description>\nExample: /wfnode Parse Data | process | Extract JSON fields');
    const parts = args.split('|').map(s => s.trim());
    const [name = 'Node', type = 'process', desc = ''] = parts;
    if (!NODE_TYPES[type]) return ctx.reply(`Unknown type: ${type}\nAvailable: ${Object.keys(NODE_TYPES).join(', ')}`);
    workflows.addNode(wfId, name, type, desc, ['default'], ['default']);
    const text = workflows.renderWorkflow(wfId);
    const nodes = workflows.getNodes(wfId);
    await ctx.reply(text, { parse_mode: 'Markdown', ...helpers.workflowKeyboard(wfId, nodes) });
  });

  bot.command('wfconnect', async (ctx) => {
    const wfId = helpers.getActiveWorkflow(ctx.from.id);
    if (!wfId) return ctx.reply('No active workflow.');
    const args = ctx.message.text.replace('/wfconnect', '').trim().split(/\s+/);
    if (args.length < 2) return ctx.reply('Usage: /wfconnect <from_node_id> <to_node_id>');
    const [fromId, toId, fromOutput, toInput] = args;
    workflows.connect(wfId, parseInt(fromId), parseInt(toId), fromOutput || 'default', toInput || 'default');
    const text = workflows.renderWorkflow(wfId);
    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  bot.command('wfview', async (ctx) => {
    const wfId = helpers.getActiveWorkflow(ctx.from.id);
    if (!wfId) return ctx.reply('No active workflow.');
    const text = workflows.renderWorkflow(wfId);
    const nodes = workflows.getNodes(wfId);
    await ctx.reply(text, { parse_mode: 'Markdown', ...helpers.workflowKeyboard(wfId, nodes) });
  });

  bot.command('wfrun', async (ctx) => {
    const wfId = helpers.getActiveWorkflow(ctx.from.id);
    if (!wfId) return ctx.reply('No active workflow.');
    const nodes = workflows.getNodes(wfId);
    if (nodes.length === 0) return ctx.reply('Workflow has no nodes.');
    await ctx.reply('\u26a1 *Executing workflow...*', { parse_mode: 'Markdown' });
    try {
      await workflows.executeWorkflow(ctx.from.id, wfId, async (node, status, result) => {
        const type = NODE_TYPES[node.node_type] || NODE_TYPES.process;
        if (status === 'running') {
          await ctx.reply(`\ud83d\udd35 Running: ${type.emoji} *${node.name}*`, { parse_mode: 'Markdown' });
        } else if (status === 'done') {
          let output = result?.result || '';
          if (output.length > 1000) output = output.substring(0, 1000) + '...(truncated)';
          await ctx.reply(`\u2705 Done: ${type.emoji} *${node.name}*\n\n\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
        } else if (status === 'error') {
          await ctx.reply(`\u274c Error: ${type.emoji} *${node.name}*\n${result?.error}`, { parse_mode: 'Markdown' });
        }
      });
      const text = workflows.renderWorkflow(wfId);
      await ctx.reply(`\ud83c\udf89 Workflow completed!\n\n${text}`, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`\u274c Workflow error: ${err.message}`);
    }
  });

  bot.command('wffix', async (ctx) => {
    const wfId = helpers.getActiveWorkflow(ctx.from.id);
    if (!wfId) return ctx.reply('No active workflow. Use /wflist first.');
    const problem = ctx.message.text.replace('/wffix', '').trim();
    await runAutoFix(ctx, ctx.from.id, wfId, problem || null);
  });

  bot.command('wfinput', async (ctx) => {
    const wfId = helpers.getActiveWorkflow(ctx.from.id);
    if (!wfId) return ctx.reply('No active workflow.');
    const args = ctx.message.text.replace('/wfinput', '').trim();
    const parts = args.split('|').map(s => s.trim());
    if (parts.length < 2) return ctx.reply('Usage: /wfinput <node_id> | <input_name1, input_name2>');
    const nodeId = parseInt(parts[0]);
    const inputs = parts[1].split(',').map(s => s.trim());
    workflows.setNodeInputs(nodeId, inputs);
    await ctx.reply(`\u2705 Inputs set for node #${nodeId}: ${inputs.join(', ')}`);
  });

  bot.command('wfoutput', async (ctx) => {
    const wfId = helpers.getActiveWorkflow(ctx.from.id);
    if (!wfId) return ctx.reply('No active workflow.');
    const args = ctx.message.text.replace('/wfoutput', '').trim();
    const parts = args.split('|').map(s => s.trim());
    if (parts.length < 2) return ctx.reply('Usage: /wfoutput <node_id> | <output_name1, output_name2>');
    const nodeId = parseInt(parts[0]);
    const outputs = parts[1].split(',').map(s => s.trim());
    workflows.setNodeOutputs(nodeId, outputs);
    await ctx.reply(`\u2705 Outputs set for node #${nodeId}: ${outputs.join(', ')}`);
  });

  bot.command('wfdelete', async (ctx) => {
    const idStr = ctx.message.text.split(/\s+/)[1];
    if (!idStr) return safeSend(ctx, '\u274c Usage: /wfdelete <workflow_id>');
    try {
      workflows.delete(parseInt(idStr));
      await safeSend(ctx, '\ud83d\uddd1 Workflow deleted.');
    } catch (err) {
      await safeSend(ctx, `\u274c ${err.message}`);
    }
  });

  // --- Workflow callback queries ---
  bot.action('list_workflows', async (ctx) => {
    await ctx.answerCbQuery();
    const list = workflows.listByUser(ctx.from.id);
    if (list.length === 0) return ctx.editMessageText('\ud83d\udd27 No workflows yet.\n\nUse /workflow <description> to auto-generate one\nor /wfnew <title> to create an empty one.');
    let text = '\ud83d\udd27 *Your Workflows:*\n\n';
    const buttons = [];
    for (const w of list) {
      const nodes = workflows.getNodes(w.id);
      text += `\u2022 *${w.title}* (${nodes.length} nodes) - ${w.status}\n`;
      buttons.push([{ text: `\ud83d\udd27 ${w.title}`, callback_data: `wf_view:${w.id}` }]);
    }
    buttons.push([{ text: '\u25c0\ufe0f Back', callback_data: 'main_menu' }]);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  });

  bot.action(/wf_view:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const wfId = parseInt(ctx.match[1]);
    helpers.db_setActiveWorkflow(ctx.from.id, wfId);
    const text = workflows.renderWorkflow(wfId);
    const nodes = workflows.getNodes(wfId);
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...helpers.workflowKeyboard(wfId, nodes) });
    } catch {
      await ctx.reply(text, { parse_mode: 'Markdown', ...helpers.workflowKeyboard(wfId, nodes) });
    }
  });

  bot.action(/wf_addnode:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const wfId = parseInt(ctx.match[1]);
    const buttons = Object.entries(NODE_TYPES).map(([key, val]) => [
      { text: `${val.emoji} ${val.label}`, callback_data: `wf_nodetype:${wfId}:${key}` },
    ]);
    buttons.push([{ text: '\u25c0\ufe0f Back', callback_data: `wf_view:${wfId}` }]);
    await ctx.editMessageText('Select node type:', { reply_markup: { inline_keyboard: buttons } });
  });

  bot.action(/wf_nodetype:(\d+):(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const wfId = parseInt(ctx.match[1]);
    const nodeType = ctx.match[2];
    userState.setAwaiting(ctx.from.id, `wf_addnode:${wfId}:${nodeType}`);
    const type = NODE_TYPES[nodeType];
    await ctx.editMessageText(
      `${type.emoji} *Adding ${type.label} node*\n\nSend the node details in this format:\n\`name | description\`\n\nExample: \`Parse User Data | Extract name and email from input\``,
      { parse_mode: 'Markdown' }
    );
  });

  bot.action(/wf_nodedetail:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const nodeId = parseInt(ctx.match[1]);
    const node = workflows.getNode(nodeId);
    if (!node) return;
    const type = NODE_TYPES[node.node_type] || NODE_TYPES.process;
    const incoming = workflows.getIncomingEdges(nodeId);
    const outgoing = workflows.getOutgoingEdges(nodeId);
    const allNodes = workflows.getNodes(node.workflow_id);

    let text = `${type.emoji} *${node.name}* (#${node.id})\nType: ${type.label}\nStatus: ${node.status}\n`;
    if (node.description) text += `Desc: ${node.description}\n`;
    text += `\nInputs: ${node._inputs.join(', ') || 'none'}\nOutputs: ${node._outputs.join(', ') || 'none'}`;

    const envVars = node._config?.env || {};
    const envCount = Object.keys(envVars).length;
    if (envCount > 0) text += `\n\n\ud83d\udd11 Env vars: ${Object.keys(envVars).map(k => `\`${k}\``).join(', ')}`;

    if (incoming.length > 0) {
      text += '\n\nConnected from:';
      for (const e of incoming) {
        const src = allNodes.find(n => n.id === e.from_node_id);
        text += `\n  \u2190 ${src?.name || '?'} (${e.from_output}\u2192${e.to_input})`;
      }
    }
    if (outgoing.length > 0) {
      text += '\n\nConnected to:';
      for (const e of outgoing) {
        const dst = allNodes.find(n => n.id === e.to_node_id);
        text += `\n  \u2192 ${dst?.name || '?'} (${e.from_output}\u2192${e.to_input})`;
      }
    }

    const buttons = [];
    const unconnected = allNodes.filter(n => n.id !== nodeId && !outgoing.find(e => e.to_node_id === n.id));
    if (unconnected.length > 0) buttons.push([{ text: '\ud83d\udd17 Connect to...', callback_data: `wf_connect_from:${nodeId}` }]);
    buttons.push([
      { text: '\u270f\ufe0f Edit Inputs', callback_data: `wf_edit_io:${nodeId}:inputs` },
      { text: '\u270f\ufe0f Edit Outputs', callback_data: `wf_edit_io:${nodeId}:outputs` },
    ]);
    buttons.push([{ text: `\ud83d\udd11 Env Vars (${envCount})`, callback_data: `wf_env:${nodeId}` }]);
    buttons.push([
      { text: '\ud83d\uddd1\ufe0f Delete', callback_data: `wf_delnode:${nodeId}` },
      { text: '\u25c0\ufe0f Back', callback_data: `wf_view:${node.workflow_id}` },
    ]);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  });

  bot.action(/wf_connect_from:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const fromId = parseInt(ctx.match[1]);
    const node = workflows.getNode(fromId);
    const allNodes = workflows.getNodes(node.workflow_id);
    const outgoing = workflows.getOutgoingEdges(fromId);
    const targets = allNodes.filter(n => n.id !== fromId && !outgoing.find(e => e.to_node_id === n.id));
    const buttons = targets.map(n => [{ text: `\u27a1\ufe0f ${n.name}`, callback_data: `wf_doconnect:${node.workflow_id}:${fromId}:${n.id}` }]);
    buttons.push([{ text: '\u25c0\ufe0f Back', callback_data: `wf_nodedetail:${fromId}` }]);
    await ctx.editMessageText(`Connect *${node.name}* to:`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  });

  bot.action(/wf_doconnect:(\d+):(\d+):(\d+)/, async (ctx) => {
    await ctx.answerCbQuery('Connected!');
    const [, wfId, fromId, toId] = ctx.match.map(Number);
    workflows.connect(wfId, fromId, toId);
    const text = workflows.renderWorkflow(wfId);
    const nodes = workflows.getNodes(wfId);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...helpers.workflowKeyboard(wfId, nodes) });
  });

  bot.action(/wf_delnode:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery('Deleted');
    const node = workflows.getNode(parseInt(ctx.match[1]));
    if (!node) return;
    workflows.deleteNode(node.id);
    const text = workflows.renderWorkflow(node.workflow_id);
    const nodes = workflows.getNodes(node.workflow_id);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...helpers.workflowKeyboard(node.workflow_id, nodes) });
  });

  bot.action(/wf_run:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const wfId = parseInt(ctx.match[1]);
    const nodes = workflows.getNodes(wfId);
    if (nodes.length === 0) return ctx.editMessageText('Workflow has no nodes.');
    await ctx.editMessageText('\u26a1 *Executing workflow...*', { parse_mode: 'Markdown' });
    try {
      await workflows.executeWorkflow(ctx.from.id, wfId, async (node, status, result) => {
        const type = NODE_TYPES[node.node_type] || NODE_TYPES.process;
        if (status === 'running') await ctx.reply(`\ud83d\udd35 ${type.emoji} *${node.name}*`, { parse_mode: 'Markdown' });
        else if (status === 'done') {
          let output = result?.result || '';
          if (output.length > 1000) output = output.substring(0, 1000) + '...';
          await ctx.reply(`\u2705 ${type.emoji} *${node.name}*\n\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
        } else if (status === 'error') {
          await ctx.reply(`\u274c ${type.emoji} *${node.name}*: ${result?.error}`, { parse_mode: 'Markdown' });
        }
      });
      await ctx.reply('\ud83c\udf89 *Workflow completed!*', { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`\u274c ${err.message}`);
    }
  });

  bot.action(/wf_delete:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery('Deleted');
    workflows.delete(parseInt(ctx.match[1]));
    await ctx.editMessageText('\u2705 Workflow deleted.');
  });

  bot.action(/wf_fix:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const wfId = parseInt(ctx.match[1]);
    const buttons = [
      [{ text: '\u26a1 Fix All Now', callback_data: `wf_fixnow:${wfId}` }],
      [{ text: '\u270f\ufe0f Describe the problem first', callback_data: `wf_fix_describe:${wfId}` }],
      [{ text: '\u25c0\ufe0f Back', callback_data: `wf_view:${wfId}` }],
    ];
    await ctx.editMessageText(
      '\ud83d\udd27 *Auto-Fix Workflow*\n\nI will test each node in order, and if it fails, I will ask the LLM to fix the script and re-test (up to 3 retries per node).\n\nYou can also describe the problem so I can give the LLM more context.',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
    );
  });

  bot.action(/wf_fixnow:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    await runAutoFix(ctx, ctx.from.id, parseInt(ctx.match[1]), null);
  });

  bot.action(/wf_fix_describe:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    userState.setAwaiting(ctx.from.id, `wf_fix_msg:${ctx.match[1]}`);
    await ctx.editMessageText(
      '\u270f\ufe0f *Describe the problem*\n\nType what\'s wrong or what you want fixed.\n\nYour message will be passed to the LLM as context for fixing.',
      { parse_mode: 'Markdown' }
    );
  });

  bot.action(/wf_edit_io:(\d+):(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const nodeId = parseInt(ctx.match[1]);
    const field = ctx.match[2];
    userState.setAwaiting(ctx.from.id, `wf_edit_${field}:${nodeId}`);
    await ctx.editMessageText(`Send the ${field} as comma-separated names:\n\nExample: \`data, config, options\``, { parse_mode: 'Markdown' });
  });

  // --- Env Vars management ---
  bot.action(/wf_env:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const nodeId = parseInt(ctx.match[1]);
    const node = workflows.getNode(nodeId);
    if (!node) return;
    const env = node._config?.env || {};
    const keys = Object.keys(env);
    let text = `\ud83d\udd11 *Env Variables \u2014 ${node.name}*\n\n`;
    if (keys.length > 0) {
      for (const k of keys) {
        const masked = env[k].length > 4 ? env[k].substring(0, 2) + '\u2022'.repeat(Math.min(env[k].length - 4, 8)) + env[k].slice(-2) : '\u2022\u2022\u2022\u2022';
        text += `\`${k}\` = \`${masked}\`\n`;
      }
    } else {
      text += '_No env vars set_\n';
    }
    text += '\nUse `env.KEY` in JS scripts or `{{KEY}}` in prompts.';
    const buttons = [[{ text: '\u2795 Add Variable', callback_data: `wf_env_add:${nodeId}` }]];
    if (keys.length > 0) buttons.push([{ text: '\ud83d\uddd1\ufe0f Remove Variable', callback_data: `wf_env_del:${nodeId}` }]);
    buttons.push([{ text: '\u25c0\ufe0f Back', callback_data: `wf_nodedetail:${nodeId}` }]);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  });

  bot.action(/wf_env_add:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    userState.setAwaiting(ctx.from.id, `wf_env_add:${ctx.match[1]}`);
    await ctx.editMessageText(
      '\u2795 *Add Environment Variable*\n\nSend in format: `KEY=value`\n\nExamples:\n\u2022 `API_KEY=sk-abc123def456`\n\u2022 `BASE_URL=https://api.example.com`',
      { parse_mode: 'Markdown' }
    );
  });

  bot.action(/wf_env_del:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const nodeId = parseInt(ctx.match[1]);
    const node = workflows.getNode(nodeId);
    if (!node) return;
    const env = node._config?.env || {};
    const buttons = Object.keys(env).map(k => [{ text: `\ud83d\uddd1\ufe0f ${k}`, callback_data: `wf_env_remove:${nodeId}:${k}` }]);
    buttons.push([{ text: '\u25c0\ufe0f Back', callback_data: `wf_env:${nodeId}` }]);
    await ctx.editMessageText('Select variable to remove:', { reply_markup: { inline_keyboard: buttons } });
  });

  bot.action(/wf_env_remove:(\d+):(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Removed');
    const nodeId = parseInt(ctx.match[1]);
    const key = ctx.match[2];
    const node = workflows.getNode(nodeId);
    if (!node) return;
    const config = node._config || {};
    const env = { ...(config.env || {}) };
    delete env[key];
    workflows.setNodeConfig(nodeId, { ...config, env });
    const updatedNode = workflows.getNode(nodeId);
    const updatedEnv = updatedNode._config?.env || {};
    const keys = Object.keys(updatedEnv);
    let text = `\ud83d\udd11 *Env Variables \u2014 ${node.name}*\n\n\u2705 Removed \`${key}\`\n\n`;
    if (keys.length > 0) {
      for (const k of keys) {
        const masked = updatedEnv[k].length > 4 ? updatedEnv[k].substring(0, 2) + '\u2022'.repeat(Math.min(updatedEnv[k].length - 4, 8)) + updatedEnv[k].slice(-2) : '\u2022\u2022\u2022\u2022';
        text += `\`${k}\` = \`${masked}\`\n`;
      }
    } else {
      text += '_No env vars remaining_\n';
    }
    const buttons = [[{ text: '\u2795 Add Variable', callback_data: `wf_env_add:${nodeId}` }]];
    if (keys.length > 0) buttons.push([{ text: '\ud83d\uddd1\ufe0f Remove Variable', callback_data: `wf_env_del:${nodeId}` }]);
    buttons.push([{ text: '\u25c0\ufe0f Back', callback_data: `wf_nodedetail:${nodeId}` }]);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  });

  // --- Auto-Fix engine (used by /wffix command + wf_fixnow callback) ---
  async function runAutoFix(ctx, userId, wfId, problemDescription) {
    const wf = workflows.get(wfId);
    if (!wf) return ctx.reply('Workflow not found.');
    let orderedNodes;
    try { orderedNodes = workflows.getExecutionOrder(wfId); }
    catch (err) { return ctx.reply(`\u274c ${err.message}`); }
    if (orderedNodes.length === 0) return ctx.reply('Workflow has no nodes.');

    const edges = workflows.getEdges(wfId);
    await ctx.reply(
      `\ud83d\udd27 *Auto-Fix: ${wf.title}*\nNodes: ${orderedNodes.length}\n` +
      (problemDescription ? `Problem: _${problemDescription}_\n` : '') +
      `\nTesting each node in order...`, { parse_mode: 'Markdown' }
    );

    const nodeResults = new Map();
    let passed = 0, autoFixed = 0, failed = 0;

    for (const node of orderedNodes) {
      const type = NODE_TYPES[node.node_type] || NODE_TYPES.process;
      const label = `${type.emoji} *${node.name}*`;
      const incomingEdges = edges.filter(e => e.to_node_id === node.id);
      const testInput = {};
      for (const e of incomingEdges) {
        const upstreamResult = nodeResults.get(e.from_node_id);
        if (upstreamResult) testInput[e.to_input] = upstreamResult.outputs?.[e.from_output] || upstreamResult.result || '';
      }
      await ctx.reply(`\u23f3 Testing ${label}...`, { parse_mode: 'Markdown' });

      let testResult;
      try { testResult = await workflows.testNode(userId, node.id, testInput); }
      catch (err) { testResult = { ok: false, error: err.message, output: null }; }

      const hasError = !testResult.ok || (testResult.output?.result && /error|fail|exception|crash|cannot|undefined/i.test(testResult.output?.result));
      if (!hasError) {
        nodeResults.set(node.id, testResult.output || { result: '', outputs: {} });
        passed++;
        await ctx.reply(`\u2705 ${label} \u2014 passed (${testResult.duration}ms)`, { parse_mode: 'Markdown' });
        continue;
      }

      const errorMsg = testResult.error || testResult.output?.result || 'Unknown error';
      await ctx.reply(`\ud83d\udd04 ${label} \u2014 failed, asking LLM to fix...\n\n\`${errorMsg.substring(0, 500)}\``, { parse_mode: 'Markdown' });

      let fixed = false;
      const currentScript = node.custom_script || '';
      let scriptToFix = currentScript;

      for (let attempt = 1; attempt <= 3; attempt++) {
        const fixPrompt = [
          `The node "${node.name}" (type: ${node.node_type}) failed with this error:`, '```', errorMsg.substring(0, 1000), '```', '',
          `Current script:`, '```', scriptToFix || '// No script', '```', '',
          `Test input was: ${JSON.stringify(testInput).substring(0, 500)}`,
          problemDescription ? `\nUser says the problem is: "${problemDescription}"` : '',
          '', 'Fix the script. Return the complete corrected script wrapped in a ```fix code block.',
        ].join('\n');

        try {
          const chatResult = await llm.chat(userId, [
            { role: 'system', content: `You are a code assistant fixing a workflow node script. The node "${node.name}" (${node.node_type}) does: "${node.description || 'No description'}". Return the complete fixed script in a \`\`\`fix code block.` },
            { role: 'user', content: fixPrompt },
          ]);
          let fixedScript = null;
          const fixMatch = chatResult.text.match(/```fix\n?([\s\S]*?)```/);
          if (fixMatch) fixedScript = fixMatch[1].trim();
          else {
            const codeMatch = chatResult.text.match(/```(?:javascript|js|bash|python)?\n?([\s\S]*?)```/);
            if (codeMatch && codeMatch[1].trim().length > 10) fixedScript = codeMatch[1].trim();
          }
          if (!fixedScript) { await ctx.reply(`  \u26a0\ufe0f Attempt ${attempt}/3: LLM didn't provide a fix`); continue; }

          workflows.saveScript(node.id, fixedScript);
          scriptToFix = fixedScript;
          let retestResult;
          try { retestResult = await workflows.testNode(userId, node.id, testInput); }
          catch (err) { retestResult = { ok: false, error: err.message }; }

          const retestError = !retestResult.ok || (retestResult.output?.result && /error|fail|exception|crash|cannot|undefined/i.test(retestResult.output?.result));
          if (!retestError) {
            nodeResults.set(node.id, retestResult.output || { result: '', outputs: {} });
            autoFixed++; fixed = true;
            await ctx.reply(`\u2705 ${label} \u2014 auto-fixed on attempt ${attempt}!`, { parse_mode: 'Markdown' });
            break;
          } else {
            const retestErr = retestResult.error || retestResult.output?.result || '';
            await ctx.reply(`  \ud83d\udd04 Attempt ${attempt}/3 \u2014 still failing: \`${retestErr.substring(0, 200)}\``, { parse_mode: 'Markdown' });
          }
        } catch (err) {
          await ctx.reply(`  \u26a0\ufe0f Attempt ${attempt}/3 LLM error: ${err.message}`);
        }
      }

      if (!fixed) {
        if (currentScript) workflows.saveScript(node.id, currentScript);
        nodeResults.set(node.id, { result: '', outputs: {} });
        failed++;
        await ctx.reply(`\u274c ${label} \u2014 could not fix after 3 attempts`, { parse_mode: 'Markdown' });
      }
    }

    const summary = [
      `\n\ud83c\udfc1 *Auto-Fix Complete: ${wf.title}*`, '',
      `\u2705 Passed: ${passed}`,
      autoFixed > 0 ? `\ud83d\udd27 Auto-fixed: ${autoFixed}` : '',
      failed > 0 ? `\u274c Failed: ${failed}` : '',
      '', failed === 0 ? '\ud83c\udf89 All nodes working!' : `\u26a0\ufe0f ${failed} node(s) still need manual fixes.`,
    ].filter(Boolean).join('\n');
    const nodes = workflows.getNodes(wfId);
    await ctx.reply(summary, { parse_mode: 'Markdown', ...helpers.workflowKeyboard(wfId, nodes) });
  }

  // Expose runAutoFix for use by messages handler
  shared.runAutoFix = runAutoFix;
}
