import db from './db.js';

function parse(row) {
  if (!row) return null;
  row.keypoints = JSON.parse(row.keypoints || '[]');
  row.chat_history = JSON.parse(row.chat_history || '[]');
  return row;
}

export const projectManager = {
  create(userId, title, description, techStack, keypoints, runCmd, installCmd) {
    const result = db.prepare(
      'INSERT INTO gen_projects (user_id, title, description, tech_stack, keypoints, run_command, install_command) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(userId, title, description || '', techStack || 'nodejs', JSON.stringify(keypoints || []), runCmd || '', installCmd || '');
    return this.get(result.lastInsertRowid);
  },

  get(id) {
    return parse(db.prepare('SELECT * FROM gen_projects WHERE id = ?').get(id));
  },

  listByUser(userId) {
    return db.prepare('SELECT * FROM gen_projects WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId).map(r => parse(r));
  },

  update(id, fields) {
    const sets = [];
    const vals = [];
    for (const [key, val] of Object.entries(fields)) {
      sets.push(`${key} = ?`);
      vals.push(typeof val === 'object' ? JSON.stringify(val) : val);
    }
    if (sets.length === 0) return;
    vals.push(id);
    db.prepare(`UPDATE gen_projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  },

  addChat(id, role, content) {
    const proj = this.get(id);
    if (!proj) return;
    const history = proj.chat_history;
    history.push({ role, content, ts: Date.now() });
    if (history.length > 50) history.splice(0, history.length - 50);
    db.prepare('UPDATE gen_projects SET chat_history = ? WHERE id = ?')
      .run(JSON.stringify(history), id);
  },

  delete(id) {
    db.prepare('DELETE FROM gen_projects WHERE id = ?').run(id);
  },
};
