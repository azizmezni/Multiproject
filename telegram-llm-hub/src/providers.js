// All LLM provider implementations with a common interface

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
    try {
      const res = await this.chat([{ role: 'user', content: 'Say "ok"' }], { max_tokens: 10 });
      return { ok: true, model: this.model, response: res };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

// --- Anthropic Claude ---
export class ClaudeProvider extends BaseProvider {
  constructor(apiKey, model = 'claude-sonnet-4-20250514') {
    super('claude', 'Anthropic Claude', apiKey, model, 'https://api.anthropic.com');
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
export class OpenAIProvider extends BaseProvider {
  constructor(apiKey, model = 'gpt-4o') {
    super('openai', 'OpenAI', apiKey, model, 'https://api.openai.com');
  }

  async chat(messages, opts = {}) {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: opts.max_tokens || 4096,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`OpenAI error ${res.status}: ${err.error?.message || res.statusText}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
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
}

// --- Mistral AI ---
export class MistralProvider extends BaseProvider {
  constructor(apiKey, model = 'mistral-large-latest') {
    super('mistral', 'Mistral AI', apiKey, model, 'https://api.mistral.ai');
  }

  async chat(messages, opts = {}) {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: opts.max_tokens || 4096,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Mistral error ${res.status}: ${err.error?.message || res.statusText}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }
}

// --- Groq ---
export class GroqProvider extends BaseProvider {
  constructor(apiKey, model = 'llama-3.1-70b-versatile') {
    super('groq', 'Groq', apiKey, model, 'https://api.groq.com/openai');
  }

  async chat(messages, opts = {}) {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: opts.max_tokens || 4096,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Groq error ${res.status}: ${err.error?.message || res.statusText}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
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
}

// --- DeepSeek ---
export class DeepSeekProvider extends BaseProvider {
  constructor(apiKey, model = 'deepseek-chat') {
    super('deepseek', 'DeepSeek', apiKey, model, 'https://api.deepseek.com');
  }

  async chat(messages, opts = {}) {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: opts.max_tokens || 4096,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`DeepSeek error ${res.status}: ${err.error?.message || res.statusText}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }
}

// --- xAI Grok ---
export class GrokProvider extends BaseProvider {
  constructor(apiKey, model = 'grok-2') {
    super('grok', 'xAI Grok', apiKey, model, 'https://api.x.ai');
  }

  async chat(messages, opts = {}) {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: opts.max_tokens || 4096,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Grok error ${res.status}: ${err.error?.message || res.statusText}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }
}

// --- Ollama (Local) ---
export class OllamaProvider extends BaseProvider {
  constructor(baseUrl = 'http://localhost:11434', model = 'llama3.1') {
    super('ollama', 'Ollama (Local)', null, model, baseUrl);
    this.isLocal = true;
  }

  async chat(messages, opts = {}) {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    return data.message?.content || '';
  }

  async test() {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) throw new Error('Ollama not running');
      const data = await res.json();
      return { ok: true, models: data.models?.map(m => m.name) || [] };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

// --- LM Studio (Local) ---
export class LMStudioProvider extends BaseProvider {
  constructor(baseUrl = 'http://localhost:1234', model = 'default') {
    super('lmstudio', 'LM Studio (Local)', null, model, baseUrl);
    this.isLocal = true;
  }

  async chat(messages, opts = {}) {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: opts.max_tokens || 4096,
      }),
    });

    if (!res.ok) {
      throw new Error(`LM Studio error ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  async test() {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`);
      if (!res.ok) throw new Error('LM Studio not running');
      const data = await res.json();
      return { ok: true, models: data.data?.map(m => m.id) || [] };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

// Provider registry with docs links
export const PROVIDER_REGISTRY = {
  claude: {
    class: ClaudeProvider,
    name: 'Anthropic Claude',
    envKey: 'ANTHROPIC_API_KEY',
    models: ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001', 'claude-opus-4-20250514'],
    docs: 'https://docs.anthropic.com/en/docs/initial-setup',
    description: 'Anthropic Claude - excellent reasoning and coding',
  },
  openai: {
    class: OpenAIProvider,
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o1-mini'],
    docs: 'https://platform.openai.com/docs/quickstart',
    description: 'OpenAI GPT models - versatile general-purpose',
  },
  gemini: {
    class: GeminiProvider,
    name: 'Google Gemini',
    envKey: 'GEMINI_API_KEY',
    models: ['gemini-2.0-flash', 'gemini-2.0-pro', 'gemini-1.5-pro'],
    docs: 'https://ai.google.dev/gemini-api/docs/quickstart',
    description: 'Google Gemini - large context, multimodal',
  },
  mistral: {
    class: MistralProvider,
    name: 'Mistral AI',
    envKey: 'MISTRAL_API_KEY',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'codestral-latest'],
    docs: 'https://docs.mistral.ai/getting-started/quickstart/',
    description: 'Mistral AI - fast European models, great for code',
  },
  groq: {
    class: GroqProvider,
    name: 'Groq',
    envKey: 'GROQ_API_KEY',
    models: ['llama-3.1-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    docs: 'https://console.groq.com/docs/quickstart',
    description: 'Groq - ultra-fast inference for open models',
  },
  cohere: {
    class: CohereProvider,
    name: 'Cohere',
    envKey: 'COHERE_API_KEY',
    models: ['command-r-plus', 'command-r', 'command-light'],
    docs: 'https://docs.cohere.com/docs/the-cohere-platform',
    description: 'Cohere - enterprise RAG and search',
  },
  deepseek: {
    class: DeepSeekProvider,
    name: 'DeepSeek',
    envKey: 'DEEPSEEK_API_KEY',
    models: ['deepseek-chat', 'deepseek-coder', 'deepseek-reasoner'],
    docs: 'https://platform.deepseek.com/api-docs',
    description: 'DeepSeek - strong coding and math',
  },
  grok: {
    class: GrokProvider,
    name: 'xAI Grok',
    envKey: 'XAI_API_KEY',
    models: ['grok-2', 'grok-2-mini'],
    docs: 'https://docs.x.ai/docs/overview',
    description: 'xAI Grok - real-time knowledge',
  },
  ollama: {
    class: OllamaProvider,
    name: 'Ollama (Local)',
    envKey: null,
    models: ['llama3.1', 'codellama', 'mistral', 'phi3', 'gemma2'],
    docs: 'https://ollama.ai/download',
    description: 'Ollama - run open models locally',
    isLocal: true,
  },
  lmstudio: {
    class: LMStudioProvider,
    name: 'LM Studio (Local)',
    envKey: null,
    models: ['default'],
    docs: 'https://lmstudio.ai/docs',
    description: 'LM Studio - GUI for local models',
    isLocal: true,
  },
};

export function createProvider(name, apiKey, model, baseUrl) {
  const reg = PROVIDER_REGISTRY[name];
  if (!reg) throw new Error(`Unknown provider: ${name}`);

  if (reg.isLocal) {
    return new reg.class(baseUrl || undefined, model || reg.models[0]);
  }
  return new reg.class(apiKey, model || reg.models[0]);
}
