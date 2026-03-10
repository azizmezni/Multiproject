import db from './db.js';

const XP_REWARDS = {
  message_sent: 5,
  task_completed: 25,
  board_created: 50,
  workflow_run: 40,
  qa_passed: 30,
  draft_saved: 10,
  streak_bonus: 15,
  challenge_completed: 50,
  arena_battle: 20,
  memory_added: 10,
  template_used: 15,
  workflow_shared: 30,
  plugin_used: 10,
  voice_processed: 15,
};

const LEVELS = [
  { level: 1, xp: 0, title: 'Novice', color: '#6b7280' },
  { level: 2, xp: 100, title: 'Apprentice', color: '#3b82f6' },
  { level: 3, xp: 300, title: 'Builder', color: '#22c55e' },
  { level: 4, xp: 600, title: 'Architect', color: '#a855f7' },
  { level: 5, xp: 1000, title: 'Engineer', color: '#f59e0b' },
  { level: 6, xp: 1500, title: 'Mastermind', color: '#ef4444' },
  { level: 7, xp: 2500, title: 'Visionary', color: '#ec4899' },
  { level: 8, xp: 4000, title: 'Legend', color: '#00f0ff' },
  { level: 9, xp: 6000, title: 'Titan', color: '#f97316' },
  { level: 10, xp: 10000, title: 'Transcendent', color: '#ffd700' },
];

const ACHIEVEMENTS = [
  { id: 'first_message', title: 'Hello World', desc: 'Send your first message', icon: '👋', condition: (s) => s.messages_sent >= 1 },
  { id: 'first_board', title: 'Project Starter', desc: 'Create your first board', icon: '📋', condition: (s) => s.boards_created >= 1 },
  { id: 'first_workflow', title: 'Flow Master', desc: 'Run your first workflow', icon: '⚡', condition: (s) => s.workflows_run >= 1 },
  { id: 'task_5', title: 'Getting Things Done', desc: 'Complete 5 tasks', icon: '✅', condition: (s) => s.tasks_completed >= 5 },
  { id: 'task_25', title: 'Productivity Machine', desc: 'Complete 25 tasks', icon: '🚀', condition: (s) => s.tasks_completed >= 25 },
  { id: 'task_100', title: 'Centurion', desc: 'Complete 100 tasks', icon: '💯', condition: (s) => s.tasks_completed >= 100 },
  { id: 'board_5', title: 'Board Collector', desc: 'Create 5 boards', icon: '📊', condition: (s) => s.boards_created >= 5 },
  { id: 'wf_5', title: 'Automation Pro', desc: 'Run 5 workflows', icon: '🔄', condition: (s) => s.workflows_run >= 5 },
  { id: 'streak_3', title: 'On a Roll', desc: '3-day streak', icon: '🔥', condition: (s) => s.streak_days >= 3 },
  { id: 'streak_7', title: 'Weekly Warrior', desc: '7-day streak', icon: '🏆', condition: (s) => s.streak_days >= 7 },
  { id: 'streak_30', title: 'Monthly Master', desc: '30-day streak', icon: '👑', condition: (s) => s.streak_days >= 30 },
  { id: 'xp_1000', title: 'XP Hunter', desc: 'Earn 1000 XP', icon: '⭐', condition: (s) => s.xp >= 1000 },
  { id: 'msg_100', title: 'Chatterbox', desc: 'Send 100 messages', icon: '💬', condition: (s) => s.messages_sent >= 100 },
  { id: 'level_5', title: 'Engineer Class', desc: 'Reach level 5', icon: '🎖️', condition: (s) => s.level >= 5 },
  { id: 'level_10', title: 'Transcendence', desc: 'Reach max level', icon: '🌟', condition: (s) => s.level >= 10 },
];

export const gamification = {
  getStats(userId) {
    let stats = db.prepare('SELECT * FROM gamification WHERE user_id = ?').get(userId);
    if (!stats) {
      db.prepare('INSERT INTO gamification (user_id) VALUES (?)').run(userId);
      stats = db.prepare('SELECT * FROM gamification WHERE user_id = ?').get(userId);
    }
    stats._achievements = JSON.parse(stats.achievements || '[]');
    stats._level = LEVELS.find(l => l.level === stats.level) || LEVELS[0];
    stats._nextLevel = LEVELS.find(l => l.level === stats.level + 1);
    stats._xpProgress = stats._nextLevel
      ? ((stats.xp - stats._level.xp) / (stats._nextLevel.xp - stats._level.xp)) * 100
      : 100;
    return stats;
  },

  addXP(userId, action) {
    const xp = XP_REWARDS[action] || 0;
    if (xp === 0) return null;

    const stats = this.getStats(userId);
    const newXP = stats.xp + xp;
    const newLevel = this._calcLevel(newXP);
    const today = new Date().toISOString().split('T')[0];

    // Update streak
    let streak = stats.streak_days;
    if (stats.last_active) {
      const lastDate = new Date(stats.last_active);
      const todayDate = new Date(today);
      const diffDays = Math.floor((todayDate - lastDate) / (1000 * 60 * 60 * 24));
      if (diffDays === 1) {
        streak += 1;
      } else if (diffDays > 1) {
        streak = 1;
      }
    } else {
      streak = 1;
    }

    // Increment counter
    const counterField = {
      message_sent: 'messages_sent',
      task_completed: 'tasks_completed',
      board_created: 'boards_created',
      workflow_run: 'workflows_run',
    }[action];

    const counterUpdate = counterField ? `, ${counterField} = ${counterField} + 1` : '';

    db.prepare(`
      UPDATE gamification
      SET xp = ?, level = ?, streak_days = ?, last_active = ? ${counterUpdate}
      WHERE user_id = ?
    `).run(newXP, newLevel, streak, today, userId);

    // Check for new achievements
    const newAchievements = this._checkAchievements(userId);

    const leveledUp = newLevel > stats.level;
    return { xp: xp, totalXP: newXP, level: newLevel, leveledUp, newAchievements };
  },

  _calcLevel(xp) {
    let level = 1;
    for (const l of LEVELS) {
      if (xp >= l.xp) level = l.level;
    }
    return level;
  },

  _checkAchievements(userId) {
    const stats = this.getStats(userId);
    const earned = stats._achievements;
    const newlyEarned = [];

    for (const ach of ACHIEVEMENTS) {
      if (!earned.includes(ach.id) && ach.condition(stats)) {
        earned.push(ach.id);
        newlyEarned.push(ach);
      }
    }

    if (newlyEarned.length > 0) {
      db.prepare('UPDATE gamification SET achievements = ? WHERE user_id = ?')
        .run(JSON.stringify(earned), userId);
    }
    return newlyEarned;
  },

  getAllAchievements(userId) {
    const stats = this.getStats(userId);
    return ACHIEVEMENTS.map(a => ({
      ...a,
      earned: stats._achievements.includes(a.id),
    }));
  },

  getLeaderboard() {
    return db.prepare('SELECT * FROM gamification ORDER BY xp DESC LIMIT 10').all();
  },

  LEVELS,
  ACHIEVEMENTS,
  XP_REWARDS,
};
