import { safeSend, stripMd } from '../bot-helpers.js';

export function registerBoards(bot, shared) {
  const { llm, boards, qa, kb, userState, sessions, helpers } = shared;

  bot.command('new', async (ctx) => {
    const userId = ctx.from.id;
    llm.initDefaults(userId);
    const projectName = ctx.message.text.replace('/new', '').trim();
    if (!projectName) return ctx.reply('Usage: /new <project name>\nExample: /new E-commerce Website');

    await ctx.reply(`\ud83d\udcdd Creating project board for: *${projectName}*\n\nAnalyzing and generating execution plan...`, { parse_mode: 'Markdown' });

    try {
      const result = await llm.chat(userId, [
        {
          role: 'system',
          content: `You are a project planner for an AI-powered task board. Each task you create will be "executed" by sending it to an AI with the task title and description as instructions. The AI will generate text output (code, documentation, configs, plans, etc.) for each task.

Write each task description as a DETAILED EXECUTION PLAN — specific instructions for what the AI should generate when this task runs.

Return a JSON array:
[{
  "title": "Short task name",
  "description": "Detailed execution plan: what the AI should produce, specific requirements, format, expected output. 2-5 sentences minimum.",
  "output_type": "code" | "text" | "config" | "plan" | "documentation",
  "requires_input": false,
  "input_question": null
}]

GOOD example:
  title: "Generate database schema"
  description: "Generate a complete SQLite CREATE TABLE schema for an e-commerce app. Include tables: users (id, email, password_hash, created_at), products (id, name, price, description, stock, category), orders (id, user_id FK, total, status, created_at), order_items (id, order_id FK, product_id FK, quantity, price). Add indexes on foreign keys and email. Output as a single SQL script."
  output_type: "code"

BAD example:
  title: "Set up database"
  description: "Create the database"

Keep to 5-12 tasks. Only return the JSON array, no markdown fences.`
        },
        { role: 'user', content: `Create an execution plan for: ${projectName}` }
      ]);

      let taskList;
      try {
        const cleaned = result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        taskList = JSON.parse(cleaned);
      } catch {
        taskList = [{ title: 'Review project requirements', description: result.text, requires_input: true, input_question: 'Please clarify the project scope' }];
      }

      const session = sessions.create(userId, `Board: ${projectName}`);
      const board = boards.create(userId, projectName, `Auto-generated board for ${projectName}`, session.id);
      boards.addTasksFromPlan(board.id, taskList);
      userState.setActiveBoard(userId, board.id);
      userState.setMode(userId, 'board');

      const tasks = boards.getTasks(board.id);
      const summary = boards.getSummary(board.id);

      let text = `\ud83d\udccb *${projectName}*\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      text += `Status: \ud83d\udcdd Planning | Tasks: ${tasks.length}\n`;
      if (summary.needsInput.length > 0) {
        text += `\n\u2753 *${summary.needsInput.length} tasks need your input*\n`;
      }
      text += `\n*Execution Plan:*\n`;
      for (const t of tasks) {
        const needsQ = (t.requires_input && !t.input_answer) ? ' \u2753' : '';
        const preview = t.description ? ` \u2014 _${stripMd(t.description).substring(0, 70)}..._` : '';
        text += `\u2b1c ${t.title}${needsQ}${preview}\n`;
      }
      text += `\n_Powered by ${result.provider} (${result.model})_`;
      text += `\n\n\u26a1 *Tap Execute All to run, or tap a task to execute individually.*`;
      await safeSend(ctx, text, kb.boardView(board.id, tasks, 'planning'));
    } catch (err) {
      await ctx.reply(`\u274c Error creating board: ${err.message}`);
    }
  });

  bot.command('boards', async (ctx) => {
    const list = boards.listByUser(ctx.from.id);
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
    const state = userState.get(ctx.from.id);
    if (!state.active_board_id) return ctx.reply('No active board. Use /boards to select one.');
    await helpers.showBoard(ctx, state.active_board_id);
  });

  bot.command('task', async (ctx) => {
    const userId = ctx.from.id;
    const desc = ctx.message.text.replace('/task', '').trim();
    if (!desc) return safeSend(ctx, '\u274c Usage: /task <description>\nAdds a task to your active board.');
    const state = userState.get(userId);
    if (!state.active_board_id) return safeSend(ctx, '\u274c No active board. Use /new <project> to create one.');
    try {
      boards.addTask(state.active_board_id, desc, '');
      const tasks = boards.getTasks(state.active_board_id);
      await safeSend(ctx, `\u2705 Task added! (${tasks.length} total)\nUse /board to view.`);
    } catch (err) {
      await safeSend(ctx, `\u274c ${err.message}`);
    }
  });

  bot.command('done', async (ctx) => {
    const idStr = ctx.message.text.split(/\s+/)[1];
    if (!idStr) return safeSend(ctx, '\u274c Usage: /done <task_id>');
    try {
      boards.setTaskStatus(parseInt(idStr), 'done');
      await safeSend(ctx, '\u2705 Task marked as done!');
    } catch (err) {
      await safeSend(ctx, `\u274c ${err.message}`);
    }
  });

  // --- Board callback queries ---
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
    await helpers.showBoardEdit(ctx, parseInt(ctx.match[1]));
  });

  bot.action(/exec_board:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const boardId = parseInt(ctx.match[1]);
    const summary = boards.getSummary(boardId);
    if (summary.needsInput.length > 0) {
      const task = summary.needsInput[0];
      userState.setAwaiting(ctx.from.id, `task_answer:${task.id}`);
      return ctx.editMessageText(
        `\u2753 *Task needs your input:*\n\n*${task.title}*\n${task.input_question}\n\n_Reply with your answer:_`,
        { parse_mode: 'Markdown' }
      );
    }
    boards.updateStatus(boardId, 'executing');
    await ctx.editMessageText(`\u26a1 *Executing board tasks...*`, { parse_mode: 'Markdown' });
    await helpers.executeBoard(ctx, ctx.from.id, boardId);
  });

  // --- Task detail with execution plan + results ---
  bot.action(/task_detail:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const task = boards.getTask(parseInt(ctx.match[1]));
    if (!task) return;

    const STATUS_LABELS = { pending: '\u2b1c Pending', in_progress: '\ud83d\udd35 In Progress', done: '\u2705 Done' };

    let text = `*Task #${task.id}: ${task.title}*\n`;
    text += `${STATUS_LABELS[task.status] || task.status}\n`;
    text += `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;

    // Execution plan (description)
    if (task.description) {
      text += `\n*Execution Plan:*\n${task.description}\n`;
    }

    // Q&A
    if (task.input_question) {
      text += `\n\u2753 *Question:* ${task.input_question}`;
      text += task.input_answer ? `\n\ud83d\udcac *Answer:* ${task.input_answer}\n` : '\n_Awaiting answer_\n';
    }

    // Execution result (the key missing piece!)
    if (task.execution_log) {
      let log = task.execution_log;
      if (log.length > 1500) log = log.substring(0, 1500) + '\n..._Use "View Result" for full output_';
      text += `\n*Execution Result:*\n${log}\n`;
    }

    // QA
    if (task.qa_status && task.qa_status !== 'pending') {
      const qaEmoji = task.qa_status === 'pass' ? '\u2705' : '\u274c';
      text += `\nQA: ${qaEmoji} ${task.qa_status}`;
    }

    if (text.length > 3900) text = text.substring(0, 3900) + '\n...(truncated)';
    await safeSend(ctx, text, kb.taskDetail(task));
  });

  // --- Execute a single task via AI ---
  bot.action(/exec_task:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery('Executing...');
    const taskId = parseInt(ctx.match[1]);
    const task = boards.getTask(taskId);
    if (!task) return;
    const userId = ctx.from.id;
    llm.initDefaults(userId);

    boards.setTaskStatus(taskId, 'in_progress');
    await safeSend(ctx, `\ud83d\udd35 *Executing:* ${task.title}\n\n_Processing with AI..._`);

    try {
      const result = await llm.chat(userId, [
        {
          role: 'system',
          content: `You are executing a project task. Produce the concrete deliverable described below.

Task: ${task.title}
Execution Plan: ${task.description || 'No plan provided — use your best judgment.'}
${task.input_answer ? `User Input: ${task.input_answer}` : ''}
${task.output_type && task.output_type !== 'text' ? `Expected output type: ${task.output_type}` : ''}

Generate the complete deliverable. Be thorough and detailed.`
        },
        { role: 'user', content: `Execute: ${task.title}` }
      ]);

      boards.updateTask(taskId, { execution_log: result.text, status: 'done' });

      let output = result.text;
      if (output.length > 3000) output = output.substring(0, 3000) + '\n...(truncated)';
      await safeSend(ctx, `\u2705 *Done:* ${task.title}\n\n${output}\n\n_via ${result.provider}_`);

      const updatedTask = boards.getTask(taskId);
      await ctx.reply('Task actions:', kb.taskDetail(updatedTask));
    } catch (err) {
      boards.setTaskStatus(taskId, 'pending');
      await safeSend(ctx, `\u274c Failed: ${task.title}\n${err.message}`);
      await ctx.reply('Retry:', kb.taskDetail(boards.getTask(taskId)));
    }
  });

  // --- Re-execute a completed task ---
  bot.action(/reexec_task:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery('Re-executing...');
    const taskId = parseInt(ctx.match[1]);
    const task = boards.getTask(taskId);
    if (!task) return;
    const userId = ctx.from.id;
    llm.initDefaults(userId);

    const prevLog = task.execution_log;
    boards.updateTask(taskId, { status: 'in_progress', qa_status: 'pending', qa_result: null });
    await safeSend(ctx, `\ud83d\udd04 *Re-executing:* ${task.title}\n\n_Improving previous result..._`);

    try {
      const result = await llm.chat(userId, [
        {
          role: 'system',
          content: `You are re-executing a project task. The previous result may need improvement.

Task: ${task.title}
Execution Plan: ${task.description || 'No plan provided.'}
${task.input_answer ? `User Input: ${task.input_answer}` : ''}
${prevLog ? `Previous result (improve on this):\n${prevLog.substring(0, 1500)}` : ''}

Produce an improved, complete deliverable.`
        },
        { role: 'user', content: `Re-execute and improve: ${task.title}` }
      ]);

      boards.updateTask(taskId, { execution_log: result.text, status: 'done' });

      let output = result.text;
      if (output.length > 3000) output = output.substring(0, 3000) + '\n...(truncated)';
      await safeSend(ctx, `\u2705 *Re-executed:* ${task.title}\n\n${output}\n\n_via ${result.provider}_`);

      const updatedTask = boards.getTask(taskId);
      await ctx.reply('Task actions:', kb.taskDetail(updatedTask));
    } catch (err) {
      boards.updateTask(taskId, { status: 'done' }); // keep done on failure
      await safeSend(ctx, `\u274c Re-execute failed: ${task.title}\n${err.message}`);
      await ctx.reply('Actions:', kb.taskDetail(boards.getTask(taskId)));
    }
  });

  // --- View full execution log ---
  bot.action(/view_log:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const taskId = parseInt(ctx.match[1]);
    const task = boards.getTask(taskId);
    if (!task?.execution_log) return safeSend(ctx, 'No execution log for this task.');

    let log = task.execution_log;
    if (log.length <= 3800) {
      await safeSend(ctx, `\ud83d\udcdc *Result: ${task.title}*\n\n${log}`);
    } else {
      // Send in chunks
      const chunks = [];
      while (log.length > 0) {
        const splitAt = log.lastIndexOf('\n', 3800) > 1900 ? log.lastIndexOf('\n', 3800) : 3800;
        chunks.push(log.substring(0, splitAt));
        log = log.substring(splitAt);
      }
      for (let i = 0; i < chunks.length; i++) {
        const header = i === 0 ? `\ud83d\udcdc *Result: ${task.title}* (${i + 1}/${chunks.length})\n\n` : '';
        await safeSend(ctx, `${header}${chunks[i]}`);
      }
    }
    await ctx.reply('Actions:', kb.taskDetail(task));
  });

  bot.action(/start_task:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery('Task started');
    const taskId = parseInt(ctx.match[1]);
    boards.setTaskStatus(taskId, 'in_progress');
    const task = boards.getTask(taskId);
    await helpers.showBoardEdit(ctx, task.board_id);
  });

  bot.action(/done_task:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery('Task completed');
    const taskId = parseInt(ctx.match[1]);
    boards.setTaskStatus(taskId, 'done');
    const task = boards.getTask(taskId);
    await helpers.showBoardEdit(ctx, task.board_id);
  });

  bot.action(/answer_task:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const taskId = parseInt(ctx.match[1]);
    const task = boards.getTask(taskId);
    userState.setAwaiting(ctx.from.id, `task_answer:${taskId}`);
    await ctx.editMessageText(`\u2753 *${task.title}*\n\n${task.input_question}\n\n_Send your answer:_`, { parse_mode: 'Markdown' });
  });

  bot.action(/discuss_task:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const taskId = parseInt(ctx.match[1]);
    const task = boards.getTask(taskId);
    userState.setAwaiting(ctx.from.id, `discuss_task:${taskId}`);
    await ctx.editMessageText(`\ud83d\udcac *Discussing: ${task.title}*\n\n${task.description}\n\n_Ask me anything about this task:_`, { parse_mode: 'Markdown' });
  });

  bot.action(/qa_task:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery('Running QA...');
    const taskId = parseInt(ctx.match[1]);
    const task = boards.getTask(taskId);
    await ctx.editMessageText(`\ud83e\uddea Running QA for: *${task.title}*...`, { parse_mode: 'Markdown' });
    const result = await qa.runTaskQA(ctx.from.id, taskId);
    const emoji = result.passed ? '\u2705' : '\u274c';
    let resultText = `${emoji} *QA Result for: ${task.title}*\n\n`;
    resultText += `Type: ${result.type || 'unknown'}\nPassed: ${result.passed ? 'Yes' : 'No'}\n`;
    if (result.notes) resultText += `Notes: ${result.notes}\n`;
    await safeSend(ctx, resultText, kb.taskDetail(boards.getTask(taskId)));
  });
}
