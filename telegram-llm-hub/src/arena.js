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

  // Congress: ALL enabled LLMs respond, then each rates the others
  async congress(userId, prompt, onProgress = null) {
    llm.initDefaults(userId);

    // Get ALL enabled providers with keys (or local)
    const rows = db.prepare(
      'SELECT name, display_name FROM providers WHERE user_id = ? AND enabled = 1 AND (api_key IS NOT NULL AND api_key != "" OR is_local = 1) ORDER BY priority'
    ).all(userId);
    const providerNames = rows.map(p => p.name);
    const providerDisplayNames = {};
    for (const r of rows) providerDisplayNames[r.name] = r.display_name;

    if (providerNames.length < 2) throw new Error('Need at least 2 enabled providers with keys for Congress. Enable more in Providers settings.');

    if (onProgress) onProgress('proposals', { count: providerNames.length, providers: providerNames });

    // ── Phase 1: Collect proposals from ALL providers ──
    const messages = [{ role: 'user', content: prompt }];
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
    const successfulProviders = [];
    for (const r of results) {
      const val = r.status === 'fulfilled' ? r.value : { provider: 'unknown', error: 'Provider failed' };
      responses[val.provider] = val;
      if (!val.error) successfulProviders.push(val.provider);
    }

    if (successfulProviders.length < 2) {
      throw new Error(`Only ${successfulProviders.length} provider(s) responded. Need at least 2 for voting.`);
    }

    if (onProgress) onProgress('voting', { responded: successfulProviders.length });

    // ── Phase 2: Voting — each LLM rates all OTHER responses ──
    // Build anonymous response list (A, B, C...)
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const letterMap = {}; // provider → letter
    const reverseMap = {}; // letter → provider
    successfulProviders.forEach((p, i) => {
      letterMap[p] = letters[i];
      reverseMap[letters[i]] = p;
    });

    const allVotes = {}; // voterProvider → { targetProvider: { score, reason } }

    // Each successful provider votes on others
    const votePromises = successfulProviders.map(async (voter) => {
      // Build response list, marking voter's own response as [YOU]
      let responseList = '';
      for (const p of successfulProviders) {
        const letter = letterMap[p];
        const reply = responses[p].reply.substring(0, 1500); // Truncate to fit context
        if (p === voter) {
          responseList += `\nResponse ${letter} [YOU — skip this one]:\n${reply}\n`;
        } else {
          responseList += `\nResponse ${letter}:\n${reply}\n`;
        }
      }

      const votingPrompt = [
        {
          role: 'system',
          content: `You are a judge in an LLM congress. Multiple AI models answered a user's question.
Rate each response on a scale of 0-100. Skip the one marked [YOU].

Return ONLY valid JSON (no markdown fences, no explanation):
{
  "votes": {
    "A": { "score": 85, "reason": "Clear and actionable" },
    "B": { "score": 72, "reason": "Too vague" }
  }
}

Rules:
- Score 0-100 (0=terrible, 50=mediocre, 80=good, 100=perfect)
- SKIP the response marked [YOU] — do NOT include it in your votes
- Judge on: accuracy, completeness, clarity, actionability, creativity
- Be honest and critical — don't give everything high scores
- Give a brief 5-10 word reason for each score`,
        },
        {
          role: 'user',
          content: `USER'S QUESTION: "${prompt}"\n\n${responseList}`,
        },
      ];

      try {
        const result = await llm.chatWithProvider(userId, voter, votingPrompt);
        const parsed = JSON.parse(result.text.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
        // Convert letter-based votes to provider-based
        const providerVotes = {};
        for (const [letter, vote] of Object.entries(parsed.votes || {})) {
          const target = reverseMap[letter];
          if (target && target !== voter) {
            providerVotes[target] = { score: Math.min(100, Math.max(0, vote.score || 0)), reason: vote.reason || '' };
          }
        }
        allVotes[voter] = providerVotes;
      } catch (err) {
        console.log(`[Congress] ${voter} voting failed: ${err.message}`);
        allVotes[voter] = {}; // Empty votes if parsing fails
      }
    });

    await Promise.allSettled(votePromises);

    // ── Phase 3: Tally scores ──
    const scores = {}; // provider → { totalScore, voteCount, avgScore, voters: [{voter, score, reason}] }
    for (const p of successfulProviders) {
      scores[p] = { totalScore: 0, voteCount: 0, avgScore: 0, voters: [] };
    }

    for (const [voter, votes] of Object.entries(allVotes)) {
      for (const [target, vote] of Object.entries(votes)) {
        if (scores[target]) {
          scores[target].totalScore += vote.score;
          scores[target].voteCount++;
          scores[target].voters.push({ voter, voterName: providerDisplayNames[voter] || voter, score: vote.score, reason: vote.reason });
        }
      }
    }

    // Calculate averages and rank
    for (const p of Object.keys(scores)) {
      scores[p].avgScore = scores[p].voteCount > 0 ? Math.round(scores[p].totalScore / scores[p].voteCount) : 0;
    }

    const ranked = successfulProviders
      .map(p => ({ provider: p, displayName: providerDisplayNames[p] || p, ...scores[p] }))
      .sort((a, b) => b.avgScore - a.avgScore);

    const winner = ranked[0]?.provider || null;

    // Store congress
    const battle = db.prepare(
      'INSERT INTO arena_battles (user_id, prompt, providers, responses, winner, mode, votes) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      userId, prompt,
      JSON.stringify(providerNames),
      JSON.stringify(responses),
      winner,
      'congress',
      JSON.stringify({ allVotes, scores, ranked, letterMap })
    );

    return {
      id: battle.lastInsertRowid,
      prompt,
      responses,
      votes: allVotes,
      scores,
      ranked,
      winner,
      letterMap,
    };
  },

  // Execute the winning plan through the winning provider
  async executeWinner(userId, battleId, customPrompt = null) {
    const battle = this.get(battleId);
    if (!battle) throw new Error('Congress session not found');

    const winnerResponse = battle.responses[battle.winner];
    if (!winnerResponse || winnerResponse.error) throw new Error('Winner response not available');

    const execPrompt = customPrompt ||
      `You previously proposed a plan for this task. Now execute and implement it in detail.\n\nOriginal question: "${battle.prompt}"\n\nYour winning plan:\n${winnerResponse.reply}\n\nNow provide the complete, detailed implementation. Include code, commands, configs — everything needed to execute this plan.`;

    llm.initDefaults(userId);
    const result = await llm.chatWithProvider(userId, battle.winner, [
      { role: 'user', content: execPrompt },
    ]);

    // Store execution result
    db.prepare('UPDATE arena_battles SET execution = ? WHERE id = ?')
      .run(result.text, battleId);

    return { text: result.text, provider: battle.winner, model: result.model };
  },

  // Vote for a winner (manual — arena mode)
  vote(battleId, winnerProvider) {
    db.prepare('UPDATE arena_battles SET winner = ? WHERE id = ?').run(winnerProvider, battleId);
    return this.get(battleId);
  },

  get(battleId) {
    const row = db.prepare('SELECT * FROM arena_battles WHERE id = ?').get(battleId);
    if (row) {
      row.providers = JSON.parse(row.providers);
      row.responses = JSON.parse(row.responses);
      try { row.votes = JSON.parse(row.votes || '{}'); } catch { row.votes = {}; }
    }
    return row;
  },

  // Get user's battle history
  listByUser(userId, limit = 20) {
    const rows = db.prepare('SELECT * FROM arena_battles WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
    return rows.map(r => ({
      ...r,
      providers: JSON.parse(r.providers),
      responses: JSON.parse(r.responses),
      votes: (() => { try { return JSON.parse(r.votes || '{}'); } catch { return {}; } })(),
    }));
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
    for (const p of Object.keys(stats)) {
      stats[p].winRate = stats[p].battles > 0 ? Math.round((stats[p].wins / stats[p].battles) * 100) : 0;
    }
    return stats;
  },
};
