// All LLM provider implementations with a common interface

// Strip <think>...</think> tags from reasoning models (DeepSeek, Qwen, etc.)
function stripThinkTags(text) {
  if (!text) return '';
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

class BaseProvider {
  constructor(name, displayName, apiKey, model, baseUrl) {
    this.name = name;
    this.displayName = displayName;
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async chat(messages, opts = {}) {
    throw new Error('chat() not implemented');
  }

  async vision(imageBase64, prompt) {
    throw new Error('vision() not supported by this provider');
  }

  async test() {
    const start = Date.now();
    try {
      const res = await this.chat([{ role: 'user', content: 'Say "ok"' }], { max_tokens: 10 });
      return { ok: true, model: this.model, latency: Date.now() - start, response: res };
    } catch (e) {
      return { ok: false, error: e.message, latency: Date.now() - start };
    }
  }
}

// --- OpenAI-compatible base (shared by many providers) ---
class OpenAICompatibleProvider extends BaseProvider {
  constructor(name, displayName, apiKey, model, baseUrl, opts = {}) {
    super(name, displayName, apiKey, model, baseUrl);
    this.chatPath = opts.chatPath || '/v1/chat/completions';
    this.extraHeaders = opts.extraHeaders || {};
    this.stripThink = opts.stripThink || false;
  }

  async chat(messages, opts = {}) {
    const res = await fetch(`${this.baseUrl}${this.chatPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: opts.max_tokens || 4096,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`${this.displayName} error ${res.status}: ${err.error?.message || res.statusText}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    return this.stripThink ? stripThinkTags(text) : text;
  }

  async vision(imageBase64, prompt, mimeType = 'image/png') {
    return this.chat([{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
        { type: 'text', text: prompt },
      ],
    }]);
  }
}

// --- Anthropic Claude ---
export class ClaudeProvider extends BaseProvider {
  constructor(apiKey, model = 'claude-sonnet-4-20250514') {
    super('claude', 'Anthropic Claude', apiKey, model, 'https://api.anthropic.com');
  }

  async listModels() {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Claude models error ${res.status}`);
    const data = await res.json();
    return (data.data || []).map(m => m.id).sort();
  }

  async chat(messages, opts = {}) {
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system');

    const body = {
      model: this.model,
      max_tokens: opts.max_tokens || 4096,
      messages: chatMsgs,
    };
    if (systemMsg) body.system = systemMsg.content;

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Claude API error ${res.status}: ${err.error?.message || res.statusText}`);
    }

    const data = await res.json();
    return data.content?.[0]?.text || '';
  }

  async vision(imageBase64, prompt, mimeType = 'image/png') {
    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Claude Vision error: ${err.error?.message || res.statusText}`);
    }

    const data = await res.json();
    return data.content?.[0]?.text || '';
  }
}

// --- OpenAI ---
export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(apiKey, model = 'gpt-4o') {
    super('openai', 'OpenAI', apiKey, model, 'https://api.openai.com');
  }

  async vision(imageBase64, prompt, mimeType = 'image/png') {
    return this.chat([{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
        { type: 'text', text: prompt },
      ],
    }]);
  }

  async listModels() {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`OpenAI models error ${res.status}`);
    const data = await res.json();
    // Filter to chat-capable models, exclude embeddings/tts/whisper/dall-e/moderation
    const exclude = /^(text-embedding|tts-|whisper|dall-e|davinci|babbage|canary|omni-moderation|chatgpt-4o-latest)/;
    const chatModels = (data.data || [])
      .filter(m => !exclude.test(m.id))
      .map(m => m.id)
      .sort();
    return chatModels;
  }
}

// --- Google Gemini ---
export class GeminiProvider extends BaseProvider {
  constructor(apiKey, model = 'gemini-2.0-flash') {
    super('gemini', 'Google Gemini', apiKey, model, 'https://generativelanguage.googleapis.com');
  }

  async chat(messages, opts = {}) {
    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const systemMsg = messages.find(m => m.role === 'system');
    const body = { contents };
    if (systemMsg) {
      body.systemInstruction = { parts: [{ text: systemMsg.content }] };
    }

    const res = await fetch(
      `${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Gemini error ${res.status}: ${err.error?.message || res.statusText}`);
    }

    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  async vision(imageBase64, prompt, mimeType = 'image/png') {
    const contents = [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: mimeType, data: imageBase64 } },
        { text: prompt },
      ],
    }];

    const res = await fetch(
      `${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents }),
      }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Gemini Vision error: ${err.error?.message || res.statusText}`);
    }

    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  async listModels() {
    const res = await fetch(
      `${this.baseUrl}/v1beta/models?key=${this.apiKey}`
    );
    if (!res.ok) throw new Error(`Gemini models error ${res.status}`);
    const data = await res.json();
    return (data.models || [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name.replace('models/', ''))
      .sort();
  }
}

// --- Mistral AI (OpenAI-compatible) ---
export class MistralProvider extends OpenAICompatibleProvider {
  constructor(apiKey, model = 'mistral-large-latest') {
    super('mistral', 'Mistral AI', apiKey, model, 'https://api.mistral.ai');
  }

  async listModels() {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Mistral models error ${res.status}`);
    const data = await res.json();
    return (data.data || []).map(m => m.id).sort();
  }
}

