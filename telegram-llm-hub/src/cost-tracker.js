import db from './db.js';

// Approximate cost per 1M tokens (USD) for common models
const PRICING = {
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
  'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10.0, output: 30.0 },
  'gemini-1.5-pro': { input: 1.25, output: 5.0 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'mistral-large-latest': { input: 2.0, output: 6.0 },
  'mistral-small-latest': { input: 0.2, output: 0.6 },
  'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
  'deepseek-chat': { input: 0.14, output: 0.28 },
  'grok-2': { input: 2.0, output: 10.0 },
  'command-r-plus': { input: 2.5, output: 10.0 },
};

function estimateCost(model, inputTokens, outputTokens) {
  // Find pricing by partial model match
  let pricing = PRICING[model];
  if (!pricing) {
    for (const [key, val] of Object.entries(PRICING)) {
      if (model && model.includes(key.split('-')[0])) {
        pricing = val;
        break;
      }
    }
  }
  if (!pricing) pricing = { input: 1.0, output: 3.0 }; // default guess

  return ((inputTokens / 1_000_000) * pricing.input) + ((outputTokens / 1_000_000) * pricing.output);
}

// Rough token count estimation (4 chars per token average)
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export const costTracker = {
  // Log a usage event
  log(userId, provider, model, inputText, outputText, action = 'chat') {
    const inputTokens = estimateTokens(inputText);
    const outputTokens = estimateTokens(outputText);
    const cost = estimateCost(model, inputTokens, outputTokens);

    db.prepare(
      'INSERT INTO usage_log (user_id, provider, model, input_tokens, output_tokens, estimated_cost, action) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(userId, provider, model || 'unknown', inputTokens, outputTokens, cost, action);

    return { inputTokens, outputTokens, cost };
  },

  // Get summary for user
  getSummary(userId, days = 30) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = db.prepare(`
      SELECT provider, model,
        SUM(input_tokens) as total_input, SUM(output_tokens) as total_output,
        SUM(estimated_cost) as total_cost, COUNT(*) as request_count
      FROM usage_log WHERE user_id = ? AND created_at >= ?
      GROUP BY provider, model ORDER BY total_cost DESC
    `).all(userId, since);

    const totals = db.prepare(`
      SELECT SUM(input_tokens) as total_input, SUM(output_tokens) as total_output,
        SUM(estimated_cost) as total_cost, COUNT(*) as request_count
      FROM usage_log WHERE user_id = ? AND created_at >= ?
    `).get(userId, since);

    return { breakdown: rows, totals, period: `${days} days` };
  },

  // Get daily breakdown
  getDaily(userId, days = 7) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    return db.prepare(`
      SELECT DATE(created_at) as date, provider,
        SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
        SUM(estimated_cost) as cost, COUNT(*) as requests
      FROM usage_log WHERE user_id = ? AND created_at >= ?
      GROUP BY DATE(created_at), provider ORDER BY date DESC
    `).all(userId, since);
  },

  // Get cost by action type
  getByAction(userId, days = 30) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    return db.prepare(`
      SELECT action, SUM(estimated_cost) as total_cost, COUNT(*) as count,
        SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens
      FROM usage_log WHERE user_id = ? AND created_at >= ?
      GROUP BY action ORDER BY total_cost DESC
    `).all(userId, since);
  },

  // Get recent logs
  getRecent(userId, limit = 50) {
    return db.prepare('SELECT * FROM usage_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
  },

  estimateTokens,
  estimateCost,
};
