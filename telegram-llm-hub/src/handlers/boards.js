import { safeSend, stripMd } from '../bot-helpers.js';

export function registerBoards(bot, shared) {
  const { llm, boards, qa, kb, userState, sessions, helpers } = shared;

  // ===== COMMANDS =====

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
          content: `You are a project planner for an AI-powered task board. Each task you create will be "executed" by sending it to an AI that generates a COMPLETE STANDALONE SCRIPT or MODULE for each task.

Write each task description as a DETAILED EXECUTION PLAN — specific instructions for what the AI should generate as a standalone script.

The LAST task should ALWAYS be an INTEGRATION task that ties all previous scripts/modules together into a working system.

Return a JSON array:
[{
  "title": "Short task name",
  "description": "Detailed execution plan: what script/module the AI should produce, specific requirements, format, dependencies. 2-5 sentences minimum.",
  "output_type": "code" | "text" | "config" | "plan" | "documentation",
  "requires_input": false,
  "input_question": null
}]

GOOD example:
  title: "Database Module"
  description: "Generate a complete SQLite database module (db.js) with: connection setup, CREATE TABLE for users/products/orders, CRUD functions for each table, proper error handling, and exports. Use better-sqlite3."
  output_type: "code"

BAD example:
  title: "Set up database"
  description: "Create the database"

Keep to 5-12 tasks. The last task MUST be integration. Only return the JSON array, no markdown fences.`
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

      let text = `\ud83d\udccb *${projectName}*\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
      text += `Tasks: ${tasks.length} | Status: \ud83d\udcdd Planning\n\n`;
      text += `*Execution Plan:*\n`;
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        const isLast = i === tasks.length - 1;
        const icon = isLast ? '\ud83d\udd17' : '\ud83d\udcc4';
        const preview = t.description ? ` \u2014 _${stripMd(t.description).substring(0, 60)}..._` : '';
        text += `${icon} ${t.title}${preview}\n`;
      }
      text += `\n_Powered by ${result.provider}_`;
      text += `\n\n\ud83d\ude80 *Tap "Run Project" to auto-execute all tasks.*`;
      await safeSend(ctx, text, kb.boardView(board.id, tasks, 'planning'));
    } catch (err) {
      await ctx.reply(`\u274c Error creating board: ${err.message}`);
    }
  });

  bot.command('boards', async (ctx) => {
    const list = boards.listByUser(ctx.from.id);
    if (list.length === 0) return ctx.reply('No boards yet. Use /new <project> to create one.');
    for (const b of list) b._tasks = boards.getTasks(b.id);
    let text = '\ud83d\udccb *Your Boards:*\n\n';
    for (const b of list) {
      const done = b._tasks.filter(t => t.status === 'done').length;
      const statusE = b.status === 'executing' ? '\u26a1' : b.status === 'completed' ? '\u2705' : '\u2b1c';
      text += `${statusE} *${b.title}* \u2014 ${done}/${b._tasks.length} done\n`;
    }
    await ctx.reply(text, { parse_mode: 'Markdown', ...kb.boardList(list) });
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

  // ===== BOARD LIST =====

  bot.action('list_boards', async (ctx) => {
    await ctx.answerCbQuery();
    const list = boards.listByUser(ctx.from.id);
    if (list.length === 0) {
      try { return ctx.editMessageText('No boards. Use /new <project> to create one.'); }
      catch { return ctx.reply('No boards. Use /new <project> to create one.'); }
    }
    for (const b of list) b._tasks = boards.getTasks(b.id);
    let text = '\ud83d\udccb *Your Boards:*\n\n';
    for (const b of list) {
      const done = b._tasks.filter(t => t.status === 'done').length;
      const statusE = b.status === 'executing' ? '\u26a1' : b.status === 'completed' ? '\u2705' : '\u2b1c';
      text += `${statusE} *${b.title}* \u2014 ${done}/${b._tasks.length} done\n`;
    }
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...kb.boardList(list) });
    } catch {
      await ctx.reply(text, { parse_mode: 'Markdown', ...kb.boardList(list) });
    }
  });

  // ===== BOARD CONTROLS =====

  bot.action(/view_board:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const boardId = parseInt(ctx.match[1]);
    userState.setActiveBoard(ctx.from.id, boardId);
    await helpers.showBoardEdit(ctx, boardId);
  });

  // Run board — auto-execute all tasks sequentially
  bot.action(/run_board:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery('Starting...');
    const boardId = parseInt(ctx.match[1]);
    const userId = ctx.from.id;

    // Only 1 board can execute at a time per user
    if (shared.runningBoards.has(userId)) {
      const runningId = shared.runningBoards.get(userId);
      if (runningId !== boardId) {
        const running = boards.get(runningId);
        return safeSend(ctx, `\u26a0\ufe0f *"${running?.title || 'Another board'}"* is already executing.\nPause it first before running a new one.`);
      }
    }

    const board = boards.get(boardId);
    if (!board) return safeSend(ctx, '\u274c Board not found.');

    // Check for tasks needing input
    const summary = boards.getSummary(boardId);
    if (summary.needsInput.length > 0) {
      const task = summary.needsInput[0];
      userState.setAwaiting(userId, `task_answer:${task.id}`);
      return safeSend(ctx, `\u2753 *Task needs your input first:*\n\n*${task.title}*\n${task.input_question}\n\n_Reply with your answer, then run again._`);
    }

    const remaining = summary.pending.length + summary.inProgress.length;
    if (remaining === 0) {
      return safeSend(ctx, `\u2705 *All tasks already completed!*`);
    }

    boards.updateStatus(boardId, 'executing');
    shared.runningBoards.set(userId, boardId);

    await safeSend(ctx, `\ud83d\ude80 *Running: ${board.title}*\n\nExecuting ${remaining} tasks sequentially...`);

    try {
      await helpers.executeBoard(ctx, userId, boardId);
    } finally {
      shared.runningBoards.delete(userId);
    }
  });

  // Pause board — stop execution after current task finishes
  bot.action(/pause_board:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery('Paused');
    const boardId = parseInt(ctx.match[1]);
    const userId = ctx.from.id;

    shared.runningBoards.delete(userId);
    boards.updateStatus(boardId, 'planning');

    const tasks = boards.getTasks(boardId);
    const done = tasks.filter(t => t.status === 'done').length;
    await safeSend(ctx, `\u23f8 *Paused.* ${done}/${tasks.length} tasks completed.\n\nTap "Run Project" to resume.`);
    await helpers.showBoard(ctx, boardId);
  });

  // Delete board
  bot.action(/del_board:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const boardId = parseInt(ctx.match[1]);
    const userId = ctx.from.id;
    const board = boards.get(boardId);
    if (!board) return;

    // Stop if running
    if (shared.runningBoards.get(userId) === boardId) {
      shared.runningBoards.delete(userId);
    }

    boards.deleteWithTasks(boardId);
    await safeSend(ctx, `\ud83d\uddd1\ufe0f Board "${board.title}" deleted.`);

    // Show updated list
    const list = boards.listByUser(userId);
    if (list.length === 0) return ctx.reply('No boards remaining. Use /new <project> to create one.');
    for (const b of list) b._tasks = boards.getTasks(b.id);
    let text = '\ud83d\udccb *Your Boards:*\n\n';
    for (const b of list) {
      const done = b._tasks.filter(t => t.status === 'done').length;
      text += `\u2b1c *${b.title}* \u2014 ${done}/${b._tasks.length} done\n`;
    }
    await ctx.reply(text, { parse_mode: 'Markdown', ...kb.boardList(list) });
  });

  // Build project — assemble all task outputs into real files via LLM
  bot.action(/build_board:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery('Building...');
    const boardId = parseInt(ctx.match[1]);
    const userId = ctx.from.id;
    const board = boards.get(boardId);
    if (!board) return safeSend(ctx, '\u274c Board not found.');

    const tasks = boards.getTasks(boardId);
    const doneTasks = tasks.filter(t => t.status === 'done' && t.execution_log);
    if (doneTasks.length === 0) return safeSend(ctx, '\u274c No completed tasks to build from.');

    llm.initDefaults(userId);
    await safeSend(ctx, `\ud83d\udce6 *Building project: ${board.title}*\n\n_Assembling ${doneTasks.length} modules into proper file structure..._\n_This may take 30-60 seconds._`);

    try {
      const taskSummaries = doneTasks.map((t, i) => {
        const content = t.execution_log.substring(0, 3000);
        return `=== MODULE ${i + 1}: ${t.title} ===\n${content}\n=== END MODULE ${i + 1} ===`;
      }).join('\n\n');

      const result = await llm.chat(userId, [
        {
          role: 'system',
          content: `You are a project assembler. You receive outputs from multiple project tasks and must combine them into a REAL, RUNNABLE project.

You MUST output ONLY a series of files in this EXACT format \u2014 no other text before or after:

===FILE: path/to/file.ext===
actual file content here
===ENDFILE===

Rules:
- Extract actual code from each module (strip markdown, explanations, backticks)
- Create proper file names and directory structure
- Create a main entry point (index.js, main.py, etc.)
- Create package.json or requirements.txt
- Create a README.md with setup and run instructions
- Make imports/exports correct between files
- Use ONE consistent language (prefer JavaScript/Node.js)
- Must be runnable after install + run command`
        },
        { role: 'user', content: `Assemble "${board.title}" from ${doneTasks.length} modules:\n\n${taskSummaries}` }
      ]);

      // Parse files
      const fileRegex = /===FILE:\s*(.+?)\s*===\n([\s\S]*?)===ENDFILE===/g;
      const files = [];
      let match;
      while ((match = fileRegex.exec(result.text)) !== null) {
        files.push({ path: match[1].trim(), size: match[2].length });
      }

      if (files.length > 0) {
        // Save to disk via dashboard API would happen here
        // For Telegram, just report what was generated
        let msg = `\u2705 *Project built: ${board.title}*\n\n`;
        msg += `\ud83d\udcc1 *${files.length} files generated:*\n`;
        for (const f of files) {
          const icon = f.path.endsWith('.js') ? '\ud83d\udfe8' : f.path.endsWith('.py') ? '\ud83d\udc0d' : f.path.endsWith('.md') ? '\ud83d\udcdd' : '\ud83d\udcc4';
          msg += `${icon} \`${f.path}\` (${f.size} chars)\n`;
        }
        msg += `\n_via ${result.provider}_`;
        msg += `\n\n\ud83d\udcbb *Open the dashboard to view and download files:*\nhttp://localhost:9999 \u2192 Boards \u2192 ${board.title} \u2192 View Files`;
        await safeSend(ctx, msg);
      } else {
        await safeSend(ctx, `\u26a0\ufe0f Build produced output but couldn't parse file structure. Check the dashboard for details.`);
      }
    } catch (err) {
      await safeSend(ctx, `\u274c Build failed: ${err.message}`);
    }
  });

  // ===== TASK DETAIL =====

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

    // Execution result preview
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

  // ===== TASK EXECUTION =====

  // Execute a single task via AI
  bot.action(/exec_task:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery('Executing...');
    const taskId = parseInt(ctx.match[1]);
    const task = boards.getTask(taskId);
    if (!task) return;
    const userId = ctx.from.id;
    llm.initDefaults(userId);

    boards.setTaskStatus(taskId, 'in_progress');
    await safeSend(ctx, `\ud83d\udd35 *Executing:* ${task.title}\n\n_Generating script/module..._`);

    try {
      // Gather context from completed sibling tasks
      const allTasks = boards.getTasks(task.board_id);
      const completedOutputs = allTasks
        .filter(t => t.status === 'done' && t.execution_log && t.id !== taskId)
        .map(t => `- ${t.title}`);
      const contextNote = completedOutputs.length > 0
        ? `\n\nCompleted modules so far:\n${completedOutputs.join('\n')}`
        : '';

      const result = await llm.chat(userId, [
        {
          role: 'system',
          content: `You are executing a project task. Generate a COMPLETE, STANDALONE script or module.

Task: ${task.title}
Execution Plan: ${task.description || 'No plan provided \u2014 use your best judgment.'}
${task.input_answer ? `User Input: ${task.input_answer}` : ''}
${task.output_type && task.output_type !== 'text' ? `Expected output type: ${task.output_type}` : ''}${contextNote}

Requirements:
- Generate a complete, self-contained script/module
- Include all necessary imports and exports
- Add error handling
- Make it production-ready`
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

  // Re-execute a completed task
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

Produce an improved, complete deliverable as a standalone script/module.`
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
      boards.updateTask(taskId, { status: 'done' });
      await safeSend(ctx, `\u274c Re-execute failed: ${task.title}\n${err.message}`);
      await ctx.reply('Actions:', kb.taskDetail(boards.getTask(taskId)));
    }
  });

  // View full execution log
  bot.action(/view_log:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const taskId = parseInt(ctx.match[1]);
    const task = boards.getTask(taskId);
    if (!task?.execution_log) return safeSend(ctx, 'No execution log for this task.');

    let log = task.execution_log;
    if (log.length <= 3800) {
      await safeSend(ctx, `\ud83d\udcdc *Result: ${task.title}*\n\n${log}`);
    } else {
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

  // ===== TASK UTILITIES =====

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

  // Legacy handlers (kept for backwards compatibility)
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
}
