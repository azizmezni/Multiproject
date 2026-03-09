import { Telegraf, Markup } from 'telegraf';
import db from './db.js';
import { llm } from './llm-manager.js';
import { sessions, userState } from './sessions.js';
import { boards } from './boards.js';
import { drafts, extractUrl, fetchLinkMeta, detectLinkType } from './drafts.js';
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
      `/wfview \u2014 View workflow | /wfrun \u2014 Execute\n` +
      `/wffix [problem] \u2014 Auto-fix workflow nodes\n\n` +
      `*Dev Assistant (from phone):*\n` +
      `/feature <desc> \u2014 Add a feature to the project\n` +
      `/bugfix <desc> \u2014 Fix a bug in the project\n\n` +
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

  // /wffix [problem description] — auto-fix workflow nodes
  bot.command('wffix', async (ctx) => {
    const userId = ctx.from.id;
    const wfId = getActiveWorkflow(userId);
    if (!wfId) return ctx.reply('No active workflow. Use /wflist first.');

    const problem = ctx.message.text.replace('/wffix', '').trim();
    await runAutoFix(ctx, userId, wfId, problem || null);
  });

  // --- Dev Assistant: add features / fix bugs from phone ---
  bot.command('feature', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const desc = ctx.message.text.replace('/feature', '').trim();
    if (!desc) {
      return ctx.reply(
        '🚀 *Add Feature*\n\n' +
        'Usage: `/feature <description>`\n\n' +
        'Examples:\n' +
        '• `/feature add search bar to filter workflows`\n' +
        '• `/feature dark/light theme toggle`\n' +
        '• `/feature export boards as PDF`\n\n' +
        'I will analyze the project, generate the code, and let you apply it.',
        { parse_mode: 'Markdown' }
      );
    }
    await handleDevRequest(ctx, userId, 'feature', desc);
  });

  bot.command('bugfix', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const desc = ctx.message.text.replace('/bugfix', '').trim();
    if (!desc) {
      return ctx.reply(
        '🐛 *Fix Bug*\n\n' +
        'Usage: `/bugfix <description>`\n\n' +
        'Examples:\n' +
        '• `/bugfix export crashes on empty workflows`\n' +
        '• `/bugfix markdown formatting breaks in long messages`\n' +
        '• `/bugfix workflow run skips first node`\n\n' +
        'I will analyze the project, diagnose the bug, and generate the fix.',
        { parse_mode: 'Markdown' }
      );
    }
    await handleDevRequest(ctx, userId, 'bugfix', desc);
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

  // --- Smart Link Actions ---

  // 📥 Clone & Setup — clone a git repo and install dependencies
  bot.action(/smart_clone:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;

    // Extract clone URL from the page URL
    let cloneUrl = draft.url;
    if (cloneUrl.includes('github.com') && !cloneUrl.endsWith('.git')) {
      cloneUrl = cloneUrl.replace(/\/$/, '') + '.git';
    }

    // Extract repo name for folder
    const repoName = cloneUrl.match(/\/([^/]+?)(?:\.git)?$/)?.[1] || 'repo';

    await ctx.editMessageText(`📥 *Cloning:* \`${repoName}\`...`, { parse_mode: 'Markdown' });

    try {
      // Clone the repo
      const cloneResult = await qa.runCommand(`git clone ${cloneUrl}`, process.cwd(), 60000);
      if (!cloneResult.ok) {
        return safeSend(ctx, `❌ Clone failed:\n\`${cloneResult.stderr.substring(0, 500)}\``);
      }

      await ctx.reply(`✅ Cloned to \`${repoName}/\``, { parse_mode: 'Markdown' });

      // Detect project type and install deps
      const fs = await import('fs/promises');
      const path = await import('path');
      const repoDir = path.join(process.cwd(), repoName);

      let projectType = 'unknown';
      let installCmd = null;
      const files = await fs.readdir(repoDir).catch(() => []);

      if (files.includes('package.json')) {
        projectType = 'node';
        installCmd = `cd "${repoDir}" && npm install`;
      } else if (files.includes('requirements.txt')) {
        projectType = 'python';
        installCmd = `cd "${repoDir}" && pip install -r requirements.txt`;
      } else if (files.includes('Cargo.toml')) {
        projectType = 'rust';
        installCmd = `cd "${repoDir}" && cargo build`;
      } else if (files.includes('go.mod')) {
        projectType = 'go';
        installCmd = `cd "${repoDir}" && go mod download`;
      } else if (files.includes('pom.xml')) {
        projectType = 'java';
        installCmd = `cd "${repoDir}" && mvn install`;
      } else if (files.includes('Gemfile')) {
        projectType = 'ruby';
        installCmd = `cd "${repoDir}" && bundle install`;
      } else if (files.includes('composer.json')) {
        projectType = 'php';
        installCmd = `cd "${repoDir}" && composer install`;
      }

      // Read README if exists
      let readmeContent = '';
      for (const f of ['README.md', 'readme.md', 'README.txt', 'README']) {
        try {
          readmeContent = await fs.readFile(path.join(repoDir, f), 'utf-8');
          break;
        } catch {}
      }

      if (installCmd) {
        await ctx.reply(`📦 Detected *${projectType}* project. Installing dependencies...`, { parse_mode: 'Markdown' });
        const installResult = await qa.runCommand(installCmd, repoDir, 120000);
        const installEmoji = installResult.ok ? '✅' : '⚠️';
        const output = (installResult.stdout || installResult.stderr || 'Done').substring(0, 500);
        await ctx.reply(`${installEmoji} Install:\n\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
      }

      // Send summary with smart analysis from LLM
      const userId = ctx.from.id;
      llm.initDefaults(userId);

      const analysis = await llm.chat(userId, [
        { role: 'system', content: 'You are a software analyst. Analyze the cloned repo and give a brief summary: what it does, how to run it, key files. Keep it short and actionable (under 500 chars). No markdown.' },
        { role: 'user', content: `Repo: ${repoName}\nProject type: ${projectType}\nFiles: ${files.slice(0, 30).join(', ')}\nREADME preview:\n${readmeContent.substring(0, 1500)}` },
      ]);

      await safeSend(ctx,
        `🏁 *${repoName}* cloned and ready!\n\n` +
        `Type: ${projectType}\n` +
        `${analysis.text.substring(0, 800)}\n\n` +
        `_via ${analysis.provider}_`
      );

      drafts.updateStatus(draft.id, 'processed');
    } catch (err) {
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  });

  // 🔍 Smart Analyze — LLM reads the page and figures out what you need
  bot.action(/smart_analyze:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;

    await ctx.editMessageText('🧠 Analyzing link...', { parse_mode: 'Markdown' });

    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const linkType = detectLinkType(draft.url);
    const pageContent = (draft.content || '').substring(0, 3000);

    try {
      const result = await llm.chat(userId, [
        { role: 'system', content: `You are a smart assistant analyzing a shared link. The user shared this ${linkType} link because they want to USE it, LEARN from it, or BUILD something with it.

Analyze the link and provide:
1. **What it is** — brief summary (2 sentences)
2. **Why they probably shared it** — what they want to do with it
3. **Actionable steps** — 3-5 concrete things they can do right now
4. **Dependencies/requirements** — what they need to get started
5. **Quick start commands** — actual CLI commands to get started (if applicable)

Be practical and specific. Use short sentences.` },
        { role: 'user', content: `URL: ${draft.url}\nTitle: ${draft.title}\nDescription: ${draft.description || 'N/A'}\n\nPage content:\n${pageContent}` },
      ]);

      await safeSend(ctx,
        `🧠 *Smart Analysis*\n\n${result.text.substring(0, 3500)}\n\n_via ${result.provider}_`,
        kb.draftActions(draft.id, linkType)
      );
    } catch (err) {
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  });

  // 📺 Summarize — video/article summary with key takeaways
  bot.action(/smart_summarize:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;

    const linkType = detectLinkType(draft.url);
    const isVideo = linkType.startsWith('youtube');

    await ctx.editMessageText(
      isVideo ? '📺 Analyzing video...' : '📖 Summarizing content...'
    );

    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const pageContent = (draft.content || '').substring(0, 3000);

    try {
      const prompt = isVideo
        ? `This is a YouTube video page. Extract and summarize:
1. **Video Title & Channel**
2. **Main Topic** (1-2 sentences)
3. **Key Points** (5-7 bullet points)
4. **Technologies/Tools mentioned** (list them)
5. **Dependencies to install** (if it's a tutorial, list packages/tools needed)
6. **Step-by-step plan** (if tutorial, list the steps to follow)

URL: ${draft.url}
Title: ${draft.title}
Page content: ${pageContent}`
        : `Summarize this article/documentation:
1. **Title & Author**
2. **Summary** (2-3 sentences)
3. **Key Takeaways** (5-7 bullet points)
4. **Code snippets / commands** (if any, list them)
5. **Dependencies** (tools/packages mentioned)
6. **Action items** (what to do next)

URL: ${draft.url}
Title: ${draft.title}
Page content: ${pageContent}`;

      const result = await llm.chat(userId, [
        { role: 'system', content: 'You are an expert content analyst. Extract actionable information. Be concise and practical.' },
        { role: 'user', content: prompt },
      ]);

      // Store the summary in the draft
      drafts.updateContent(draft.id, draft.title, result.text.substring(0, 2000), draft.content);

      await safeSend(ctx,
        `${isVideo ? '📺' : '📖'} *Summary*\n\n${result.text.substring(0, 3500)}\n\n_via ${result.provider}_`,
        kb.draftActions(draft.id, linkType)
      );
    } catch (err) {
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  });

  // 📋 Follow Tutorial — extract steps, create board, install deps
  bot.action(/smart_tutorial:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;

    await ctx.editMessageText('📋 Extracting tutorial steps...');

    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const pageContent = (draft.content || '').substring(0, 3000);

    try {
      const result = await llm.chat(userId, [
        { role: 'system', content: `You are a tutorial parser. Extract a step-by-step plan from this content.

Return a JSON object:
{
  "title": "Tutorial/Project title",
  "prerequisites": ["prerequisite1", "prerequisite2"],
  "install_commands": ["npm install x", "pip install y"],
  "steps": [
    {"title": "Step title", "description": "What to do", "commands": ["cmd1", "cmd2"], "code": "code snippet if any"}
  ],
  "test_commands": ["npm test", "python -m pytest"]
}

Return ONLY valid JSON.` },
        { role: 'user', content: `Extract tutorial steps from:\nURL: ${draft.url}\nTitle: ${draft.title}\n\nContent:\n${pageContent}` },
      ]);

      let tutorial;
      try {
        tutorial = JSON.parse(result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
      } catch {
        return safeSend(ctx, `📋 Could not parse tutorial steps. Here's the raw analysis:\n\n${result.text.substring(0, 2000)}`);
      }

      // Install prerequisites
      if (tutorial.install_commands?.length > 0) {
        const installButtons = [
          [{ text: '📦 Install All Dependencies', callback_data: `smart_install_cmds:${draft.id}` }],
          [{ text: '📋 Just Create Board', callback_data: `smart_tutorial_board:${draft.id}` }],
          [{ text: '◀️ Back', callback_data: 'list_drafts' }],
        ];

        // Store tutorial data in draft content for later use
        drafts.updateContent(draft.id, tutorial.title || draft.title, JSON.stringify(tutorial), draft.content);

        let previewText = `📋 *${stripMd(tutorial.title || 'Tutorial')}*\n\n`;
        if (tutorial.prerequisites?.length) {
          previewText += `*Prerequisites:*\n${tutorial.prerequisites.map(p => `• ${stripMd(p)}`).join('\n')}\n\n`;
        }
        previewText += `*Steps (${tutorial.steps?.length || 0}):*\n`;
        for (let i = 0; i < (tutorial.steps || []).length && i < 8; i++) {
          previewText += `${i + 1}. ${stripMd(tutorial.steps[i].title)}\n`;
        }
        if ((tutorial.steps?.length || 0) > 8) previewText += `... and ${tutorial.steps.length - 8} more\n`;

        if (tutorial.install_commands?.length) {
          previewText += `\n*Install commands:*\n${tutorial.install_commands.map(c => `\`${c}\``).join('\n')}\n`;
        }

        return safeSend(ctx, previewText, { reply_markup: { inline_keyboard: installButtons } });
      }

      // No install commands — just create the board
      drafts.updateContent(draft.id, tutorial.title || draft.title, JSON.stringify(tutorial), draft.content);
      await createTutorialBoard(ctx, userId, draft, tutorial);

    } catch (err) {
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  });

  // 📦 Install Package (npm/pypi/docker)
  bot.action(/smart_install:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;

    const linkType = detectLinkType(draft.url);

    await ctx.editMessageText('📦 Installing...');

    try {
      let installCmd;
      if (linkType === 'npm') {
        const pkgName = draft.url.match(/npmjs\.com\/package\/([@\w/-]+)/)?.[1];
        if (!pkgName) return ctx.reply('Could not extract package name.');
        installCmd = `npm install ${pkgName}`;
      } else if (linkType === 'pypi') {
        const pkgName = draft.url.match(/pypi\.org\/project\/([\w-]+)/)?.[1];
        if (!pkgName) return ctx.reply('Could not extract package name.');
        installCmd = `pip install ${pkgName}`;
      } else if (linkType === 'docker') {
        const imgName = draft.url.match(/hub\.docker\.com\/r\/([\w/-]+)/)?.[1] ||
                        draft.url.match(/hub\.docker\.com\/_\/([\w-]+)/)?.[1];
        if (!imgName) return ctx.reply('Could not extract image name.');
        installCmd = `docker pull ${imgName}`;
      } else {
        // Generic — try npm
        installCmd = `npm install ${draft.title || 'unknown'}`;
      }

      await ctx.reply(`▶️ Running: \`${installCmd}\``, { parse_mode: 'Markdown' });
      const result = await qa.runCommand(installCmd, process.cwd(), 120000);
      const emoji = result.ok ? '✅' : '❌';
      let output = result.stdout || result.stderr || 'Done';
      if (output.length > 2000) output = output.substring(0, 2000) + '...(truncated)';

      await safeSend(ctx, `${emoji} Install result:\n\`\`\`\n${output}\n\`\`\``);
      if (result.ok) drafts.updateStatus(draft.id, 'processed');
    } catch (err) {
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  });

  // Install commands from tutorial extraction
  bot.action(/smart_install_cmds:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;

    let tutorial;
    try { tutorial = JSON.parse(draft.description); } catch { return ctx.reply('Tutorial data expired. Try extracting again.'); }

    await ctx.editMessageText('📦 Installing dependencies...');

    for (const cmd of (tutorial.install_commands || [])) {
      await ctx.reply(`▶️ \`${cmd}\``, { parse_mode: 'Markdown' });
      const result = await qa.runCommand(cmd, process.cwd(), 120000);
      const emoji = result.ok ? '✅' : '❌';
      const output = (result.stdout || result.stderr || 'Done').substring(0, 500);
      await ctx.reply(`${emoji}\n\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
      if (!result.ok) break;
    }

    // After install, create the board
    const userId = ctx.from.id;
    await createTutorialBoard(ctx, userId, draft, tutorial);
  });

  // Create board from tutorial
  bot.action(/smart_tutorial_board:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;

    let tutorial;
    try { tutorial = JSON.parse(draft.description); } catch { return ctx.reply('Tutorial data expired.'); }

    await createTutorialBoard(ctx, ctx.from.id, draft, tutorial);
  });

  // 🌐 Test API endpoint
  bot.action(/smart_testapi:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = drafts.get(parseInt(ctx.match[1]));
    if (!draft) return;

    await ctx.editMessageText('🌐 Testing API endpoint...');

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(draft.url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json', 'User-Agent': 'TelegramLLMHub/1.0' },
      });
      clearTimeout(timeout);

      const status = res.status;
      const contentType = res.headers.get('content-type') || '';
      let body = await res.text();
      if (body.length > 2000) body = body.substring(0, 2000) + '...';

      // Try to pretty-print JSON
      try { body = JSON.stringify(JSON.parse(body), null, 2); } catch {}

      await safeSend(ctx,
        `🌐 *API Test Result*\n\n` +
        `Status: ${status}\n` +
        `Content-Type: ${contentType}\n\n` +
        `\`\`\`\n${body.substring(0, 1500)}\n\`\`\``
      );
    } catch (err) {
      await ctx.reply(`❌ API test failed: ${err.message}`);
    }
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

    // Show env vars count
    const envVars = node._config?.env || {};
    const envCount = Object.keys(envVars).length;
    if (envCount > 0) {
      text += `\n\n🔑 Env vars: ${Object.keys(envVars).map(k => `\`${k}\``).join(', ')}`;
    }

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
      { text: `🔑 Env Vars (${envCount})`, callback_data: `wf_env:${nodeId}` },
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

  // --- Auto Fix from button ---
  bot.action(/wf_fix:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const wfId = parseInt(ctx.match[1]);
    const buttons = [
      [{ text: '⚡ Fix All Now', callback_data: `wf_fixnow:${wfId}` }],
      [{ text: '✏️ Describe the problem first', callback_data: `wf_fix_describe:${wfId}` }],
      [{ text: '◀️ Back', callback_data: `wf_view:${wfId}` }],
    ];
    await ctx.editMessageText(
      '🔧 *Auto-Fix Workflow*\n\n' +
      'I will test each node in order, and if it fails, I will ask the LLM to fix the script and re-test (up to 3 retries per node).\n\n' +
      'You can also describe the problem so I can give the LLM more context.',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
    );
  });

  bot.action(/wf_fixnow:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const wfId = parseInt(ctx.match[1]);
    await runAutoFix(ctx, ctx.from.id, wfId, null);
  });

  bot.action(/wf_fix_describe:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const wfId = parseInt(ctx.match[1]);
    userState.setAwaiting(ctx.from.id, `wf_fix_msg:${wfId}`);
    await ctx.editMessageText(
      '✏️ *Describe the problem*\n\n' +
      'Type what\'s wrong or what you want fixed. For example:\n' +
      '• "The API node returns 401, need to add auth header"\n' +
      '• "Node 3 crashes on empty input"\n' +
      '• "The output format should be CSV not JSON"\n\n' +
      'Your message will be passed to the LLM as context for fixing.',
      { parse_mode: 'Markdown' }
    );
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

  // --- Env Vars management from Telegram ---
  bot.action(/wf_env:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const nodeId = parseInt(ctx.match[1]);
    const node = workflows.getNode(nodeId);
    if (!node) return;

    const env = node._config?.env || {};
    const keys = Object.keys(env);

    let text = `🔑 *Env Variables — ${node.name}*\n\n`;
    if (keys.length > 0) {
      for (const k of keys) {
        const masked = env[k].length > 4
          ? env[k].substring(0, 2) + '•'.repeat(Math.min(env[k].length - 4, 8)) + env[k].slice(-2)
          : '••••';
        text += `\`${k}\` = \`${masked}\`\n`;
      }
    } else {
      text += '_No env vars set_\n';
    }
    text += '\nUse `env.KEY` in JS scripts or `{{KEY}}` in prompts.';

    const buttons = [
      [{ text: '➕ Add Variable', callback_data: `wf_env_add:${nodeId}` }],
    ];
    if (keys.length > 0) {
      buttons.push([{ text: '🗑️ Remove Variable', callback_data: `wf_env_del:${nodeId}` }]);
    }
    buttons.push([{ text: '◀️ Back', callback_data: `wf_nodedetail:${nodeId}` }]);

    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  });

  // Add env var — ask user for KEY=VALUE
  bot.action(/wf_env_add:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const nodeId = parseInt(ctx.match[1]);
    userState.setAwaiting(ctx.from.id, `wf_env_add:${nodeId}`);
    await ctx.editMessageText(
      '➕ *Add Environment Variable*\n\n' +
      'Send in format: `KEY=value`\n\n' +
      'Examples:\n' +
      '• `API_KEY=sk-abc123def456`\n' +
      '• `BASE_URL=https://api.example.com`\n' +
      '• `DEBUG=true`',
      { parse_mode: 'Markdown' }
    );
  });

  // Remove env var — show list to pick from
  bot.action(/wf_env_del:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const nodeId = parseInt(ctx.match[1]);
    const node = workflows.getNode(nodeId);
    if (!node) return;

    const env = node._config?.env || {};
    const buttons = Object.keys(env).map(k => [
      { text: `🗑️ ${k}`, callback_data: `wf_env_remove:${nodeId}:${k}` },
    ]);
    buttons.push([{ text: '◀️ Back', callback_data: `wf_env:${nodeId}` }]);

    await ctx.editMessageText('Select variable to remove:', { reply_markup: { inline_keyboard: buttons } });
  });

  // Actually remove an env var
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

    // Show updated env list
    const updatedNode = workflows.getNode(nodeId);
    const updatedEnv = updatedNode._config?.env || {};
    const keys = Object.keys(updatedEnv);

    let text = `🔑 *Env Variables — ${node.name}*\n\n✅ Removed \`${key}\`\n\n`;
    if (keys.length > 0) {
      for (const k of keys) {
        const masked = updatedEnv[k].length > 4
          ? updatedEnv[k].substring(0, 2) + '•'.repeat(Math.min(updatedEnv[k].length - 4, 8)) + updatedEnv[k].slice(-2)
          : '••••';
        text += `\`${k}\` = \`${masked}\`\n`;
      }
    } else {
      text += '_No env vars remaining_\n';
    }

    const buttons = [
      [{ text: '➕ Add Variable', callback_data: `wf_env_add:${nodeId}` }],
    ];
    if (keys.length > 0) {
      buttons.push([{ text: '🗑️ Remove Variable', callback_data: `wf_env_del:${nodeId}` }]);
    }
    buttons.push([{ text: '◀️ Back', callback_data: `wf_nodedetail:${nodeId}` }]);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  });

  // --- Dev Assistant callbacks (from main menu) ---
  bot.action('dev_feature', async (ctx) => {
    await ctx.answerCbQuery();
    userState.setAwaiting(ctx.from.id, 'dev_feature');
    await ctx.editMessageText(
      '🚀 *Add Feature*\n\n' +
      'Describe the feature you want to add:\n\n' +
      '_Example: "add search bar to filter workflows" or "add notification sounds"_',
      { parse_mode: 'Markdown' }
    );
  });

  bot.action('dev_bugfix', async (ctx) => {
    await ctx.answerCbQuery();
    userState.setAwaiting(ctx.from.id, 'dev_bugfix');
    await ctx.editMessageText(
      '🐛 *Fix Bug*\n\n' +
      'Describe the bug you want to fix:\n\n' +
      '_Example: "export crashes on empty workflows" or "markdown breaks in long messages"_',
      { parse_mode: 'Markdown' }
    );
  });

  // Apply code changes from dev assistant
  bot.action(/dev_apply:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const requestId = parseInt(ctx.match[1]);
    const request = pendingDevRequests.get(requestId);
    if (!request) return ctx.editMessageText('Request expired. Please run the command again.');

    await ctx.editMessageText('⏳ *Applying changes...*', { parse_mode: 'Markdown' });
    const fs = await import('fs/promises');
    const path = await import('path');
    const projectDir = process.cwd();

    let applied = 0, errors = 0;
    for (const change of request.changes) {
      try {
        const filePath = path.join(projectDir, change.file);

        if (change.action === 'create') {
          // Create new file
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, change.code, 'utf-8');
          applied++;
        } else {
          // Modify existing file — read current, send to LLM to apply the change
          const currentContent = await fs.readFile(filePath, 'utf-8');

          const applyResult = await llm.chat(request.userId, [
            { role: 'system', content: `You are a code editor. Apply the described change to the file. Return ONLY the complete modified file content, no markdown fences, no explanations. Just the raw file content.` },
            { role: 'user', content: `File: ${change.file}\nChange to make: ${change.description}\n\nCode to add/modify:\n\`\`\`\n${change.code}\n\`\`\`\n\nCurrent file content:\n\`\`\`\n${currentContent}\n\`\`\`` },
          ]);

          let newContent = applyResult.text;
          // Strip markdown fences if LLM wrapped it
          newContent = newContent.replace(/^```(?:javascript|js|css|html)?\n?/g, '').replace(/\n?```$/g, '');
          await fs.writeFile(filePath, newContent, 'utf-8');
          applied++;
        }
      } catch (err) {
        errors++;
        await ctx.reply(`⚠️ Error applying ${change.file}: ${err.message}`);
      }
    }

    pendingDevRequests.delete(requestId);

    const summary = errors === 0
      ? `✅ *All ${applied} file(s) updated!*\n\nRestart the server to see changes.`
      : `⚠️ Applied ${applied} change(s), ${errors} error(s).`;

    await ctx.reply(summary, { parse_mode: 'Markdown', ...kb.mainMenu() });
  });

  // Refine — let user ask follow-up questions about the plan
  bot.action(/dev_refine:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const requestId = parseInt(ctx.match[1]);
    const request = pendingDevRequests.get(requestId);
    if (!request) return ctx.editMessageText('Request expired.');

    userState.setAwaiting(ctx.from.id, `dev_refine_msg:${requestId}`);
    await ctx.editMessageText(
      '💬 *Refine the plan*\n\n' +
      'Tell me what to change about the plan. For example:\n' +
      '• "Also add it to the dashboard, not just Telegram"\n' +
      '• "Use a different approach, use X instead"\n' +
      '• "Add more error handling"\n\n' +
      '_Send your refinement:_',
      { parse_mode: 'Markdown' }
    );
  });

  // Create board task from dev request
  bot.action(/dev_board:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const requestId = parseInt(ctx.match[1]);
    const request = pendingDevRequests.get(requestId);
    if (!request) return ctx.editMessageText('Request expired.');

    const title = `${request.type === 'feature' ? '🚀' : '🐛'} ${request.description.substring(0, 60)}`;
    const board = boards.create(ctx.from.id, title);
    const tasks = request.changes.map(c => ({
      title: `${c.action === 'create' ? 'Create' : 'Modify'} ${c.file}`,
      description: c.description + (c.code ? `\n\nCode:\n${c.code.substring(0, 500)}` : ''),
    }));
    boards.addTasksFromPlan(board.id, tasks);
    userState.setActiveBoard(ctx.from.id, board.id);

    pendingDevRequests.delete(requestId);

    const boardTasks = boards.getTasks(board.id);
    await ctx.reply(
      `📋 *Board created: ${title}*\n${boardTasks.length} tasks`,
      { parse_mode: 'Markdown', ...kb.boardView(board.id, boardTasks, 'planning') }
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

    // Handle dev assistant inputs from main menu buttons
    if (state.awaiting_input === 'dev_feature' || state.awaiting_input === 'dev_bugfix') {
      const type = state.awaiting_input === 'dev_feature' ? 'feature' : 'bugfix';
      userState.clearAwaiting(userId);
      await handleDevRequest(ctx, userId, type, text);
      return;
    }

    // Handle dev assistant refinement
    if (state.awaiting_input?.startsWith('dev_refine_msg:')) {
      const requestId = parseInt(state.awaiting_input.split(':')[1]);
      userState.clearAwaiting(userId);
      const request = pendingDevRequests.get(requestId);
      if (!request) return ctx.reply('Request expired. Use /feature or /bugfix again.');

      // Re-run with refined context
      const refinedDesc = `${request.description}\n\nAdditional context: ${text}`;
      pendingDevRequests.delete(requestId);
      await handleDevRequest(ctx, userId, request.type, refinedDesc);
      return;
    }

    // Handle env var addition
    if (state.awaiting_input?.startsWith('wf_env_add:')) {
      const nodeId = parseInt(state.awaiting_input.split(':')[1]);
      userState.clearAwaiting(userId);

      // Parse KEY=VALUE format (support multiple lines)
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const node = workflows.getNode(nodeId);
      if (!node) return ctx.reply('Node not found.');

      const config = node._config || {};
      const env = { ...(config.env || {}) };
      let added = 0;

      for (const line of lines) {
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;
        const key = line.substring(0, eqIdx).trim();
        const val = line.substring(eqIdx + 1).trim();
        if (key) {
          env[key] = val;
          added++;
        }
      }

      if (added === 0) return ctx.reply('Invalid format. Use `KEY=value`', { parse_mode: 'Markdown' });

      workflows.setNodeConfig(nodeId, { ...config, env });
      await ctx.reply(
        `✅ Added ${added} env var(s) to *${node.name}*\n\n` +
        `Keys: ${Object.keys(env).map(k => `\`${k}\``).join(', ')}\n\n` +
        `Use \`env.KEY\` in JS or \`{{KEY}}\` in prompts.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Handle auto-fix with user problem description
    if (state.awaiting_input?.startsWith('wf_fix_msg:')) {
      const wfId = parseInt(state.awaiting_input.split(':')[1]);
      userState.clearAwaiting(userId);
      await runAutoFix(ctx, userId, wfId, text);
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

    // Check if message contains a URL -> smart link handling
    const url = extractUrl(text);
    if (url && !text.startsWith('/')) {
      const linkType = detectLinkType(url);
      const typeLabels = {
        github_repo: '📦 GitHub Repo', github_issue: '🐛 GitHub Issue', github_code: '💻 GitHub Code',
        github: '🐙 GitHub', youtube: '📺 YouTube Video', youtube_playlist: '📺 YouTube Playlist',
        npm: '📦 npm Package', pypi: '📦 PyPI Package', docs: '📖 Documentation',
        article: '📰 Article', stackoverflow: '💡 StackOverflow', api: '🌐 API',
        docker: '🐳 Docker Image', website: '🔗 Website',
      };
      const typeLabel = typeLabels[linkType] || '🔗 Link';

      await ctx.reply(`${typeLabel} detected! Fetching info...`);

      const meta = await fetchLinkMeta(url);
      const draft = drafts.add(userId, url, meta.title, meta.description, meta.bodyText || '');

      // Smart context message based on link type
      let contextMsg = `📥 *Saved to Drafts*\n\n`;
      contextMsg += `*${stripMd(meta.title || url)}*\n`;
      if (meta.description) contextMsg += `${stripMd(meta.description).substring(0, 200)}\n`;
      contextMsg += `\nType: ${typeLabel}\n`;

      if (linkType === 'github_repo' && meta.extra?.language) {
        contextMsg += `Language: ${meta.extra.language}\n`;
      }

      contextMsg += `\nI detected this as a *${typeLabel}*. Pick a smart action:`;

      return safeSend(ctx, contextMsg, kb.draftActions(draft.id, linkType));
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

    const linkType = draft.url ? detectLinkType(draft.url) : 'website';
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...kb.draftActions(draft.id, linkType) });
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

  // --- Dev Assistant: scan project + LLM code generation ---
  const pendingDevRequests = new Map();

  async function handleDevRequest(ctx, userId, type, description) {
    const fs = await import('fs/promises');
    const path = await import('path');
    const projectDir = process.cwd();

    const emoji = type === 'feature' ? '🚀' : '🐛';
    const label = type === 'feature' ? 'Feature' : 'Bug Fix';

    await ctx.reply(
      `${emoji} *${label}*\n_${description.substring(0, 200)}_\n\nScanning project files...`,
      { parse_mode: 'Markdown' }
    );

    // 1. Scan project structure — read src/ files
    const srcDir = path.join(projectDir, 'src');
    let sourceFiles = [];
    try {
      const readDir = async (dir, prefix = '') => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory() && entry.name !== 'node_modules') {
            await readDir(path.join(dir, entry.name), rel);
          } else if (entry.isFile() && /\.(js|css|html)$/.test(entry.name)) {
            sourceFiles.push(rel);
          }
        }
      };
      await readDir(srcDir);
    } catch {}

    // 2. Read file summaries (function signatures, exports, first lines)
    const fileSummaries = [];
    for (const f of sourceFiles) {
      try {
        const content = await fs.readFile(path.join(srcDir, f), 'utf-8');
        const lines = content.split('\n');
        // Extract key info: exports, function names, class names
        const exports = lines.filter(l => /^export |module\.exports/.test(l)).join('\n');
        const functions = lines.filter(l => /^\s*(async\s+)?function\s+|^\s*\w+\s*\(|bot\.(command|action)|app\.(get|post|put|delete)/.test(l)).slice(0, 20).join('\n');
        fileSummaries.push({
          file: `src/${f}`,
          lines: lines.length,
          exports: exports.substring(0, 300),
          functions: functions.substring(0, 500),
          preview: lines.slice(0, 15).join('\n'),
        });
      } catch {}
    }

    await ctx.reply('🤖 Analyzing and generating code...');

    // 3. LLM call: analyze project + generate changes
    const projectOverview = fileSummaries.map(f =>
      `=== ${f.file} (${f.lines} lines) ===\n` +
      `Exports: ${f.exports || 'none'}\n` +
      `Key functions:\n${f.functions || 'none'}\n` +
      `Preview:\n${f.preview}\n`
    ).join('\n');

    try {
      const result = await llm.chat(userId, [
        { role: 'system', content: `You are a senior full-stack developer. The user wants to ${type === 'feature' ? 'add a feature' : 'fix a bug'} in their Node.js project.

Project structure and file summaries:
${projectOverview}

Analyze the request and generate specific code changes. Return a JSON object:
{
  "analysis": "Brief analysis of what needs to be done (2-3 sentences)",
  "changes": [
    {
      "file": "src/filename.js",
      "action": "modify" or "create",
      "description": "What this change does",
      "code": "The actual code to add/insert. For modifications, show the NEW code block that should be added."
    }
  ],
  "summary": "One-line summary of all changes"
}

IMPORTANT:
- Be specific about WHERE in the file the code goes (mention what it's near/after)
- For modifications, show complete functions/blocks, not snippets
- Keep code practical and matching the existing codebase style
- Return ONLY the JSON object, no markdown fences` },
        { role: 'user', content: `${type === 'feature' ? 'Add this feature' : 'Fix this bug'}: ${description}` },
      ]);

      // Parse the plan
      let plan;
      try {
        const cleaned = result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        plan = JSON.parse(cleaned);
      } catch {
        // LLM didn't return valid JSON — show raw response
        await safeSend(ctx,
          `${emoji} *${label} Analysis*\n\n${result.text.substring(0, 3500)}\n\n_via ${result.provider}_`
        );
        return;
      }

      // 4. Store the request for apply
      const requestId = Date.now();
      pendingDevRequests.set(requestId, {
        type,
        description,
        changes: plan.changes || [],
        userId,
      });

      // Auto-expire after 30 minutes
      setTimeout(() => pendingDevRequests.delete(requestId), 30 * 60 * 1000);

      // 5. Format and show the plan
      let planText = `${emoji} *${label} Plan*\n\n`;
      planText += `${plan.analysis || 'No analysis'}\n\n`;
      planText += `*Changes (${(plan.changes || []).length} files):*\n`;

      for (const c of (plan.changes || [])) {
        const actionEmoji = c.action === 'create' ? '🆕' : '✏️';
        planText += `\n${actionEmoji} \`${c.file}\`\n`;
        planText += `${c.description}\n`;
        // Show a preview of the code (truncated)
        if (c.code) {
          const preview = c.code.substring(0, 300);
          planText += `\`\`\`\n${preview}${c.code.length > 300 ? '\n...' : ''}\n\`\`\`\n`;
        }
      }

      if (plan.summary) planText += `\n_${plan.summary}_\n`;
      planText += `\n_via ${result.provider}_`;

      const buttons = [
        [{ text: '✅ Apply All Changes', callback_data: `dev_apply:${requestId}` }],
        [{ text: '💬 Refine Plan', callback_data: `dev_refine:${requestId}` }],
        [{ text: '📋 Create as Board', callback_data: `dev_board:${requestId}` }],
        [{ text: '❌ Cancel', callback_data: 'main_menu' }],
      ];

      // Send plan (chunked if too long)
      if (planText.length <= 3800) {
        await safeSend(ctx, planText, { reply_markup: { inline_keyboard: buttons } });
      } else {
        // Split: send plan first, then action buttons
        const chunks = [];
        let remaining = planText;
        while (remaining.length > 0) {
          let splitAt = 3800;
          const nlPos = remaining.lastIndexOf('\n', 3800);
          if (nlPos > 1900) splitAt = nlPos + 1;
          chunks.push(remaining.substring(0, splitAt));
          remaining = remaining.substring(splitAt);
        }
        for (const chunk of chunks) {
          await safeSend(ctx, chunk);
        }
        await ctx.reply('Choose an action:', { reply_markup: { inline_keyboard: buttons } });
      }

    } catch (err) {
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  }

  // --- Smart link helpers ---
  async function createTutorialBoard(ctx, userId, draft, tutorial) {
    const title = tutorial.title || draft.title || 'Tutorial';
    const board = boards.create(userId, title);

    const taskList = (tutorial.steps || []).map((step, i) => ({
      title: `Step ${i + 1}: ${step.title}`,
      description: [
        step.description || '',
        step.commands?.length ? `Commands:\n${step.commands.join('\n')}` : '',
        step.code ? `Code:\n${step.code.substring(0, 300)}` : '',
      ].filter(Boolean).join('\n\n'),
    }));

    // Add test step if there are test commands
    if (tutorial.test_commands?.length) {
      taskList.push({
        title: 'Run Tests',
        description: `Test commands:\n${tutorial.test_commands.join('\n')}`,
      });
    }

    if (taskList.length === 0) {
      taskList.push({ title: 'Review tutorial', description: `Source: ${draft.url}` });
    }

    boards.addTasksFromPlan(board.id, taskList);
    userState.setActiveBoard(userId, board.id);
    drafts.updateStatus(draft.id, 'processed');

    const tasks = boards.getTasks(board.id);
    await ctx.reply(
      `📋 *Board created: ${stripMd(title)}*\n${tasks.length} steps extracted from tutorial`,
      { parse_mode: 'Markdown', ...kb.boardView(board.id, tasks, 'planning') }
    );
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

  // --- Auto-Fix: test each node, send errors to LLM, apply fix, retry ---
  async function runAutoFix(ctx, userId, wfId, problemDescription) {
    const wf = workflows.get(wfId);
    if (!wf) return ctx.reply('Workflow not found.');

    let orderedNodes;
    try {
      orderedNodes = workflows.getExecutionOrder(wfId);
    } catch (err) {
      return ctx.reply(`❌ ${err.message}`);
    }
    if (orderedNodes.length === 0) return ctx.reply('Workflow has no nodes.');

    const edges = workflows.getEdges(wfId);

    await ctx.reply(
      `🔧 *Auto-Fix: ${wf.title}*\n` +
      `Nodes: ${orderedNodes.length}\n` +
      (problemDescription ? `Problem: _${problemDescription}_\n` : '') +
      `\nTesting each node in order...`,
      { parse_mode: 'Markdown' }
    );

    const nodeResults = new Map(); // nodeId -> test result output
    let passed = 0, autoFixed = 0, failed = 0;

    for (const node of orderedNodes) {
      const type = NODE_TYPES[node.node_type] || NODE_TYPES.process;
      const label = `${type.emoji} *${node.name}*`;

      // Build input from upstream results
      const incomingEdges = edges.filter(e => e.to_node_id === node.id);
      const testInput = {};
      for (const e of incomingEdges) {
        const upstreamResult = nodeResults.get(e.from_node_id);
        if (upstreamResult) {
          testInput[e.to_input] = upstreamResult.outputs?.[e.from_output] || upstreamResult.result || '';
        }
      }

      await ctx.reply(`⏳ Testing ${label}...`, { parse_mode: 'Markdown' });

      let testResult;
      try {
        testResult = await workflows.testNode(userId, node.id, testInput);
      } catch (err) {
        testResult = { ok: false, error: err.message, output: null };
      }

      // Check if test passed
      const hasError = !testResult.ok ||
        (testResult.output?.result && /error|fail|exception|crash|cannot|undefined/i.test(testResult.output?.result));

      if (!hasError) {
        // Node passed
        nodeResults.set(node.id, testResult.output || { result: '', outputs: {} });
        passed++;
        await ctx.reply(`✅ ${label} — passed (${testResult.duration}ms)`, { parse_mode: 'Markdown' });
        continue;
      }

      // Node failed — try to auto-fix
      const errorMsg = testResult.error || testResult.output?.result || 'Unknown error';
      await ctx.reply(`🔄 ${label} — failed, asking LLM to fix...\n\n\`${errorMsg.substring(0, 500)}\``, { parse_mode: 'Markdown' });

      let fixed = false;
      const currentScript = node.custom_script || '';
      let scriptToFix = currentScript;

      for (let attempt = 1; attempt <= 3; attempt++) {
        // Build chat message for LLM
        const fixPrompt = [
          `The node "${node.name}" (type: ${node.node_type}) failed with this error:`,
          `\`\`\``,
          errorMsg.substring(0, 1000),
          `\`\`\``,
          ``,
          `Current script:`,
          `\`\`\``,
          scriptToFix || '// No script',
          `\`\`\``,
          ``,
          `Test input was: ${JSON.stringify(testInput).substring(0, 500)}`,
          problemDescription ? `\nUser says the problem is: "${problemDescription}"` : '',
          ``,
          `Fix the script. Return the complete corrected script wrapped in a \`\`\`fix code block.`,
        ].join('\n');

        try {
          const chatResult = await llm.chat(userId, [
            { role: 'system', content: `You are a code assistant fixing a workflow node script. The node "${node.name}" (${node.node_type}) does: "${node.description || 'No description'}". Return the complete fixed script in a \`\`\`fix code block.` },
            { role: 'user', content: fixPrompt },
          ]);

          // Extract fixed script
          let fixedScript = null;
          const fixMatch = chatResult.text.match(/```fix\n?([\s\S]*?)```/);
          if (fixMatch) {
            fixedScript = fixMatch[1].trim();
          } else {
            const codeMatch = chatResult.text.match(/```(?:javascript|js|bash|python)?\n?([\s\S]*?)```/);
            if (codeMatch && codeMatch[1].trim().length > 10) fixedScript = codeMatch[1].trim();
          }

          if (!fixedScript) {
            await ctx.reply(`  ⚠️ Attempt ${attempt}/3: LLM didn't provide a fix`);
            continue;
          }

          // Save fixed script
          workflows.saveScript(node.id, fixedScript);
          scriptToFix = fixedScript;

          // Re-test
          // Need to re-fetch the node to get updated custom_script
          let retestResult;
          try {
            retestResult = await workflows.testNode(userId, node.id, testInput);
          } catch (err) {
            retestResult = { ok: false, error: err.message };
          }

          const retestError = !retestResult.ok ||
            (retestResult.output?.result && /error|fail|exception|crash|cannot|undefined/i.test(retestResult.output?.result));

          if (!retestError) {
            // Fixed!
            nodeResults.set(node.id, retestResult.output || { result: '', outputs: {} });
            autoFixed++;
            fixed = true;
            await ctx.reply(`✅ ${label} — auto-fixed on attempt ${attempt}!`, { parse_mode: 'Markdown' });
            break;
          } else {
            const retestErr = retestResult.error || retestResult.output?.result || '';
            await ctx.reply(`  🔄 Attempt ${attempt}/3 — still failing: \`${retestErr.substring(0, 200)}\``, { parse_mode: 'Markdown' });
          }
        } catch (err) {
          await ctx.reply(`  ⚠️ Attempt ${attempt}/3 LLM error: ${err.message}`);
        }
      }

      if (!fixed) {
        // Restore original script if all attempts failed
        if (currentScript) workflows.saveScript(node.id, currentScript);
        nodeResults.set(node.id, { result: '', outputs: {} });
        failed++;
        await ctx.reply(`❌ ${label} — could not fix after 3 attempts`, { parse_mode: 'Markdown' });
      }
    }

    // Summary
    const summary = [
      `\n🏁 *Auto-Fix Complete: ${wf.title}*`,
      ``,
      `✅ Passed: ${passed}`,
      autoFixed > 0 ? `🔧 Auto-fixed: ${autoFixed}` : '',
      failed > 0 ? `❌ Failed: ${failed}` : '',
      ``,
      failed === 0 ? '🎉 All nodes working!' : `⚠️ ${failed} node(s) still need manual fixes.`,
    ].filter(Boolean).join('\n');

    const nodes = workflows.getNodes(wfId);
    await ctx.reply(summary, { parse_mode: 'Markdown', ...workflowKeyboard(wfId, nodes) });
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
      { text: '🔧 Fix', callback_data: `wf_fix:${wfId}` },
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
