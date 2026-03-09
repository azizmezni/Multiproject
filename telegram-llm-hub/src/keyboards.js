import { Markup } from 'telegraf';
import { PROVIDER_REGISTRY } from './providers.js';

const STATUS_EMOJI = {
  pending: '\u2b1c',     // white square
  in_progress: '\ud83d\udd35', // blue circle
  done: '\u2705',         // green check
  planning: '\ud83d\udcdd', // memo
  executing: '\u26a1',    // lightning
  completed: '\u2705',
};

const QA_EMOJI = {
  pending: '\u23f3',   // hourglass
  running: '\ud83d\udd04', // arrows
  pass: '\u2705',      // check
  fail: '\u274c',      // cross
};

export const kb = {
  // Main menu
  mainMenu() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('\ud83d\udcac New Chat', 'new_chat')],
      [Markup.button.callback('\ud83d\udccb My Boards', 'list_boards'), Markup.button.callback('\ud83d\udce5 Drafts', 'list_drafts')],
      [Markup.button.callback('\ud83d\udd27 Workflows', 'list_workflows'), Markup.button.callback('\ud83d\udd27 Providers', 'providers')],
      [Markup.button.callback('🚀 Add Feature', 'dev_feature'), Markup.button.callback('🐛 Fix Bug', 'dev_bugfix')],
      [Markup.button.callback('\u2699\ufe0f Settings', 'settings'), Markup.button.callback('\u2753 Help', 'help')],
    ]);
  },

  // Provider list with controls
  providerList(providers) {
    const buttons = [];
    for (const p of providers) {
      const status = p.enabled ? '\u2705' : '\u274c';
      const type = p.is_local ? '\ud83c\udfe0' : '\u2601\ufe0f';
      buttons.push([
        Markup.button.callback(`${status} ${type} ${p.display_name}`, `toggle_prov:${p.name}`),
        Markup.button.callback('\u2b06\ufe0f', `prov_up:${p.name}`),
        Markup.button.callback('\u2b07\ufe0f', `prov_down:${p.name}`),
      ]);
    }
    buttons.push([
      Markup.button.callback('\ud83d\udd11 Set API Key', 'set_api_key'),
      Markup.button.callback('\ud83d\udcca Models', 'change_model'),
    ]);
    buttons.push([Markup.button.callback('\u25c0\ufe0f Back', 'main_menu')]);
    return Markup.inlineKeyboard(buttons);
  },

  // Provider selection for API key setup
  providerSelect(action = 'setkey') {
    const buttons = Object.entries(PROVIDER_REGISTRY)
      .filter(([, v]) => !v.isLocal)
      .map(([name, v]) => [Markup.button.callback(v.name, `${action}:${name}`)]);
    buttons.push([Markup.button.callback('\u25c0\ufe0f Back', 'providers')]);
    return Markup.inlineKeyboard(buttons);
  },

  // Model selection for a provider
  modelSelect(providerName) {
    const reg = PROVIDER_REGISTRY[providerName];
    if (!reg) return null;
    const buttons = reg.models.map(m => [Markup.button.callback(m, `select_model:${providerName}:${m}`)]);
    buttons.push([Markup.button.callback('\u25c0\ufe0f Back', 'providers')]);
    return Markup.inlineKeyboard(buttons);
  },

  // Board view with tasks
  boardView(boardId, tasks, boardStatus) {
    const buttons = [];

    for (const t of tasks) {
      const statusE = STATUS_EMOJI[t.status] || '\u2b1c';
      const qaE = QA_EMOJI[t.qa_status] || '';
      const needsInput = (t.requires_input && !t.input_answer) ? '\u2753' : '';
      const label = `${statusE}${qaE}${needsInput} ${t.title}`.substring(0, 50);
      buttons.push([Markup.button.callback(label, `task_detail:${t.id}`)]);
    }

    const actions = [];
    if (boardStatus === 'planning') {
      actions.push(Markup.button.callback('\u26a1 Execute All', `exec_board:${boardId}`));
    }
    actions.push(Markup.button.callback('\ud83d\udd04 Refresh', `view_board:${boardId}`));
    if (actions.length) buttons.push(actions);

    buttons.push([Markup.button.callback('\u25c0\ufe0f Back to Boards', 'list_boards')]);
    return Markup.inlineKeyboard(buttons);
  },

  // Task detail view
  taskDetail(task) {
    const buttons = [];

    if (task.status === 'pending') {
      buttons.push([Markup.button.callback('\u25b6\ufe0f Start Task', `start_task:${task.id}`)]);
    }
    if (task.status === 'in_progress') {
      buttons.push([Markup.button.callback('\u2705 Mark Done', `done_task:${task.id}`)]);
    }
    if (task.requires_input && !task.input_answer) {
      buttons.push([Markup.button.callback('\u2753 Answer Question', `answer_task:${task.id}`)]);
    }

    buttons.push([
      Markup.button.callback('\ud83e\uddea Run QA', `qa_task:${task.id}`),
      Markup.button.callback('\ud83d\udcac Discuss', `discuss_task:${task.id}`),
    ]);
    buttons.push([Markup.button.callback('\u25c0\ufe0f Back to Board', `view_board:${task.board_id}`)]);

    return Markup.inlineKeyboard(buttons);
  },

  // Smart draft actions based on link type
  draftActions(draftId, linkType = 'website') {
    const buttons = [];

    // Smart actions based on link type
    if (['github_repo', 'github', 'github_code'].includes(linkType)) {
      buttons.push([Markup.button.callback('📥 Clone & Setup', `smart_clone:${draftId}`)]);
      buttons.push([Markup.button.callback('🔍 Analyze Repo', `smart_analyze:${draftId}`)]);
    }
    if (linkType === 'youtube' || linkType === 'youtube_playlist') {
      buttons.push([Markup.button.callback('📺 Summarize Video', `smart_summarize:${draftId}`)]);
      buttons.push([Markup.button.callback('📋 Extract Tutorial Steps', `smart_tutorial:${draftId}`)]);
    }
    if (linkType === 'npm' || linkType === 'pypi') {
      buttons.push([Markup.button.callback('📦 Install Package', `smart_install:${draftId}`)]);
      buttons.push([Markup.button.callback('🔍 Analyze Package', `smart_analyze:${draftId}`)]);
    }
    if (['article', 'docs', 'stackoverflow'].includes(linkType)) {
      buttons.push([Markup.button.callback('📖 Summarize & Extract', `smart_summarize:${draftId}`)]);
      buttons.push([Markup.button.callback('📋 Follow Tutorial', `smart_tutorial:${draftId}`)]);
    }
    if (linkType === 'api') {
      buttons.push([Markup.button.callback('🌐 Test API', `smart_testapi:${draftId}`)]);
      buttons.push([Markup.button.callback('📦 Generate Client', `smart_analyze:${draftId}`)]);
    }
    if (linkType === 'docker') {
      buttons.push([Markup.button.callback('🐳 Pull & Run', `smart_install:${draftId}`)]);
    }
    if (linkType === 'github_issue') {
      buttons.push([Markup.button.callback('🐛 Analyze Issue', `smart_analyze:${draftId}`)]);
    }

    // Universal smart action (always first if no type-specific ones)
    if (buttons.length === 0) {
      buttons.push([Markup.button.callback('🧠 Smart Analyze', `smart_analyze:${draftId}`)]);
    }

    // Common actions
    buttons.push([
      Markup.button.callback('\ud83d\udca1 Expand Idea', `draft_expand:${draftId}`),
      Markup.button.callback('\ud83d\udccb Clone as Board', `draft_clone:${draftId}`),
    ]);
    buttons.push([
      Markup.button.callback('\ud83d\udcbb Run CLI', `draft_cli:${draftId}`),
      Markup.button.callback('\ud83d\uddd1\ufe0f Delete', `draft_delete:${draftId}`),
    ]);
    buttons.push([Markup.button.callback('\u25c0\ufe0f Back', 'list_drafts')]);

    return Markup.inlineKeyboard(buttons);
  },

  // Session list
  sessionList(sessionsList) {
    const buttons = sessionsList.map(s => [
      Markup.button.callback(`\ud83d\udcac ${s.title}`.substring(0, 50), `switch_session:${s.id}`),
    ]);
    buttons.push([Markup.button.callback('\u25c0\ufe0f Back', 'main_menu')]);
    return Markup.inlineKeyboard(buttons);
  },

  // Settings menu
  settingsMenu() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('\ud83d\udd11 API Keys', 'providers')],
      [Markup.button.callback('\ud83d\udcca Default Model', 'change_model')],
      [Markup.button.callback('\ud83d\udcac Sessions', 'list_sessions')],
      [Markup.button.callback('\u25c0\ufe0f Back', 'main_menu')],
    ]);
  },

  // Confirmation
  confirm(action, id) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('\u2705 Yes', `confirm_${action}:${id}`),
        Markup.button.callback('\u274c No', 'main_menu'),
      ],
    ]);
  },
};
