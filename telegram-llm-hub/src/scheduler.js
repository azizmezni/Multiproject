import db from './db.js';
import { workflows } from './workflows.js';

// Simple cron parser supporting: minute hour dayOfMonth month dayOfWeek
function parseCron(expression) {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  return {
    minute: parts[0],
    hour: parts[1],
    dayOfMonth: parts[2],
    month: parts[3],
    dayOfWeek: parts[4],
  };
}

function matchesCronField(field, value) {
  if (field === '*') return true;
  // Handle ranges: 1-5
  if (field.includes('-')) {
    const [start, end] = field.split('-').map(Number);
    return value >= start && value <= end;
  }
  // Handle lists: 1,3,5
  if (field.includes(',')) {
    return field.split(',').map(Number).includes(value);
  }
  // Handle step: */5
  if (field.startsWith('*/')) {
    const step = parseInt(field.substring(2));
    return step > 0 && value % step === 0;
  }
  return parseInt(field) === value;
}

function shouldRunNow(cronExpr) {
  const cron = parseCron(cronExpr);
  if (!cron) return false;
  const now = new Date();
  return (
    matchesCronField(cron.minute, now.getMinutes()) &&
    matchesCronField(cron.hour, now.getHours()) &&
    matchesCronField(cron.dayOfMonth, now.getDate()) &&
    matchesCronField(cron.month, now.getMonth() + 1) &&
    matchesCronField(cron.dayOfWeek, now.getDay())
  );
}

function getNextRunTime(cronExpr) {
  const cron = parseCron(cronExpr);
  if (!cron) return null;
  const now = new Date();
  // Simple forward scan: check each minute for up to 7 days
  const check = new Date(now);
  check.setSeconds(0, 0);
  check.setMinutes(check.getMinutes() + 1);
  const maxCheck = 7 * 24 * 60; // 7 days of minutes
  for (let i = 0; i < maxCheck; i++) {
    if (
      matchesCronField(cron.minute, check.getMinutes()) &&
      matchesCronField(cron.hour, check.getHours()) &&
      matchesCronField(cron.dayOfMonth, check.getDate()) &&
      matchesCronField(cron.month, check.getMonth() + 1) &&
      matchesCronField(cron.dayOfWeek, check.getDay())
    ) {
      return check;
    }
    check.setMinutes(check.getMinutes() + 1);
  }
  return null;
}

// Describe cron expression in human-readable format
function describeCron(expr) {
  const cron = parseCron(expr);
  if (!cron) return expr;
  const parts = [];
  if (cron.minute === '0' && cron.hour !== '*') {
    const h = parseInt(cron.hour);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hour12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
    parts.push(`at ${hour12}:00 ${ampm}`);
  } else if (cron.minute !== '*' && cron.hour !== '*') {
    parts.push(`at ${cron.hour}:${cron.minute.padStart(2, '0')}`);
  } else if (cron.minute.startsWith('*/')) {
    parts.push(`every ${cron.minute.substring(2)} minutes`);
  }
  const days = { '1': 'Mon', '2': 'Tue', '3': 'Wed', '4': 'Thu', '5': 'Fri', '6': 'Sat', '0': 'Sun' };
  if (cron.dayOfWeek === '1-5') parts.push('weekdays');
  else if (cron.dayOfWeek === '0,6') parts.push('weekends');
  else if (cron.dayOfWeek !== '*') {
    const dayNames = cron.dayOfWeek.split(',').map(d => days[d] || d).join(', ');
    parts.push(`on ${dayNames}`);
  }
  if (cron.dayOfMonth !== '*') parts.push(`day ${cron.dayOfMonth}`);
  if (cron.month !== '*') parts.push(`month ${cron.month}`);
  return parts.join(', ') || 'custom schedule';
}

