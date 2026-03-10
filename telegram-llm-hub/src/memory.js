import db from './db.js';

export const memory = {
  // Store a memory
  set(userId, key, value, category = 'general') {
    const existing = db.prepare('SELECT id FROM memory WHERE user_id = ? AND key = ?').get(userId, key);
    if (existing) {
      db.prepare('UPDATE memory SET value = ?, category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(value, category, existing.id);
      return this.getById(existing.id);
    }
    const result = db.prepare('INSERT INTO memory (user_id, key, value, category) VALUES (?, ?, ?, ?)').run(userId, key, value, category);
    return this.getById(result.lastInsertRowid);
  },

  getById(memoryId) {
    return db.prepare('SELECT * FROM memory WHERE id = ?').get(memoryId);
  },

  // Get by key
  get(userId, key) {
    return db.prepare('SELECT * FROM memory WHERE user_id = ? AND key = ?').get(userId, key);
  },

  // List all memories for user
  list(userId, category = null) {
    if (category && category !== 'all') {
      return db.prepare('SELECT * FROM memory WHERE user_id = ? AND category = ? ORDER BY updated_at DESC').all(userId, category);
    }
    return db.prepare('SELECT * FROM memory WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
  },

  // Search memories by keyword
  search(userId, query) {
    const q = `%${query}%`;
    return db.prepare('SELECT * FROM memory WHERE user_id = ? AND (key LIKE ? OR value LIKE ?) ORDER BY updated_at DESC').all(userId, q, q);
  },

  // Delete a memory
  delete(userId, memoryId) {
    return db.prepare('DELETE FROM memory WHERE id = ? AND user_id = ?').run(memoryId, userId);
  },

  // Get relevant memories for a prompt (simple keyword matching)
  getRelevant(userId, prompt, limit = 5) {
    const words = prompt.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (!words.length) return [];

    const all = this.list(userId);
    // Score each memory by keyword overlap
    const scored = all.map(m => {
      const text = `${m.key} ${m.value}`.toLowerCase();
      let score = 0;
      for (const word of words) {
        if (text.includes(word)) score++;
      }
      return { ...m, score };
    }).filter(m => m.score > 0);

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  },

  // Build memory context string for injection into chat
  buildContext(userId, prompt) {
    const relevant = this.getRelevant(userId, prompt);
    if (!relevant.length) return '';
    const lines = relevant.map(m => `- ${m.key}: ${m.value}`);
    return `\n[User Knowledge Base]\n${lines.join('\n')}\n`;
  },

  // Get categories
  getCategories(userId) {
    return db.prepare('SELECT DISTINCT category FROM memory WHERE user_id = ? ORDER BY category').all(userId).map(r => r.category);
  },

  // Bulk import
  importMemories(userId, entries) {
    const tx = db.transaction(() => {
      for (const e of entries) {
        this.set(userId, e.key, e.value, e.category || 'general');
      }
    });
    tx();
    return entries.length;
  },

  // Export all
  exportMemories(userId) {
    return this.list(userId).map(m => ({ key: m.key, value: m.value, category: m.category }));
  },
};
