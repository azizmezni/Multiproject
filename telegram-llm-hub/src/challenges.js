import db from './db.js';
import { gamification } from './gamification.js';

// Challenge definitions
const CHALLENGE_POOL = [
  // Chat challenges
  { title: 'Chatty Cathy', description: 'Send 5 messages in chat', action: 'message_sent', target: 5, xp_reward: 30, category: 'chat' },
  { title: 'Deep Thinker', description: 'Send a message over 200 characters', action: 'long_message', target: 1, xp_reward: 20, category: 'chat' },
  { title: 'Provider Hopper', description: 'Use 2 different providers', action: 'provider_used', target: 2, xp_reward: 40, category: 'chat' },
  // Board challenges
  { title: 'Task Master', description: 'Complete 3 tasks', action: 'task_completed', target: 3, xp_reward: 50, category: 'boards' },
  { title: 'Board Builder', description: 'Create a new board', action: 'board_created', target: 1, xp_reward: 30, category: 'boards' },
  { title: 'QA Champion', description: 'Run QA on 2 tasks', action: 'qa_run', target: 2, xp_reward: 40, category: 'boards' },
  // Workflow challenges
  { title: 'Flow Runner', description: 'Execute a workflow', action: 'workflow_run', target: 1, xp_reward: 35, category: 'workflows' },
  { title: 'Node Crafter', description: 'Add 3 nodes to a workflow', action: 'node_added', target: 3, xp_reward: 30, category: 'workflows' },
  { title: 'Automation Pro', description: 'Run 3 workflows', action: 'workflow_run', target: 3, xp_reward: 60, category: 'workflows' },
  // General
  { title: 'Explorer', description: 'Save 2 links as drafts', action: 'draft_saved', target: 2, xp_reward: 25, category: 'general' },
  { title: 'Memory Keeper', description: 'Add 3 items to knowledge base', action: 'memory_added', target: 3, xp_reward: 35, category: 'general' },
  { title: 'Arena Fighter', description: 'Run an arena battle', action: 'arena_battle', target: 1, xp_reward: 40, category: 'general' },
  { title: 'Template User', description: 'Use a workflow template', action: 'template_used', target: 1, xp_reward: 25, category: 'workflows' },
  { title: 'Speed Demon', description: 'Complete 5 tasks in one day', action: 'task_completed', target: 5, xp_reward: 75, category: 'boards' },
  { title: 'Power User', description: 'Use 5 different features today', action: 'feature_used', target: 5, xp_reward: 100, category: 'general' },
];

export const challenges = {
  // Seed challenge definitions if empty
  seedDefaults() {
    const count = db.prepare('SELECT COUNT(*) as c FROM challenges').get().c;
    if (count > 0) return;
    const insert = db.prepare('INSERT INTO challenges (title, description, action, target, xp_reward, category) VALUES (?, ?, ?, ?, ?, ?)');
    const tx = db.transaction(() => {
      for (const c of CHALLENGE_POOL) {
        insert.run(c.title, c.description, c.action, c.target, c.xp_reward, c.category);
      }
    });
    tx();
  },

  // Get or assign daily challenges for a user
  getDailyChallenges(userId) {
    const today = new Date().toISOString().split('T')[0];
    let assigned = db.prepare(`
      SELECT uc.*, c.title, c.description, c.action, c.target, c.xp_reward, c.category
      FROM user_challenges uc JOIN challenges c ON uc.challenge_id = c.id
      WHERE uc.user_id = ? AND uc.assigned_date = ?
    `).all(userId, today);

    if (assigned.length === 0) {
      // Assign 3 random challenges for today
      const allChallenges = db.prepare('SELECT * FROM challenges').all();
      const shuffled = allChallenges.sort(() => Math.random() - 0.5).slice(0, 3);
      const insert = db.prepare('INSERT INTO user_challenges (user_id, challenge_id, assigned_date) VALUES (?, ?, ?)');
      const tx = db.transaction(() => {
        for (const c of shuffled) {
          insert.run(userId, c.id, today);
        }
      });
      tx();
      assigned = db.prepare(`
        SELECT uc.*, c.title, c.description, c.action, c.target, c.xp_reward, c.category
        FROM user_challenges uc JOIN challenges c ON uc.challenge_id = c.id
        WHERE uc.user_id = ? AND uc.assigned_date = ?
      `).all(userId, today);
    }

    return assigned;
  },

  // Track progress on an action
  trackAction(userId, action, increment = 1) {
    const today = new Date().toISOString().split('T')[0];
    const active = db.prepare(`
      SELECT uc.id, uc.progress, c.target, c.xp_reward, c.title
      FROM user_challenges uc JOIN challenges c ON uc.challenge_id = c.id
      WHERE uc.user_id = ? AND uc.assigned_date = ? AND c.action = ? AND uc.completed = 0
    `).all(userId, today, action);

    const completed = [];
    for (const ch of active) {
      const newProgress = ch.progress + increment;
      if (newProgress >= ch.target) {
        db.prepare('UPDATE user_challenges SET progress = ?, completed = 1, completed_at = CURRENT_TIMESTAMP WHERE id = ?').run(ch.target, ch.id);
        // Award XP
        gamification.addXP(userId, 'challenge_completed');
        completed.push({ title: ch.title, xp: ch.xp_reward });
      } else {
        db.prepare('UPDATE user_challenges SET progress = ? WHERE id = ?').run(newProgress, ch.id);
      }
    }
    return completed;
  },

  // Get challenge history
  getHistory(userId, limit = 30) {
    return db.prepare(`
      SELECT uc.*, c.title, c.description, c.xp_reward, c.category
      FROM user_challenges uc JOIN challenges c ON uc.challenge_id = c.id
      WHERE uc.user_id = ? ORDER BY uc.assigned_date DESC LIMIT ?
    `).all(userId, limit);
  },

  // Get streaks data
  getStreak(userId) {
    const dates = db.prepare(`
      SELECT DISTINCT assigned_date FROM user_challenges
      WHERE user_id = ? AND completed = 1 ORDER BY assigned_date DESC LIMIT 30
    `).all(userId).map(r => r.assigned_date);

    let streak = 0;
    const today = new Date().toISOString().split('T')[0];
    let checkDate = today;
    for (const d of dates) {
      if (d === checkDate) {
        streak++;
        const prev = new Date(checkDate);
        prev.setDate(prev.getDate() - 1);
        checkDate = prev.toISOString().split('T')[0];
      } else break;
    }
    return { streak, totalCompleted: dates.length };
  },
};
