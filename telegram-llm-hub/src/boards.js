import db from './db.js';

export const boards = {
  create(userId, title, description = '', sessionId = null) {
    const result = db.prepare(
      'INSERT INTO boards (user_id, session_id, title, description) VALUES (?, ?, ?, ?)'
    ).run(userId, sessionId, title, description);
    return this.get(result.lastInsertRowid);
  },

  get(boardId) {
    return db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId);
  },

  listByUser(userId) {
    return db.prepare('SELECT * FROM boards WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  },

  updateStatus(boardId, status) {
    db.prepare('UPDATE boards SET status = ? WHERE id = ?').run(status, boardId);
  },

  delete(boardId) {
    db.prepare('DELETE FROM boards WHERE id = ?').run(boardId);
  },

  // --- Task management ---
  addTask(boardId, title, description = '', position = null) {
    if (position === null) {
      const max = db.prepare('SELECT MAX(position) as m FROM tasks WHERE board_id = ?').get(boardId);
      position = (max?.m ?? -1) + 1;
    }
    const result = db.prepare(
      'INSERT INTO tasks (board_id, title, description, position) VALUES (?, ?, ?, ?)'
    ).run(boardId, title, description, position);
    return this.getTask(result.lastInsertRowid);
  },

  getTask(taskId) {
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  },

  getTasks(boardId) {
    return db.prepare('SELECT * FROM tasks WHERE board_id = ? ORDER BY position ASC').all(boardId);
  },

  getTasksByStatus(boardId, status) {
    return db.prepare('SELECT * FROM tasks WHERE board_id = ? AND status = ? ORDER BY position ASC').all(boardId, status);
  },

  updateTask(taskId, updates) {
    const sets = [];
    const vals = [];
    for (const [key, val] of Object.entries(updates)) {
      sets.push(`${key} = ?`);
      vals.push(val);
    }
    if (sets.length === 0) return;
    vals.push(taskId);
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  },

  setTaskStatus(taskId, status) {
    db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, taskId);
  },

  setTaskInput(taskId, question, answer = null) {
    db.prepare('UPDATE tasks SET requires_input = 1, input_question = ?, input_answer = ? WHERE id = ?')
      .run(question, answer, taskId);
  },

  answerTaskInput(taskId, answer) {
    db.prepare('UPDATE tasks SET input_answer = ? WHERE id = ?').run(answer, taskId);
  },

  setTaskQA(taskId, status, result = null) {
    db.prepare('UPDATE tasks SET qa_status = ?, qa_result = ? WHERE id = ?').run(status, result, taskId);
  },

  setTaskTools(taskId, tools) {
    const toolsJson = JSON.stringify(tools);
    db.prepare('UPDATE tasks SET tools_needed = ? WHERE id = ?').run(toolsJson, taskId);
  },

  deleteTask(taskId) {
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  },

  // Move task up or down
  reorderTask(taskId, direction) {
    const task = this.getTask(taskId);
    if (!task) return;

    const tasks = this.getTasks(task.board_id);
    const idx = tasks.findIndex(t => t.id === taskId);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= tasks.length) return;

    const tx = db.transaction(() => {
      db.prepare('UPDATE tasks SET position = ? WHERE id = ?').run(tasks[swapIdx].position, tasks[idx].id);
      db.prepare('UPDATE tasks SET position = ? WHERE id = ?').run(tasks[idx].position, tasks[swapIdx].id);
    });
    tx();
  },

  // Bulk add tasks from LLM-generated plan
  addTasksFromPlan(boardId, taskList) {
    const tx = db.transaction(() => {
      for (let i = 0; i < taskList.length; i++) {
        const t = taskList[i];
        const result = db.prepare(
          'INSERT INTO tasks (board_id, title, description, position, requires_input, input_question, tools_needed) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(boardId, t.title, t.description || '', i, t.requires_input ? 1 : 0, t.input_question || null, t.tools_needed ? JSON.stringify(t.tools_needed) : null);
      }
    });
    tx();
  },

  // Get board summary for display
  getSummary(boardId) {
    const board = this.get(boardId);
    if (!board) return null;
    const tasks = this.getTasks(boardId);

    const pending = tasks.filter(t => t.status === 'pending');
    const inProgress = tasks.filter(t => t.status === 'in_progress');
    const done = tasks.filter(t => t.status === 'done');
    const qaPass = tasks.filter(t => t.qa_status === 'pass');
    const qaFail = tasks.filter(t => t.qa_status === 'fail');
    const needsInput = tasks.filter(t => t.requires_input && !t.input_answer);

    return { board, tasks, pending, inProgress, done, qaPass, qaFail, needsInput };
  },

  // Check if all tasks are ready for execution
  isReadyForExecution(boardId) {
    const tasks = this.getTasks(boardId);
    const needsInput = tasks.filter(t => t.requires_input && !t.input_answer);
    return needsInput.length === 0 && tasks.length > 0;
  },

  // Get next pending task
  getNextPendingTask(boardId) {
    return db.prepare(
      'SELECT * FROM tasks WHERE board_id = ? AND status = ? ORDER BY position ASC LIMIT 1'
    ).get(boardId, 'pending');
  },
};
