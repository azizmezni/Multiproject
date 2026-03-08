import db from './db.js';
import { createProvider, PROVIDER_REGISTRY } from './providers.js';

class LLMManager {
  constructor() {
    this.providerCache = new Map();
  }

  // Initialize default providers from env for a user
  initDefaults(userId) {
    const existing = db.prepare('SELECT COUNT(*) as c FROM providers WHERE user_id = ?').get(userId);
    if (existing.c > 0) return;

    const defaults = [
      { name: 'claude', envKey: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-4-20250514', priority: 0 },
      { name: 'openai', envKey: 'OPENAI_API_KEY', model: 'gpt-4o', priority: 1 },
      { name: 'gemini', envKey: 'GEMINI_API_KEY', model: 'gemini-2.0-flash', priority: 2 },
      { name: 'mistral', envKey: 'MISTRAL_API_KEY', model: 'mistral-large-latest', priority: 3 },
      { name: 'groq', envKey: 'GROQ_API_KEY', model: 'llama-3.1-70b-versatile', priority: 4 },
      { name: 'cohere', envKey: 'COHERE_API_KEY', model: 'command-r-plus', priority: 5 },
      { name: 'deepseek', envKey: 'DEEPSEEK_API_KEY', model: 'deepseek-chat', priority: 6 },
      { name: 'grok', envKey: 'XAI_API_KEY', model: 'grok-2', priority: 7 },
      { name: 'ollama', envKey: null, model: 'llama3.1', priority: 8, isLocal: true },
      { name: 'lmstudio', envKey: null, model: 'default', priority: 9, isLocal: true },
    ];

    const insert = db.prepare(`
      INSERT OR IGNORE INTO providers (user_id, name, display_name, api_key, model, priority, enabled, is_local, base_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      for (const d of defaults) {
        const apiKey = d.envKey ? (process.env[d.envKey] || '') : '';
        const reg = PROVIDER_REGISTRY[d.name];
        const enabled = d.isLocal ? 1 : (apiKey ? 1 : 0);
        const baseUrl = d.isLocal
          ? (d.name === 'ollama' ? (process.env.OLLAMA_BASE_URL || 'http://localhost:11434') : (process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234'))
          : '';
        insert.run(userId, d.name, reg.name, apiKey, d.model, d.priority, enabled, d.isLocal ? 1 : 0, baseUrl);
      }
    });
    tx();
  }

  // Get ordered list of enabled providers for a user
  getProviders(userId) {
    return db.prepare(
      'SELECT * FROM providers WHERE user_id = ? ORDER BY priority ASC'
    ).all(userId);
  }

  getEnabledProviders(userId) {
    return db.prepare(
      'SELECT * FROM providers WHERE user_id = ? AND enabled = 1 ORDER BY priority ASC'
    ).all(userId);
  }

  // Build a provider instance from DB row
  _buildProvider(row) {
    const key = `${row.user_id}:${row.name}`;
    if (this.providerCache.has(key)) return this.providerCache.get(key);

    const provider = createProvider(row.name, row.api_key, row.model, row.base_url);
    this.providerCache.set(key, provider);
    return provider;
  }

  // Clear cache when provider config changes
  clearCache(userId, providerName) {
    this.providerCache.delete(`${userId}:${providerName}`);
  }

  // Chat with fallback across providers
  async chat(userId, messages, opts = {}) {
    const providers = this.getEnabledProviders(userId);
    if (providers.length === 0) {
      throw new Error('No providers configured. Use /settings to add API keys.');
    }

    const errors = [];

    for (const row of providers) {
      if (!row.api_key && !row.is_local) continue;

      try {
        const provider = this._buildProvider(row);
        const response = await provider.chat(messages, opts);
        return {
          text: response,
          provider: row.display_name,
          model: row.model,
        };
      } catch (err) {
        errors.push({ provider: row.display_name, error: err.message });
        console.log(`[Fallback] ${row.display_name} failed: ${err.message}`);
        continue;
      }
    }

    const errSummary = errors.map(e => `  ${e.provider}: ${e.error}`).join('\n');
    throw new Error(`All providers failed:\n${errSummary}`);
  }

  // Vision chat with fallback
  async vision(userId, imageBase64, prompt, mimeType = 'image/png') {
    const providers = this.getEnabledProviders(userId);
    const visionProviders = ['claude', 'openai', 'gemini'];

    for (const row of providers) {
      if (!visionProviders.includes(row.name)) continue;
      if (!row.api_key && !row.is_local) continue;

      try {
        const provider = this._buildProvider(row);
        const response = await provider.vision(imageBase64, prompt, mimeType);
        return { text: response, provider: row.display_name, model: row.model };
      } catch (err) {
        console.log(`[Vision Fallback] ${row.display_name} failed: ${err.message}`);
        continue;
      }
    }
    throw new Error('No vision-capable provider available.');
  }

  // Provider management
  updateProvider(userId, name, updates) {
    const sets = [];
    const vals = [];
    for (const [key, val] of Object.entries(updates)) {
      sets.push(`${key} = ?`);
      vals.push(val);
    }
    vals.push(userId, name);
    db.prepare(`UPDATE providers SET ${sets.join(', ')} WHERE user_id = ? AND name = ?`).run(...vals);
    this.clearCache(userId, name);
  }

  toggleProvider(userId, name) {
    db.prepare('UPDATE providers SET enabled = CASE WHEN enabled = 1 THEN 0 ELSE 1 END WHERE user_id = ? AND name = ?').run(userId, name);
    this.clearCache(userId, name);
  }

  // Reorder: move provider to new priority position
  reorderProvider(userId, name, direction) {
    const providers = this.getProviders(userId);
    const idx = providers.findIndex(p => p.name === name);
    if (idx === -1) return;

    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= providers.length) return;

    const tx = db.transaction(() => {
      db.prepare('UPDATE providers SET priority = ? WHERE user_id = ? AND name = ?')
        .run(providers[swapIdx].priority, userId, providers[idx].name);
      db.prepare('UPDATE providers SET priority = ? WHERE user_id = ? AND name = ?')
        .run(providers[idx].priority, userId, providers[swapIdx].name);
    });
    tx();
  }

  setApiKey(userId, name, apiKey) {
    db.prepare('UPDATE providers SET api_key = ?, enabled = 1 WHERE user_id = ? AND name = ?')
      .run(apiKey, userId, name);
    this.clearCache(userId, name);
  }

  setModel(userId, name, model) {
    db.prepare('UPDATE providers SET model = ? WHERE user_id = ? AND name = ?')
      .run(model, userId, name);
    this.clearCache(userId, name);
  }
}

export const llm = new LLMManager();
