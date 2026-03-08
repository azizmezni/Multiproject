import db from './db.js';

export const settings = {
  get(userId) {
    const row = db.prepare('SELECT config FROM settings WHERE user_id = ?').get(userId);
    if (!row) return {};
    try { return JSON.parse(row.config); } catch { return {}; }
  },

  set(userId, config) {
    const json = JSON.stringify(config);
    db.prepare(`
      INSERT INTO settings (user_id, config) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET config = ?
    `).run(userId, json, json);
  },

  update(userId, key, value) {
    const config = this.get(userId);
    config[key] = value;
    this.set(userId, config);
  },

  getValue(userId, key, defaultVal = null) {
    const config = this.get(userId);
    return config[key] ?? defaultVal;
  },

  delete(userId, key) {
    const config = this.get(userId);
    delete config[key];
    this.set(userId, config);
  },
};
