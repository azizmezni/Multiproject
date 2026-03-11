import { safeSend, stripMd } from '../bot-helpers.js';

export function registerBoards(bot, shared) {
  const { llm, boards, qa, kb, userState, sessions, helpers } = shared;

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

  bot.action(/task_detail:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const task = boards.getTask(parseInt(ctx.match[1]));
    if (!task) return;
    const qaInfo = task.qa_result ? `\nQA: ${task.qa_status}` : '';
    const tools = task.tools_needed ? `\nTools: ${task.tools_needed}` : '';
    const question = task.input_question ? `\n\u2753 Question: ${task.input_question}` : '';
    const answer = task.input_answer ? `\n\ud83d\udcac Answer: ${task.input_answer}` : '';
    await ctx.editMessageText(
      `*Task #${task.id}: ${task.title}*\n\n${task.description || 'No description'}\n\nStatus: ${task.status}${qaInfo}${tools}${question}${answer}`,
      { parse_mode: 'Markdown', ...kb.taskDetail(task) }
    );
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
    await ctx.reply(resultText, { parse_mode: 'Markdown', ...kb.taskDetail(boards.getTask(taskId)) });
  });
}
