# Telegram LLM Hub

Multi-model AI assistant for Telegram with project boards, automated workflows, smart drafts, and a web dashboard. Chat with 15+ LLM providers, manage development tasks, and collaborate — all from Telegram.

## Features

- **Multi-LLM Chat** — Claude, OpenAI, Gemini, Mistral, Groq, DeepSeek, Grok, and 8 more providers with per-user configuration and fallback chains
- **Project Boards** — Create Kanban-style boards with AI-generated tasks, input questions, and automated execution
- **Workflow Engine** — Visual node-based workflows with 9 node types, auto-generation from descriptions, auto-fix, scheduling, and webhooks
- **Smart Drafts** — Share any link and get intelligent actions: clone repos, summarize articles, generate tutorials, test APIs
- **Dev Assistant** — Describe features or bugs in plain English, get AI-generated implementation plans with code
- **Arena Mode** — Battle LLM providers head-to-head on the same prompt, vote for winners
- **Knowledge Base** — Save and recall information across sessions with `/remember` and `/recall`
- **Gamification** — XP system, daily challenges, streaks, achievements, and leaderboards
- **Cost Tracking** — Per-provider usage and cost monitoring
- **Secret Vault** — Securely store API keys and secrets for use in workflows
- **Collaboration** — Share workflows publicly, fork others' workflows
- **Voice Messages** — Whisper-powered transcription with AI responses
- **Vision** — Send photos for AI analysis (supported providers)
- **Web Dashboard** — Full-featured UI at `localhost:9999` with project management, workflow editor, and real-time execution
- **Inline Queries** — Search boards and workflows from any Telegram chat

## Quick Start

### 1. Create a Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token

### 2. Install & Configure

```bash
git clone https://github.com/azizmezni/Multiproject.git
cd Multiproject/telegram-llm-hub
npm install
```

Create a `.env` file:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
DASHBOARD_PORT=9999

# Add API keys for providers you want to use (all optional)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
```

### 3. Run

```bash
npm start        # Production
npm run dev      # Development (auto-reload)
```

The bot will start polling Telegram and the dashboard will be available at `http://localhost:9999`.

## Commands

### Chat & AI

| Command | Description |
|---------|-------------|
| `/start` | Welcome & quick start guide |
| `/help` | Full command reference |
| `/chat [title]` | Start a new chat session |
| `/sessions` | List chat sessions |
| `/ask <question>` | Quick one-shot question (no session context) |
| `/explain <text>` | Get a clear explanation of a concept or code |
| `/code <desc>` | Generate code from a description |
| `/review <code>` | Review code for issues (or reply to a message) |
| `/translate <text>` | Translate text (add `to <lang>` for target language) |
| `/summarize` | Summarize the current session |
| `/rename <title>` | Rename current session |
| `/clear` | Clear session messages |
| `/export` | Export session as text |

### Project Boards

| Command | Description |
|---------|-------------|
| `/new <name>` | Create a project board |
| `/boards` | List your boards |
| `/board` | View active board |
| `/task <desc>` | Add task to active board |
| `/done <id>` | Mark task as done |

### Workflows

| Command | Description |
|---------|-------------|
| `/workflow <desc>` | Auto-generate a workflow from description |
| `/wfnew <title>` | Create empty workflow |
| `/wflist` | List workflows |
| `/wfview` | View active workflow |
| `/wfrun` | Execute workflow |
| `/wffix` | Auto-fix failing nodes |
| `/wfnode <wf_id> <type> <name>` | Add node manually |
| `/wfconnect <from> <to>` | Connect two nodes |
| `/wfinput <node_id> <inputs>` | Set node inputs |
| `/wfoutput <node_id> <outputs>` | Set node outputs |
| `/wfdelete <id>` | Delete a workflow |
| `/templates` | Browse workflow templates |
| `/usetemplate <id>` | Create workflow from template |

### Dev Assistant

| Command | Description |
|---------|-------------|
| `/feature <desc>` | Add a feature (AI-planned implementation) |
| `/bugfix <desc>` | Fix a bug (AI-analyzed fix plan) |
| `/f <desc>` | Quick feature shortcut |
| `/b <desc>` | Quick bugfix shortcut |

### LLM Providers

| Command | Description |
|---------|-------------|
| `/providers` | Manage LLM providers (interactive menu) |
| `/models` | View available models per provider |
| `/setkey <provider> <key>` | Set API key for a provider |
| `/setmodel <provider> <model>` | Change active model |
| `/test <provider>` | Test provider connection |

### Memory & Knowledge

| Command | Description |
|---------|-------------|
| `/remember <key> = <value>` | Save to knowledge base |
| `/recall [query]` | Search knowledge base (or list all) |
| `/forget <id>` | Delete a memory |

### Arena & Gamification

| Command | Description |
|---------|-------------|
| `/arena <prompt>` | Battle all enabled providers simultaneously |
| `/vote <battle_id> <provider>` | Vote for arena winner |
| `/stats` | Your XP, level, badges |
| `/challenges` | Daily challenge progress |
| `/leaderboard` | Top users ranking |
| `/costs` | Usage cost summary (30 days) |

