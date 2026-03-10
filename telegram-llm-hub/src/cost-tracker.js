import db from './db.js';

// Approximate cost per 1M tokens (USD) for common models
const PRICING = {
  // Anthropic Claude
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4.0 },
  'claude-opus-4-20250514': { input: 15.0, output: 75.0 },
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'o3': { input: 10.0, output: 40.0 },
  'o3-mini': { input: 1.1, output: 4.4 },
  'o4-mini': { input: 1.1, output: 4.4 },
  // Google Gemini
  'gemini-2.5-pro': { input: 1.25, output: 10.0 },
  'gemini-2.5-flash': { input: 0.15, output: 0.6 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-2.0-pro': { input: 1.25, output: 5.0 },
  'gemini-1.5-pro': { input: 1.25, output: 5.0 },
  // Mistral
  'mistral-large-latest': { input: 2.0, output: 6.0 },
  'mistral-small-latest': { input: 0.2, output: 0.6 },
  'codestral-latest': { input: 0.3, output: 0.9 },
  // Groq (inference cost)
  'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
  'llama-3.1-8b-instant': { input: 0.05, output: 0.08 },
  'deepseek-r1-distill-llama-70b': { input: 0.75, output: 0.99 },
  'gemma2-9b-it': { input: 0.2, output: 0.2 },
  // DeepSeek
  'deepseek-chat': { input: 0.14, output: 0.28 },
  'deepseek-r1': { input: 0.55, output: 2.19 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
  // Cohere
  'command-r-plus': { input: 2.5, output: 10.0 },
  'command-r': { input: 0.15, output: 0.6 },
  // xAI Grok
  'grok-2': { input: 2.0, output: 10.0 },
  'grok-3': { input: 3.0, output: 15.0 },
  'grok-3-mini': { input: 0.3, output: 0.5 },
  // Perplexity
  'sonar-pro': { input: 3.0, output: 15.0 },
  'sonar': { input: 1.0, output: 1.0 },
  'sonar-reasoning-pro': { input: 2.0, output: 8.0 },
  // Together AI (open model pricing)
  'meta-llama/Llama-3.3-70B-Instruct-Turbo': { input: 0.88, output: 0.88 },
  'Qwen/Qwen2.5-72B-Instruct-Turbo': { input: 0.9, output: 0.9 },
  // Fireworks AI
  'accounts/fireworks/models/llama-v3p3-70b-instruct': { input: 0.9, output: 0.9 },
  // Cerebras
  'llama-3.3-70b': { input: 0.6, output: 0.6 },
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