// --- Groq (OpenAI-compatible) ---
export class GroqProvider extends OpenAICompatibleProvider {
  constructor(apiKey, model = 'llama-3.3-70b-versatile') {
    super('groq', 'Groq', apiKey, model, 'https://api.groq.com/openai');
  }

  async listModels() {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`Groq models error ${res.status}`);
    const data = await res.json();
    return (data.data || [])
      .filter(m => m.id && !m.id.includes('whisper') && !m.id.includes('guard') && !m.id.includes('tts') && !m.id.includes('compound') && m.active !== false)
      .map(m => m.id)
      .sort();
  }
}

// --- Cohere ---
export class CohereProvider extends BaseProvider {
  constructor(apiKey, model = 'command-r-plus') {
    super('cohere', 'Cohere', apiKey, model, 'https://api.cohere.com');
  }

  async chat(messages, opts = {}) {
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system');

    const body = {
      model: this.model,
      messages: chatMsgs.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
    };
    if (systemMsg) body.preamble = systemMsg.content;

    const res = await fetch(`${this.baseUrl}/v2/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Cohere error ${res.status}: ${err.message || res.statusText}`);
    }

    const data = await res.json();
    return data.message?.content?.[0]?.text || '';
  }

  async listModels() {
    const res = await fetch(`${this.baseUrl}/v2/models`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Cohere models error ${res.status}`);
    const data = await res.json();
    return (data.models || [])
      .filter(m => m.endpoints && m.endpoints.includes('chat'))
      .map(m => m.name)
      .sort();
  }
}

// --- DeepSeek (OpenAI-compatible, strips <think> tags) ---
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(apiKey, model = 'deepseek-chat') {
    super('deepseek', 'DeepSeek', apiKey, model, 'https://api.deepseek.com', {
      chatPath: '/chat/completions',
      stripThink: true,
    });
  }

  async listModels() {
    const res = await fetch('https://api.deepseek.com/models', {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`DeepSeek models error ${res.status}`);
    const data = await res.json();
    return (data.data || []).map(m => m.id).sort();
  }
}

// --- xAI Grok (OpenAI-compatible) ---
export class GrokProvider extends OpenAICompatibleProvider {
  constructor(apiKey, model = 'grok-2') {
    super('grok', 'xAI Grok', apiKey, model, 'https://api.x.ai');
  }

  async listModels() {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Grok models error ${res.status}`);
    const data = await res.json();
    return (data.data || []).map(m => m.id).sort();
  }
}

