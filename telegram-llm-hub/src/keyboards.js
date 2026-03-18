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
  // pending: intentionally omitted — don't show anything for default state
  running: '\ud83d\udd04', // arrows
  pass: '\u2705',      // check
  fail: '\u274c',      // cross
};

export const kb = {
  // Main menu
  mainMenu() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('\ud83d\udcac New Chat', 'new_chat')],
      [Markup.button.callback('🚀 Projects', 'list_projects'), Markup.button.callback('\ud83d\udccb Boards', 'list_boards')],
      [Markup.button.callback('📚 Git Repos', 'list_git_repos'), Markup.button.callback('📥 Clone Repo', 'git_clone_new')],
      [Markup.button.callback('\ud83d\udce5 Drafts', 'list_drafts'), Markup.button.callback('\ud83d\udd27 Workflows', 'list_workflows')],
      [Markup.button.callback('🔧 Providers', 'providers'), Markup.button.callback('🐛 Fix Bug', 'dev_bugfix')],
      [Markup.button.callback('🧬 Self-Improve', 'self_improve'), Markup.button.callback('📜 Improve History', 'self_improve_history')],
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

  // Model selection for a provider (supports grouped models)
  modelSelect(providerName) {
    const reg = PROVIDER_REGISTRY[providerName];
    if (!reg) return null;
    const buttons = [];

    if (reg.modelGroups) {
      for (const [groupName, models] of Object.entries(reg.modelGroups)) {
        // Group header (non-clickable, shown as text)
        buttons.push([Markup.button.callback(`── ${groupName} ──`, `noop`)]);
        // Show first 8 models per group (Telegram keyboard limit)
        for (const m of models.slice(0, 8)) {
          const short = m.split('/').pop().substring(0, 30);
          // Callback data must be <=64 bytes; use index-based lookup
          buttons.push([Markup.button.callback(short, `select_model:${providerName}:${m}`.substring(0, 64))]);
        }
      }
    } else {
      for (const m of reg.models) {
        buttons.push([Markup.button.callback(m, `select_model:${providerName}:${m}`.substring(0, 64))]);
      }
    }

    buttons.push([Markup.button.callback('\u25c0\ufe0f Back', 'providers')]);
    return Markup.inlineKeyboard(buttons);
  },

  // Board list — each board gets play/pause/remove controls
  boardList(boardsList) {
    const buttons = [];
    for (const b of boardsList) {
      const tasks = b._tasks || [];
      const done = tasks.filter(t => t.status === 'done').length;
      const statusE = STATUS_EMOJI[b.status] || '\u2b1c';
      const label = `${statusE} ${b.title}`.substring(0, 35);
      const isRunning = b.status === 'executing';
      buttons.push([
        Markup.button.callback(label, `view_board:${b.id}`),
        isRunning
          ? Markup.button.callback('\u23f8 Pause', `pause_board:${b.id}`)
          : Markup.button.callback('\u25b6\ufe0f Run', `run_board:${b.id}`),
        Markup.button.callback('\ud83d\uddd1', `del_board:${b.id}`),
      ]);
    }
    buttons.push([Markup.button.callback('\u25c0\ufe0f Back', 'main_menu')]);
    return Markup.inlineKeyboard(buttons);
  },

  // Board view with tasks — "Run Project" at top, tasks with status
  boardView(boardId, tasks, boardStatus) {
    const buttons = [];

    // Run Project / Build buttons at top
    const hasUnfinished = tasks.some(t => t.status !== 'done');
    const isRunning = boardStatus === 'executing';
    const isComplete = boardStatus === 'completed' || (!hasUnfinished && tasks.length > 0);
    if (hasUnfinished) {
      buttons.push([
        isRunning
          ? Markup.button.callback('\u23f8 Pause Project', `pause_board:${boardId}`)
          : Markup.button.callback('\ud83d\ude80 Run Project \u2014 auto-execute all tasks', `run_board:${boardId}`),
      ]);
    }
    if (isComplete) {
      buttons.push([
        Markup.button.callback('\ud83d\udce6 Build Project \u2014 assemble into files', `build_board:${boardId}`),
      ]);
    }

    // Task list
    for (const t of tasks) {
      const statusE = STATUS_EMOJI[t.status] || '\u2b1c';
      const qaE = QA_EMOJI[t.qa_status] || '';
      const label = `${statusE}${qaE} ${t.title}`.substring(0, 50);
      buttons.push([Markup.button.callback(label, `task_detail:${t.id}`)]);
    }

    const actions = [Markup.button.callback('\ud83d\udd04 Refresh', `view_board:${boardId}`)];
    buttons.push(actions);
    buttons.push([Markup.button.callback('\u25c0\ufe0f Back to Boards', 'list_boards')]);
    return Markup.inlineKeyboard(buttons);
  },

  // Task detail view
  taskDetail(task) {
    const buttons = [];

    // AI execution
    if (task.status === 'pending') {
      buttons.push([Markup.button.callback('\u26a1 Execute — generate script for this task', `exec_task:${task.id}`)]);
    }
    if (task.status === 'in_progress') {
      buttons.push([Markup.button.callback('\ud83d\udd35 Running...', `view_board:${task.board_id}`)]);
    }
    if (task.status === 'done' && task.execution_log) {
      buttons.push([
        Markup.button.callback('\ud83d\udd04 Re-execute — regenerate output', `reexec_task:${task.id}`),
        Markup.button.callback('\ud83d\udcdc View Result', `view_log:${task.id}`),
      ]);
    }

    // Input question
    if (task.requires_input && !task.input_answer) {
      buttons.push([Markup.button.callback('\u2753 Answer Question', `answer_task:${task.id}`)]);
    }

    // Utilities
    const utilRow = [Markup.button.callback('\ud83d\udcac Discuss', `discuss_task:${task.id}`)];
    if (task.status === 'done') {
      utilRow.unshift(Markup.button.callback('\ud83e\uddea Run QA', `qa_task:${task.id}`));
    }
    buttons.push(utilRow);

    buttons.push([Markup.button.callback('\u25c0\ufe0f Back to Board', `view_board:${task.board_id}`)]);

    return Markup.inlineKeyboard(buttons);
  },

  // Smart draft actions based on link type
  draftActions(draftId, linkType = 'website') {
    const buttons = [];

    // Smart actions based on link type
    if (['github_repo', 'github', 'github_code'].includes(linkType)) {
      buttons.push([
        Markup.button.callback('📥 Clone & Setup', `smart_clone:${draftId}`),
        Markup.button.callback('⚡ Clone & Run', `smart_clone_run:${draftId}`),
      ]);
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
    // Social media / any other link — project-focused actions
    const SOCIAL = ['twitter', 'reddit', 'instagram', 'facebook', 'linkedin', 'tiktok', 'threads', 'mastodon'];
    if (SOCIAL.includes(linkType)) {
      buttons.push([
        Markup.button.callback('🧠 Extract Project Idea', `smart_extract_idea:${draftId}`),
      ]);
      buttons.push([
        Markup.button.callback('🔍 Analyze Content', `smart_analyze:${draftId}`),
      ]);
    }

    // Universal smart action (always first if no type-specific ones)
    if (buttons.length === 0) {
      buttons.push([Markup.button.callback('🧠 Smart Analyze', `smart_analyze:${draftId}`)]);
    }

    // Common actions
    buttons.push([
      Markup.button.callback('🚀 Create Project', `draft_to_project:${draftId}`),
      Markup.button.callback('\ud83d\udca1 Expand Idea', `draft_expand:${draftId}`),
    ]);
    buttons.push([
      Markup.button.callback('\ud83d\udccb Clone as Board', `draft_clone:${draftId}`),
      Markup.button.callback('\ud83d\udcbb Run CLI', `draft_cli:${draftId}`),
    ]);
    buttons.push([
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

  // Project list
  projectList(projects) {
    const buttons = [];
    for (const p of projects) {
      const statusE = { draft: '📝', generating: '⏳', ready: '✅', running: '▶️' }[p.status] || '📝';
      const label = `${statusE} ${p.title}`.substring(0, 40);
      buttons.push([
        Markup.button.callback(label, `proj_view:${p.id}`),
        Markup.button.callback('🗑', `proj_delete:${p.id}`),
      ]);
    }
    buttons.push([Markup.button.callback('◀️ Back', 'main_menu')]);
    return Markup.inlineKeyboard(buttons);
  },

  // Project detail view — context-aware buttons
  projectView(projId, proj) {
    const buttons = [];
    const status = proj.status || 'draft';

    if (status === 'draft') {
      buttons.push([Markup.button.callback('⚡ Generate Project', `proj_generate:${projId}`)]);
    }
    if (status === 'ready') {
      buttons.push([
        Markup.button.callback('🔄 Regenerate', `proj_generate:${projId}`),
        Markup.button.callback('🔧 Fix Bugs', `proj_fix:${projId}`),
      ]);
      buttons.push([Markup.button.callback('📁 View Files', `proj_files:${projId}`)]);
    }
    if (status === 'generating') {
      buttons.push([Markup.button.callback('⏳ Generating...', `proj_view:${projId}`)]);
    }

    buttons.push([
      Markup.button.callback('📌 Add Keypoint', `proj_addkp:${projId}`),
      Markup.button.callback('❌ Remove Keypoint', `proj_rmkp:${projId}`),
    ]);
    buttons.push([
      Markup.button.callback('💬 Chat / Refine', `proj_chat:${projId}`),
    ]);
    buttons.push([
      Markup.button.callback('🗑 Delete', `proj_delete:${projId}`),
      Markup.button.callback('◀️ Back', 'list_projects'),
    ]);

    return Markup.inlineKeyboard(buttons);
  },

  // Git Repo list
  gitRepoList(repos) {
    const buttons = [];
    for (const r of repos) {
      const statusE = { cloned: '✅', running: '▶️', cloning: '⏳', error: '❌' }[r.status] || '📁';
      const typeE = { node: '🟢', python: '🐍', rust: '🦀', go: '🔵' }[r.project_type] || '📦';
      const label = `${statusE}${typeE} ${r.name}`.substring(0, 35);
      buttons.push([
        Markup.button.callback(label, `git_view:${r.id}`),
        Markup.button.callback('🗑', `git_delete:${r.id}`),
      ]);
    }
    buttons.push([Markup.button.callback('📥 Clone New Repo', 'git_clone_new')]);
    buttons.push([Markup.button.callback('◀️ Back', 'main_menu')]);
    return Markup.inlineKeyboard(buttons);
  },

  // Git Repo detail view
  gitRepoView(repoId, repo) {
    const buttons = [];
    const isRunning = repo.status === 'running';
    if (isRunning) {
      buttons.push([Markup.button.callback('⏹ Stop', `git_stop:${repoId}`)]);
    } else {
      buttons.push([Markup.button.callback('▶️ Run', `git_run:${repoId}`)]);
    }
    buttons.push([
      Markup.button.callback('🔄 Git Pull', `git_pull:${repoId}`),
      Markup.button.callback('🔍 Re-analyze', `git_reanalyze:${repoId}`),
    ]);
    buttons.push([
      Markup.button.callback('🗑 Delete', `git_delete:${repoId}`),
      Markup.button.callback('◀️ Back', 'list_git_repos'),
    ]);
    return Markup.inlineKeyboard(buttons);
  },

  // Congress result keyboard
  congressResult(battleId) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('✅ Execute Winner', `congress_execute:${battleId}`)],
      [Markup.button.callback('📊 Full Vote Details', `congress_details:${battleId}`)],
      [Markup.button.callback('◀️ Back', 'main_menu')],
    ]);
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
