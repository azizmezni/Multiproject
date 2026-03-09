import { Telegraf, Markup } from 'telegraf';
import db from './db.js';
import { llm } from './llm-manager.js';
import { sessions, userState } from './sessions.js';
import { boards } from './boards.js';
import { drafts, extractUrl, fetchLinkMeta } from './drafts.js';
import { settings } from './settings.js';
import { qa } from './qa.js';
import { kb } from './keyboards.js';
import { PROVIDER_REGISTRY } from './providers.js';
import { workflows, NODE_TYPES } from './workflows.js';

// Strip all Telegram Markdown special chars so it never fails
function stripMd(text) {
  return text
    .replace(/```[\s\S]*?```/g, m => m.slice(3, -3))  // unwrap code blocks
    .replace(/\*\*/g, '')     // remove bold **
    .replace(/\*/g, '')       // remove italic *
    .replace(/__/g, '')       // remove bold __
    .replace(/_/g, '')        // remove italic _
    .replace(/`/g, '')        // remove inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');  // [text](url) -> text
}

// Send a message safely — tries Markdown first, falls back to plain text
async function safeSend(ctx, text, extra = {}) {
  // First try with Markdown
  try {
    return await ctx.reply(text, { parse_mode: 'Markdown', ...extra });
  } catch {
    // Markdown failed — send as plain text (strip all formatting)
    try {
      return await ctx.reply(stripMd(text), extra);
    } catch {
      // Even plain text failed (maybe too long) — truncate hard
      return await ctx.reply(stripMd(text).substring(0, 4000), extra);
    }
  }
}

export function createBot(token) {
  const bot = new Telegraf(token);

  // ============================================================
  // COMMANDS
  // ============================================================

  bot.command('start', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    userState.get(userId);

    await ctx.reply(
      `*Welcome to Telegram LLM Hub* \u26a1\n\n` +
      `Multi-model AI assistant with project boards, QA testing, and smart drafts.\n\n` +
      `*Quick Start:*\n` +
      `\u2022 Just type to chat with AI\n` +
      `\u2022 /new <project> \u2014 Create a project board\n` +
      `\u2022 Share a link \u2014 Goes to your draft board\n` +
      `\u2022 /settings \u2014 Configure API keys & models\n\n` +
      `Your default provider is *Claude* (Anthropic).`,
      { parse_mode: 'Markdown', ...kb.mainMenu() }
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      `*Commands:*\n\n` +
      `*Boards & Tasks:*\n` +
      `/new <name> \u2014 Create project board\n` +
      `/boards \u2014 List boards | /board \u2014 Active board\n\n` +
      `*Workflows (n8n-style):*\n` +
      `/workflow <desc> \u2014 Auto-generate workflow\n` +
      `/wfnew <title> \u2014 Create empty workflow\n` +
      `/wflist \u2014 List workflows\n` +
      `/wfnode <name>|<type>|<desc> \u2014 Add node\n` +
      `/wfconnect <from> <to> \u2014 Connect nodes\n` +
      `/wfinput <id>|<names> \u2014 Set node inputs\n` +
      `/wfoutput <id>|<names> \u2014 Set node outputs\n` +
      `/wfview \u2014 View workflow | /wfrun \u2014 Execute\n\n` +
      `*Chat & Providers:*\n` +
      `/chat \u2014 New session | /sessions \u2014 List\n` +
      `/providers \u2014 Manage LLMs | /setkey <prov> <key>\n` +
      `/drafts \u2014 Draft board | /settings \u2014 Config\n` +
      `/qa <id> \u2014 Run QA | /run <cmd> \u2014 CLI\n\n` +
      `*Tips:* Share links \u2192 drafts | Auto-fallback across providers`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('menu', (ctx) => ctx.reply('Main Menu:', kb.mainMenu()));

  // --- Chat ---
  bot.command('chat', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const title = ctx.message.text.replace('/chat', '').trim() || 'New Chat';
    const session = sessions.create(userId, title);
    userState.setMode(userId, 'chat');
    await ctx.reply(`\ud83d\udcac *New chat session:* ${session.title}\n\nJust type your message.`, { parse_mode: 'Markdown' });
  });

  bot.command('sessions', async (ctx) => {
    const userId = ctx.from.id;
    const list = sessions.listByUser(userId);
    if (list.length === 0) return ctx.reply('No sessions yet. Start chatting or use /chat.');
    await ctx.reply('Your chat sessions:', kb.sessionList(list));
  });

  // --- Boards ---
  bot.command('new', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const projectName = ctx.message.text.replace('/new', '').trim();
    if (!projectName) return ctx.reply('Usage: /new <project name>\nExample: /new E-commerce Website');

    await ctx.reply(`\ud83d\udcdd Creating project board for: *${projectName}*\n\nAnalyzing and generating tasks...`, { parse_mode: 'Markdown' });

    try {
      const result = await llm.chat(userId, [
        {
          role: 'system',
          content: `You are a project planner. Break down the project into clear, actionable tasks.
For each task, identify if it needs user input and what tools it might need.
Return a JSON array of tasks:
[{
  "title": "Task title",
  "description": "What needs to be done",
  "requires_input": false,
  "input_question": null,
  "tools_needed": ["tool1"]
}]
Keep tasks specific and actionable. 5-15 tasks typically.
Only return the JSON array, no markdown fences.`
        },
        { role: 'user', content: `Create a project plan for: ${projectName}` }
      ]);

      let taskList;
      try {
        const cleaned = result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        taskList = JSON.parse(cleaned);
      } catch {
        taskList = [{ title: 'Review project requirements', description: result.text, requires_input: true, input_question: 'Please clarify the project scope' }];
      }

      // Create board and tasks
      const session = sessions.create(userId, `Board: ${projectName}`);
      const board = boards.create(userId, projectName, `Auto-generated board for ${projectName}`, session.id);
      boards.addTasksFromPlan(board.id, taskList);
      userState.setActiveBoard(userId, board.id);
      userState.setMode(userId, 'board');

      const tasks = boards.getTasks(board.id);
      const summary = boards.getSummary(board.id);

      let text = `\ud83d\udccb *${projectName}*\n`;
      text += `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      text += `Status: \ud83d\udcdd Planning | Tasks: ${tasks.length}\n`;

      if (summary.needsInput.length > 0) {
        text += `\n\u2753 *${summary.needsInput.length} tasks need your input*\n`;
      }

      text += `\n*Tasks:*\n`;
      for (const t of tasks) {
        const needsQ = (t.requires_input && !t.input_answer) ? ' \u2753' : '';
        text += `\u2b1c ${t.title}${needsQ}\n`;
      }

      text += `\n_Powered by ${result.provider} (${result.model})_`;

      await ctx.reply(text, { parse_mode: 'Markdown', ...kb.boardView(board.id, tasks, 'planning') });
    } catch (err) {
      await ctx.reply(`\u274c Error creating board: ${err.message}`);
    }
  });

  bot.command('boards', async (ctx) => {
    const userId = ctx.from.id;
    const list = boards.listByUser(userId);
    if (list.length === 0) return ctx.reply('No boards yet. Use /new <project> to create one.');

    let text = '\ud83d\udccb *Your Boards:*\n\n';
    const buttons = [];
    for (const b of list) {
      const tasks = boards.getTasks(b.id);
      const done = tasks.filter(t => t.status === 'done').length;
      text += `\u2022 *${b.title}* (${done}/${tasks.length} done) - ${b.status}\n`;
      buttons.push([{ text: `\ud83d\udccb ${b.title}`, callback_data: `view_board:${b.id}` }]);
    }
    buttons.push([{ text: '\u25c0\ufe0f Back', callback_data: 'main_menu' }]);

    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  });

  bot.command('board', async (ctx) => {
    const userId = ctx.from.id;
    const state = userState.get(userId);
    if (!state.active_board_id) return ctx.reply('No active board. Use /boards to select one.');
    await showBoard(ctx, state.active_board_id);
  });

  // --- Workflows (n8n-style) ---
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
      '/wfrun \u2014 Execute workflow\n\n' +
      `*Node Types:* ${Object.entries(NODE_TYPES).map(([k, v]) => `${v.emoji} ${k}`).join(', ')}`,
      { parse_mode: 'Markdown' }
    );

    await ctx.reply(`\ud83d\udd27 Generating workflow for: *${desc}*...`, { parse_mode: 'Markdown' });
    try {
      const workflow = await workflows.buildFromDescription(userId, desc);
      db_setActiveWorkflow(userId, workflow.id);
      const text = workflows.renderWorkflow(workflow.id);
      const nodes = workflows.getNodes(workflow.id);
      await ctx.reply(text, { parse_mode: 'Markdown', ...workflowKeyboard(workflow.id, nodes) });
    } catch (err) {
      await ctx.reply(`\u274c Error: ${err.message}`);
    }
  });

  bot.command('wfnew', async (ctx) => {
    const userId = ctx.from.id;
    const title = ctx.message.text.replace('/wfnew', '').trim() || 'New Workflow';
    const workflow = workflows.create(userId, title);
    db_setActiveWorkflow(userId, workflow.id);
    await ctx.reply(
      `\ud83d\udd27 *Workflow created: ${title}*\n\n` +
      `Add nodes with /wfnode <name> | <type> | <description>\n` +
      `Node types: ${Object.entries(NODE_TYPES).map(([k, v]) => `\`${k}\``).join(', ')}`,
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
    const userId = ctx.from.id;
    const wfId = getActiveWorkflow(userId);
    if (!wfId) return ctx.reply('No active workflow. Use /wfnew or /wflist first.');

    const args = ctx.message.text.replace('/wfnode', '').trim();
    if (!args) return ctx.reply('Usage: /wfnode <name> | <type> | <description>\nExample: /wfnode Parse Data | process | Extract JSON fields');

    const parts = args.split('|').map(s => s.trim());
    const name = parts[0] || 'Node';
    const type = parts[1] || 'process';
    const desc = parts[2] || '';

    if (!NODE_TYPES[type]) return ctx.reply(`Unknown type: ${type}\nAvailable: ${Object.keys(NODE_TYPES).join(', ')}`);

    const node = workflows.addNode(wfId, name, type, desc, ['default'], ['default']);
    const text = workflows.renderWorkflow(wfId);
    const nodes = workflows.getNodes(wfId);
    await ctx.reply(text, { parse_mode: 'Markdown', ...workflowKeyboard(wfId, nodes) });
  });

  bot.command('wfconnect', async (ctx) => {
    const userId = ctx.from.id;
    const wfId = getActiveWorkflow(userId);
    if (!wfId) return ctx.reply('No active workflow.');

    const args = ctx.message.text.replace('/wfconnect', '').trim().split(/\s+/);
    if (args.length < 2) return ctx.reply('Usage: /wfconnect <from_node_id> <to_node_id>\nOptional: /wfconnect <from> <to> <from_output> <to_input>');

    const [fromId, toId, fromOutput, toInput] = args;
    workflows.connect(wfId, parseInt(fromId), parseInt(toId), fromOutput || 'default', toInput || 'default');
    const text = workflows.renderWorkflow(wfId);
    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  bot.command('wfview', async (ctx) => {
    const userId = ctx.from.id;
    const wfId = getActiveWorkflow(userId);
    if (!wfId) return ctx.reply('No active workflow.');
    const text = workflows.renderWorkflow(wfId);
    const nodes = workflows.getNodes(wfId);
    await ctx.reply(text, { parse_mode: 'Markdown', ...workflowKeyboard(wfId, nodes) });
  });

  bot.command('wfrun', async (ctx) => {
    const userId = ctx.from.id;
    const wfId = getActiveWorkflow(userId);
    if (!wfId) return ctx.reply('No active workflow.');

    const nodes = workflows.getNodes(wfId);
    if (nodes.length === 0) return ctx.reply('Workflow has no nodes.');

    await ctx.reply('\u26a1 *Executing workflow...*', { parse_mode: 'Markdown' });

    try {
      await workflows.executeWorkflow(userId, wfId, async (node, status, result) => {
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

  bot.command('wfinput', async (ctx) => {
    const userId = ctx.from.id;
    const wfId = getActiveWorkflow(userId);
    if (!wfId) return ctx.reply('No active workflow.');

    const args = ctx.message.text.replace('/wfinput', '').trim();
    const parts = args.split('|').map(s => s.trim());
    if (parts.length < 2) return ctx.reply('Usage: /wfinput <node_id> | <input_name1, input_name2>\nSets the input ports for a node.');

    const nodeId = parseInt(parts[0]);
    const inputs = parts[1].split(',').map(s => s.trim());
    workflows.setNodeInputs(nodeId, inputs);
    await ctx.reply(`\u2705 Inputs set for node #${nodeId}: ${inputs.join(', ')}`);
  });

  bot.command('wfoutput', async (ctx) => {
    const userId = ctx.from.id;
    const wfId = getActiveWorkflow(userId);
    if (!wfId) return ctx.reply('No active workflow.');

    const args = ctx.message.text.replace('/wfoutput', '').trim();
    const parts = args.split('|').map(s => s.trim());
    if (parts.length < 2) return ctx.reply('Usage: /wfoutput <node_id> | <output_name1, output_name2>');

    const nodeId = parseInt(parts[0]);
    const outputs = parts[1].split(',').map(s => s.trim());
    workflows.setNodeOutputs(nodeId, outputs);
    await ctx.reply(`\u2705 Outputs set for node #${nodeId}: ${outputs.join(', ')}`);
  });

  // --- Providers ---
  bot.command('providers', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    await showProviders(ctx, userId);
  });

  bot.command('setkey', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const parts = ctx.message.text.replace('/setkey', '').trim().split(/\s+/);
    if (parts.length < 2) return ctx.reply('Usage: /setkey <provider> <api_key>\nExample: /setkey openai sk-...');

    const [providerName, apiKey] = parts;
    if (!PROVIDER_REGISTRY[providerName]) {
      return ctx.reply(`Unknown provider: ${providerName}\nAvailable: ${Object.keys(PROVIDER_REGISTRY).filter(k => !PROVIDER_REGISTRY[k].isLocal).join(', ')}`);
    }

    llm.setApiKey(userId, providerName, apiKey);
    await ctx.reply(`\u2705 API key set for *${PROVIDER_REGISTRY[providerName].name}*`, { parse_mode: 'Markdown' });
  });

  // --- Settings ---
  bot.command('settings', async (ctx) => {
    await ctx.reply('\u2699\ufe0f *Settings*', { parse_mode: 'Markdown', ...kb.settingsMenu() });
  });

  // --- Drafts ---
  bot.command('drafts', async (ctx) => {
    const userId = ctx.from.id;
    await showDrafts(ctx, userId);
  });

  // --- QA ---
  bot.command('qa', async (ctx) => {
    const userId = ctx.from.id;
    const taskId = parseInt(ctx.message.text.replace('/qa', '').trim());
    if (!taskId) return ctx.reply('Usage: /qa <task_id>');

    await ctx.reply('\ud83e\uddea Running QA tests...');
    const result = await qa.runTaskQA(userId, taskId);
    const emoji = result.passed ? '\u2705' : '\u274c';
    await ctx.reply(`${emoji} QA Result:\n\`\`\`\n${JSON.stringify(result, null, 2)}\n\`\`\``, { parse_mode: 'Markdown' });
  });

  // --- Run CLI ---
  bot.command('run', async (ctx) => {
    const command = ctx.message.text.replace('/run', '').trim();
    if (!command) return ctx.reply('Usage: /run <command>\nExample: /run npm test');

    await ctx.reply(`\u25b6\ufe0f Running: \`${command}\``, { parse_mode: 'Markdown' });
    const result = await qa.runCommand(command);
    const emoji = result.ok ? '\u2705' : '\u274c';
    let output = result.stdout || result.stderr || 'No output';
    if (output.length > 3500) output = output.substring(0, 3500) + '\n...(truncated)';
    await ctx.reply(`${emoji} \`${command}\`\n\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
  });

  // ============================================================
  // CALLBACK QUERIES (inline button handlers)
  // ============================================================

  // Main menu
  bot.action('main_menu', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('Main Menu:', kb.mainMenu());
  });

  bot.action('help', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      'Use /help for full command list.\n\n' +
      '\u2022 Type to chat with AI\n' +
      '\u2022 /new to create project boards\n' +
      '\u2022 Share links to draft board\n' +
      '\u2022 /providers to manage AI models'
    );
  });

  // --- Chat actions ---
  bot.action('new_chat', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const session = sessions.create(userId, 'New Chat');
    userState.setMode(userId, 'chat');
    await ctx.editMessageText(`\ud83d\udcac *New chat started*\n\nJust type your message.`, { parse_mode: 'Markdown' });
  });

  bot.action('list_sessions', async (ctx) => {
    await ctx.answerCbQuery();
    const list = sessions.listByUser(ctx.from.id);
    if (list.length === 0) return ctx.editMessageText('No sessions. Use /chat to start one.');
    await ctx.editMessageText('Your sessions:', kb.sessionList(list));
  });

  bot.action(/switch_session:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const sessionId = parseInt(ctx.match[1]);
    const userId = ctx.from.id;
    sessions.setActive(userId, sessionId);
    userState.setMode(userId, 'chat');
    const session = sessions.get(sessionId);
    await ctx.editMessageText(`\ud83d\udcac Switched to: *${session.title}*\n\nContinue chatting.`, { parse_mode: 'Markdown' });
  });

  // --- Provider actions ---
  bot.action('providers', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    await showProvidersEdit(ctx, userId);
  });

  bot.action(/toggle_prov:(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Toggled');
    const userId = ctx.from.id;
    llm.toggleProvider(userId, ctx.match[1]);
    await showProvidersEdit(ctx, userId);
  });

  bot.action(/prov_up:(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Moved up');
    const userId = ctx.from.id;
    llm.reorderProvider(userId, ctx.match[1], 'up');
    await showProvidersEdit(ctx, userId);
  });

  bot.action(/prov_down:(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Moved down');
    const userId = ctx.from.id;
    llm.reorderProvider(userId, ctx.match[1], 'down');
    await showProvidersEdit(ctx, userId);
  });

  bot.action('set_api_key', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('Select provider to set API key:', kb.providerSelect('setkey'));
  });

  bot.action(/setkey:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const providerName = ctx.match[1];
    const reg = PROVIDER_REGISTRY[providerName];
    userState.setAwaiting(ctx.from.id, `setkey:${providerName}`);
    await ctx.editMessageText(
      `\ud83d\udd11 *Set API Key for ${reg.name}*\n\n` +
      `Send your API key as the next message.\n\n` +
      `\ud83d\udcd6 Setup docs: ${reg.docs}`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.action('change_model', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('Select provider to change model:', kb.providerSelect('chmodel'));
  });

  bot.action(/chmodel:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const providerName = ctx.match[1];
    const keyboard = kb.modelSelect(providerName);
    if (!keyboard) return ctx.editMessageText('Provider not found.');
    await ctx.editMessageText(`Select model for ${PROVIDER_REGISTRY[providerName].name}:`, keyboard);
  });

  bot.action(/select_model:(.+):(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Model updated');
    const [, providerName, model] = ctx.match;
    llm.setModel(ctx.from.id, providerName, model);
    await showProvidersEdit(ctx, ctx.from.id);
  });

  // --- Board actions ---
  bot.action('list_boards', async (ctx) => {
    await ctx.answerCbQuery();
    const list = boards.listByUser(ctx.from.id);
    if (list.length === 0) return ctx.editMessageText('No boards. Use /new <project> to create one.');

    let text = '\ud83d\udccb *Your Boards:*\n\n';
    const buttons = [];
    for (const b of list) {
      const tasks = boards.getTasks(b.id);
      const done = tasks.filter(t => t.status === 'done').length;
      text += `\u2022 *${b.title}* (${done}/${tasks.length}) - ${b.status}\n`;
      buttons.push([{ text: `\ud83d\udccb ${b.title}`, callback_data: `view_board:${b.id}` }]);
    }
    buttons.push([{ text: '\u25c0\ufe0f Back', callback_data: 'main_menu' }]);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  });

  bot.action(/view_board:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    await showBoardEdit(ctx, parseInt(ctx.match[1]));
  });

  bot.action(/exec_board:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const boardId = parseInt(ctx.match[1]);
    const summary = boards.getSummary(boardId);

    if (summary.needsInput.length > 0) {
      const task = summary.needsInput[0];
      userState.setAwaiting(ctx.from.id, `task_answer:${task.id}`);
      return ctx.editMessageText(
        `\u2753 *Task needs your input:*\n\n` +
        `*${task.title}*\n${task.input_question}\n\n` +
        `_Reply with your answer:_`,
        { parse_mode: 'Markdown' }
      );
    }

    boards.updateStatus(boardId, 'executing');
    await ctx.editMessageText(`\u26a1 *Executing board tasks...*`, { parse_mode: 'Markdown' });

    // Execute tasks sequentially
    await executeBoard(ctx, ctx.from.id, boardId);
  });

  // --- Task actions ---
  bot.action(/task_detail:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const task = boards.getTask(parseInt(ctx.match[1]));
    if (!task) return;

    const qaInfo = task.qa_result ? `\nQA: ${task.qa_status}` : '';
    const tools = task.tools_needed ? `\nTools: ${task.tools_needed}` : '';
    const question = task.input_question ? `\n\u2753 Question: ${task.input_question}` : '';
    const answer = task.input_answer ? `\n\ud83d\udcac Answer: ${task.input_answer}` : '';

    await ctx.editMessageText(
      `*Task #${task.id}: ${task.title}*\n\n` +
      `${task.description || 'No description'}` +
      `\n\nStatus: ${task.status}${qaInfo}${tools}${question}${answer}`,
      { parse_mode: 'Markdown', ...kb.taskDetail(task) }
    );
  });

  bot.action(/start_task:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery('Task started');
    const taskId = parseInt(ctx.match[1]);
    boards.setTaskStatus(taskId, 'in_progress');
    const task = boards.getTask(taskId);
    await showBoardEdit(ctx, task.board_id);
  });

  bot.action(/done_task:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery('Task completed');
    const taskId = parseInt(ctx.match[1]);
    boards.setTaskStatus(taskId, 'done');
    const task = boards.getTask(taskId);
    await showBoardEdit(ctx, task.board_id);
  });

  bot.action(/answer_task:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const taskId = parseInt(ctx.match[1]);
    const task = boards.getTask(taskId);
    userState.setAwaiting(ctx.from.id, `task_answer:${taskId}`);
    await ctx.editMessageText(
      `\u2753 *${task.title}*\n\n${task.input_question}\n\n_Send your answer:_`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.action(/discuss_task:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const taskId = parseInt(ctx.match[1]);
    const task = boards.getTask(taskId);
    userState.setAwaiting(ctx.from.id, `discuss_task:${taskId}`);
    await ctx.editMessageText(
      `\ud83d\udcac *Discussing: ${task.title}*\n\n${task.description}\n\n_Ask me anything about this task:_`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.action(/qa_task:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery('Running QA...');
    const taskId = parseInt(ctx.match[1]);
    const task = boards.getTask(taskId);

    await ctx.editMessageText(`\ud83e\uddea Running QA for: *${task.title}*...`, { parse_mode: 'Markdown' });

    const result = await qa.runTaskQA(ctx.from.id, taskId);
    const emoji = result.passed ? '\u2705' : '\u274c';
    let resultText = `${emoji} *QA Result for: ${task.title}*\n\n`;
    resultText += `Type: ${result.type || 'unknown'}\n`;
    resultText += `Passed: ${result.passed ? 'Yes' : 'No'}\n`;
    if (result.notes) resultText += `Notes: ${result.notes}\n`;

    await ctx.reply(resultText, { parse_mode: 'Markdown', ...kb.taskDetail(boards.getTask(taskId)) });
  });

  // --- Draft actions ---
  bot.action('list_drafts', async (ctx) => {
    await ctx.answerCbQuery();
    await showDraftsEdit(ctx, ctx.from.id);
  });

  bot.action(/draft_clone:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;

    const title = draft.title || 'Cloned Project';
    await ctx.editMessageText(`\ud83d\udccb Creating board from draft: *${title}*...`, { parse_mode: 'Markdown' });

    try {
      const result = await llm.chat(ctx.from.id, [
        {
          role: 'system',
          content: `Create a project plan based on this reference. Return a JSON array of tasks:
[{"title":"...", "description":"...", "requires_input": false, "input_question": null, "tools_needed": []}]
Only return JSON, no markdown.`
        },
        { role: 'user', content: `Clone and plan this idea:\nURL: ${draft.url || 'N/A'}\nTitle: ${draft.title}\nDescription: ${draft.description || draft.content || 'No description'}` }
      ]);

      let taskList;
      try {
        const cleaned = result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        taskList = JSON.parse(cleaned);
      } catch {
        taskList = [{ title: 'Review cloned project', description: result.text }];
      }

      const board = boards.create(ctx.from.id, title);
      boards.addTasksFromPlan(board.id, taskList);
      drafts.updateStatus(draft.id, 'processed');
      userState.setActiveBoard(ctx.from.id, board.id);

      const tasks = boards.getTasks(board.id);
      await ctx.reply(`\u2705 Board created with ${tasks.length} tasks!`, kb.boardView(board.id, tasks, 'planning'));
    } catch (err) {
      await ctx.reply(`\u274c Error: ${err.message}`);
    }
  });

  bot.action(/draft_expand:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;

    await ctx.editMessageText('\ud83d\udca1 Analyzing and generating plans...');

    const pageContent = (draft.content || '').substring(0, 2000);

    try {
      const result = await llm.chat(ctx.from.id, [
        { role: 'system', content: `You are an expert product strategist and software architect. Analyze the given link/resource and generate 3-5 actionable project plans.

Return ONLY a valid JSON array. Each item:
{"title":"Plan Title","description":"What to build (2-3 sentences)","features":["feature1","feature2","feature3"],"techStack":["tech1","tech2"],"skills":["api/skill1","api/skill2"],"difficulty":"Easy|Medium|Hard"}

Return ONLY the JSON array. No markdown, no extra text, no code fences.` },
        { role: 'user', content: `Analyze this resource and generate project plans:\n\nURL: ${draft.url || 'N/A'}\nTitle: ${draft.title}\nDescription: ${draft.description || 'No description'}\n${pageContent ? `\nPage Content:\n${pageContent}` : ''}` }
      ]);

      // Parse plans from LLM response
      let plans = [];
      try {
        const cleaned = result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
        if (jsonMatch) plans = JSON.parse(jsonMatch[0]);
      } catch {
        plans = [{ title: draft.title || 'Plan', description: result.text.substring(0, 500), features: [], techStack: [], skills: [], difficulty: 'Medium' }];
      }

      // Store plans in draft content for later retrieval
      drafts.updateContent(draft.id, draft.title, JSON.stringify(plans), draft.content || pageContent);

      // Send each plan as a readable message
      const header = `Plans for: ${stripMd(draft.title || 'Draft')}\n\n`;
      let plansText = '';
      for (let i = 0; i < plans.length; i++) {
        const p = plans[i];
        plansText += `${i + 1}. ${stripMd(p.title || 'Untitled')}\n`;
        plansText += `   ${stripMd(p.description || 'No description')}\n`;
        if (p.features?.length) plansText += `   Features: ${p.features.map(f => stripMd(f)).join(', ')}\n`;
        if (p.techStack?.length) plansText += `   Tech: ${p.techStack.map(t => stripMd(t)).join(', ')}\n`;
        if (p.skills?.length) plansText += `   Skills/APIs: ${p.skills.map(s => stripMd(s)).join(', ')}\n`;
        plansText += `   Difficulty: ${p.difficulty || 'Medium'}\n\n`;
      }

      const fullMsg = header + plansText + 'Select a plan below to build it:';

      // Build selection buttons — one per plan + back
      const planButtons = plans.map((p, i) => [
        Markup.button.callback(`${i + 1}. ${(p.title || 'Plan').substring(0, 40)} (${p.difficulty || '?'})`, `draft_select_plan:${draft.id}:${i}`)
      ]);
      planButtons.push([Markup.button.callback('\ud83d\udccb Clone All as Board', `draft_clone:${draft.id}`)]);
      planButtons.push([Markup.button.callback('\ud83d\udca1 Re-Expand', `draft_expand:${draft.id}`), Markup.button.callback('\u25c0\ufe0f Back', 'list_drafts')]);

      // Send (chunked if needed)
      if (fullMsg.length <= 3800) {
        await ctx.reply(fullMsg, Markup.inlineKeyboard(planButtons));
      } else {
        // Split: send plans text first, then selection message
        const chunks = [];
        let remaining = plansText;
        const maxLen = 3800;
        while (remaining.length > 0) {
          let splitAt = maxLen;
          const nlPos = remaining.lastIndexOf('\n', maxLen);
          if (nlPos > maxLen * 0.5) splitAt = nlPos + 1;
          chunks.push(remaining.substring(0, splitAt));
          remaining = remaining.substring(splitAt);
        }
        for (const chunk of chunks) {
          await ctx.reply(chunk);
        }
        await ctx.reply('Select a plan to build:', Markup.inlineKeyboard(planButtons));
      }
    } catch (err) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  // Handle plan selection from expand results
  bot.action(/draft_select_plan:(\d+):(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draftId = parseInt(ctx.match[1]);
    const planIndex = parseInt(ctx.match[2]);
    const draft = drafts.get(draftId);
    if (!draft) return;

    // Retrieve stored plans
    let plans = [];
    try {
      plans = JSON.parse(draft.description || '[]');
    } catch {
      try { plans = JSON.parse(draft.content || '[]'); } catch {}
    }

    const plan = plans[planIndex];
    if (!plan) {
      await ctx.reply('Plan not found. Try expanding the idea again.');
      return;
    }

    await ctx.editMessageText(`Building: ${stripMd(plan.title || 'Plan')}...\n\nGenerating tasks from this plan...`);

    try {
      const planContext = `Title: ${plan.title}\nDescription: ${plan.description}\nFeatures: ${(plan.features || []).join(', ')}\nTech: ${(plan.techStack || []).join(', ')}\nSkills/APIs: ${(plan.skills || []).join(', ')}`;

      const result = await llm.chat(ctx.from.id, [
        { role: 'system', content: 'You are a project planner. Create a detailed task breakdown for the given plan. Return a JSON array of tasks: [{"title":"...","description":"...","requires_input":false,"input_question":null,"tools_needed":[]}]. Only return JSON, no markdown.' },
        { role: 'user', content: `Create a project board with tasks for this plan:\n\n${planContext}\n\nOriginal source: ${draft.url || 'N/A'}` },
      ]);

      let taskList;
      try {
        taskList = JSON.parse(result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
      } catch { taskList = [{ title: 'Review and plan', description: result.text.substring(0, 500) }]; }

      const board = boards.create(ctx.from.id, plan.title || 'Project');
      boards.addTasksFromPlan(board.id, taskList);
      drafts.updateStatus(draftId, 'processed');
      userState.setActiveBoard(ctx.from.id, board.id);

      const tasks = boards.getTasks(board.id);
      await ctx.reply(`Board created: ${stripMd(plan.title)}\n${tasks.length} tasks generated!`, kb.boardView(board.id, tasks, 'planning'));
    } catch (err) {
      await ctx.reply(`Error creating board: ${err.message}`);
    }
  });

  bot.action(/draft_plan:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;
    // Reuse the /new flow
    const fakeCtx = { ...ctx, message: { text: `/new ${draft.title || 'Draft Project'}` }, from: ctx.from };
    userState.setAwaiting(ctx.from.id, `draft_plan:${draft.id}`);
    await ctx.editMessageText(`\ud83d\udcdd Planning project from draft: *${draft.title}*\n\nUse /new ${draft.title} to create the board.`, { parse_mode: 'Markdown' });
  });

  bot.action(/draft_cli:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    userState.setAwaiting(ctx.from.id, `draft_cli:${ctx.match[1]}`);
    await ctx.editMessageText('\ud83d\udcbb Send the CLI command to run:');
  });

  bot.action(/draft_delete:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery('Deleted');
    drafts.delete(parseInt(ctx.match[1]));
    await showDraftsEdit(ctx, ctx.from.id);
  });

  // --- Settings actions ---
  bot.action('settings', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('\u2699\ufe0f *Settings*', { parse_mode: 'Markdown', ...kb.settingsMenu() });
  });

  // --- Workflow callback actions ---
  bot.action('list_workflows', async (ctx) => {
    await ctx.answerCbQuery();
    const list = workflows.listByUser(ctx.from.id);
    if (list.length === 0) {
      return ctx.editMessageText(
        '\ud83d\udd27 No workflows yet.\n\nUse /workflow <description> to auto-generate one\nor /wfnew <title> to create an empty one.'
      );
    }
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
    db_setActiveWorkflow(ctx.from.id, wfId);
    const text = workflows.renderWorkflow(wfId);
    const nodes = workflows.getNodes(wfId);
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...workflowKeyboard(wfId, nodes) });
    } catch {
      await ctx.reply(text, { parse_mode: 'Markdown', ...workflowKeyboard(wfId, nodes) });
    }
  });

  bot.action(/wf_addnode:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const wfId = parseInt(ctx.match[1]);
    // Show node type selection
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
      `${type.emoji} *Adding ${type.label} node*\n\n` +
      `Send the node details in this format:\n` +
      `\`name | description\`\n\n` +
      `Example: \`Parse User Data | Extract name and email from input\``,
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

    let text = `${type.emoji} *${node.name}* (#${node.id})\n`;
    text += `Type: ${type.label}\n`;
    text += `Status: ${node.status}\n`;
    if (node.description) text += `Desc: ${node.description}\n`;
    text += `\nInputs: ${node._inputs.join(', ') || 'none'}`;
    text += `\nOutputs: ${node._outputs.join(', ') || 'none'}`;

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
    // Connect to another node
    const unconnected = allNodes.filter(n => n.id !== nodeId && !outgoing.find(e => e.to_node_id === n.id));
    if (unconnected.length > 0) {
      buttons.push([{ text: '\ud83d\udd17 Connect to...', callback_data: `wf_connect_from:${nodeId}` }]);
    }
    buttons.push([
      { text: '\u270f\ufe0f Edit Inputs', callback_data: `wf_edit_io:${nodeId}:inputs` },
      { text: '\u270f\ufe0f Edit Outputs', callback_data: `wf_edit_io:${nodeId}:outputs` },
    ]);
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
    const buttons = targets.map(n => [
      { text: `\u27a1\ufe0f ${n.name}`, callback_data: `wf_doconnect:${node.workflow_id}:${fromId}:${n.id}` },
    ]);
    buttons.push([{ text: '\u25c0\ufe0f Back', callback_data: `wf_nodedetail:${fromId}` }]);
    await ctx.editMessageText(`Connect *${node.name}* to:`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  });

  bot.action(/wf_doconnect:(\d+):(\d+):(\d+)/, async (ctx) => {
    await ctx.answerCbQuery('Connected!');
    const [, wfId, fromId, toId] = ctx.match.map(Number);
    workflows.connect(wfId, fromId, toId);
    const text = workflows.renderWorkflow(wfId);
    const nodes = workflows.getNodes(wfId);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...workflowKeyboard(wfId, nodes) });
  });

  bot.action(/wf_delnode:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery('Deleted');
    const node = workflows.getNode(parseInt(ctx.match[1]));
    if (!node) return;
    workflows.deleteNode(node.id);
    const text = workflows.renderWorkflow(node.workflow_id);
    const nodes = workflows.getNodes(node.workflow_id);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...workflowKeyboard(node.workflow_id, nodes) });
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
        if (status === 'running') {
          await ctx.reply(`\ud83d\udd35 ${type.emoji} *${node.name}*`, { parse_mode: 'Markdown' });
        } else if (status === 'done') {
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

  bot.action(/wf_edit_io:(\d+):(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const nodeId = parseInt(ctx.match[1]);
    const field = ctx.match[2]; // 'inputs' or 'outputs'
    userState.setAwaiting(ctx.from.id, `wf_edit_${field}:${nodeId}`);
    await ctx.editMessageText(
      `Send the ${field} as comma-separated names:\n\nExample: \`data, config, options\``,
      { parse_mode: 'Markdown' }
    );
  });

  // ============================================================
  // MESSAGE HANDLER (chat + special inputs)
  // ============================================================

  bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const text = ctx.message.text;
    llm.initDefaults(userId);

    // Check for awaiting input
    const state = userState.get(userId);

    // Handle API key input
    if (state.awaiting_input?.startsWith('setkey:')) {
      const providerName = state.awaiting_input.split(':')[1];
      llm.setApiKey(userId, providerName, text.trim());
      userState.clearAwaiting(userId);
      return ctx.reply(`\u2705 API key set for *${PROVIDER_REGISTRY[providerName]?.name || providerName}*`, { parse_mode: 'Markdown' });
    }

    // Handle task answer
    if (state.awaiting_input?.startsWith('task_answer:')) {
      const taskId = parseInt(state.awaiting_input.split(':')[1]);
      boards.answerTaskInput(taskId, text);
      userState.clearAwaiting(userId);
      const task = boards.getTask(taskId);
      await ctx.reply(`\u2705 Answer recorded for: *${task.title}*`, { parse_mode: 'Markdown' });

      // Check if board is now ready
      if (boards.isReadyForExecution(task.board_id)) {
        const board = boards.get(task.board_id);
        await ctx.reply(
          `\u2705 All questions answered! Board *${board.title}* is ready.\n\nHit Execute to start!`,
          { parse_mode: 'Markdown', ...kb.boardView(task.board_id, boards.getTasks(task.board_id), 'planning') }
        );
      } else {
        // Ask next question
        const summary = boards.getSummary(task.board_id);
        if (summary.needsInput.length > 0) {
          const next = summary.needsInput[0];
          userState.setAwaiting(userId, `task_answer:${next.id}`);
          await ctx.reply(`\u2753 *Next question - ${next.title}:*\n\n${next.input_question}`, { parse_mode: 'Markdown' });
        }
      }
      return;
    }

    // Handle task discussion
    if (state.awaiting_input?.startsWith('discuss_task:')) {
      const taskId = parseInt(state.awaiting_input.split(':')[1]);
      const task = boards.getTask(taskId);

      try {
        const result = await llm.chat(userId, [
          { role: 'system', content: `You are helping with a project task.\nTask: ${task.title}\nDescription: ${task.description}` },
          { role: 'user', content: text },
        ]);
        await safeSend(ctx, `\ud83d\udcac ${result.text}\n\n_via ${result.provider}_`, kb.taskDetail(task));
      } catch (err) {
        await ctx.reply(`\u274c Error: ${err.message}`);
      }
      return;
    }

    // Handle workflow node addition
    if (state.awaiting_input?.startsWith('wf_addnode:')) {
      const parts = state.awaiting_input.split(':');
      const wfId = parseInt(parts[1]);
      const nodeType = parts[2];
      userState.clearAwaiting(userId);

      const nodeParts = text.split('|').map(s => s.trim());
      const name = nodeParts[0] || 'Node';
      const desc = nodeParts[1] || '';
      const node = workflows.addNode(wfId, name, nodeType, desc, ['default'], ['default']);
      const rendered = workflows.renderWorkflow(wfId);
      const nodes = workflows.getNodes(wfId);
      return ctx.reply(rendered, { parse_mode: 'Markdown', ...workflowKeyboard(wfId, nodes) });
    }

    // Handle workflow input/output editing
    if (state.awaiting_input?.startsWith('wf_edit_inputs:') || state.awaiting_input?.startsWith('wf_edit_outputs:')) {
      const parts = state.awaiting_input.split(':');
      const field = parts[0].replace('wf_edit_', '');
      const nodeId = parseInt(parts[1]);
      userState.clearAwaiting(userId);

      const values = text.split(',').map(s => s.trim()).filter(Boolean);
      if (field === 'inputs') {
        workflows.setNodeInputs(nodeId, values);
      } else {
        workflows.setNodeOutputs(nodeId, values);
      }
      return ctx.reply(`\u2705 ${field} updated: ${values.join(', ')}`);
    }

    // Handle CLI command for draft
    if (state.awaiting_input?.startsWith('draft_cli:')) {
      userState.clearAwaiting(userId);
      await ctx.reply(`\u25b6\ufe0f Running: \`${text}\``, { parse_mode: 'Markdown' });
      const result = await qa.runCommand(text);
      const emoji = result.ok ? '\u2705' : '\u274c';
      let output = result.stdout || result.stderr || 'No output';
      if (output.length > 3500) output = output.substring(0, 3500) + '...(truncated)';
      return ctx.reply(`${emoji}\n\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
    }

    // Check if message contains a URL -> add to drafts
    const url = extractUrl(text);
    if (url && !text.startsWith('/')) {
      await ctx.reply('\ud83d\udce5 Link detected! Fetching info...');

      const meta = await fetchLinkMeta(url);
      const draft = drafts.add(userId, url, meta.title, meta.description, meta.bodyText || '');

      return safeSend(ctx,
        `\ud83d\udce5 *Saved to Drafts*\n\n` +
        `*${meta.title}*\n${meta.description ? meta.description.substring(0, 200) : 'No description'}\n\n` +
        `What would you like to do?`,
        kb.draftActions(draft.id)
      );
    }

    // Normal chat mode
    let session = sessions.getActive(userId);
    if (!session) {
      session = sessions.create(userId, 'Chat');
    }

    sessions.addMessage(session.id, 'user', text);
    const history = sessions.getRecentMessages(session.id);
    const chatMessages = history.map(m => ({ role: m.role, content: m.content }));

    try {
      await ctx.sendChatAction('typing');
      const result = await llm.chat(userId, chatMessages);
      sessions.addMessage(session.id, 'assistant', result.text);

      let response = result.text;
      if (response.length > 4000) response = response.substring(0, 4000) + '\n\n...(truncated)';
      response += `\n\n_${result.provider} \u2022 ${result.model}_`;

      await safeSend(ctx, response);
    } catch (err) {
      await ctx.reply(`\u274c ${err.message}`);
    }
  });

  // Handle photos (for vision QA)
  bot.on('photo', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const caption = ctx.message.caption || 'What do you see in this image?';

    try {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const fileLink = await ctx.telegram.getFileLink(photo.file_id);
      const response = await fetch(fileLink.href);
      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString('base64');

      await ctx.sendChatAction('typing');
      const result = await llm.vision(userId, base64, caption);
      await safeSend(ctx, `${result.text}\n\n_${result.provider} \u2022 ${result.model}_`);
    } catch (err) {
      await ctx.reply(`\u274c Vision error: ${err.message}`);
    }
  });

  // ============================================================
  // HELPER FUNCTIONS
  // ============================================================

  async function showProviders(ctx, userId) {
    const providers = llm.getProviders(userId);
    let text = '\ud83d\udd27 *LLM Providers* (ordered by priority)\n\n';
    text += '_Requests try each enabled provider in order.\nIf one fails, it falls back to the next._\n\n';

    for (let i = 0; i < providers.length; i++) {
      const p = providers[i];
      const status = p.enabled ? '\u2705' : '\u274c';
      const type = p.is_local ? '\ud83c\udfe0 Local' : '\u2601\ufe0f Cloud';
      const hasKey = p.is_local || p.api_key ? '\ud83d\udd11' : '\u26a0\ufe0f No key';
      text += `${i + 1}. ${status} ${type} *${p.display_name}*\n   Model: \`${p.model}\` ${hasKey}\n\n`;
    }

    await ctx.reply(text, { parse_mode: 'Markdown', ...kb.providerList(providers) });
  }

  async function showProvidersEdit(ctx, userId) {
    const providers = llm.getProviders(userId);
    let text = '\ud83d\udd27 *LLM Providers*\n\n';
    for (let i = 0; i < providers.length; i++) {
      const p = providers[i];
      const status = p.enabled ? '\u2705' : '\u274c';
      const type = p.is_local ? '\ud83c\udfe0' : '\u2601\ufe0f';
      text += `${i + 1}. ${status} ${type} *${p.display_name}* - \`${p.model}\`\n`;
    }
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...kb.providerList(providers) });
    } catch {
      await ctx.reply(text, { parse_mode: 'Markdown', ...kb.providerList(providers) });
    }
  }

  async function showBoard(ctx, boardId) {
    const summary = boards.getSummary(boardId);
    if (!summary) return ctx.reply('Board not found.');

    const { board, tasks, pending, inProgress, done, needsInput } = summary;

    let text = `\ud83d\udccb *${board.title}*\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
    text += `Status: ${board.status} | Total: ${tasks.length}\n`;
    text += `Done: ${done.length} | In Progress: ${inProgress.length} | Pending: ${pending.length}\n`;
    if (needsInput.length > 0) text += `\u2753 Needs input: ${needsInput.length}\n`;
    text += '\n';

    for (const t of tasks) {
      const s = t.status === 'done' ? '\u2705' : t.status === 'in_progress' ? '\ud83d\udd35' : '\u2b1c';
      const q = (t.requires_input && !t.input_answer) ? ' \u2753' : '';
      const qaE = t.qa_status === 'pass' ? ' \u2705' : t.qa_status === 'fail' ? ' \u274c' : '';
      text += `${s}${qaE}${q} ${t.title}\n`;
    }

    await ctx.reply(text, { parse_mode: 'Markdown', ...kb.boardView(boardId, tasks, board.status) });
  }

  async function showBoardEdit(ctx, boardId) {
    const summary = boards.getSummary(boardId);
    if (!summary) return;

    const { board, tasks, pending, inProgress, done, needsInput } = summary;
    let text = `\ud83d\udccb *${board.title}*\n`;
    text += `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
    text += `${done.length}/${tasks.length} done`;
    if (needsInput.length > 0) text += ` | \u2753 ${needsInput.length} need input`;
    text += '\n\n';

    for (const t of tasks) {
      const s = t.status === 'done' ? '\u2705' : t.status === 'in_progress' ? '\ud83d\udd35' : '\u2b1c';
      text += `${s} ${t.title}\n`;
    }

    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...kb.boardView(boardId, tasks, board.status) });
    } catch {
      await ctx.reply(text, { parse_mode: 'Markdown', ...kb.boardView(boardId, tasks, board.status) });
    }
  }

  async function showDrafts(ctx, userId) {
    const list = drafts.listByUser(userId);
    if (list.length === 0) return ctx.reply('\ud83d\udce5 No drafts yet.\n\nShare a link in this chat to add it to your draft board!');

    let text = '\ud83d\udce5 *Draft Board*\n\n';
    const buttons = [];
    for (const d of list) {
      const emoji = d.status === 'new' ? '\ud83c\udd95' : '\u2705';
      text += `${emoji} *${(d.title || d.url || 'Untitled').substring(0, 50)}*\n`;
      buttons.push([{ text: `${emoji} ${(d.title || d.url || 'Untitled').substring(0, 40)}`, callback_data: `draft_view:${d.id}` }]);
    }
    buttons.push([{ text: '\u25c0\ufe0f Back', callback_data: 'main_menu' }]);
    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  }

  async function showDraftsEdit(ctx, userId) {
    const list = drafts.listByUser(userId);
    if (list.length === 0) {
      try {
        return ctx.editMessageText('\ud83d\udce5 No drafts. Share a link to add one!');
      } catch {
        return ctx.reply('\ud83d\udce5 No drafts. Share a link to add one!');
      }
    }

    let text = '\ud83d\udce5 *Draft Board*\n\n';
    const buttons = [];
    for (const d of list) {
      const emoji = d.status === 'new' ? '\ud83c\udd95' : '\u2705';
      text += `${emoji} ${(d.title || d.url || 'Untitled').substring(0, 50)}\n`;
      buttons.push([{ text: `${emoji} ${(d.title || 'Untitled').substring(0, 40)}`, callback_data: `draft_view:${d.id}` }]);
    }
    buttons.push([{ text: '\u25c0\ufe0f Back', callback_data: 'main_menu' }]);
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
    } catch {
      await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
    }
  }

  bot.action(/draft_view:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;

    let text = `\ud83d\udce5 *${draft.title || 'Untitled Draft'}*\n\n`;
    if (draft.url) text += `\ud83d\udd17 ${draft.url}\n\n`;
    if (draft.description) text += `${draft.description.substring(0, 500)}\n\n`;
    text += `Status: ${draft.status} | Added: ${draft.created_at}`;

    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...kb.draftActions(draft.id) });
  });

  // Board execution engine
  async function executeBoard(ctx, userId, boardId) {
    const tasks = boards.getTasks(boardId);
    let allDone = true;

    for (const task of tasks) {
      if (task.status === 'done') continue;
      allDone = false;

      boards.setTaskStatus(task.id, 'in_progress');
      await ctx.reply(`\ud83d\udd35 *Executing:* ${task.title}`, { parse_mode: 'Markdown' });

      try {
        const result = await llm.chat(userId, [
          {
            role: 'system',
            content: `You are executing a project task. Provide the implementation or result.
If CLI commands are needed, list them clearly.
Task: ${task.title}
Description: ${task.description}
${task.input_answer ? `User Input: ${task.input_answer}` : ''}
${task.tools_needed ? `Tools: ${task.tools_needed}` : ''}`
          },
          { role: 'user', content: `Execute this task and provide the result: ${task.title}` }
        ]);

        boards.updateTask(task.id, { execution_log: result.text, status: 'done' });

        let output = result.text;
        if (output.length > 3000) output = output.substring(0, 3000) + '\n...(truncated)';
        await ctx.reply(`\u2705 *Done:* ${task.title}\n\n${output}`, { parse_mode: 'Markdown' });

        // Auto-run QA
        await ctx.reply(`\ud83e\uddea Running QA for: ${task.title}...`);
        const qaResult = await qa.runTaskQA(userId, task.id);
        const qaEmoji = qaResult.passed ? '\u2705' : '\u26a0\ufe0f';
        await ctx.reply(`${qaEmoji} QA: ${qaResult.passed ? 'Passed' : 'Needs review'}`);

      } catch (err) {
        boards.setTaskStatus(task.id, 'pending');
        await ctx.reply(`\u274c Failed: ${task.title}\n${err.message}`);
        break;
      }
    }

    if (allDone || boards.getTasks(boardId).every(t => t.status === 'done')) {
      boards.updateStatus(boardId, 'completed');
      await ctx.reply(`\ud83c\udf89 *Board completed!* All tasks done.`, { parse_mode: 'Markdown' });
    }

    const finalTasks = boards.getTasks(boardId);
    const board = boards.get(boardId);
    await ctx.reply('Board status:', kb.boardView(boardId, finalTasks, board.status));
  }

  // --- Workflow helpers ---
  function db_setActiveWorkflow(userId, wfId) {
    db.prepare(`
      INSERT INTO user_state (user_id, active_workflow_id) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET active_workflow_id = ?
    `).run(userId, wfId, wfId);
  }

  function getActiveWorkflow(userId) {
    const state = db.prepare('SELECT active_workflow_id FROM user_state WHERE user_id = ?').get(userId);
    return state?.active_workflow_id || null;
  }

  function workflowKeyboard(wfId, nodes) {
    const buttons = [];
    for (const n of nodes) {
      const type = NODE_TYPES[n.node_type] || NODE_TYPES.process;
      const statusE = n.status === 'done' ? '\u2705' : n.status === 'running' ? '\ud83d\udd35' : '\u2b1c';
      buttons.push([{ text: `${statusE} ${type.emoji} ${n.name}`, callback_data: `wf_nodedetail:${n.id}` }]);
    }
    buttons.push([
      { text: '\u2795 Add Node', callback_data: `wf_addnode:${wfId}` },
      { text: '\u26a1 Run', callback_data: `wf_run:${wfId}` },
    ]);
    buttons.push([
      { text: '\ud83d\udd04 Refresh', callback_data: `wf_view:${wfId}` },
      { text: '\ud83d\uddd1\ufe0f Delete', callback_data: `wf_delete:${wfId}` },
    ]);
    buttons.push([{ text: '\u25c0\ufe0f Back', callback_data: 'main_menu' }]);
    return { reply_markup: { inline_keyboard: buttons } };
  }

  return bot;
}