// --- OpenRouter (OpenAI-compatible, meta-provider) ---
export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor(apiKey, model = 'openrouter/free') {
    super('openrouter', 'OpenRouter', apiKey, model, 'https://openrouter.ai/api', {
      extraHeaders: { 'HTTP-Referer': 'https://telegram-llm-hub.local', 'X-Title': 'Telegram LLM Hub' },
    });
  }

  // Override chat to add OpenRouter-specific provider settings (bypass data policy restrictions)
  async chat(messages, opts = {}) {
    const res = await fetch(`${this.baseUrl}${this.chatPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: opts.max_tokens || 4096,
        provider: {
          allow_fallbacks: true,
          data_collection: 'allow',
        },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => res.statusText);
      if (res.status === 404 && errBody.includes('guardrail')) {
        throw new Error(`OpenRouter: Privacy settings blocking requests. Go to https://openrouter.ai/settings/privacy and set Data Policy to "Allow all" to use free models.`);
      }
      throw new Error(`OpenRouter error ${res.status}: ${errBody.substring(0, 200)}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    return stripThinkTags(text);
  }

  async listModels() {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    if (!res.ok) throw new Error(`OpenRouter models error ${res.status}`);
    const data = await res.json();
    const free = (data.data || []).filter(m => m.id.includes(':free') || m.id.startsWith('openrouter/'));
    const paid = (data.data || []).filter(m => !m.id.includes(':free') && !m.id.startsWith('openrouter/'));
    return {
      groups: {
        '🆓 Free': ['openrouter/free', 'openrouter/auto', ...free.filter(m => !m.id.startsWith('openrouter/')).map(m => m.id).sort()],
        '💎 Premium': paid.slice(0, 30).map(m => m.id).sort(),
      },
    };
  }
}

// --- Together AI (OpenAI-compatible) ---
export class TogetherProvider extends OpenAICompatibleProvider {
  constructor(apiKey, model = 'meta-llama/Llama-3.3-70B-Instruct-Turbo') {
    super('together', 'Together AI', apiKey, model, 'https://api.together.xyz');
  }

  async listModels() {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Together models error ${res.status}`);
    const data = await res.json();
    return (data.data || [])
      .filter(m => m.type === 'chat' || !m.type)
      .map(m => m.id)
      .sort();
  }
}

// --- Perplexity (OpenAI-compatible, search-augmented) ---
export class PerplexityProvider extends OpenAICompatibleProvider {
  constructor(apiKey, model = 'sonar-pro') {
    super('perplexity', 'Perplexity', apiKey, model, 'https://api.perplexity.ai');
    this.chatPath = '/chat/completions';
  }

  async listModels() {
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Perplexity models error ${res.status}`);
    const data = await res.json();
    return (data.data || data.models || []).map(m => m.id || m).sort();
  }
}

// --- Fireworks AI (OpenAI-compatible, ultra-fast) ---
export class FireworksProvider extends OpenAICompatibleProvider {
  constructor(apiKey, model = 'accounts/fireworks/models/llama-v3p3-70b-instruct') {
    super('fireworks', 'Fireworks AI', apiKey, model, 'https://api.fireworks.ai/inference');
  }

  async listModels() {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Fireworks models error ${res.status}`);
    const data = await res.json();
    return (data.data || []).map(m => m.id).sort();
  }
}

// --- Cerebras (OpenAI-compatible, wafer-scale fast) ---
export class CerebrasProvider extends OpenAICompatibleProvider {
  constructor(apiKey, model = 'llama-3.3-70b') {
    super('cerebras', 'Cerebras', apiKey, model, 'https://api.cerebras.ai');
  }

  async listModels() {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`Cerebras models error ${res.status}`);
    const data = await res.json();
    return (data.data || []).map(m => m.id).sort();
  }
}

// --- Ollama (Local + Cloud) ---
export class OllamaProvider extends BaseProvider {
  constructor(baseUrl = 'http://localhost:11434', model = 'llama3.1', apiKey = null) {
    super('ollama', 'Ollama', apiKey, model, baseUrl);
    this.isLocal = !apiKey;
  }