### Vault & Collaboration

| Command | Description |
|---------|-------------|
| `/vault` | View stored secrets |
| `/vaultset <name> <value>` | Store a secret |
| `/vaultdel <id>` | Delete a secret |
| `/share <wf_id>` | Share a workflow publicly |
| `/unshare <wf_id>` | Unshare a workflow |
| `/browse` | Browse public workflows |
| `/fork <token>` | Fork a shared workflow |
| `/myshares` | List your shared workflows |

### Utility

| Command | Description |
|---------|-------------|
| `/status` | Quick overview dashboard |
| `/settings` | Open settings menu |
| `/drafts` | View draft board |
| `/ping` | Check bot latency |
| `/id` | Show your user/chat ID |
| `/dashboard` | Get dashboard URL |
| `/menu` / `/m` | Main menu |
| `/qa <task_id>` | Run QA tests on a task |
| `/run <command>` | Execute a shell command |

## Supported Providers

| Provider | Type | Highlights |
|----------|------|------------|
| **Anthropic Claude** | Cloud | Best-in-class reasoning and coding |
| **OpenAI** | Cloud | GPT-4o, o3, o4-mini |
| **Google Gemini** | Cloud | 1M+ token context, multimodal |
| **Mistral AI** | Cloud | Fast European models, great for code |
| **Groq** | Cloud | Ultra-fast LPU inference |
| **DeepSeek** | Cloud | Strong coding, math, reasoning |
| **xAI Grok** | Cloud | Real-time knowledge from X |
| **Cohere** | Cloud | Enterprise RAG and search |
| **OpenRouter** | Cloud | 200+ models, one API key |
| **Together AI** | Cloud | Fast open-model serverless |
| **Perplexity** | Cloud | Search-augmented with citations |
| **Fireworks AI** | Cloud | Ultra-fast serverless |
| **Cerebras** | Cloud | Fastest inference (wafer-scale) |
| **Ollama** | Local | Run open models locally via CLI |
| **LM Studio** | Local | Desktop app for local models |

## Architecture

```
telegram-llm-hub/
├── src/
│   ├── index.js              # Entry point — starts bot + dashboard
│   ├── bot.js                # Bot orchestrator — wires all handlers
│   ├── bot-helpers.js        # Shared utilities (safeSend, stripMd, helpers factory)
│   ├── handlers/
│   │   ├── core.js           # /start, /help, /chat, /sessions, /settings, /status
│   │   ├── boards.js         # Board & task commands + callbacks
│   │   ├── workflows.js      # Workflow commands + auto-fix engine
│   │   ├── drafts.js         # Smart link handling + draft actions
│   │   ├── dev-assistant.js  # /feature, /bugfix + AI planning
│   │   ├── providers.js      # Provider management commands + callbacks
│   │   ├── ai-tools.js       # /ask, /explain, /code, /review, /translate
│   │   ├── social.js         # Memory, arena, stats, vault, collaboration
│   │   └── messages.js       # Catch-all: text, photo, voice, inline queries
│   ├── dashboard.js          # Express web dashboard + REST API
│   ├── db.js                 # SQLite database (better-sqlite3)
│   ├── llm-manager.js        # Multi-provider LLM routing + fallback
│   ├── providers.js          # 15 LLM provider implementations
│   ├── sessions.js           # Chat session management
│   ├── boards.js             # Board/task data layer
│   ├── workflows.js          # Workflow engine + node execution
│   ├── node-runner.js        # Sandboxed node script execution
│   ├── drafts.js             # Draft management + link metadata
│   ├── keyboards.js          # Telegram inline keyboard builders
│   ├── arena.js              # Provider battle system
│   ├── memory.js             # Knowledge base storage
│   ├── gamification.js       # XP, levels, achievements
│   ├── challenges.js         # Daily challenge system
│   ├── cost-tracker.js       # Usage cost tracking
│   ├── templates.js          # Workflow template marketplace
│   ├── vault.js              # Secret storage
│   ├── collaboration.js      # Workflow sharing + forking
│   ├── scheduler.js          # Cron-based workflow scheduling
│   ├── qa.js                 # QA testing + CLI runner
│   ├── plugins.js            # Plugin system
│   └── settings.js           # User settings management
├── public/                   # Dashboard frontend (HTML/CSS/JS)
├── data/                     # SQLite database files
├── package.json
└── .env                      # Configuration (not committed)
```

## Dashboard

Access the web dashboard at `http://localhost:9999` for:

- **Boards** — Visual Kanban board management
- **Workflows** — Node graph editor with drag-and-drop
- **Chat** — Web-based chat interface
- **Providers** — Visual provider configuration
- **Drafts** — Link management and smart actions
- **Projects** — Sub-project management with subdomain proxying
- **Stats** — Usage analytics and cost breakdown

## Tech Stack

- **Runtime**: Node.js 18+
- **Bot Framework**: [Telegraf](https://github.com/telegraf/telegraf) v4.16
- **Database**: SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- **Dashboard**: [Express](https://expressjs.com/) + vanilla HTML/CSS/JS
- **Config**: [dotenv](https://github.com/motdotla/dotenv)

## License

MIT
