import db from './db.js';
import { llm } from './llm-manager.js';

export const arena = {
  // Run a battle: send same prompt to multiple providers simultaneously
  async battle(userId, prompt, providerNames = []) {
    llm.initDefaults(userId);

    // Get available providers if none specified
    if (!providerNames.length) {
      const providers = db.prepare('SELECT name FROM providers WHERE user_id = ? AND enabled = 1 ORDER BY priority').all(userId);
      providerNames = providers.slice(0, 3).map(p => p.name); // max 3
    }
    if (providerNames.length < 2) throw new Error('Need at least 2 enabled providers for arena battle');

    const messages = [{ role: 'user', content: prompt }];

    // Run all providers in parallel
    const results = await Promise.allSettled(
      providerNames.map(async (name) => {
        const start = Date.now();
        try {
          const result = await llm.chatWithProvider(userId, name, messages);
          return { provider: name, reply: result.text, model: result.model, latency: Date.now() - start };
        } catch (err) {
          return { provider: name, error: err.message, latency: Date.now() - start };
        }
      })
    );

    const responses = {};
    for (const r of results) {
      const val = r.status === 'fulfilled' ? r.value : { provider: 'unknown', error: 'Provider failed' };
      responses[val.provider] = val;
    }

    // Store battle
    const battle = db.prepare(
      'INSERT INTO arena_battles (user_id, prompt, providers, responses) VALUES (?, ?, ?, ?)'
    ).run(userId, prompt, JSON.stringify(providerNames), JSON.stringify(responses));

    return { id: battle.lastInsertRowid, prompt, responses };
  },

  // Vote for a winner
  vote(battleId, winnerProvider) {
    db.prepare('UPDATE arena_battles SET winner = ? WHERE id = ?').run(winnerProvider, battleId);
    return this.get(battleId);
  },

  get(battleId) {
    const row = db.prepare('SELECT * FROM arena_battles WHERE id = ?').get(battleId);
    if (row) {
      row.providers = JSON.parse(row.providers);
      row.responses = JSON.parse(row.responses);
    }
    return row;
  },

  // Get user's battle history
  listByUser(userId, limit = 20) {
    const rows = db.prepare('SELECT * FROM arena_battles WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
    return rows.map(r => ({ ...r, providers: JSON.parse(r.providers), responses: JSON.parse(r.responses) }));
  },

  // Get win rate stats per provider
  getStats(userId) {
    const battles = db.prepare('SELECT winner, providers FROM arena_battles WHERE user_id = ? AND winner IS NOT NULL').all(userId);
    const stats = {};
    for (const b of battles) {
      const providers = JSON.parse(b.providers);
      for (const p of providers) {
        if (!stats[p]) stats[p] = { battles: 0, wins: 0 };
        stats[p].battles++;
        if (b.winner === p) stats[p].wins++;
      }
    }
    // Calculate win rates
    for (const p of Object.keys(stats)) {
      stats[p].winRate = stats[p].battles > 0 ? Math.round((stats[p].wins / stats[p].battles) * 100) : 0;
    }
    return stats;
  },
};