  _headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  async chat(messages, opts = {}) {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama error ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    const text = data.message?.content || '';
    return stripThinkTags(text);
  }

  async test() {
    const start = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { headers: this._headers() });
      if (!res.ok) throw new Error(`Ollama ${this.apiKey ? 'Cloud' : 'Local'} error ${res.status}`);
      const data = await res.json();
      return { ok: true, models: data.models?.map(m => m.name) || [], latency: Date.now() - start };
    } catch (e) {
      return { ok: false, error: e.message, latency: Date.now() - start };
    }
  }
}

// --- LM Studio (Local) ---
export class LMStudioProvider extends OpenAICompatibleProvider {
  constructor(baseUrl = 'http://localhost:1234', model = 'default') {
    super('lmstudio', 'LM Studio (Local)', null, model, baseUrl, { stripThink: true });
    this.isLocal = true;
  }

  async test() {
    const start = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`);
      if (!res.ok) throw new Error('LM Studio not running');
      const data = await res.json();
      return { ok: true, models: data.data?.map(m => m.id) || [], latency: Date.now() - start };
    } catch (e) {
      return { ok: false, error: e.message, latency: Date.now() - start };
    }
  }
}

// --- SambaNova (OpenAI-compatible, free tier) ---
export class SambaNovaProvider extends OpenAICompatibleProvider {
  constructor(apiKey, model = 'Meta-Llama-3.3-70B-Instruct') {
    super('sambanova', 'SambaNova', apiKey, model, 'https://api.sambanova.ai');
  }

  async listModels() {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`SambaNova models error ${res.status}`);
    const data = await res.json();
    return (data.data || []).map(m => m.id).sort();
  }
}

// --- Hugging Face Inference (OpenAI-compatible) ---
export class HuggingFaceProvider extends OpenAICompatibleProvider {
  constructor(apiKey, model = 'meta-llama/Llama-3.3-70B-Instruct') {
    super('huggingface', 'Hugging Face', apiKey, model, 'https://router.huggingface.co', {
      stripThink: true,
    });
  }

  async listModels() {
    // HF has thousands of models — fetch featured/recommended text-generation ones
    const res = await fetch('https://huggingface.co/api/models?pipeline_tag=text-generation&sort=likes&direction=-1&limit=50&filter=conversational', {
      headers: this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {},
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HuggingFace models error ${res.status}`);
    const data = await res.json();
    return (data || []).map(m => m.id || m.modelId).sort();
  }
}

// --- Chutes AI (OpenAI-compatible, free tier) ---
export class ChutesProvider extends OpenAICompatibleProvider {
  constructor(apiKey, model = 'deepseek-ai/DeepSeek-V3-0324') {
    super('chutes', 'Chutes AI', apiKey, model, 'https://llm.chutes.ai', {
      stripThink: true,
    });
  }

  async listModels() {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Chutes models error ${res.status}`);
    const data = await res.json();
    return (data.data || []).map(m => m.id).sort();
  }
}

// --- NVIDIA NIM (OpenAI-compatible, free tier) ---
export class NvidiaProvider extends OpenAICompatibleProvider {
  constructor(apiKey, model = 'meta/llama-3.3-70b-instruct') {
    super('nvidia', 'NVIDIA NIM', apiKey, model, 'https://integrate.api.nvidia.com');
  }

  async listModels() {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`NVIDIA models error ${res.status}`);
    const data = await res.json();
    return (data.data || []).map(m => m.id).sort();
  }
}

// --- Hyperbolic (OpenAI-compatible, free tier 60 req/min) ---
export class HyperbolicProvider extends OpenAICompatibleProvider {
  constructor(apiKey, model = 'meta-llama/Llama-3.3-70B-Instruct') {
    super('hyperbolic', 'Hyperbolic', apiKey, model, 'https://api.hyperbolic.xyz');
  }

  async listModels() {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Hyperbolic models error ${res.status}`);
    const data = await res.json();
    return (data.data || []).map(m => m.id).sort();
  }
}

