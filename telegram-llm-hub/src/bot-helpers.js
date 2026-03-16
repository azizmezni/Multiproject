import { Markup } from 'telegraf';
import db from './db.js';

// Strip all Telegram Markdown special chars so it never fails
export function stripMd(text) {
  return text
    .replace(/```[\s\S]*?```/g, m => m.slice(3, -3))
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/__/g, '')
    .replace(/_/g, '')
    .replace(/`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

// Send a message safely — tries Markdown first, falls back to plain text
export async function safeSend(ctx, text, extra = {}) {
  try {
    return await ctx.reply(text, { parse_mode: 'Markdown', ...extra });
  } catch {
    try {
      return await ctx.reply(stripMd(text), extra);
    } catch (err) {
      try {
        return await ctx.reply(stripMd(text).substring(0, 4000), extra);
      } catch (finalErr) {
        console.error('safeSend failed completely:', finalErr.message);
      }
    }
  }
}

/**
 * Factory that returns helper closures over shared dependencies.
 * Called once by the orchestrator, result stored in shared.helpers.
 */
export function createHelpers(shared) {
  const { llm, boards, drafts, qa, kb, PROVIDER_REGISTRY, workflows, NODE_TYPES, userState } = shared;

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
      { text: '\ud83d\udd27 Fix', callback_data: `wf_fix:${wfId}` },
    ]);
    buttons.push([
      { text: '\ud83d\udd04 Refresh', callback_data: `wf_view:${wfId}` },
      { text: '\ud83d\uddd1\ufe0f Delete', callback_data: `wf_delete:${wfId}` },
    ]);
    buttons.push([{ text: '\u25c0\ufe0f Back', callback_data: 'main_menu' }]);
    return { reply_markup: { inline_keyboard: buttons } };
  }

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
    let text = `\ud83d\udccb *${board.title}*\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
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
      try { return ctx.editMessageText('\ud83d\udce5 No drafts. Share a link to add one!'); }
      catch { return ctx.reply('\ud83d\udce5 No drafts. Share a link to add one!'); }
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
    if (tutorial.test_commands?.length) {
      taskList.push({ title: 'Run Tests', description: `Test commands:\n${tutorial.test_commands.join('\n')}` });
    }
    if (taskList.length === 0) {
      taskList.push({ title: 'Review tutorial', description: `Source: ${draft.url}` });
    }
    boards.addTasksFromPlan(board.id, taskList);
    userState.setActiveBoard(userId, board.id);
    drafts.updateStatus(draft.id, 'processed');
    const tasks = boards.getTasks(board.id);
    await ctx.reply(
      `\ud83d\udccb *Board created: ${stripMd(title)}*\n${tasks.length} steps extracted from tutorial`,
      { parse_mode: 'Markdown', ...kb.boardView(board.id, tasks, 'planning') }
    );
  }

  /**
   * Auto-execute all pending tasks in a board sequentially.
   * Each task generates a standalone script/module.
   * The last task integrates all previous outputs.
   * Checks shared.runningBoards between tasks for pause support.
   */
  async function executeBoard(ctx, userId, boardId) {
    const allTasks = boards.getTasks(boardId);
    const completedOutputs = [];

    // Collect already-completed outputs for context
    for (const t of allTasks) {
      if (t.status === 'done' && t.execution_log) {
        completedOutputs.push({ title: t.title, output: t.execution_log });
      }
    }

    for (let i = 0; i < allTasks.length; i++) {
      const task = allTasks[i];
      if (task.status === 'done') continue;

      // Check if paused between tasks
      if (!shared.runningBoards || shared.runningBoards.get(userId) !== boardId) {
        boards.updateStatus(boardId, 'planning');
        const tasks = boards.getTasks(boardId);
        await ctx.reply('Board paused:', kb.boardView(boardId, tasks, 'planning'));
        return;
      }

      boards.setTaskStatus(task.id, 'in_progress');
      const progress = `[${completedOutputs.length + 1}/${allTasks.length}]`;
      await safeSend(ctx, `\ud83d\udd35 *${progress} Executing:* ${task.title}\n\n_Generating script/module..._`);

      try {
        const isLastTask = !allTasks.slice(i + 1).some(t => t.status !== 'done');

        let systemPrompt;
        if (isLastTask && completedOutputs.length > 0) {
          // Integration task — combine all previous scripts
          const prevSummary = completedOutputs.map((o, idx) =>
            `--- Module ${idx + 1}: ${o.title} ---\n${o.output.substring(0, 2000)}`
          ).join('\n\n');

          systemPrompt = `You are executing the FINAL integration task of a project. Previous tasks produced these modules:

${prevSummary}

Your job: ${task.title}
Plan: ${task.description || 'Integrate all modules into a working system.'}
${task.input_answer ? `User Input: ${task.input_answer}` : ''}

Produce a COMPLETE integration script that imports/uses all previous modules. Include:
- All imports and connections between modules
- Configuration and setup
- Main entry point
- Error handling
Make it production-ready and runnable.`;
        } else {
          // Regular task — generate standalone script/module
          const prevContext = completedOutputs.length > 0
            ? `\n\nCompleted modules so far:\n${completedOutputs.map(o => `- ${o.title}`).join('\n')}`
            : '';

          systemPrompt = `You are executing a project task. Generate a COMPLETE, STANDALONE script or module.

Task: ${task.title}
Execution Plan: ${task.description || 'No plan \u2014 use your best judgment.'}
${task.input_answer ? `User Input: ${task.input_answer}` : ''}
${task.output_type && task.output_type !== 'text' ? `Expected output type: ${task.output_type}` : ''}${prevContext}

Requirements:
- Generate a complete, self-contained script/module
- Include all necessary imports and exports
- Add error handling
- Make it production-ready`;
        }

        const result = await llm.chat(userId, [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Execute: ${task.title}` }
        ]);

        boards.updateTask(task.id, { execution_log: result.text, status: 'done' });
        completedOutputs.push({ title: task.title, output: result.text });

        let output = result.text;
        if (output.length > 3000) output = output.substring(0, 3000) + '\n...(truncated)';
        await safeSend(ctx, `\u2705 *${progress} Done:* ${task.title}\n\n${output}\n\n_via ${result.provider}_`);
      } catch (err) {
        boards.setTaskStatus(task.id, 'pending');
        await safeSend(ctx, `\u274c *Failed:* ${task.title}\n${err.message}\n\n\u23f8 Execution paused. Fix and retry.`);
        shared.runningBoards?.delete(userId);
        boards.updateStatus(boardId, 'planning');
        const tasks = boards.getTasks(boardId);
        await ctx.reply('Board status:', kb.boardView(boardId, tasks, 'planning'));
        return;
      }
    }

    // Final status update
    const finalTasks = boards.getTasks(boardId);
    const allDone = finalTasks.every(t => t.status === 'done');

    if (allDone) {
      boards.updateStatus(boardId, 'completed');
      await safeSend(ctx, `\ud83c\udf89 *Project completed!* All ${finalTasks.length} tasks done.\n\nAll scripts generated and integrated.`);
    } else {
      boards.updateStatus(boardId, 'planning');
    }

    const board = boards.get(boardId);
    await ctx.reply('Board status:', kb.boardView(boardId, finalTasks, board.status));
  }

  return {
    workflowKeyboard, db_setActiveWorkflow, getActiveWorkflow,
    showBoard, showBoardEdit, showProviders, showProvidersEdit,
    showDrafts, showDraftsEdit, createTutorialBoard, executeBoard,
  };
}