export const scheduler = {
  _interval: null,
  _sseClients: new Map(), // workflowId -> Set of response objects

  // Validate cron expression format
  validateCron(expression) {
    const cron = parseCron(expression);
    if (!cron) return 'Invalid cron format: expected 5 fields (minute hour dayOfMonth month dayOfWeek)';
    const ranges = { minute: [0, 59], hour: [0, 23], dayOfMonth: [1, 31], month: [1, 12], dayOfWeek: [0, 6] };
    for (const [field, [min, max]] of Object.entries(ranges)) {
      const val = cron[field];
      if (val === '*') continue;
      // Check each token (handles lists like "1,3,5")
      const tokens = val.includes(',') ? val.split(',') : [val];
      for (const token of tokens) {
        if (token.startsWith('*/')) {
          const step = parseInt(token.substring(2));
          if (isNaN(step) || step <= 0) return `Invalid step in ${field}: ${token}`;
        } else if (token.includes('-')) {
          const [s, e] = token.split('-').map(Number);
          if (isNaN(s) || isNaN(e) || s < min || e > max || s > e) return `Invalid range in ${field}: ${token}`;
        } else {
          const num = parseInt(token);
          if (isNaN(num) || num < min || num > max) return `Invalid value in ${field}: ${token} (expected ${min}-${max})`;
        }
      }
    }
    return null; // valid
  },

  // CRUD
  create(workflowId, userId, cronExpression) {
    const error = this.validateCron(cronExpression);
    if (error) throw new Error(error);
    const nextRun = getNextRunTime(cronExpression);
    const result = db.prepare(
      'INSERT INTO workflow_schedules (workflow_id, user_id, cron_expression, next_run_at) VALUES (?, ?, ?, ?)'
    ).run(workflowId, userId, cronExpression, nextRun?.toISOString() || null);
    return this.get(result.lastInsertRowid);
  },

  get(scheduleId) {
    return db.prepare('SELECT * FROM workflow_schedules WHERE id = ?').get(scheduleId);
  },

  getByWorkflow(workflowId) {
    return db.prepare('SELECT * FROM workflow_schedules WHERE workflow_id = ?').get(workflowId);
  },

  listAll() {
    return db.prepare('SELECT ws.*, w.title as workflow_title FROM workflow_schedules ws JOIN workflows w ON ws.workflow_id = w.id ORDER BY ws.created_at DESC').all();
  },

  listByUser(userId) {
    return db.prepare('SELECT ws.*, w.title as workflow_title FROM workflow_schedules ws JOIN workflows w ON ws.workflow_id = w.id WHERE ws.user_id = ? ORDER BY ws.created_at DESC').all(userId);
  },

  update(scheduleId, updates) {
    const allowed = ['cron_expression', 'enabled', 'last_run_at', 'next_run_at', 'run_count', 'last_status', 'last_error'];
    const sets = [];
    const vals = [];
    for (const [key, val] of Object.entries(updates)) {
      if (!allowed.includes(key)) continue;
      sets.push(`${key} = ?`);
      vals.push(val);
    }
    if (sets.length === 0) return;
    vals.push(scheduleId);
    db.prepare(`UPDATE workflow_schedules SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  },

  delete(scheduleId) {
    db.prepare('DELETE FROM workflow_schedules WHERE id = ?').run(scheduleId);
  },

  toggle(scheduleId) {
    const schedule = this.get(scheduleId);
    if (!schedule) return;
    const newEnabled = schedule.enabled ? 0 : 1;
    this.update(scheduleId, { enabled: newEnabled });
    if (newEnabled) {
      const nextRun = getNextRunTime(schedule.cron_expression);
      this.update(scheduleId, { next_run_at: nextRun?.toISOString() || null });
    }
  },

  // Run history
  addRunHistory(workflowId, userId, triggerType = 'manual') {
    const result = db.prepare(
      'INSERT INTO workflow_run_history (workflow_id, user_id, trigger_type) VALUES (?, ?, ?)'
    ).run(workflowId, userId, triggerType);
    return result.lastInsertRowid;
  },

  updateRunHistory(runId, updates) {
    const allowed = ['status', 'finished_at', 'node_count', 'passed_count', 'failed_count', 'results', 'error'];
    const sets = [];
    const vals = [];
    for (const [key, val] of Object.entries(updates)) {
      if (!allowed.includes(key)) continue;
      sets.push(`${key} = ?`);
      vals.push(val);
    }
    if (sets.length === 0) return;
    vals.push(runId);
    db.prepare(`UPDATE workflow_run_history SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  },

  getRunHistory(workflowId, limit = 20) {
    return db.prepare(
      'SELECT * FROM workflow_run_history WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?'
    ).all(workflowId, limit);
  },

  // SSE helpers
  addSSEClient(workflowId, res) {
    if (!this._sseClients.has(workflowId)) this._sseClients.set(workflowId, new Set());
    this._sseClients.get(workflowId).add(res);
    res.on('close', () => {
      this._sseClients.get(workflowId)?.delete(res);
    });
  },

  sendSSE(workflowId, event, data) {
    const clients = this._sseClients.get(workflowId);
    if (!clients) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      try { client.write(msg); } catch { clients.delete(client); }
    }
  },

  // Execute workflow with run tracking + SSE
  async executeWithTracking(userId, workflowId, triggerType = 'manual') {
    const runId = this.addRunHistory(workflowId, userId, triggerType);
    this.sendSSE(workflowId, 'start', { runId, triggerType });

    try {
      const nodeResults = await workflows.executeWorkflow(userId, workflowId, async (node, status, result) => {
        this.sendSSE(workflowId, 'node', {
          nodeId: node.id, name: node.name, type: node.node_type, status,
          result: result ? JSON.stringify(result).substring(0, 500) : null,
        });
      });

      const nodes = workflows.getNodes(workflowId);
      const passed = nodes.filter(n => n.status === 'done').length;
      const failed = nodes.filter(n => n.status === 'error').length;

      this.updateRunHistory(runId, {
        status: 'completed',
        finished_at: new Date().toISOString(),
        node_count: nodes.length,
        passed_count: passed,
        failed_count: failed,
      });

      this.sendSSE(workflowId, 'complete', { runId, passed, failed, total: nodes.length });
      return { runId, nodeResults, passed, failed };
    } catch (err) {
      this.updateRunHistory(runId, {
        status: 'failed',
        finished_at: new Date().toISOString(),
        error: err.message,
      });
      this.sendSSE(workflowId, 'error', { runId, error: err.message });
      throw err;
    }
  },

  // Scheduler tick - runs every minute
  async tick() {
    const schedules = db.prepare(
      "SELECT * FROM workflow_schedules WHERE enabled = 1"
    ).all();

    for (const schedule of schedules) {
      if (!shouldRunNow(schedule.cron_expression)) continue;

      // Debounce: skip if last run was less than 50 seconds ago
      if (schedule.last_run_at) {
        const lastRun = new Date(schedule.last_run_at);
        if (Date.now() - lastRun.getTime() < 50000) continue;
      }

      console.log(`⏰ Scheduler: running workflow ${schedule.workflow_id} (cron: ${schedule.cron_expression})`);

      const nextRun = getNextRunTime(schedule.cron_expression);
      this.update(schedule.id, {
        last_run_at: new Date().toISOString(),
        next_run_at: nextRun?.toISOString() || null,
        run_count: schedule.run_count + 1,
      });

      try {
        await this.executeWithTracking(schedule.user_id, schedule.workflow_id, 'schedule');
        this.update(schedule.id, { last_status: 'completed', last_error: null });
      } catch (err) {
        console.error(`⏰ Scheduler error for workflow ${schedule.workflow_id}:`, err.message);
        this.update(schedule.id, { last_status: 'failed', last_error: err.message });
      }
    }
  },

  // Start the scheduler (runs every 60 seconds)
  start() {
    if (this._interval) return;
    console.log('⏰ Workflow scheduler started');
    this._interval = setInterval(() => this.tick(), 60000);
  },

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  },

  describeCron,
  getNextRunTime,
  parseCron,
};
