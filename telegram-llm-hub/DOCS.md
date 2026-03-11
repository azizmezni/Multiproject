# Telegram LLM Hub — Developer Documentation

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Module Descriptions](#module-descriptions)
3. [Shared Context Pattern](#shared-context-pattern)
4. [Provider Setup Guides](#provider-setup-guides)
5. [Workflow System](#workflow-system)
6. [Dashboard REST API](#dashboard-rest-api)
7. [Adding New Commands](#adding-new-commands)
8. [Database Schema](#database-schema)

---

## Architecture Overview

The project uses a **modular handler architecture** with dependency injection via a shared context object.

### Boot Sequence

```
index.js
  ├── createDashboard(port)   → Express server on :9999
  └── createBot(token)        → Telegraf bot
        ├── Build shared deps object
        ├── createHelpers(shared) → closures over deps
        ├── registerCore(bot, shared)
        ├── registerBoards(bot, shared)
        ├── registerWorkflows(bot, shared)
        ├── registerDrafts(bot, shared)
        ├── registerDevAssistant(bot, shared)
        ├── registerProviders(bot, shared)
        ├── registerAITools(bot, shared)
        ├── registerSocial(bot, shared)
        ├── registerMessages(bot, shared)  ← LAST (catch-all)
        └── setMyCommands([...])           ← Telegram menu
```

### Key Design Decisions

- **Handler registration order matters**: `messages.js` must be registered last because its `bot.on('text')` handler is a catch-all that processes any text not matched by a command.
- **Cross-module functions**: Some handlers expose functions for use by other handlers (e.g., `handleDevRequest` in dev-assistant.js is called by messages.js when processing awaited input). These are set on the `shared` object after registration.
- **Helpers factory**: `createHelpers(shared)` returns closures that have access to all shared dependencies, avoiding circular imports.

---

## Module Descriptions

### Data Layer Modules (`src/*.js`)

| Module | Purpose |
|--------|---------|
| `db.js` | SQLite connection via better-sqlite3, auto-creates tables |
| `sessions.js` | Chat session CRUD, message history, active session tracking |
| `boards.js` | Project board/task CRUD, execution status, input questions |
| `workflows.js` | Workflow/node/edge CRUD, topological execution, node types |
| `drafts.js` | Link draft storage, URL metadata fetching, link type detection |
| `llm-manager.js` | Multi-provider routing, fallback chains, per-user config |
| `providers.js` | 15 provider implementations (BaseProvider → specific classes) |
| `arena.js` | Simultaneous multi-provider battles, voting system |
| `memory.js` | Key-value knowledge base per user |
| `gamification.js` | XP, levels, achievements, leaderboard |
| `challenges.js` | Daily challenge generation, streak tracking |
| `cost-tracker.js` | Token usage logging, cost estimation per provider |
| `templates.js` | Workflow template CRUD, ratings, marketplace |
| `vault.js` | Encrypted secret storage per user |
| `collaboration.js` | Workflow sharing tokens, forking, public listing |
| `scheduler.js` | Cron-based workflow scheduling |
| `qa.js` | Task QA testing, shell command execution |
| `keyboards.js` | Telegram InlineKeyboard builders for all menus |
| `node-runner.js` | Sandboxed JavaScript execution for workflow nodes |
| `plugins.js` | Plugin system for extensibility |
| `settings.js` | User settings management |

### Handler Modules (`src/handlers/*.js`)

Each handler module exports a single `register*(bot, shared)` function that binds commands and callbacks to the Telegraf bot instance.

| Module | Responsibilities | Commands | Callbacks |
|--------|-----------------|----------|-----------|
| `core.js` | Welcome, help, navigation, status | 12 commands | 6 callbacks |
| `boards.js` | Board & task management | 5 commands | 9 callbacks |
| `workflows.js` | Workflow CRUD, execution, auto-fix | 11 commands | 18 callbacks |
| `drafts.js` | Smart link actions, draft board | 1 command | 17 callbacks |
| `dev-assistant.js` | AI feature/bug planning | 4 commands | 5 callbacks |
| `providers.js` | LLM provider configuration | 5 commands | 9 callbacks |
| `ai-tools.js` | One-shot AI tools | 8 commands | 0 callbacks |
| `social.js` | Memory, arena, stats, vault, sharing | 22 commands | 0 callbacks |
| `messages.js` | Text, photo, voice, inline queries | 0 commands | 4 event handlers |

### Utility Modules

| Module | Purpose |
|--------|---------|
| `bot-helpers.js` | `stripMd()` — escapes Markdown special chars; `safeSend()` — sends messages with Markdown fallback; `createHelpers(shared)` — factory returning helper closures |
| `dashboard.js` | Express app with 50+ REST endpoints, static file serving, subdomain proxying for sub-projects |

---

## Shared Context Pattern

All handler modules receive a `shared` object containing every dependency they might need. This avoids circular imports and makes testing easier.

```javascript
const shared = {
  // Data modules
  llm, sessions, userState, boards, drafts, qa, kb,
  PROVIDER_REGISTRY, workflows, NODE_TYPES,
  memory, arena, challenges, costTracker, gamification,
  templates, vault, collaboration,

  // Shared state
  pendingDevRequests,  // Map for dev-assistant request tracking

  // Utilities
  stripMd, safeSend,
  draftUtils: { extractUrl, fetchLinkMeta, detectLinkType },

  // Set after initialization
  helpers: null,          // createHelpers(shared) result
  handleDevRequest: null, // set by dev-assistant.js
  runAutoFix: null,       // set by workflows.js
};
```

### Cross-Module Function Sharing

Some handler modules define functions that need to be called from other handlers (specifically from `messages.js` which handles awaited user input):

1. **`shared.handleDevRequest`** — Defined in `dev-assistant.js`, called by `messages.js` when user provides feature/bugfix description
2. **`shared.runAutoFix`** — Defined in `workflows.js`, called by `messages.js` when user describes a workflow problem

These are set on `shared` during handler registration:

```javascript
// In dev-assistant.js
export function registerDevAssistant(bot, shared) {
  async function handleDevRequest(ctx, userId, type, description) { ... }
  shared.handleDevRequest = handleDevRequest;
  // ... register commands
}
```

### Adding Dependencies

To add a new data module to the shared context:

1. Create the module in `src/`
2. Import it in `src/bot.js`
3. Add it to the `shared` object
4. Access it in any handler via destructuring: `const { myModule } = shared;`

---

## Provider Setup Guides

### Anthropic Claude (Recommended)

```
/setkey claude sk-ant-api03-...
/setmodel claude claude-sonnet-4-20250514
```

Models: `claude-sonnet-4-20250514`, `claude-haiku-4-5-20251001`, `claude-opus-4-20250514`
Get key: https://console.anthropic.com/settings/keys

### OpenAI

```
/setkey openai sk-...
/setmodel openai gpt-4o
```

Models: `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`, `o3`, `o3-mini`, `o4-mini`
Get key: https://platform.openai.com/api-keys

### Google Gemini

```
/setkey gemini AIza...
/setmodel gemini gemini-2.5-pro
```

Models: `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.0-flash`, `gemini-2.0-pro`, `gemini-1.5-pro`
Get key: https://aistudio.google.com/app/apikey

### Mistral AI

```
/setkey mistral ...
/setmodel mistral mistral-large-latest
```

Models: `mistral-large-latest`, `mistral-medium-latest`, `mistral-small-latest`, `codestral-latest`, `pixtral-large-latest`
Get key: https://console.mistral.ai/api-keys/

### Groq

```
/setkey groq gsk_...
/setmodel groq llama-3.3-70b-versatile
```

Models: `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `deepseek-r1-distill-llama-70b`, `gemma2-9b-it`
Get key: https://console.groq.com/keys

### DeepSeek

```
/setkey deepseek sk-...
/setmodel deepseek deepseek-chat
```

Models: `deepseek-chat`, `deepseek-r1`, `deepseek-coder`, `deepseek-reasoner`
Get key: https://platform.deepseek.com/api_keys

Note: DeepSeek models use `<think>` tags for reasoning. These are automatically stripped from responses.

### xAI Grok

```
/setkey grok xai-...
/setmodel grok grok-3
```

Models: `grok-2`, `grok-2-mini`, `grok-3`, `grok-3-mini`
Get key: https://console.x.ai/

### Cohere

```
/setkey cohere ...
/setmodel cohere command-r-plus
```

Models: `command-r-plus`, `command-r`, `command-light`
Get key: https://dashboard.cohere.com/api-keys

### OpenRouter (Meta-Provider)

```
/setkey openrouter sk-or-...
/setmodel openrouter anthropic/claude-sonnet-4-20250514
```

Models: `anthropic/claude-sonnet-4-20250514`, `openai/gpt-4o`, `google/gemini-2.5-flash`, `meta-llama/llama-3.3-70b-instruct`, `deepseek/deepseek-r1`
Get key: https://openrouter.ai/keys

### Together AI

```
/setkey together ...
/setmodel together meta-llama/Llama-3.3-70B-Instruct-Turbo
```

Get key: https://api.together.ai/settings/api-keys

### Perplexity

```
/setkey perplexity pplx-...
/setmodel perplexity sonar-pro
```

Models: `sonar-pro`, `sonar`, `sonar-reasoning-pro`, `sonar-reasoning`
Get key: https://www.perplexity.ai/settings/api

### Fireworks AI

```
/setkey fireworks fw_...
/setmodel fireworks accounts/fireworks/models/llama-v3p3-70b-instruct
```

Get key: https://fireworks.ai/account/api-keys

### Cerebras

```
/setkey cerebras csk-...
/setmodel cerebras llama-3.3-70b
```

Models: `llama-3.3-70b`, `llama-3.1-8b`, `deepseek-r1-distill-llama-70b`
Get key: https://cloud.cerebras.ai/

### Ollama (Local)

No API key needed. Install Ollama and pull a model:

```bash
ollama pull llama3.2
ollama serve  # starts on port 11434
```

Then in the bot: `/setmodel ollama llama3.2`

### LM Studio (Local)

No API key needed. Download LM Studio, load a model, and start the local server (default port 1234).

Then in the bot: `/setmodel lmstudio default`

---

## Workflow System

### Node Types

The workflow engine supports 9 node types:

| Type | Description | Use Case |
|------|-------------|----------|
| `llm_prompt` | Send prompt to LLM, get response | Text generation, analysis |
| `script` | Execute JavaScript code | Data transformation, API calls |
| `api_call` | Make HTTP request | External API integration |
| `condition` | Branch based on expression | Conditional logic |
| `transform` | Transform data with expression | Data mapping |
| `input` | Accept user input | Interactive workflows |
| `output` | Produce final output | Results display |
| `loop` | Iterate over array | Batch processing |
| `aggregate` | Combine multiple inputs | Data merging |

### Workflow Lifecycle

1. **Create** — `/workflow <description>` auto-generates, or `/wfnew <title>` for manual
2. **Configure** — Add nodes, connect them, set inputs/outputs, add env vars
3. **Execute** — `/wfrun` executes nodes in topological order
4. **Auto-Fix** — `/wffix` uses AI to diagnose and fix failing nodes
5. **Share** — `/share <id>` creates a share token for collaboration
6. **Schedule** — Set up cron-based automatic execution via dashboard
7. **Template** — Save as template for reuse via `/templates`

### Auto-Fix Engine

The auto-fix system (`runAutoFix` in `workflows.js`):

1. Collects all failing nodes and their error messages
2. Builds context with node scripts, configs, and connections
3. Sends to LLM with a structured prompt requesting fixes
4. Parses LLM response for corrected scripts
5. Applies fixes and reports results

### Execution Model

Nodes execute in **topological order** (respecting edge dependencies). Each node receives:

- **Inputs** — Data from connected upstream nodes
- **Config** — Node-specific settings (env vars, scripts, prompts)
- **Context** — Workflow-level context (user ID, vault secrets)

Node results are stored and passed to downstream nodes via edges.

---

## Dashboard REST API

All endpoints are prefixed with `/api/` and served on the dashboard port (default 9999).

### Providers

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/providers` | List all providers with status |
| `PUT` | `/api/providers/:name/toggle` | Enable/disable a provider |
| `PUT` | `/api/providers/:name/reorder` | Change provider priority |
| `PUT` | `/api/providers/:name/key` | Set API key |
| `PUT` | `/api/providers/:name/model` | Set active model |
| `POST` | `/api/providers/:name/test` | Test provider connection |

### Boards

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/boards` | List boards for user |
| `POST` | `/api/boards` | Create board (AI-generated tasks) |
| `GET` | `/api/boards/:id` | Get board with tasks |
| `DELETE` | `/api/boards/:id` | Delete a board |
| `POST` | `/api/boards/:id/tasks` | Add task to board |
| `PUT` | `/api/tasks/:id` | Update task status |
| `PUT` | `/api/tasks/:id/answer` | Answer task input question |
| `POST` | `/api/tasks/:id/qa` | Run QA on task |
| `POST` | `/api/boards/:id/execute` | Execute all board tasks |

### Workflows

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/workflows` | List workflows for user |
| `POST` | `/api/workflows` | Create workflow (AI-generated) |
| `GET` | `/api/workflows/:id` | Get workflow with nodes/edges |
| `DELETE` | `/api/workflows/:id` | Delete workflow |
| `POST` | `/api/workflows/:id/nodes` | Add node |
| `PUT` | `/api/workflows/nodes/:id` | Update node |
| `GET` | `/api/workflows/nodes/:id/script` | Get node script |
| `PUT` | `/api/workflows/nodes/:id/script` | Update node script |
| `POST` | `/api/workflows/nodes/:id/test` | Test node execution |
| `POST` | `/api/workflows/nodes/:id/generate` | AI-generate node script |
| `POST` | `/api/workflows/nodes/:id/chat` | Chat with AI about node |
| `GET` | `/api/workflows/nodes/:id/result` | Get node execution result |
| `DELETE` | `/api/workflows/nodes/:id` | Delete node |
| `POST` | `/api/workflows/:id/edges` | Add edge between nodes |
| `DELETE` | `/api/workflows/edges/:id` | Delete edge |
| `GET` | `/api/node-types` | List available node types |
| `POST` | `/api/workflows/:id/export` | Export workflow as standalone app |
| `POST` | `/api/workflows/:id/execute` | Execute workflow |
| `GET` | `/api/workflows/:id/stream` | SSE stream for execution progress |
| `GET` | `/api/workflows/:id/history` | Execution history |
| `POST` | `/api/workflows/import` | Import workflow from JSON |

### Webhooks & Scheduling

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/workflows/:id/webhook` | Create webhook trigger |
| `DELETE` | `/api/workflows/:id/webhook` | Remove webhook |
| `POST` | `/api/webhook/:webhookId` | Trigger workflow via webhook |
| `GET` | `/api/schedules` | List scheduled workflows |
| `POST` | `/api/workflows/:id/schedule` | Schedule workflow (cron) |
| `PUT` | `/api/schedules/:id/toggle` | Enable/disable schedule |
| `DELETE` | `/api/schedules/:id` | Delete schedule |

### Drafts

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/drafts` | List drafts for user |
| `DELETE` | `/api/drafts/:id` | Delete a draft |
| `POST` | `/api/drafts/:id/expand` | AI-expand draft content |
| `POST` | `/api/drafts/:id/clone` | Clone linked repository |

### Sessions & Chat

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/sessions` | List chat sessions |
| `GET` | `/api/sessions/:id/messages` | Get session messages |
| `POST` | `/api/chat` | Send chat message, get AI response |

### Other

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/stats` | User stats (XP, level, achievements) |
| `POST` | `/api/run` | Execute shell command |
| `GET` | `/api/projects` | List managed sub-projects |
| `POST` | `/api/projects/:name/start` | Start a sub-project |
| `POST` | `/api/projects/:name/stop` | Stop a sub-project |
| `GET` | `/api/projects/:name/logs` | Get sub-project logs |
| `GET` | `/api/search` | Search across boards, workflows, sessions |

---

## Adding New Commands

### Step 1: Choose the Right Handler

Pick the handler module that best fits your command's domain:

- Chat/AI tools → `ai-tools.js`
- Board/task related → `boards.js`
- Workflow related → `workflows.js`
- Provider management → `providers.js`
- Stats/social/utility → `social.js`
- Core navigation → `core.js`

### Step 2: Add the Command

```javascript
// In the appropriate handler's register function:
bot.command('mycommand', async (ctx) => {
  const userId = ctx.from.id;
  llm.initDefaults(userId);  // if using LLM features

  const args = ctx.message.text.replace('/mycommand', '').trim();
  if (!args) return safeSend(ctx, 'Usage: /mycommand <args>');

  // Your logic here
  await safeSend(ctx, 'Result message', { parse_mode: 'Markdown' });
});
```

### Step 3: Add Callback Handlers (if needed)

```javascript
// Simple callback
bot.action('my_action', async (ctx) => {
  await ctx.answerCbQuery();
  // handle action
});

// Parameterized callback
bot.action(/my_action:(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = parseInt(ctx.match[1]);
  // handle action with id
});
```

### Step 4: Register in Telegram Menu

Add to the `setMyCommands` array in `src/bot.js`:

```javascript
{ command: 'mycommand', description: 'Short description for menu' },
```

Note: Telegram limits the menu to 100 commands, and descriptions must be 3-256 characters.

### Step 5: Add Keyboard Buttons (optional)

Add inline keyboard builders in `src/keyboards.js` if your command needs interactive menus.

### Awaited Input Pattern

If your command needs follow-up text input from the user:

```javascript
// In your handler — set awaiting state:
userState.setAwaiting(userId, 'my_custom_input:some_context');
await ctx.reply('Please enter your response:');

// In messages.js — handle the awaited input:
if (state.awaiting_input?.startsWith('my_custom_input:')) {
  const context = state.awaiting_input.split(':')[1];
  userState.clearAwaiting(userId);
  // process user's text response
  return;
}
```

---

## Database Schema

The project uses SQLite via better-sqlite3. Tables are auto-created on first run. Key tables include:

- **sessions** — Chat sessions per user
- **messages** — Chat message history
- **boards** — Project boards
- **tasks** — Board tasks with status, input questions, QA results
- **workflows** — Workflow definitions
- **workflow_nodes** — Individual workflow nodes
- **workflow_edges** — Node connections
- **drafts** — Saved link drafts with metadata
- **memories** — Key-value knowledge base entries
- **user_providers** — Per-user provider configuration
- **cost_logs** — Token usage and cost records
- **achievements** — User achievement/badge records
- **challenges** — Daily challenge tracking
- **vault_secrets** — Encrypted secret storage
- **shared_workflows** — Workflow sharing tokens
- **templates** — Workflow templates with ratings
- **schedules** — Cron-based workflow schedules

All tables use auto-incrementing integer primary keys and include `user_id` for multi-user isolation.
