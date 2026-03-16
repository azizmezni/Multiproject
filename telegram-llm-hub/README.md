# Telegram LLM Hub

Telegram bot + web dashboard for AI-powered development. Chat with 14+ LLM providers, generate complete runnable projects from ideas, manage task boards, build visual workflows, and let the bot improve its own code.

## Quick Start

### Prerequisites
- Node.js >= 18
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- At least one LLM provider (local LM Studio/Ollama works, or any cloud API key)

### Setup

```bash
git clone https://github.com/azizmezni/Multiproject.git
cd Multiproject/telegram-llm-hub
npm install
```

Create a `.env` file:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
DASHBOARD_PORT=9999

# Local providers (pick one or both — free, no API key needed)
LMSTUDIO_BASE_URL=http://localhost:1234/v1
OLLAMA_BASE_URL=http://localhost:11434

# Cloud providers (all optional — add any you have)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AI...
GROQ_API_KEY=gsk_...
DEEPSEEK_API_KEY=sk-...
MISTRAL_API_KEY=...
COHERE_API_KEY=...
XAI_API_KEY=xai-...
```

### Run

```bash
npm start        # Production
npm run dev      # Development (auto-reload)
start.bat        # Windows launcher (double-click)
```

Bot starts polling Telegram. Dashboard opens at **http://localhost:9999**.

---

## Features

### Multi-LLM Chat
Chat through Telegram with automatic provider fallback. If one provider fails, the next picks up seamlessly. Per-user configuration lets each user set their own API keys and model preferences.

**14 supported providers:** Claude, OpenAI, Gemini, Mistral, Groq, Cohere, DeepSeek, Grok, OpenRouter, Together, Perplexity, Fireworks, Cerebras + local Ollama & LM Studio.

### Project Generator
Turn an idea into a complete, runnable project:

1. `/project My Game Idea` — describe what you want
2. Add keypoints (features, tech stack choices)
3. Click **Generate** — LLM creates all project files in one shot
4. Click **Run** — auto-installs dependencies and runs the project live
5. If it crashes, use **Code Chat** or **Fix Bugs** for automatic repair

The dashboard project view has a side-by-side layout:
- **Left:** Run output with persistent logs (separated between runs)
- **Right:** Code Chat — talk to the LLM with full project file context
- **Center:** `=>` arrow sends the last crash log directly to chat for auto-fix
- **Terminal** button opens a real cmd window for interactive CLI programs (argparse, prompts, etc.)

Auto-detects Python dependencies from imports and generates `requirements.txt` if missing.

### Task Boards
`/new Build an e-commerce site` — AI breaks your project into executable tasks with detailed plans. Each task has:
- Detailed execution plan
- Individual execute/re-execute buttons
- Execution result logs
- QA testing with LLM-based review

### Workflow Engine
Visual node-based automation with 6 node types: process, input, output, decision, loop, script. Auto-generate workflows from plain text descriptions. Schedule with cron. Auto-fix failing nodes.

### Self-Improve
The bot modifies its own source code via LLM:
- **Telegram:** Tap `Self-Improve` on the main menu → describe what to add/fix
- **Dashboard:** Navigate to the Self-Improve section → chat interface
- The LLM reads all `src/` files, generates changes, writes them to disk
- Restart to apply. History of all improvements is saved.

Safety: only `src/` files can be modified. Database, node_modules, and .git are protected.

### Dev Assistant
`/feature add search to the dashboard` or `/bugfix export crashes on empty data` — AI scans the project, generates a detailed plan with code changes. Choose to apply all, refine the plan, or convert to a task board.

### Draft Board
Paste any link and get intelligent per-type actions:
- **GitHub repos:** One-click clone, analyze dependencies, generate tutorial
- **YouTube videos:** Summarize content
- **NPM packages:** Dependency analysis, install commands
- **APIs:** Auto-test endpoints
- **Articles:** Smart summarization

### LLM Arena
Battle multiple providers on the same prompt. Compare responses side-by-side, pick a winner, track stats over time.

### Gamification
XP system with levels, achievements, daily streaks, and a leaderboard. Earn XP for messages, task completions, board creation, and workflow runs.

### Other Features
- **Memory / Knowledge Base** — `/remember` and `/recall` for persistent facts
- **Vault** — Secure API key and secret storage for workflows
- **Cost Tracking** — Monitor API spend per provider
- **Collaboration** — Share and fork workflows between users
- **Scheduled Workflows** — Cron-based automatic execution
- **Vision** — Send photos for AI analysis (Claude, OpenAI, Gemini)
- **Plugin System** — Extensible workflow node types

---

## Telegram Commands

### Chat & AI
| Command | Description |
|---------|-------------|
| `/start` | Welcome & quick start guide |
| `/help` | Full command reference |
| `/chat [title]` | Start a new chat session |
| `/sessions` | List chat sessions |
| `/ask <question>` | Quick one-shot question |
| `/explain <text>` | Get a clear explanation |
| `/code <desc>` | Generate code |
| `/review <code>` | Review code for issues |
| `/translate <text>` | Translate text |
| `/summarize` | Summarize current session |

### Projects
| Command | Description |
|---------|-------------|
| `/project <idea>` | Create a new AI project |
| `/projects` | List your projects |
| `/new <name>` | Create a task board |
| `/boards` | List boards |
| `/board` | View active board |
| `/task <desc>` | Add task to active board |
| `/done <id>` | Mark task as done |

### Workflows
| Command | Description |
|---------|-------------|
| `/workflow <desc>` | Auto-generate workflow from description |
| `/wfnew <title>` | Create empty workflow |
| `/wflist` | List workflows |
| `/wfrun` | Execute active workflow |
| `/wffix` | Auto-fix failing nodes |
| `/templates` | Browse workflow templates |

### Dev & Self-Improve
| Command | Description |
|---------|-------------|
| `/feature <desc>` | Add a feature (AI code generation) |
| `/bugfix <desc>` | Fix a bug (AI diagnosis + fix) |
| `/f <desc>` | Quick feature shortcut |
| `/b <desc>` | Quick bugfix shortcut |

### Providers
| Command | Description |
|---------|-------------|
| `/providers` | Manage LLM providers |
| `/models` | View available models |
| `/setkey <provider> <key>` | Set API key |
| `/test <provider>` | Test provider connection |

### Memory, Arena & Stats
| Command | Description |
|---------|-------------|
| `/remember <key> = <value>` | Save to knowledge base |
| `/recall [query]` | Search knowledge base |
| `/arena <prompt>` | Battle providers head-to-head |
| `/stats` | Your XP, level, badges |
| `/costs` | Usage cost summary |

Full list: **47 commands**. Type `/help` in the bot for all of them.

---

## Dashboard Sections

Access at `http://localhost:9999`