// --- glhf.chat (OpenAI-compatible, free beta) ---
export class GlhfProvider extends OpenAICompatibleProvider {
  constructor(apiKey, model = 'hf:meta-llama/Llama-3.3-70B-Instruct') {
    super('glhf', 'glhf.chat', apiKey, model, 'https://glhf.chat/api/openai');
  }

  async listModels() {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`glhf models error ${res.status}`);
    const data = await res.json();
    return (data.data || []).map(m => m.id).sort();
  }
}

// Provider registry with docs, models, descriptions
export const PROVIDER_REGISTRY = {
  claude: {
    class: ClaudeProvider,
    name: 'Anthropic Claude',
    envKey: 'ANTHROPIC_API_KEY',
    models: ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001', 'claude-opus-4-20250514'],
    docs: 'https://docs.anthropic.com/en/docs/initial-setup',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    description: 'Best-in-class reasoning and coding',
    tagline: 'Premier AI with deep thinking',
    dynamicModels: true,
  },
  openai: {
    class: OpenAIProvider,
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3', 'o3-mini', 'o4-mini'],
    docs: 'https://platform.openai.com/docs/quickstart',
    keyUrl: 'https://platform.openai.com/api-keys',
    description: 'Versatile GPT & reasoning models',
    tagline: 'Industry standard, wide ecosystem',
    dynamicModels: true,
  },
  gemini: {
    class: GeminiProvider,
    name: 'Google Gemini',
    envKey: 'GEMINI_API_KEY',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-3.1-pro-preview', 'gemini-2.0-flash'],
    docs: 'https://ai.google.dev/gemini-api/docs/quickstart',
    keyUrl: 'https://aistudio.google.com/apikey',
    description: 'Huge context window, multimodal',
    tagline: '🆓 Free tier — 1M+ token context, vision built-in',
    dynamicModels: true,
  },
  mistral: {
    class: MistralProvider,
    name: 'Mistral AI',
    envKey: 'MISTRAL_API_KEY',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'codestral-latest', 'pixtral-large-latest'],
    docs: 'https://docs.mistral.ai/getting-started/quickstart/',
    keyUrl: 'https://console.mistral.ai/api-keys',
    description: 'Fast European models, great for code',
    tagline: 'EU-based, multilingual, fast inference',
    dynamicModels: true,
  },
  groq: {
    class: GroqProvider,
    name: 'Groq',
    envKey: 'GROQ_API_KEY',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3-32b', 'meta-llama/llama-4-scout-17b-16e-instruct', 'moonshotai/kimi-k2-instruct-0905'],
    docs: 'https://console.groq.com/docs/quickstart',
    keyUrl: 'https://console.groq.com/keys',
    description: 'Ultra-fast LPU inference for open models',
    tagline: '🆓 Free tier — fastest open-model inference (LPU)',
    dynamicModels: true,
  },
  cohere: {
    class: CohereProvider,
    name: 'Cohere',
    envKey: 'COHERE_API_KEY',
    models: ['command-r-plus', 'command-r', 'command-light'],
    docs: 'https://docs.cohere.com/docs/the-cohere-platform',
    keyUrl: 'https://dashboard.cohere.com/api-keys',
    description: 'Enterprise RAG and search',
    tagline: 'Built for enterprise search & RAG',
    dynamicModels: true,
  },
  deepseek: {
    class: DeepSeekProvider,
    name: 'DeepSeek',
    envKey: 'DEEPSEEK_API_KEY',
    models: ['deepseek-chat', 'deepseek-r1', 'deepseek-coder', 'deepseek-reasoner'],
    docs: 'https://platform.deepseek.com/api-docs',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    description: 'Strong coding, math, and reasoning',
    tagline: 'Open-weight, excels at code & math',
    dynamicModels: true,
  },
  grok: {
    class: GrokProvider,
    name: 'xAI Grok',
    envKey: 'XAI_API_KEY',
    models: ['grok-2', 'grok-2-mini', 'grok-3', 'grok-3-mini'],
    docs: 'https://docs.x.ai/docs/overview',
    keyUrl: 'https://console.x.ai/team/default/api-keys',
    description: 'Real-time knowledge from X',
    tagline: 'Live data, witty, uncensored',
    dynamicModels: true,
  },
  openrouter: {
    class: OpenRouterProvider,
    name: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    modelGroups: {
      '🆓 Free (no key needed)': [
        'openrouter/free',
        'openrouter/auto',
        'qwen/qwen3-coder:free',
        'openai/gpt-oss-120b:free',
        'openai/gpt-oss-20b:free',
        'nvidia/nemotron-3-super-120b-a12b:free',
        'minimax/minimax-m2.5:free',
        'meta-llama/llama-3.3-70b-instruct:free',
        'nousresearch/hermes-3-llama-3.1-405b:free',
        'google/gemma-3-27b-it:free',
        'google/gemma-3-12b-it:free',
        'mistralai/mistral-small-3.1-24b-instruct:free',
        'qwen/qwen3-4b:free',
        'qwen/qwen3-next-80b-a3b-instruct:free',
        'stepfun/step-3.5-flash:free',
        'arcee-ai/trinity-large-preview:free',
        'arcee-ai/trinity-mini:free',
        'nvidia/nemotron-nano-9b-v2:free',
        'nvidia/nemotron-nano-12b-v2-vl:free',
        'nvidia/nemotron-3-nano-30b-a3b:free',
        'z-ai/glm-4.5-air:free',
        'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
        'google/gemma-3n-e4b-it:free',
        'google/gemma-3n-e2b-it:free',
        'liquid/lfm-2.5-1.2b-thinking:free',
        'liquid/lfm-2.5-1.2b-instruct:free',
      ],
      '💎 Premium (key required)': [
        'anthropic/claude-sonnet-4-20250514',
        'openai/gpt-4o',
        'google/gemini-2.5-flash',
        'deepseek/deepseek-r1',
        'meta-llama/llama-3.3-70b-instruct',
      ],
    },
    // Flat list for compatibility (all models combined)
    models: [
      'openrouter/free', 'openrouter/auto',
      'qwen/qwen3-coder:free', 'openai/gpt-oss-120b:free', 'openai/gpt-oss-20b:free',
      'nvidia/nemotron-3-super-120b-a12b:free', 'minimax/minimax-m2.5:free',
      'meta-llama/llama-3.3-70b-instruct:free', 'nousresearch/hermes-3-llama-3.1-405b:free',
      'google/gemma-3-27b-it:free', 'google/gemma-3-12b-it:free',
      'mistralai/mistral-small-3.1-24b-instruct:free', 'qwen/qwen3-4b:free',
      'anthropic/claude-sonnet-4-20250514', 'openai/gpt-4o', 'google/gemini-2.5-flash',
      'deepseek/deepseek-r1',
    ],
    docs: 'https://openrouter.ai/docs/quickstart',
    keyUrl: 'https://openrouter.ai/settings/keys',
    description: 'Meta-provider: 200+ models, one API. Free models available!',
    tagline: 'One key, every model — free tier included',
    dynamicModels: true,
  },
  together: {
    class: TogetherProvider,
    name: 'Together AI',
    envKey: 'TOGETHER_API_KEY',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'meta-llama/Llama-3.1-8B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo', 'deepseek-ai/DeepSeek-R1'],
    docs: 'https://docs.together.ai/docs/quickstart',
    keyUrl: 'https://api.together.xyz/settings/api-keys',
    description: 'Fast open-model serverless inference',
    tagline: 'Serverless open models, great pricing',
    dynamicModels: true,
  },
  perplexity: {
    class: PerplexityProvider,
    name: 'Perplexity',
    envKey: 'PERPLEXITY_API_KEY',
    models: ['sonar-pro', 'sonar', 'sonar-reasoning-pro', 'sonar-reasoning'],
    docs: 'https://docs.perplexity.ai/guides/getting-started',
    keyUrl: 'https://www.perplexity.ai/settings/api',
    description: 'Search-augmented with live citations',
    tagline: 'Internet-connected, cites sources',
    dynamicModels: true,
  },
  fireworks: {
    class: FireworksProvider,
    name: 'Fireworks AI',
    envKey: 'FIREWORKS_API_KEY',
    models: ['accounts/fireworks/models/llama-v3p3-70b-instruct', 'accounts/fireworks/models/qwen2p5-72b-instruct', 'accounts/fireworks/models/deepseek-r1'],
    docs: 'https://docs.fireworks.ai/getting-started/quickstart',
    keyUrl: 'https://fireworks.ai/account/api-keys',
    description: 'Ultra-fast serverless, function calling',
    tagline: 'Fastest serverless, compound AI',
    dynamicModels: true,
  },
  cerebras: {
    class: CerebrasProvider,
    name: 'Cerebras',
    envKey: 'CEREBRAS_API_KEY',
    models: ['llama3.1-8b', 'gpt-oss-120b', 'qwen-3-235b-a22b-instruct-2507', 'zai-glm-4.7'],
    docs: 'https://inference-docs.cerebras.ai/introduction',
    keyUrl: 'https://cloud.cerebras.ai/platform/api-keys',
    description: 'Fastest inference (wafer-scale chip)',
    tagline: '🆓 Free tier — record-breaking speed, wafer-scale AI',
    dynamicModels: true,
  },
  ollama: {
    class: OllamaProvider,
    name: 'Ollama (Local)',
    envKey: null,
    models: ['llama3.2', 'llama3.1', 'deepseek-r1', 'qwen2.5', 'phi4', 'gemma2', 'codellama', 'mistral'],
    docs: 'https://ollama.ai/download',
    description: 'Run open models locally via CLI',
    tagline: 'Free, private, runs on your machine',
    isLocal: true,
    dynamicModels: true,
  },
  'ollama-cloud': {
    class: OllamaProvider,
    name: 'Ollama Cloud',
    envKey: 'OLLAMA_CLOUD_API_KEY',
    models: [
      'deepseek-v3.1:671b', 'deepseek-v3.2', 'qwen3-coder:480b', 'qwen3.5:397b',
      'gpt-oss:120b', 'gpt-oss:20b', 'kimi-k2:1t', 'kimi-k2.5',
      'glm-5', 'glm-4.7', 'mistral-large-3:675b', 'nemotron-3-super',
      'minimax-m2.5', 'cogito-2.1:671b', 'devstral-2:123b',
      'gemma3:27b', 'gemma3:12b', 'gemma3:4b',
    ],
    docs: 'https://ollama.com/cloud',
    keyUrl: 'https://ollama.com/settings/keys',
    description: 'Free cloud inference — huge models, no GPU needed',
    tagline: 'Free preview: 1T Kimi, 671B DeepSeek, 480B Qwen on cloud GPUs',
    dynamicModels: true,
  },
  lmstudio: {
    class: LMStudioProvider,
    name: 'LM Studio (Local)',
    envKey: null,
    models: ['default'],
    docs: 'https://lmstudio.ai/docs',
    description: 'GUI for local model management',
    tagline: 'Desktop app, easy local models',
    isLocal: true,
    dynamicModels: true,
  },
  sambanova: {
    class: SambaNovaProvider,
    name: 'SambaNova',
    envKey: 'SAMBANOVA_API_KEY',
    models: ['Meta-Llama-3.3-70B-Instruct', 'Meta-Llama-3.1-8B-Instruct', 'DeepSeek-R1-Distill-Llama-70B', 'Qwen2.5-72B-Instruct', 'QwQ-32B'],
    docs: 'https://community.sambanova.ai/docs',
    keyUrl: 'https://cloud.sambanova.ai/apis',
    description: 'World-record speed, free tier, open models',
    tagline: '🆓 Free — fastest inference, Llama/DeepSeek/Qwen',
    dynamicModels: true,
  },
  huggingface: {
    class: HuggingFaceProvider,
    name: 'Hugging Face',
    envKey: 'HF_API_KEY',
    models: ['meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen2.5-72B-Instruct', 'mistralai/Mistral-Small-24B-Instruct-2501', 'google/gemma-2-27b-it', 'NousResearch/Hermes-3-Llama-3.1-8B'],
    docs: 'https://huggingface.co/docs/api-inference',
    keyUrl: 'https://huggingface.co/settings/tokens',
    description: 'Thousands of open models, free inference',
    tagline: '🆓 Free tier — largest model hub, community',
    dynamicModels: true,
  },
  chutes: {
    class: ChutesProvider,
    name: 'Chutes AI',
    envKey: 'CHUTES_API_KEY',
    models: ['deepseek-ai/DeepSeek-V3-0324', 'deepseek-ai/DeepSeek-R1', 'meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen2.5-72B-Instruct'],
    docs: 'https://chutes.ai/docs',
    keyUrl: 'https://chutes.ai/app/api-keys',
    description: 'Free GPU inference for open models',
    tagline: '🆓 Free — DeepSeek, Llama, Qwen on GPUs',
    dynamicModels: true,
  },
  nvidia: {
    class: NvidiaProvider,
    name: 'NVIDIA NIM',
    envKey: 'NVIDIA_API_KEY',
    models: ['meta/llama-3.3-70b-instruct', 'meta/llama-3.1-405b-instruct', 'google/gemma-2-27b-it', 'mistralai/mistral-large-2-instruct'],
    docs: 'https://build.nvidia.com/explore/discover',
    keyUrl: 'https://build.nvidia.com/settings/api-key',
    description: 'Enterprise-grade, 1000 free API calls',
    tagline: '🆓 Free credits — optimized NVIDIA inference',
    dynamicModels: true,
  },
  hyperbolic: {
    class: HyperbolicProvider,
    name: 'Hyperbolic',
    envKey: 'HYPERBOLIC_API_KEY',
    models: ['meta-llama/Llama-3.3-70B-Instruct', 'deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct', 'meta-llama/Llama-3.1-405B-Instruct'],
    docs: 'https://docs.hyperbolic.xyz',
    keyUrl: 'https://app.hyperbolic.xyz/settings',
    description: 'Affordable inference, 60 req/min free',
    tagline: '🆓 Free — no credit card, crypto payments',
    dynamicModels: true,
  },
  glhf: {
    class: GlhfProvider,
    name: 'glhf.chat',
    envKey: 'GLHF_API_KEY',
    models: ['hf:meta-llama/Llama-3.3-70B-Instruct', 'hf:Qwen/QwQ-32B-Preview', 'hf:mistralai/Mistral-Small-24B-Instruct-2501', 'hf:google/gemma-2-27b-it'],
    docs: 'https://glhf.chat/docs',
    keyUrl: 'https://glhf.chat/users/settings/api',
    description: 'Free beta — any HuggingFace model on demand',
    tagline: '🆓 Free beta — run any HF model instantly',
    dynamicModels: true,
  },
};

export function createProvider(name, apiKey, model, baseUrl) {
  const reg = PROVIDER_REGISTRY[name];
  if (!reg) throw new Error(`Unknown provider: ${name}`);

  // Ollama Cloud: same class as local Ollama but with API key + cloud base URL
  if (name === 'ollama-cloud') {
    return new reg.class(baseUrl || 'https://ollama.com', model || reg.models[0], apiKey);
  }

  if (reg.isLocal) {
    return new reg.class(baseUrl || undefined, model || reg.models[0]);
  }
  return new reg.class(apiKey, model || reg.models[0]);
}
