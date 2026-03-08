import db from './db.js';

export const sessions = {
  create(userId, title = 'New Chat') {
    // Deactivate other sessions
    db.prepare('UPDATE sessions SET active = 0 WHERE user_id = ? AND active = 1').run(userId);

    const result = db.prepare(
      'INSERT INTO sessions (user_id, title, active) VALUES (?, ?, 1)'
    ).run(userId, title);

    // Set as active session in user_state
    db.prepare(`
      INSERT INTO user_state (user_id, active_session_id, mode) VALUES (?, ?, 'chat')
      ON CONFLICT(user_id) DO UPDATE SET active_session_id = ?, mode = 'chat'
    `).run(userId, result.lastInsertRowid, result.lastInsertRowid);

    return this.get(result.lastInsertRowid);
  },

  get(sessionId) {
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  },

  getActive(userId) {
    const state = db.prepare('SELECT active_session_id FROM user_state WHERE user_id = ?').get(userId);
    if (!state?.active_session_id) return null;
    return this.get(state.active_session_id);
  },

  listByUser(userId, limit = 20) {
    return db.prepare(
      'SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(userId, limit);
  },

  setActive(userId, sessionId) {
    db.prepare(`
      INSERT INTO user_state (user_id, active_session_id) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET active_session_id = ?
    `).run(userId, sessionId, sessionId);
  },

  rename(sessionId, title) {
    db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, sessionId);
  },

  delete(sessionId) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  },

  // --- Messages ---
  addMessage(sessionId, role, content) {
    db.prepare(
      'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)'
    ).run(sessionId, role, content);
  },

  getMessages(sessionId, limit = 50) {
    return db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?'
    ).all(sessionId, limit);
  },

  getRecentMessages(sessionId, limit = 20) {
    const msgs = db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(sessionId, limit);
    return msgs.reverse();
  },

  clearMessages(sessionId) {
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
  },
};

// --- User state helpers ---
export const userState = {
  get(userId) {
    let state = db.prepare('SELECT * FROM user_state WHERE user_id = ?').get(userId);
    if (!state) {
      db.prepare("INSERT INTO user_state (user_id, mode) VALUES (?, 'chat')").run(userId);
      state = db.prepare('SELECT * FROM user_state WHERE user_id = ?').get(userId);
    }
    return state;
  },

  setMode(userId, mode) {
    db.prepare(`
      INSERT INTO user_state (user_id, mode) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET mode = ?
    `).run(userId, mode, mode);
  },

  setActiveBoard(userId, boardId) {
    db.prepare(`
      INSERT INTO user_state (user_id, active_board_id) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET active_board_id = ?
    `).run(userId, boardId, boardId);
  },

  setAwaiting(userId, awaitingType) {
    db.prepare(`
      INSERT INTO user_state (user_id, awaiting_input) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET awaiting_input = ?
    `).run(userId, awaitingType, awaitingType);
  },

  clearAwaiting(userId) {
    db.prepare(`
      INSERT INTO user_state (user_id, awaiting_input) VALUES (?, NULL)
      ON CONFLICT(user_id) DO UPDATE SET awaiting_input = NULL
    `).run(userId);
  },
};
