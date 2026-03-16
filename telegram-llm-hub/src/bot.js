import { Telegraf } from 'telegraf';
import db from './db.js';
import { llm } from './llm-manager.js';
import { sessions, userState } from './sessions.js';
import { boards } from './boards.js';
import { drafts, extractUrl, fetchLinkMeta, detectLinkType, fetchSocialContent } from './drafts.js';
import { qa } from './qa.js';
import { kb } from './keyboards.js';
import { PROVIDER_REGISTRY } from './providers.js';
import { workflows, NODE_TYPES } from './workflows.js';
import { memory } from './memory.js';
import { arena } from './arena.js';
import { challenges } from './challenges.js';
import { costTracker } from './cost-tracker.js';
import { gamification } from './gamification.js';
import { templates } from './templates.js';
import { vault } from './vault.js';
import { collaboration } from './collaboration.js';

// Helpers
import { stripMd, safeSend, createHelpers } from './bot-helpers.js';

// Handler modules
import { registerCore } from './handlers/core.js';
import { registerBoards } from './handlers/boards.js';
import { registerWorkflows } from './handlers/workflows.js';
import { registerDrafts } from './handlers/drafts.js';
import { registerDevAssistant } from './handlers/dev-assistant.js';
import { registerProviders } from './handlers/providers.js';
import { registerAITools } from './handlers/ai-tools.js';
import { registerSocial } from './handlers/social.js';
import { registerGenProjects } from './handlers/gen-projects.js';
import { registerSelfImprove } from './handlers/self-improve.js';
import { registerMessages } from './handlers/messages.js';

export function createBot(token) {
  const bot = new Telegraf(token);

  // Self-heal: reset any boards stuck in 'executing' state from previous crash
  try {
    const fixed = db.prepare("UPDATE boards SET status = 'planning' WHERE status = 'executing'").run();
    if (fixed.changes > 0) console.log(`\ud83d\udd27 Fixed ${fixed.changes} stuck board(s)`);
  } catch { /* non-critical */ }

  // Shared dependency object — passed to all handler modules
  const pendingDevRequests = new Map();
  const runningBoards = new Map();   // userId → boardId, tracks which board is executing per user
  const shared = {
    llm, sessions, userState, boards, drafts, qa, kb,
    PROVIDER_REGISTRY, workflows, NODE_TYPES,
    memory, arena, challenges, costTracker, gamification,
    templates, vault, collaboration,
    pendingDevRequests, runningBoards, stripMd, safeSend,
    draftUtils: { extractUrl, fetchLinkMeta, detectLinkType, fetchSocialContent },
    helpers: null,          // set below
    handleDevRequest: null, // set by dev-assistant handler
    runAutoFix: null,       // set by workflows handler
  };

  // Build helpers (closures over shared deps)
  shared.helpers = createHelpers(shared);

  // Register all handler modules (order matters — messages LAST)
  registerCore(bot, shared);
  registerBoards(bot, shared);
  registerWorkflows(bot, shared);
  registerDrafts(bot, shared);
  registerDevAssistant(bot, shared);
  registerProviders(bot, shared);
  registerAITools(bot, shared);
  registerSocial(bot, shared);
  registerGenProjects(bot, shared);
  registerSelfImprove(bot, shared);
  registerMessages(bot, shared);  // catch-all text handler — must be last

  // Register Telegram command menu (visible via / button)
  bot.telegram.setMyCommands([
    // Chat & AI
    { command: 'start', description: 'Welcome & quick start guide' },
    { command: 'help', description: 'Full command reference' },
    { command: 'chat', description: 'Start a new chat session' },
    { command: 'sessions', description: 'List chat sessions' },
    { command: 'ask', description: 'Quick one-shot question' },
    { command: 'explain', description: 'Explain a concept or code' },
    { command: 'code', description: 'Generate code from description' },
    { command: 'review', description: 'Review code for issues' },
    { command: 'translate', description: 'Translate text' },
    { command: 'summarize', description: 'Summarize current session' },
    // Projects
    { command: 'project', description: 'Create a project from an idea' },
    { command: 'projects', description: 'List your projects' },
    // Boards
    { command: 'new', description: 'Create a project board' },
    { command: 'boards', description: 'List your boards' },
    { command: 'board', description: 'View active board' },
    { command: 'task', description: 'Add task to active board' },
    { command: 'done', description: 'Mark task as done' },
    // Workflows
    { command: 'workflow', description: 'Auto-generate a workflow' },
    { command: 'wfnew', description: 'Create empty workflow' },
    { command: 'wflist', description: 'List workflows' },
    { command: 'wfview', description: 'View active workflow' },
    { command: 'wfrun', description: 'Execute workflow' },
    { command: 'wffix', description: 'Auto-fix failing nodes' },
    // Dev Assistant
    { command: 'feature', description: 'Add a feature to the project' },
    { command: 'bugfix', description: 'Fix a bug in the project' },
    // Providers
    { command: 'providers', description: 'Manage LLM providers' },
    { command: 'models', description: 'View available models' },
    { command: 'setkey', description: 'Set API key for a provider' },
    { command: 'setmodel', description: 'Change model for a provider' },
    { command: 'test', description: 'Test a provider connection' },
    // Social & Stats
    { command: 'status', description: 'Quick overview dashboard' },
    { command: 'stats', description: 'Your XP, level, badges' },
    { command: 'arena', description: 'Battle LLM providers' },
    { command: 'costs', description: 'Usage cost summary' },
    { command: 'remember', description: 'Save to knowledge base' },
    { command: 'recall', description: 'Search knowledge base' },
    // Utility
    { command: 'settings', description: 'Open settings menu' },
    { command: 'drafts', description: 'View draft board' },
    { command: 'templates', description: 'Browse workflow templates' },
    { command: 'ping', description: 'Check bot is alive' },
    { command: 'dashboard', description: 'Get dashboard URL' },
  ]).catch(err => console.error('setMyCommands failed:', err.message));

  return bot;
}