| Section | What it does |
|---------|-------------|
| **Home** | XP progress ring, stats overview, streak counter |
| **Providers** | Add/remove/reorder LLM providers, set API keys, test connections |
| **Projects** | AI-generated projects — generate, run, view files, code chat, terminal |
| **Workflows** | Visual workflow builder with node graph editor |
| **Drafts** | Smart link analysis board |
| **Chat** | Web-based chat sessions with LLM |
| **Templates** | Workflow template marketplace |
| **Arena** | Multi-model battle arena |
| **Memory** | Persistent knowledge base with search |
| **Self-Improve** | Bot self-modification via LLM |
| **Challenges** | Daily XP challenges |
| **Costs** | API usage cost tracking per provider |
| **Vault** | Secure secrets storage |
| **Leaderboard** | User rankings |
| **Collaboration** | Share & fork workflows |
| **Plugins** | Workflow plugin management |
| **Achievements** | Badge collection |

---

## Supported Providers

| Provider | Type | Highlights |
|----------|------|------------|
| **Anthropic Claude** | Cloud | Best reasoning and coding (claude-sonnet-4, opus-4) |
| **OpenAI** | Cloud | GPT-4o, o3-mini |
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

---

## Architecture

```
telegram-llm-hub/
  src/
    index.js              # Entry — starts bot + dashboard on port 9999
    bot.js                # Telegraf bot setup, registers all handlers
    dashboard.js          # Express server, all REST API endpoints (~2300 LOC)
    llm-manager.js        # Multi-provider LLM with fallback chains
    providers.js          # 14 provider implementations + vision support
    db.js                 # SQLite schema (17 tables, WAL mode)
    keyboards.js          # All Telegram inline keyboard layouts
    sessions.js           # Chat session + user state management
    boards.js             # Task board CRUD + execution
    workflows.js          # Workflow engine with 6 node types
    project-manager.js    # Generated project CRUD
    auto-fix.js           # Run -> crash -> LLM fix -> retry engine
    bot-helpers.js        # safeSend, stripMd, shared helper factory
    drafts.js             # Link analysis + metadata fetching
    qa.js                 # QA testing for task outputs
    memory.js             # User knowledge base
    arena.js              # Multi-model battle system
    gamification.js       # XP, levels, achievements, streaks
    cost-tracker.js       # API spend tracking per provider
    templates.js          # Workflow template marketplace
    vault.js              # Secure key/secret storage
    collaboration.js      # Multi-user workflow sharing
    scheduler.js          # Cron-based workflow scheduling
    plugins.js            # Plugin system for workflow nodes
    settings.js           # User preferences
    node-runner.js        # Workflow node executor
    handlers/
      core.js             # /start, /help, /chat, /settings, /status
      boards.js           # Board + task operations
      workflows.js        # Workflow CRUD + execution
      drafts.js           # Smart draft handling
      gen-projects.js     # Project generation + code chat
      dev-assistant.js    # /feature, /bugfix code generation
      self-improve.js     # Bot self-modification via LLM
      providers.js        # Provider management
      ai-tools.js         # /ask, /code, /review, /translate
      social.js           # /remember, /arena, /stats, /achievements
      messages.js         # Catch-all text router (MUST be last)
    routes/
      features.js         # Additional dashboard feature routes
    public/
      index.html          # Dashboard HTML shell with sidebar nav
      app.js              # Frontend state, API client, section renderers
      styles.css          # Pixel-art / Game Dev Story aesthetic
  projects/               # Generated project output directory
  .env                    # API keys and config (not committed)
  start.bat               # Windows launcher
  package.json
```

