# Telegram LLM Hub

Multi-model AI assistant via Telegram with a gamified web dashboard, n8n-style workflow builder, project boards, automatic provider fallback, QA testing, and draft management.

## Quick Setup

1. **Create a Telegram Bot** via [@BotFather](https://t.me/BotFather) - send `/newbot` and copy the token
2. Copy `.env.example` to `.env` and set your bot token and API keys
3. Install & run:

```bash
cd telegram-llm-hub
npm install
npm start
```

4. Open the dashboard at **http://localhost:9999**
5. Message your bot on Telegram and send `/start`

> The dashboard works even without a Telegram bot token (dashboard-only mode).

## Features

### Multi-LLM Chat with Fallback
- Chat with 10 LLM providers through a single interface
- Automatic fallback: if one provider hits a rate limit, the next one is tried
- Reorderable provider list to set priority
- Cloud providers fall back to local solutions (Ollama / LM Studio)

### Web Dashboard (port 9999)
- Dark-themed UI with glass-morphism and particle animations
- 7 sections: Home, Providers, Boards, Workflows, Drafts, Chat, Achievements
- Configure providers, API keys, and models from the browser
- Full chat interface with session management

### Gamification System
- XP and leveling (10 levels from Novice to Ascended)
- 15 achievements to unlock (First Steps, Board Master, Workflow Wizard, etc.)
- Daily streak tracking
- Progress ring and stats on the dashboard home

### Project Boards (Trello-style)
- AI auto-generates task boards from project descriptions
- Kanban view with Pending / In Progress / Done columns
- Tasks can require user input before execution
- Execute mode runs all tasks sequentially with AI
- QA testing per task (CLI tests + vision verification)

### Workflow Builder (n8n-style)
- Visual node-based editor with drag-and-drop
- 9 node types: Input, Process, Code, API, File, Decision, Output, CLI, Merge
- Connect nodes by clicking output/input ports
- Auto-generate workflows from natural language descriptions
- **Node detail panel**: double-click a node to see a split view with:
  - Left: node configuration (name, description, inputs, outputs)
  - Right: generated code/prompt preview + test runner
- Test individual nodes with custom JSON input and see results
- Execute entire workflows with topological ordering

### Draft Board
- Share links in Telegram chat to save them to the draft board
- Options: clone as board, generate plan, expand idea, run CLI commands

### Vision Mode
- Send photos to the Telegram bot for AI analysis
- Vision fallback across providers that support it

## Supported Providers

### Cloud Providers

| # | Provider | Docs | Models |
|---|----------|------|--------|
| 1 | **Anthropic Claude** | [docs.anthropic.com](https://docs.anthropic.com/en/docs/initial-setup) | claude-sonnet-4-20250514, claude-haiku-4-5-20251001, claude-opus-4-20250514 |
| 2 | **OpenAI** | [platform.openai.com](https://platform.openai.com/docs/quickstart) | gpt-4o, gpt-4o-mini, gpt-4-turbo, o1, o1-mini |
| 3 | **Google Gemini** | [ai.google.dev](https://ai.google.dev/gemini-api/docs/quickstart) | gemini-2.0-flash, gemini-2.0-pro, gemini-1.5-pro |
| 4 | **Mistral AI** | [docs.mistral.ai](https://docs.mistral.ai/getting-started/quickstart/) | mistral-large-latest, mistral-medium-latest, codestral-latest |
| 5 | **Groq** | [console.groq.com](https://console.groq.com/docs/quickstart) | llama-3.1-70b-versatile, llama-3.1-8b-instant, mixtral-8x7b-32768 |
| 6 | **Cohere** | [docs.cohere.com](https://docs.cohere.com/docs/the-cohere-platform) | command-r-plus, command-r, command-light |
| 7 | **DeepSeek** | [platform.deepseek.com](https://platform.deepseek.com/api-docs) | deepseek-chat, deepseek-coder, deepseek-reasoner |
| 8 | **xAI Grok** | [docs.x.ai](https://docs.x.ai/docs/overview) | grok-2, grok-2-mini |

### Local Providers (Fallback)

| # | Provider | Docs | Setup |
|---|----------|------|-------|
| 9 | **Ollama** | [ollama.ai](https://ollama.ai/download) | Install Ollama, run `ollama pull llama3.1`, starts on port 11434 |
| 10 | **LM Studio** | [lmstudio.ai](https://lmstudio.ai/docs) | Install LM Studio, download a model, start local server on port 1234 |

## Setting API Keys

**Option 1 - .env file:**
```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AI...
```

**Option 2 - Telegram commands:**
```
/setkey openai sk-your-key-here
/setkey gemini AIza-your-key-here
```

**Option 3 - Dashboard UI:**
Open http://localhost:9999, go to Providers, and click the key icon next to any provider.

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome & setup |
| `/chat [title]` | Start new chat session |
| `/new <project>` | Create project board with AI-generated tasks |
| `/boards` | List all project boards |
| `/board` | View active board |
| `/workflow` | View current workflow |
| `/wfnew <description>` | Create workflow from description |
| `/wflist` | List all workflows |
| `/wfnode <name>` | Add a node to current workflow |
| `/wfconnect <from> <to>` | Connect two nodes |
| `/wfrun` | Execute current workflow |
| `/sessions` | List chat sessions |
| `/drafts` | View draft board |
| `/providers` | Manage & reorder LLM providers |
| `/setkey <provider> <key>` | Set API key for a provider |
| `/settings` | Configuration menu |
| `/qa <task_id>` | Run QA tests for a task |
| `/run <command>` | Execute a CLI command |
| `/menu` | Show main menu |
| `/help` | Show help |

## How Fallback Works

Providers are tried in priority order (configurable via `/providers` or the dashboard):

```
Claude -> OpenAI -> Gemini -> Mistral -> Groq -> Cohere -> DeepSeek -> Grok -> Ollama -> LM Studio
```

If Claude hits a rate limit, it automatically tries OpenAI, then Gemini, etc. When all cloud providers fail, it falls back to local solutions (Ollama/LM Studio). Reorder or disable providers at any time.

## Workflow Builder

The workflow builder lets you create automation pipelines similar to n8n:

1. **Create a workflow** - describe what it should do, or start empty
2. **Add nodes** - each node has a type (process, code, API, etc.) with inputs and outputs
3. **Connect nodes** - click an output port, then an input port to create a connection
4. **Inspect nodes** - double-click a node to see its generated code/prompt and test it
5. **Run the workflow** - nodes execute in topological order, passing data between connections

### Node Types

| Type | Description |
|------|-------------|
| **Input** | Starting data or user-provided values |
| **Process** | LLM-powered text processing |
| **Code** | JavaScript code execution |
| **API** | HTTP requests to external services |
| **File** | Read/write file operations |
| **Decision** | Conditional branching |
| **Output** | Final results |
| **CLI** | Shell command execution |
| **Merge** | Combine outputs from multiple nodes |

## Project Structure

```
telegram-llm-hub/
  src/
    index.js          # Entry point - starts bot + dashboard
    bot.js            # Telegram bot handlers and commands
    dashboard.js      # Express web server and REST API
    db.js             # SQLite database schema and connection
    providers.js      # 10 LLM provider implementations
    llm-manager.js    # Provider fallback and routing logic
    boards.js         # Project board and task management
    workflows.js      # Workflow engine with node execution
    sessions.js       # Chat session management
    drafts.js         # Draft/link management
    gamification.js   # XP, levels, achievements, streaks
    qa.js             # QA testing (CLI + vision)
    keyboards.js      # Telegram inline keyboard builders
    settings.js       # User settings store
    public/
      index.html      # Dashboard SPA shell
      app.js          # Dashboard frontend logic
      styles.css      # Dark theme with animations
  package.json
  .env                # API keys and config (not committed)
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | No* | Telegram bot token from @BotFather |
| `ANTHROPIC_API_KEY` | No | Claude API key |
| `OPENAI_API_KEY` | No | OpenAI API key |
| `GEMINI_API_KEY` | No | Google Gemini API key |
| `MISTRAL_API_KEY` | No | Mistral AI API key |
| `GROQ_API_KEY` | No | Groq API key |
| `COHERE_API_KEY` | No | Cohere API key |
| `DEEPSEEK_API_KEY` | No | DeepSeek API key |
| `XAI_API_KEY` | No | xAI Grok API key |
| `OLLAMA_BASE_URL` | No | Ollama endpoint (default: http://localhost:11434) |
| `LMSTUDIO_BASE_URL` | No | LM Studio endpoint (default: http://localhost:1234) |
| `DASHBOARD_PORT` | No | Dashboard port (default: 9999) |

*Without a bot token, the app runs in dashboard-only mode.

## License

MIT