### Database Tables (SQLite3, WAL mode)

| Table | Purpose |
|-------|---------|
| `providers` | User API keys, models, priority, enabled status |
| `sessions` | Chat sessions per user |
| `messages` | Chat message history |
| `boards` | Project boards (planning/executing/completed) |
| `tasks` | Board tasks with status, QA, execution logs |
| `drafts` | Saved links with type detection |
| `settings` | User config JSON |
| `user_state` | Active session/board/workflow per user |
| `gamification` | XP, level, streaks, achievements |
| `workflows` | Workflow definitions |
| `workflow_nodes` | Nodes with type, config, inputs/outputs |
| `workflow_edges` | Node-to-node connections |
| `workflow_schedules` | Cron-scheduled workflows |
| `workflow_run_history` | Execution logs |
| `workflow_templates` | Template marketplace |
| `arena_battles` | Multi-model battle results |
| `memory` | Knowledge base entries |
| `gen_projects` | AI-generated projects with chat history |
| `self_improvements` | Bot self-modification history |

---

## For AI Agents

If you're an AI agent working on this codebase, here's what you need to know.

### Key Patterns

**Handler registration:** Each `src/handlers/*.js` exports `registerXxx(bot, shared)` that receives all shared dependencies via a single `shared` object. Register in `src/bot.js` — `registerMessages` **must be last** (it's the catch-all).

**LLM fallback:** `llm.chat(userId, messages)` tries enabled providers in priority order. If one fails, it falls back to the next. Returns `{ text, provider, model }`.

**File generation format:** LLM responses use `===FILE: path===\ncontent\n===ENDFILE===` blocks for code generation/fixing. Fallback: fenced code blocks with filename (`` ```path.js ``).

**User state machine:** `userState.setAwaiting(userId, 'my_state')` routes the next text message to a handler. Clear with `userState.clearAwaiting(userId)`. Handle in `src/handlers/messages.js`.

**Partial DOM refresh:** Dashboard uses `updateProjectButtons(id, preservedLogs)` targeting elements by ID instead of full page re-renders, preserving logs and chat state.

**Log persistence:** Run output stays in memory via `persistedLogs` Map with `━━━` separators between runs. Logs are snapshot-copied to `persistedLogs` on process exit.

### Adding a Telegram Command

1. Create `src/handlers/my-feature.js`:
   ```javascript
   export function registerMyFeature(bot, shared) {
     const { llm, kb, userState } = shared;
     bot.command('mycmd', async (ctx) => {
       await ctx.reply('Hello!');
     });
     bot.action('my_callback', async (ctx) => {
       await ctx.answerCbQuery();
       // handle inline button press
     });
   }
   ```
2. Import and register in `src/bot.js` — **before** `registerMessages`
3. Add to `bot.telegram.setMyCommands([...])` in bot.js
4. Optionally add keyboard button in `src/keyboards.js`

### Adding a Dashboard Section

1. Add nav button in `src/public/index.html` sidebar
2. Add `mysection: renderMySection` to the `renderers` object in `src/public/app.js`
3. Create `async function renderMySection(el) { el.innerHTML = '...'; }`
4. Add API endpoints in `src/dashboard.js` (before the SPA fallback `app.get('*', ...)`)
5. Use `GET()`, `POST()`, `PUT()`, `DEL()` helpers from app.js to call your API

### Adding an LLM Provider

1. Add entry to `PROVIDER_REGISTRY` in `src/providers.js`
2. Create provider class extending `BaseProvider` or `OpenAICompatibleProvider`
3. Add env var for API key in `.env`
4. Add to `_buildProvider()` switch in `src/llm-manager.js`

### Database Changes

- Schema lives in `src/db.js` in the `db.exec()` block
- Uses `CREATE TABLE IF NOT EXISTS` — safe to add new tables
- All JSON fields (keypoints, chat_history, etc.) are stored as TEXT and parsed on read

### Safety Rules

- Self-Improve only edits `src/` files — rejects paths with `..` or outside src
- Chat history is poisoned-filtered: assistant messages containing "cannot access files" are stripped before LLM calls
- File parsing rejects `..` traversal and absolute paths
- Generated projects run in isolated `projects/` subdirectories
- `persistedLogs` are in-memory only — server restart clears them
- `<think>` tags from reasoning models (Qwen, DeepSeek) are auto-stripped

### Testing

```bash
# Verify all modules load without errors
node -e "import('./src/bot.js').then(() => console.log('bot OK'))"
node -e "import('./src/dashboard.js').then(() => console.log('dashboard OK'))"

# Start in dev mode (auto-reload on file changes)
npm run dev
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Bot framework | Telegraf v4.16 |
| Web server | Express v4.21 |
| Database | better-sqlite3 (WAL mode) |
| Environment | dotenv |
| Runtime | Node.js >= 18 (ESM modules) |
| Frontend | Vanilla JS/CSS, pixel-art aesthetic |
| LLM | 14 providers with automatic fallback |

## License

MIT
