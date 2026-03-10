// ===================== STATE =====================
let state = {
  stats: null,
  providers: [],
  registry: [],
  boards: [],
  workflows: [],
  drafts: [],
  sessions: [],
  schedules: [],
  nodeTypes: {},
  chatSessionId: null,
  activeSection: 'home',
  searchQuery: '',
};

// ===================== API HELPERS =====================
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return {};
  let data;
  try { data = await res.json(); } catch {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    throw new Error('Invalid response from server');
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const GET = (p) => api(p);
const POST = (p, b) => api(p, { method: 'POST', body: b });
const PUT = (p, b) => api(p, { method: 'PUT', body: b });
const DEL = (p) => api(p, { method: 'DELETE' });

// ===================== INIT =====================
document.addEventListener('DOMContentLoaded', async () => {
  createParticles();
  await refreshAll();
  showSection('home');
});

async function refreshAll() {
  try {
    const results = await Promise.allSettled([
      GET('/stats'), GET('/providers'), GET('/boards'),
      GET('/workflows'), GET('/drafts'), GET('/sessions'), GET('/node-types'),
      GET('/schedules'),
    ]);
    const val = (i, fallback) => results[i].status === 'fulfilled' ? results[i].value : fallback;
    state.stats = val(0, state.stats);
    const provData = val(1, { providers: state.providers, registry: state.registry });
    state.providers = provData.providers || [];
    state.registry = provData.registry || [];
    state.boards = val(2, state.boards || []);
    state.workflows = val(3, state.workflows || []);
    state.drafts = val(4, state.drafts || []);
    state.sessions = val(5, state.sessions || []);
    state.nodeTypes = val(6, state.nodeTypes || {});
    state.schedules = val(7, state.schedules || []);
    updateHeader();
  } catch (err) {
    console.error('Failed to refresh app state:', err);
  }
}

function updateHeader() {
  const s = state.stats?.stats;
  if (!s) return;
  document.getElementById('xp-value').textContent = s.xp;
  document.getElementById('level-value').textContent = s.level;
  document.getElementById('level-title').textContent = state.stats.levels?.find(l => l.level === s.level)?.title || '';
  document.getElementById('streak-value').textContent = s.streak_days;
  document.getElementById('tasks-done').textContent = s.tasks_completed;
  const progress = s._xpProgress || 0;
  document.getElementById('xp-fill').style.width = `${Math.min(progress, 100)}%`;
  const badge = document.getElementById('level-badge');
  const levelData = state.stats.levels?.find(l => l.level === s.level);
  if (levelData) badge.style.borderColor = levelData.color;
}

// ===================== SECTIONS =====================
function showSection(name) {
  state.activeSection = name;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.section === name));
  const content = document.getElementById('content');
  const renderers = { home: renderHome, providers: renderProviders, boards: renderBoards, workflows: renderWorkflows, drafts: renderDrafts, projects: renderProjects, chat: renderChat, achievements: renderAchievements, templates: renderTemplates, arena: renderArena, memory: renderMemory, costs: renderCosts, challenges: renderChallenges, vault: renderVault, plugins: renderPlugins, leaderboard: renderLeaderboard, collaboration: renderCollaboration };
  const fn = renderers[name];
  if (fn) fn(content);
}

// ===================== HOME =====================
function renderHome(el) {
  const s = state.stats?.stats || {};
  const lvl = state.stats?.levels?.find(l => l.level === s.level) || { title: 'Novice', color: '#6b7280' };
  const nextLvl = state.stats?.levels?.find(l => l.level === s.level + 1);
  const circ = 2 * Math.PI * 42;
  const offset = circ - (circ * (s._xpProgress || 0) / 100);
  const recentAch = (state.stats?.achievements || []).filter(a => a.earned).slice(-3);

  el.innerHTML = `
    <div class="section-title"><span class="icon">🏠</span> Dashboard</div>
    <div class="home-stats">
      <div class="home-stat">
        <svg width="0" height="0"><defs><linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" style="stop-color:var(--cyan)"/><stop offset="100%" style="stop-color:var(--purple)"/></linearGradient></defs></svg>
        <div class="progress-ring">
          <svg viewBox="0 0 100 100"><circle class="bg" cx="50" cy="50" r="42"/><circle class="fill" cx="50" cy="50" r="42" stroke-dasharray="${circ}" stroke-dashoffset="${offset}"/></svg>
          <div class="center-text" style="color:${lvl.color}">${s.level}</div>
        </div>
        <div style="font-weight:700;color:${lvl.color}">${lvl.title}</div>
        <div class="stat-label">${s.xp} XP${nextLvl ? ` / ${nextLvl.xp}` : ' MAX'}</div>
      </div>
      <div class="home-stat"><div class="big-num">${s.tasks_completed}</div><div class="stat-label">Tasks Done</div></div>
      <div class="home-stat"><div class="big-num">${s.boards_created}</div><div class="stat-label">Boards</div></div>
      <div class="home-stat"><div class="big-num">${s.workflows_run}</div><div class="stat-label">Workflows</div></div>
      <div class="home-stat"><div class="big-num">${s.messages_sent}</div><div class="stat-label">Messages</div></div>
      <div class="home-stat"><div class="big-num">🔥 ${s.streak_days}</div><div class="stat-label">Day Streak</div></div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-header"><div class="card-title">📋 Recent Boards</div><button class="btn btn-sm" onclick="showSection('boards')">View All</button></div>
        ${state.boards.length === 0 ? '<div class="card-subtitle">No boards yet</div>' :
          state.boards.slice(0, 3).map(b => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
            <span>${escapeHtml(b.title)}</span><span class="badge badge-${b.status === 'completed' ? 'green' : b.status === 'executing' ? 'orange' : 'blue'}">${escapeHtml(b.status)}</span>
          </div>`).join('')}
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title">🏆 Recent Achievements</div><button class="btn btn-sm" onclick="showSection('achievements')">View All</button></div>
        ${recentAch.length === 0 ? '<div class="card-subtitle">Keep going to unlock!</div>' :
          recentAch.map(a => `<div style="display:flex;align-items:center;gap:10px;padding:6px 0"><span style="font-size:24px">${a.icon}</span><div><div style="font-weight:700;font-size:13px">${a.title}</div><div style="font-size:11px;color:var(--text2)">${a.desc}</div></div></div>`).join('')}
      </div>
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">⚡ Quick Actions</div></div>
      <div class="btn-group">
        <button class="btn btn-primary" onclick="promptNewBoard()">📋 New Board</button>
        <button class="btn btn-primary" onclick="promptNewWorkflow()">🔀 New Workflow</button>
        <button class="btn" onclick="showSection('chat')">💬 Chat</button>
        <button class="btn" onclick="showSection('providers')">🔧 Providers</button>
      </div>
    </div>`;
}

// ===================== PROVIDERS =====================
async function renderProviders(el) {
  await refreshAll();
  const providers = state.providers;
  const registry = state.registry;
  const cloud = providers.filter(p => !p.is_local);
  const local = providers.filter(p => p.is_local);

  function provStatus(p) {
    if (!p.enabled) return { dot: 'status-off', label: 'Disabled' };
    if (p.is_local) return { dot: 'status-on', label: 'Local' };
    if (p.api_key) return { dot: 'status-on', label: 'Active' };
    return { dot: 'status-warn', label: 'No key' };
  }

  function renderCard(p, i) {
    const reg = registry.find(r => r.name === p.name) || {};
    const st = provStatus(p);
    return `<div class="prov-card ${p.enabled ? '' : 'disabled'} prov-${st.dot}" data-name="${p.name}" style="animation-delay:${i * 0.03}s">
      <div class="prov-rank">#${i + 1}</div>
      <div class="prov-status-dot ${st.dot}" title="${st.label}"></div>
      <div class="prov-info">
        <div class="prov-name">${p.display_name} <span class="prov-badge">${p.is_local ? '🏠 Local' : '☁️ Cloud'}</span></div>
        <div class="prov-tagline">${reg.tagline || reg.description || ''}</div>
        <div class="prov-model">Model: <code>${p.model}</code></div>
        <div class="prov-docs"><a href="${reg.docs || '#'}" target="_blank">📖 Docs</a></div>
      </div>
      <div class="prov-actions">
        <button onclick="moveProv('${p.name}','up')" title="Move up">⬆️</button>
        <button onclick="moveProv('${p.name}','down')" title="Move down">⬇️</button>
        <button onclick="toggleProv('${p.name}')" title="Toggle">${p.enabled ? '✅' : '❌'}</button>
        ${!p.is_local ? `<button onclick="promptSetKey('${p.name}','${p.display_name}')" title="Set key">🔑</button>` : ''}
        <button onclick="promptSetModel('${p.name}','${p.display_name}')" title="Change model">📊</button>
        <button onclick="testProvider('${p.name}')" title="Test connection" id="test-btn-${p.name}">🏓</button>
      </div>
    </div>`;
  }

  el.innerHTML = `
    <div class="section-title"><span class="icon">🔧</span> LLM Providers <span class="badge badge-blue">${providers.length} total</span></div>
    <p style="color:var(--text2);margin-bottom:16px">Requests try each enabled provider in order with automatic fallback. Test connections with 🏓.</p>
    <div class="prov-group-label">☁️ Cloud Providers (${cloud.length})</div>
    <div id="prov-list-cloud">${cloud.map((p, i) => renderCard(p, i)).join('')}</div>
    <div class="prov-group-label" style="margin-top:20px">🏠 Local Providers (${local.length})</div>
    <div id="prov-list-local">${local.map((p, i) => renderCard(p, cloud.length + i)).join('')}</div>`;
}

async function testProvider(name) {
  const btn = document.getElementById(`test-btn-${name}`);
  if (btn) { btn.textContent = '⏳'; btn.disabled = true; }
  try {
    const result = await POST(`/providers/${name}/test`);
    const msg = result.ok ? `✅ ${name} OK (${result.latency}ms)` : `❌ ${name}: ${result.error}`;
    showToast(msg);
  } catch (err) {
    showToast(`❌ ${name}: ${err.message}`);
  }
  if (btn) { btn.textContent = '🏓'; btn.disabled = false; }
}

async function toggleProv(name) { await PUT(`/providers/${name}/toggle`); renderProviders(document.getElementById('content')); }
async function moveProv(name, dir) { await PUT(`/providers/${name}/reorder`, { direction: dir }); renderProviders(document.getElementById('content')); }

function promptSetKey(name, displayName) {
  const reg = state.registry.find(r => r.name === name) || {};
  showModal(`🔑 Set API Key — ${displayName}`, `
    <p style="margin-bottom:12px;color:var(--text2)">Get your key from: <a href="${reg.docs || '#'}" target="_blank" style="color:var(--cyan)">${reg.docs || 'provider docs'}</a></p>
    <div class="form-group">
      <label class="form-label">API Key</label>
      <input class="input" id="modal-key" type="password" placeholder="sk-..." style="font-family:monospace">
    </div>
    <div class="btn-group"><button class="btn btn-primary" onclick="submitKey('${name}')">Save Key</button><button class="btn" onclick="closeModal()">Cancel</button></div>
  `);
}

async function submitKey(name) {
  const key = document.getElementById('modal-key').value.trim();
  if (!key) return;
  await PUT(`/providers/${name}/key`, { apiKey: key });
  closeModal();
  renderProviders(document.getElementById('content'));
}

function promptSetModel(name, displayName) {
  const reg = state.registry.find(r => r.name === name) || {};
  const models = reg.models || [];
  showModal(`📊 Set Model — ${displayName}`, `
    <div class="form-group">
      <label class="form-label">Select Model</label>
      ${models.map(m => `<button class="btn" style="margin:4px" onclick="submitModel('${name}','${m}')">${m}</button>`).join('')}
    </div>
    <button class="btn" onclick="closeModal()">Cancel</button>
  `);
}

async function submitModel(name, model) {
  await PUT(`/providers/${name}/model`, { model });
  closeModal();
  renderProviders(document.getElementById('content'));
}

// ===================== BOARDS =====================
async function renderBoards(el) {
  await refreshAll();
  el.innerHTML = `
    <div class="section-title"><span class="icon">📋</span> Project Boards <button class="btn btn-primary btn-sm" onclick="promptNewBoard()" style="margin-left:auto">+ New Board</button></div>
    ${state.boards.length === 0 ? '<div class="empty-state"><div class="empty-icon">📋</div><h3>No boards yet</h3><p>Create a project board to break down tasks</p></div>' :
      state.boards.map(b => {
        const tasks = b.tasks || [];
        const done = tasks.filter(t => t.status === 'done').length;
        const pct = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0;
        return `<div class="card" onclick="viewBoard(${b.id})" style="cursor:pointer">
          <div class="card-header">
            <div><div class="card-title">${escapeHtml(b.title)}</div><div class="card-subtitle">${tasks.length} tasks · ${escapeHtml(b.status)}</div></div>
            <div class="badge badge-${b.status === 'completed' ? 'green' : b.status === 'executing' ? 'orange' : 'blue'}">${pct}%</div>
          </div>
          <div style="height:4px;background:var(--bg3);border-radius:2px;overflow:hidden"><div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--cyan),var(--green));border-radius:2px;transition:width 0.5s"></div></div>
        </div>`;
      }).join('')}`;
}

function promptNewBoard() {
  showModal('📋 Create Board', `
    <div class="form-group"><label class="form-label">Project Name</label><input class="input" id="board-title" placeholder="My Awesome Project"></div>
    <div class="btn-group">
      <button class="btn btn-primary" onclick="createBoard(true)">🤖 Auto-Generate Tasks</button>
      <button class="btn" onclick="createBoard(false)">📝 Empty Board</button>
      <button class="btn" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function createBoard(auto) {
  const title = document.getElementById('board-title').value.trim();
  if (!title) return;
  closeModal();
  const content = document.getElementById('content');
  content.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><h3>Generating board...</h3></div>';
  const result = await POST('/boards', { title, auto });
  await refreshAll();
  if (result.board) viewBoard(result.board.id);
  else renderBoards(content);
}

async function viewBoard(boardId) {
  const data = await GET(`/boards/${boardId}`);
  if (!data.board) return;
  const { board, tasks, pending, inProgress, done, needsInput } = data;
  const content = document.getElementById('content');

  content.innerHTML = `
    <div class="section-title">
      <span class="icon">📋</span> ${escapeHtml(board.title)}
      <span class="badge badge-${board.status === 'completed' ? 'green' : 'blue'}" style="margin-left:8px">${escapeHtml(board.status)}</span>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-sm" onclick="renderBoards(document.getElementById('content'))">← Back</button>
        <button class="btn btn-sm btn-primary" onclick="addTaskPrompt(${board.id})">+ Task</button>
        <button class="btn btn-sm btn-danger" onclick="deleteBoard(${board.id})">🗑️</button>
      </div>
    </div>
    ${needsInput.length > 0 ? `<div class="card" style="border-color:var(--orange)"><b>⚠️ ${needsInput.length} tasks need your input</b></div>` : ''}
    <div class="kanban">
      <div class="kanban-col">
        <div class="kanban-col-title">⬜ Pending <span class="count">${pending.length}</span></div>
        ${pending.map(t => taskCard(t, board.id)).join('')}
      </div>
      <div class="kanban-col">
        <div class="kanban-col-title">🔵 In Progress <span class="count">${inProgress.length}</span></div>
        ${inProgress.map(t => taskCard(t, board.id)).join('')}
      </div>
      <div class="kanban-col">
        <div class="kanban-col-title">✅ Done <span class="count">${done.length}</span></div>
        ${done.map(t => taskCard(t, board.id)).join('')}
      </div>
    </div>`;
}

function taskCard(t, boardId) {
  const qaClass = t.qa_status === 'pass' ? 'pass' : t.qa_status === 'fail' ? 'fail' : 'pending';
  const needsQ = t.requires_input && !t.input_answer;
  return `<div class="task-card" onclick="taskDetail(${t.id}, ${boardId})">
    <div class="task-title">${needsQ ? '❓ ' : ''}${escapeHtml(t.title)}</div>
    <div class="task-meta">
      <span class="task-qa ${qaClass}">QA: ${escapeHtml(t.qa_status)}</span>
      ${t.tools_needed ? `<span>🔧</span>` : ''}
    </div>
  </div>`;
}

async function taskDetail(taskId, boardId) {
  const data = await GET(`/boards/${boardId}`);
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) return;

  const statusOpts = ['pending', 'in_progress', 'done'].map(s =>
    `<button class="btn btn-sm ${task.status === s ? 'btn-primary' : ''}" onclick="setTaskStatus(${taskId},${boardId},'${s}')">${s}</button>`).join('');

  showModal(`Task: ${escapeHtml(task.title)}`, `
    <p style="color:var(--text2);margin-bottom:12px">${escapeHtml(task.description || 'No description')}</p>
    <div class="form-group"><label class="form-label">Status</label><div class="btn-group">${statusOpts}</div></div>
    ${task.requires_input ? `<div class="form-group"><label class="form-label">❓ ${escapeHtml(task.input_question || 'Input needed')}</label>
      <input class="input" id="task-answer" value="${escapeAttr(task.input_answer || '')}" placeholder="Your answer...">
      <button class="btn btn-sm" style="margin-top:6px" onclick="answerTask(${taskId},${boardId})">Save Answer</button></div>` : ''}
    <div class="form-group"><label class="form-label">QA Status: <span class="badge badge-${task.qa_status === 'pass' ? 'green' : task.qa_status === 'fail' ? 'red' : 'blue'}">${escapeHtml(task.qa_status)}</span></label>
      <button class="btn btn-sm" onclick="runQA(${taskId},${boardId})">🧪 Run QA</button></div>
    <button class="btn" onclick="closeModal()">Close</button>
  `);
}

async function setTaskStatus(taskId, boardId, status) { await PUT(`/tasks/${taskId}`, { status }); closeModal(); viewBoard(boardId); await refreshAll(); updateHeader(); }
async function answerTask(taskId, boardId) { await PUT(`/tasks/${taskId}/answer`, { answer: document.getElementById('task-answer').value }); closeModal(); viewBoard(boardId); }
async function runQA(taskId, boardId) { await POST(`/tasks/${taskId}/qa`); closeModal(); viewBoard(boardId); await refreshAll(); updateHeader(); }
async function deleteBoard(boardId) { if (!confirm('Delete this board?')) return; await DEL(`/boards/${boardId}`); await refreshAll(); renderBoards(document.getElementById('content')); }

function addTaskPrompt(boardId) {
  showModal('Add Task', `
    <div class="form-group"><label class="form-label">Title</label><input class="input" id="new-task-title" placeholder="Task name"></div>
    <div class="form-group"><label class="form-label">Description</label><textarea class="textarea" id="new-task-desc" placeholder="What needs to be done?"></textarea></div>
    <div class="btn-group"><button class="btn btn-primary" onclick="addTask(${boardId})">Add</button><button class="btn" onclick="closeModal()">Cancel</button></div>
  `);
}
async function addTask(boardId) {
  await POST(`/boards/${boardId}/tasks`, { title: document.getElementById('new-task-title').value, description: document.getElementById('new-task-desc').value });
  closeModal(); viewBoard(boardId);
}

// ===================== WORKFLOWS =====================
async function renderWorkflows(el) {
  await refreshAll();
  el.innerHTML = `
    <div class="section-title">
      <span class="icon">🔀</span> Workflows
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-sm" onclick="importWorkflow()">📥 Import</button>
        <button class="btn btn-primary btn-sm" onclick="promptNewWorkflow()">+ New Workflow</button>
      </div>
    </div>
    ${state.workflows.length === 0 ? '<div class="empty-state"><div class="empty-icon">🔀</div><h3>No workflows</h3><p>Create n8n-style workflows to automate tasks</p></div>' :
      `<div class="grid grid-2">${state.workflows.map(w => {
        const sched = state.schedules.find(s => s.workflow_id === w.id);
        const schedBadge = sched ? `<span class="badge ${sched.enabled ? 'badge-orange' : 'badge-red'}" title="${escapeAttr(sched.description || '')}">⏰ ${sched.enabled ? sched.description : 'paused'}</span>` : '';
        const webhookBadge = w.webhook_id ? '<span class="badge badge-purple">🔗 webhook</span>' : '';
        return `<div class="card" onclick="viewWorkflow(${w.id})" style="cursor:pointer">
          <div class="card-header"><div class="card-title">🔀 ${escapeHtml(w.title)}</div><span class="badge badge-${w.status === 'completed' ? 'green' : 'blue'}">${w.status}</span></div>
          <div class="card-subtitle">${(w.nodes || []).length} nodes · ${(w.edges || []).length} connections</div>
          <div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap">${schedBadge}${webhookBadge}</div>
        </div>`;
      }).join('')}</div>`}`;
}

function promptNewWorkflow() {
  showModal('🔀 Create Workflow', `
    <div class="form-group"><label class="form-label">Description</label><textarea class="textarea" id="wf-desc" placeholder="Describe what the workflow should do..."></textarea></div>
    <div class="btn-group">
      <button class="btn btn-primary" onclick="createWorkflow(true)">🤖 Auto-Generate</button>
      <button class="btn" onclick="createWorkflow(false)">📝 Empty</button>
      <button class="btn" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function createWorkflow(auto) {
  const desc = document.getElementById('wf-desc').value.trim();
  closeModal();
  const content = document.getElementById('content');
  if (auto && desc) content.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><h3>Generating workflow...</h3></div>';
  const result = await POST('/workflows', { title: desc || 'New Workflow', description: desc, auto });
  await refreshAll();
  if (result.id) viewWorkflow(result.id);
  else renderWorkflows(content);
}

async function viewWorkflow(wfId) {
  const wf = await GET(`/workflows/${wfId}`);
  if (!wf.id) return;
  const content = document.getElementById('content');
  const nt = state.nodeTypes;

  content.innerHTML = `
    <div class="section-title">
      <span class="icon">🔀</span> ${wf.title}
      <span class="badge badge-${wf.status === 'completed' ? 'green' : wf.status === 'running' ? 'orange' : 'blue'}">${wf.status}</span>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-sm" onclick="renderWorkflows(document.getElementById('content'))">← Back</button>
        <button class="btn btn-sm btn-primary" onclick="addNodePrompt(${wf.id})">+ Node</button>
        <button class="btn btn-sm" onclick="executeWorkflow(${wf.id})">⚡ Run</button>
        <button class="btn btn-sm btn-autofix" onclick="autoFixWorkflow(${wf.id})">🔧 Mini Fix</button>
        <button class="btn btn-sm" onclick="scheduleWorkflow(${wf.id})">⏰ Schedule</button>
        <button class="btn btn-sm" onclick="webhookWorkflow(${wf.id})">🔗 Webhook</button>
        <button class="btn btn-sm" onclick="workflowHistory(${wf.id})">📊 History</button>
        <button class="btn btn-sm" onclick="exportWorkflow(${wf.id})">📦 Export</button>
        <button class="btn btn-sm btn-danger" onclick="deleteWorkflow(${wf.id})">🗑️</button>
      </div>
    </div>
    <div class="wf-editor">
      <div class="wf-canvas" id="wf-canvas-${wf.id}">
        <svg id="wf-svg-${wf.id}"></svg>
        ${(wf.nodes || []).map((n, i) => {
          const type = nt[n.node_type] || { emoji: '⚙️', label: 'Process' };
          const x = 40 + (i % 4) * 200;
          const y = 40 + Math.floor(i / 4) * 120;
          const inputs = JSON.parse(n.inputs || '[]');
          const outputs = JSON.parse(n.outputs || '[]');
          const statusCls = n.status === 'done' ? 'done' : n.status === 'running' ? 'running' : n.status === 'error' ? 'error' : '';
          return `<div class="wf-node ${statusCls}" id="wfnode-${n.id}" style="left:${x}px;top:${y}px"
            onmousedown="startDrag(event,${n.id})" ondblclick="nodeDetail(${n.id},${wf.id})">
            <button class="wf-node-delete" onclick="event.stopPropagation();deleteNode(${n.id},${wf.id})" title="Delete node">×</button>
            <div class="wf-node-header"><span class="wf-node-type">${type.emoji}</span><span class="wf-node-name">${n.name}</span></div>
            <div class="wf-node-io">
              <div class="wf-ports-row">${inputs.map(inp => `<div class="wf-port input-port" data-node="${n.id}" data-port="${inp}" data-dir="in" onclick="portClick(event,${n.id},'${inp}','in',${wf.id})" title="${inp}"></div>`).join('')}</div>
              <div class="wf-ports-row">${outputs.map(out => `<div class="wf-port output-port" data-node="${n.id}" data-port="${out}" data-dir="out" onclick="portClick(event,${n.id},'${out}','out',${wf.id})" title="${out}"></div>`).join('')}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;

  requestAnimationFrame(() => drawEdges(wf));
}

let pendingConnection = null;

function portClick(e, nodeId, portName, dir, wfId) {
  e.stopPropagation();
  if (!pendingConnection) {
    if (dir !== 'out') return;
    pendingConnection = { fromNode: nodeId, fromOutput: portName, wfId };
    e.target.style.background = 'var(--cyan)';
    e.target.style.boxShadow = '0 0 10px var(--cyan)';
  } else {
    if (dir !== 'in' || pendingConnection.fromNode === nodeId) { pendingConnection = null; return; }
    connectNodes(pendingConnection.wfId, pendingConnection.fromNode, nodeId, pendingConnection.fromOutput, portName);
    pendingConnection = null;
  }
}

async function connectNodes(wfId, from, to, fromOut, toIn) {
  await POST(`/workflows/${wfId}/edges`, { fromNodeId: from, toNodeId: to, fromOutput: fromOut, toInput: toIn });
  viewWorkflow(wfId);
}

function drawEdges(wf) {
  const svg = document.getElementById(`wf-svg-${wf.id}`);
  if (!svg) return;
  svg.innerHTML = '';
  const canvas = svg.parentElement;
  const canvasRect = canvas.getBoundingClientRect();

  for (const edge of (wf.edges || [])) {
    const fromEl = document.getElementById(`wfnode-${edge.from_node_id}`);
    const toEl = document.getElementById(`wfnode-${edge.to_node_id}`);
    if (!fromEl || !toEl) continue;

    const fromRect = fromEl.getBoundingClientRect();
    const toRect = toEl.getBoundingClientRect();
    const x1 = fromRect.right - canvasRect.left;
    const y1 = fromRect.top + fromRect.height / 2 - canvasRect.top;
    const x2 = toRect.left - canvasRect.left;
    const y2 = toRect.top + toRect.height / 2 - canvasRect.top;
    const cx = (x1 + x2) / 2;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`);
    path.setAttribute('stroke', 'var(--cyan)');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('fill', 'none');
    path.setAttribute('opacity', '0.5');
    path.style.pointerEvents = 'auto';
    path.style.cursor = 'pointer';
    path.onclick = () => { if (confirm('Remove connection?')) { DEL(`/workflows/edges/${edge.id}`).then(() => viewWorkflow(wf.id)); } };
    svg.appendChild(path);
  }
}

// Drag nodes
let dragState = null;
function startDrag(e, nodeId) {
  if (e.target.classList.contains('wf-port')) return;
  const el = document.getElementById(`wfnode-${nodeId}`);
  dragState = { el, nodeId, startX: e.clientX - el.offsetLeft, startY: e.clientY - el.offsetTop };
  document.addEventListener('mousemove', onDrag);
  document.addEventListener('mouseup', stopDrag);
}
function onDrag(e) {
  if (!dragState) return;
  dragState.el.style.left = (e.clientX - dragState.startX) + 'px';
  dragState.el.style.top = (e.clientY - dragState.startY) + 'px';
  // Redraw edges
  const wfId = dragState.el.closest('.wf-canvas')?.id?.replace('wf-canvas-', '');
  if (wfId) {
    const wf = state.workflows.find(w => w.id === parseInt(wfId));
    if (wf) drawEdges(wf);
  }
}
function stopDrag() { dragState = null; document.removeEventListener('mousemove', onDrag); document.removeEventListener('mouseup', stopDrag); }

function addNodePrompt(wfId) {
  const nt = state.nodeTypes;
  showModal('Add Node', `
    <div class="form-group"><label class="form-label">Node Type</label>
      <div class="btn-group">${Object.entries(nt).map(([k, v]) => `<button class="btn btn-sm" onclick="document.getElementById('node-type').value='${k}';this.parentElement.querySelectorAll('.btn').forEach(b=>b.classList.remove('btn-primary'));this.classList.add('btn-primary')">${v.emoji} ${v.label}</button>`).join('')}</div>
      <input type="hidden" id="node-type" value="process">
    </div>
    <div class="form-group"><label class="form-label">Name</label><input class="input" id="node-name" placeholder="Node name"></div>
    <div class="form-group"><label class="form-label">Description</label><input class="input" id="node-desc" placeholder="What this node does"></div>
    <div class="btn-group"><button class="btn btn-primary" onclick="addNode(${wfId})">Add</button><button class="btn" onclick="closeModal()">Cancel</button></div>
  `);
}
async function addNode(wfId) {
  await POST(`/workflows/${wfId}/nodes`, { name: document.getElementById('node-name').value || 'Node', type: document.getElementById('node-type').value, description: document.getElementById('node-desc').value });
  closeModal(); viewWorkflow(wfId);
}

async function nodeDetail(nodeId, wfId) {
  const wf = state.workflows.find(w => w.id === wfId) || {};
  const node = (wf.nodes || []).find(n => n.id === nodeId);
  if (!node) return;
  const nt = state.nodeTypes[node.node_type] || { emoji: '⚙️', label: '?' };
  const inputs = JSON.parse(node.inputs || '[]');
  const outputs = JSON.parse(node.outputs || '[]');

  const config = JSON.parse(node.config || '{}');
  const envVars = config.env || {};

  // Fetch script + connected inputs from API
  let scriptData = { language: 'text', script: '', prompt: '', connectedInputs: {}, isCustom: false };
  try { scriptData = await GET(`/workflows/nodes/${nodeId}/script`); } catch {}

  const codeContent = scriptData.script || scriptData.prompt || '// No script';
  const langLabel = scriptData.language === 'prompt' ? 'LLM Prompt' : scriptData.language === 'bash' ? 'Bash' : 'JavaScript';
  const langBadge = scriptData.language === 'prompt' ? 'badge-purple' : scriptData.language === 'bash' ? 'badge-orange' : 'badge-blue';

  // Build connection info HTML
  const conns = scriptData.connections || { incoming: [], outgoing: [] };
  let connectionHtml = '';
  if (conns.incoming.length > 0 || conns.outgoing.length > 0) {
    const inHtml = conns.incoming.map(c =>
      `<div class="conn-item conn-in">⬅️ <strong>${escapeHtml(c.name)}</strong> <span class="badge badge-blue" style="font-size:10px">${c.type}</span> <span style="color:var(--text2);font-size:11px">${c.fromOutput} → ${c.toInput}</span>${c.hasResult ? ' <span class="badge badge-green" style="font-size:9px">has data</span>' : ''}
        ${c.hasResult ? `<button class="btn btn-sm" style="font-size:10px;padding:1px 6px;margin-left:4px" onclick="viewUpstreamOutput(${c.nodeId},'${escapeAttr(c.name)}')">👁️ View</button>` : ''}</div>`
    ).join('');
    const outHtml = conns.outgoing.map(c =>
      `<div class="conn-item conn-out">➡️ <strong>${escapeHtml(c.name)}</strong> <span class="badge badge-purple" style="font-size:10px">${c.type}</span> <span style="color:var(--text2);font-size:11px">${c.fromOutput} → ${c.toInput}</span></div>`
    ).join('');
    connectionHtml = `<div class="nd-connections">
      <div class="nd-section-title" style="font-size:12px;margin-bottom:6px">🔗 Connections
        ${conns.incoming.some(c => c.hasResult) ? `<button class="btn btn-sm" style="font-size:10px;margin-left:auto;padding:2px 8px" onclick="fetchUpstreamOutputs(${nodeId})">📥 Get All Upstream</button>` : ''}
      </div>
      ${inHtml}${outHtml}
    </div>`;
  }

  // Build upstream output preview if available
  let upstreamPreviewHtml = '';
  if (Object.keys(scriptData.connectedInputs).length > 0) {
    const preview = JSON.stringify(scriptData.connectedInputs, null, 2);
    upstreamPreviewHtml = `<div class="nd-upstream-preview">
      <div class="nd-section-title" style="font-size:12px;margin-bottom:6px">📊 Upstream Output Structure
        <button class="btn btn-sm" style="font-size:10px;margin-left:auto;padding:2px 8px" onclick="useUpstreamAsTestInput()">↓ Use as Test Input</button>
      </div>
      <pre class="nd-result-pre" style="max-height:150px;overflow-y:auto;font-size:11px">${escapeHtml(preview.substring(0, 2000))}</pre>
    </div>`;
  }

  // Build test input JSON from connected inputs
  const testInputDefault = Object.keys(scriptData.connectedInputs).length > 0
    ? JSON.stringify(scriptData.connectedInputs, null, 2)
    : JSON.stringify({ default: '' }, null, 2);

  // Parse last result if available
  let lastResult = '';
  if (node.result) {
    try { lastResult = JSON.stringify(JSON.parse(node.result), null, 2); }
    catch { lastResult = node.result; }
  }

  showWideModal(`${nt.emoji} ${node.name}`, `
    <div class="node-detail-split">
      <!-- LEFT: Node Config -->
      <div class="node-detail-left">
        <div class="nd-section-title">Configuration</div>
        <p style="color:var(--text2);margin-bottom:10px;font-size:13px">${node.description || 'No description'}</p>
        <div class="form-group"><label class="form-label">Name</label><input class="input" id="nd-name" value="${escapeAttr(node.name)}"></div>
        <div class="form-group"><label class="form-label">Description</label><input class="input" id="nd-desc" value="${escapeAttr(node.description || '')}"></div>
        <div class="form-group"><label class="form-label">Inputs</label><input class="input" id="nd-inputs" value="${inputs.join(', ')}"></div>
        <div class="form-group"><label class="form-label">Outputs</label><input class="input" id="nd-outputs" value="${outputs.join(', ')}"></div>

        <!-- Env Vars / Secrets -->
        <div class="nd-section-title" style="font-size:12px;margin-top:14px;margin-bottom:6px">
          🔑 Environment Variables
          <button class="btn btn-sm" style="margin-left:auto;font-size:10px;padding:2px 8px" onclick="addEnvVarRow()">+ Add</button>
        </div>
        <div id="nd-env-vars" class="nd-env-vars">
          ${Object.entries(envVars).map(([k, v]) => `
            <div class="env-var-row">
              <input class="input env-key" value="${escapeAttr(k)}" placeholder="KEY">
              <input class="input env-val" type="password" value="${escapeAttr(v)}" placeholder="value">
              <button class="btn btn-sm env-toggle" onclick="toggleEnvVisibility(this)" title="Show/Hide">👁️</button>
              <button class="btn btn-sm btn-danger env-del" onclick="this.parentElement.remove()" title="Remove">×</button>
            </div>
          `).join('')}
        </div>
        <p style="color:var(--text2);font-size:10px;margin-top:4px">Use as <code>env.KEY</code> in scripts or <code>{{KEY}}</code> in prompts</p>

        <div class="btn-group" style="margin-top:12px">
          <button class="btn btn-primary btn-sm" onclick="updateNode(${nodeId},${wfId})">💾 Save</button>
          <button class="btn btn-danger btn-sm" onclick="deleteNode(${nodeId},${wfId})">🗑️ Delete</button>
          <button class="btn btn-sm" onclick="closeModal()">Close</button>
        </div>
        ${connectionHtml}
      </div>

      <!-- RIGHT: Code + Test -->
      <div class="node-detail-right">
        <!-- Code/Script header with generate + save buttons -->
        <div class="nd-section-title">
          Script <span class="badge ${langBadge}" style="margin-left:6px">${langLabel}</span>
          ${scriptData.isCustom ? '<span class="badge badge-green" style="margin-left:4px">Custom</span>' : `<span class="badge badge-blue" style="margin-left:4px">${nt.label}</span>`}
          <div style="margin-left:auto;display:flex;gap:6px">
            <button class="btn btn-sm btn-generate" id="nd-gen-btn" onclick="generateNodeScript(${nodeId})">🤖 Generate</button>
            <button class="btn btn-sm btn-primary" onclick="saveNodeScript(${nodeId})">💾 Save Script</button>
          </div>
        </div>
        <textarea class="textarea code-textarea" id="nd-script-editor" rows="8">${escapeHtml(codeContent)}</textarea>

        ${upstreamPreviewHtml}

        <!-- Test Panel -->
        <div class="nd-section-title" style="margin-top:16px">
          🧪 Test Node
          <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="testNodeRun(${nodeId})">▶ Run Test</button>
        </div>
        <div class="form-group">
          <label class="form-label">Test Input (JSON)</label>
          <textarea class="textarea code-textarea" id="nd-test-input" rows="4">${escapeHtml(testInputDefault)}</textarea>
        </div>
        <div id="nd-test-result" class="nd-test-result">
          ${lastResult ? `<div class="nd-section-title" style="font-size:12px">Last Run Result</div><pre class="nd-result-pre">${escapeHtml(lastResult.substring(0, 2000))}</pre>` : '<div style="color:var(--text2);font-size:13px;text-align:center;padding:20px">Click ▶ Run Test to execute this node with the input above</div>'}
        </div>

        <!-- Script Chat Assistant -->
        <div class="nd-script-chat">
          <div class="nd-section-title" style="cursor:pointer" onclick="toggleScriptChat()">
            💬 Script Assistant <span class="badge badge-purple" style="margin-left:6px">AI</span>
            <span style="margin-left:auto;font-size:11px;color:var(--text2)" id="nd-chat-toggle">▼ Open</span>
          </div>
          <div id="nd-script-chat-body" style="display:none">
            <div id="nd-chat-messages" class="nd-chat-messages"></div>
            <div class="nd-chat-input-row">
              <input class="input" id="nd-chat-input" placeholder="Ask AI to fix, explain, or improve this script..."
                onkeydown="if(event.key==='Enter')sendScriptChat(${nodeId})">
              <button class="btn btn-primary btn-sm" onclick="sendScriptChat(${nodeId})">Send</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `);
  // Reset chat history when opening node detail
  window._scriptChatHistory = [];
  window._lastScriptFix = null;
}

async function generateNodeScript(nodeId) {
  const btn = document.getElementById('nd-gen-btn');
  const editor = document.getElementById('nd-script-editor');
  btn.disabled = true;
  btn.classList.add('generating');
  btn.innerHTML = '<div class="nd-spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:middle"></div> Generating...';

  try {
    const result = await POST(`/workflows/nodes/${nodeId}/generate`);
    const script = result.script || result.prompt || '';
    if (!script) throw new Error('LLM returned empty script');
    editor.value = script;
    showToast('🤖', 'Script generated! Click Save Script to keep it.');
  } catch (err) {
    showToast('❌', `Generation failed: ${err.message}`);
    editor.value = `// Generation failed: ${err.message}\n// Check your LLM provider configuration`;
  } finally {
    btn.disabled = false;
    btn.classList.remove('generating');
    btn.innerHTML = '🤖 Generate';
  }
}

async function saveNodeScript(nodeId) {
  const editor = document.getElementById('nd-script-editor');
  const script = editor.value.trim();
  await PUT(`/workflows/nodes/${nodeId}/script`, { script: script || null });
  showToast('💾', 'Script saved!');
  await refreshAll();
}

// View a single upstream node's output
async function viewUpstreamOutput(upstreamNodeId, nodeName) {
  try {
    const data = await GET(`/workflows/nodes/${upstreamNodeId}/result`);
    const content = data.result ? JSON.stringify(data.result, null, 2) : 'No result available';
    showModal(`📊 Output from: ${nodeName}`, `
      <pre class="nd-result-pre" style="max-height:400px;overflow-y:auto;font-size:12px;background:var(--bg);padding:12px;border-radius:8px">${escapeHtml(content.substring(0, 5000))}</pre>
      <div class="btn-group" style="margin-top:12px">
        <button class="btn btn-sm btn-primary" onclick="copyUpstreamToTestInput('${escapeAttr(content.substring(0, 3000))}')">↓ Use as Test Input</button>
        <button class="btn btn-sm" onclick="copyToClipboard(\`${escapeAttr(content.substring(0, 5000))}\`)">📋 Copy</button>
        <button class="btn btn-sm" onclick="closeModal()">Close</button>
      </div>
    `);
  } catch (err) {
    showToast('❌', `Failed to get output: ${err.message}`);
  }
}

// Fetch all upstream outputs and show in the test input
async function fetchUpstreamOutputs(nodeId) {
  try {
    const scriptData = await GET(`/workflows/nodes/${nodeId}/script`);
    const inputs = scriptData.connectedInputs || {};
    if (Object.keys(inputs).length === 0) {
      showToast('⚠️', 'No upstream data available. Run upstream nodes first.');
      return;
    }
    const testInputEl = document.getElementById('nd-test-input');
    if (testInputEl) {
      testInputEl.value = JSON.stringify(inputs, null, 2);
      showToast('📥', 'Upstream outputs loaded into test input!');
    }
  } catch (err) {
    showToast('❌', `Failed to fetch: ${err.message}`);
  }
}

// Copy upstream preview to test input field
function useUpstreamAsTestInput() {
  const preview = document.querySelector('.nd-upstream-preview pre');
  const testInput = document.getElementById('nd-test-input');
  if (preview && testInput) {
    testInput.value = preview.textContent;
    showToast('📥', 'Upstream data copied to test input!');
  }
}

function copyUpstreamToTestInput(data) {
  closeModal();
  const testInput = document.getElementById('nd-test-input');
  if (testInput) {
    try {
      // Try to wrap in the proper input format
      const parsed = JSON.parse(data);
      testInput.value = JSON.stringify({ default: parsed }, null, 2);
    } catch {
      testInput.value = JSON.stringify({ default: data }, null, 2);
    }
    showToast('📥', 'Output copied to test input!');
  }
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => showToast('📋', 'Copied!')).catch(() => showToast('❌', 'Copy failed'));
}

// ===================== SCRIPT CHAT ASSISTANT =====================
function toggleScriptChat() {
  const body = document.getElementById('nd-script-chat-body');
  const toggle = document.getElementById('nd-chat-toggle');
  if (body.style.display === 'none') {
    body.style.display = 'block';
    toggle.textContent = '▲ Close';
  } else {
    body.style.display = 'none';
    toggle.textContent = '▼ Open';
  }
}

function formatChatReply(text) {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map(part => {
    if (part.startsWith('```')) {
      const code = part.replace(/^```(?:fix|javascript|js|bash|prompt)?\n?/, '').replace(/```$/, '');
      return `<pre class="nd-result-pre" style="margin:6px 0">${escapeHtml(code)}</pre>`;
    }
    return escapeHtml(part).replace(/\n/g, '<br>');
  }).join('');
}

async function sendScriptChat(nodeId) {
  const input = document.getElementById('nd-chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';

  const container = document.getElementById('nd-chat-messages');
  container.innerHTML += `<div class="nd-chat-msg nd-chat-user">${escapeHtml(msg)}</div>`;
  container.innerHTML += `<div class="nd-chat-msg nd-chat-ai" id="nd-chat-typing" style="opacity:0.5"><div class="nd-spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;vertical-align:middle"></div> Thinking...</div>`;
  container.scrollTop = container.scrollHeight;

  const editor = document.getElementById('nd-script-editor');
  const currentScript = editor ? editor.value : '';

  try {
    const result = await POST(`/workflows/nodes/${nodeId}/chat`, {
      message: msg,
      script: currentScript,
      history: window._scriptChatHistory || [],
    });

    document.getElementById('nd-chat-typing')?.remove();

    if (!window._scriptChatHistory) window._scriptChatHistory = [];
    window._scriptChatHistory.push({ role: 'user', content: msg });
    window._scriptChatHistory.push({ role: 'assistant', content: result.reply });

    const replyHtml = formatChatReply(result.reply);

    let applyBtn = '';
    if (result.fixedScript) {
      window._lastScriptFix = result.fixedScript;
      applyBtn = `<button class="btn btn-sm btn-primary" style="margin-top:6px" onclick="applyScriptFix()">✨ Apply Fix</button>`;
    }

    container.innerHTML += `<div class="nd-chat-msg nd-chat-ai">${replyHtml}<div class="msg-meta" style="font-size:10px;opacity:0.6;margin-top:4px">${escapeHtml(result.provider || '')} · ${escapeHtml(result.model || '')}</div>${applyBtn}</div>`;
    container.scrollTop = container.scrollHeight;
  } catch (err) {
    document.getElementById('nd-chat-typing')?.remove();
    container.innerHTML += `<div class="nd-chat-msg nd-chat-ai" style="color:var(--red)">Error: ${escapeHtml(err.message)}</div>`;
  }
}

function applyScriptFix() {
  if (!window._lastScriptFix) return;
  const editor = document.getElementById('nd-script-editor');
  if (editor) {
    editor.value = window._lastScriptFix;
    showToast('✨', 'Script fix applied! Click Save Script to keep it.');
  }
}

// ===================== AUTO-FIX WORKFLOW =====================
function getExecutionOrder(nodes, edges) {
  const inDegree = new Map();
  const adj = new Map();
  for (const n of nodes) { inDegree.set(n.id, 0); adj.set(n.id, []); }
  for (const e of edges) {
    adj.get(e.from_node_id)?.push(e.to_node_id);
    inDegree.set(e.to_node_id, (inDegree.get(e.to_node_id) || 0) + 1);
  }
  const queue = [];
  for (const [id, deg] of inDegree) { if (deg === 0) queue.push(id); }
  const order = [];
  while (queue.length > 0) {
    const curr = queue.shift();
    order.push(curr);
    for (const next of (adj.get(curr) || [])) {
      inDegree.set(next, inDegree.get(next) - 1);
      if (inDegree.get(next) === 0) queue.push(next);
    }
  }
  return order.map(id => nodes.find(n => n.id === id)).filter(Boolean);
}

async function autoFixWorkflow(wfId) {
  const wf = await GET(`/workflows/${wfId}`);
  const nodes = wf.nodes || [];
  const edges = wf.edges || [];

  if (nodes.length === 0) { showToast('⚠️', 'No nodes to fix'); return; }

  const orderedNodes = getExecutionOrder(nodes, edges);

  const nodeStatusHtml = orderedNodes.map(n => {
    const nt = state.nodeTypes[n.node_type] || { emoji: '⚙️' };
    return `<div class="af-node-row" id="af-node-${n.id}">
      <span class="af-status" id="af-status-${n.id}">⏳</span>
      <span class="af-node-name">${nt.emoji} ${escapeHtml(n.name)}</span>
      <span class="af-node-msg" id="af-msg-${n.id}">Waiting...</span>
    </div>`;
  }).join('');

  showWideModal('🔧 Auto-Fix Workflow', `
    <p style="color:var(--text2);margin-bottom:16px">Testing each node in order, auto-fixing failures with AI (up to 3 retries per node)...</p>
    <div id="af-progress">${nodeStatusHtml}</div>
    <div id="af-summary" style="margin-top:16px;padding:12px;background:var(--bg);border-radius:8px;display:none"></div>
    <div style="margin-top:16px"><button class="btn" onclick="closeModal()">Close</button></div>
  `);

  const nodeResults = new Map();
  let passed = 0, failed = 0, fixed = 0;
  const MAX_RETRIES = 3;

  for (const node of orderedNodes) {
    const statusEl = document.getElementById(`af-status-${node.id}`);
    const msgEl = document.getElementById(`af-msg-${node.id}`);
    const rowEl = document.getElementById(`af-node-${node.id}`);

    // Build input from upstream results
    const testInput = {};
    const incoming = edges.filter(e => e.to_node_id === node.id);
    for (const e of incoming) {
      const src = nodeResults.get(e.from_node_id);
      if (src) testInput[e.to_input] = src.outputs?.[e.from_output] || src.result || '';
    }
    if (Object.keys(testInput).length === 0) testInput.default = '';

    statusEl.textContent = '🔄';
    msgEl.textContent = 'Testing...';
    msgEl.style.color = 'var(--cyan)';

    try {
      let testResult = await POST(`/workflows/nodes/${node.id}/test`, { input: testInput });

      let retries = 0;
      while (!testResult.ok && retries < MAX_RETRIES) {
        retries++;
        statusEl.textContent = '🔧';
        msgEl.textContent = `Fix attempt ${retries}/${MAX_RETRIES}...`;
        msgEl.style.color = 'var(--orange)';

        const scriptData = await GET(`/workflows/nodes/${node.id}/script`);
        const currentScript = scriptData.script || scriptData.prompt || '';

        const chatResult = await POST(`/workflows/nodes/${node.id}/chat`, {
          message: `This script FAILED with error:\n\`\`\`\n${testResult.error}\n\`\`\`\n\nTest input was:\n\`\`\`json\n${JSON.stringify(testInput, null, 2)}\n\`\`\`\n\nPlease fix the script so it works correctly with this input. Return the complete fixed script.`,
          script: currentScript,
          history: [],
        });

        if (chatResult.fixedScript) {
          await PUT(`/workflows/nodes/${node.id}/script`, { script: chatResult.fixedScript });
          msgEl.textContent = `Re-testing after fix ${retries}...`;
          testResult = await POST(`/workflows/nodes/${node.id}/test`, { input: testInput });
        } else {
          break;
        }
      }

      if (testResult.ok) {
        statusEl.textContent = '✅';
        msgEl.textContent = `Passed (${testResult.duration}ms)${retries > 0 ? ` — auto-fixed in ${retries} attempt${retries > 1 ? 's' : ''}` : ''}`;
        msgEl.style.color = 'var(--green)';
        rowEl.style.borderLeft = '3px solid var(--green)';
        nodeResults.set(node.id, testResult.output);
        passed++;
        if (retries > 0) fixed++;
      } else {
        statusEl.textContent = '❌';
        msgEl.textContent = `Failed after ${retries} fix attempts: ${(testResult.error || '').substring(0, 80)}`;
        msgEl.style.color = 'var(--red)';
        rowEl.style.borderLeft = '3px solid var(--red)';
        failed++;
        nodeResults.set(node.id, testResult.output || { result: '', outputs: { default: '' } });
      }
    } catch (err) {
      statusEl.textContent = '❌';
      msgEl.textContent = `Error: ${err.message}`;
      msgEl.style.color = 'var(--red)';
      rowEl.style.borderLeft = '3px solid var(--red)';
      failed++;
    }
  }

  const summaryEl = document.getElementById('af-summary');
  summaryEl.style.display = 'block';
  summaryEl.innerHTML = `
    <div style="font-weight:700;margin-bottom:8px">🔧 Auto-Fix Complete</div>
    <div style="display:flex;gap:16px;font-size:13px">
      <span style="color:var(--green)">✅ ${passed} passed</span>
      <span style="color:var(--orange)">🔧 ${fixed} auto-fixed</span>
      <span style="color:var(--red)">❌ ${failed} failed</span>
    </div>
  `;

  await refreshAll();
}

// ===================== EXPORT WORKFLOW =====================
function exportWorkflow(wfId) {
  showWideModal('📦 Export Workflow', `
    <p style="color:var(--text2);margin-bottom:16px">Choose an export format:</p>
    <div class="grid grid-2" style="gap:12px">
      <div class="card export-card" onclick="doExport(${wfId},'json')">
        <div class="card-title">📄 JSON Backup</div>
        <div class="card-subtitle">Raw workflow definition with all nodes, edges, and scripts. Import or share later.</div>
      </div>
      <div class="card export-card" onclick="doExport(${wfId},'nodejs')">
        <div class="card-title">📦 Node.js Project</div>
        <div class="card-subtitle">Standalone runnable project with package.json, individual node files, and workflow runner.</div>
      </div>
      <div class="card export-card" onclick="doExport(${wfId},'api')">
        <div class="card-title">🌐 API Server</div>
        <div class="card-subtitle">Express REST server exposing the workflow as a POST /run endpoint.</div>
      </div>
      <div class="card export-card" onclick="doExport(${wfId},'docker')">
        <div class="card-title">🐳 Docker Project</div>
        <div class="card-subtitle">Containerized API server with Dockerfile and docker-compose.yml, ready to deploy.</div>
      </div>
    </div>
    <div style="margin-top:16px"><button class="btn" onclick="closeModal()">Cancel</button></div>
  `);
}

async function doExport(wfId, format) {
  showWideModal('📦 Exporting...', '<div class="nd-test-running"><div class="nd-spinner"></div> Generating export files...</div>');

  try {
    const result = await POST(`/workflows/${wfId}/export`, { format });

    if (format === 'json') {
      const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' });
      downloadBlob(blob, result.filename || 'workflow.json');
      showToast('📄', 'JSON exported!');
      closeModal();
    } else {
      const filesHtml = result.files.map(f =>
        `<div style="font-size:12px;padding:4px 8px;background:var(--bg);border-radius:4px;margin:2px 0;font-family:monospace">${escapeHtml(f)}</div>`
      ).join('');

      showWideModal(`📦 Export Complete — ${format.toUpperCase()}`, `
        <p style="color:var(--green);margin-bottom:12px">✅ ${result.files.length} files generated!</p>
        <div style="margin-bottom:12px"><strong>Location:</strong> <code style="color:var(--cyan)">${escapeHtml(result.outputDir)}</code></div>
        <div class="nd-section-title" style="font-size:12px">Generated Files</div>
        <div style="max-height:250px;overflow-y:auto">${filesHtml}</div>
        <div class="btn-group" style="margin-top:16px">
          <button class="btn btn-primary" onclick="closeModal()">Done</button>
        </div>
      `);
    }
  } catch (err) {
    showModal('❌ Export Error', `<p style="color:var(--red)">${escapeHtml(err.message)}</p><button class="btn" onclick="closeModal()">Close</button>`);
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
}

async function testNodeRun(nodeId) {
  const resultEl = document.getElementById('nd-test-result');
  const inputEl = document.getElementById('nd-test-input');
  let testInput = {};
  try { testInput = JSON.parse(inputEl.value); }
  catch { resultEl.innerHTML = '<div style="color:var(--red);padding:10px">❌ Invalid JSON input</div>'; return; }

  resultEl.innerHTML = '<div class="nd-test-running"><div class="nd-spinner"></div> Running test...</div>';

  try {
    const result = await POST(`/workflows/nodes/${nodeId}/test`, { input: testInput });
    const statusIcon = result.ok ? '✅' : '❌';
    const statusClass = result.ok ? 'badge-green' : 'badge-red';
    const output = result.ok
      ? (typeof result.output === 'object' ? JSON.stringify(result.output, null, 2) : String(result.output))
      : result.error;

    resultEl.innerHTML = `
      <div class="nd-test-header">
        <span class="badge ${statusClass}">${statusIcon} ${result.ok ? 'PASS' : 'FAIL'}</span>
        <span style="color:var(--text2);font-size:11px">⏱ ${result.duration}ms</span>
      </div>
      <div class="nd-section-title" style="font-size:12px;margin-top:8px">Output</div>
      <pre class="nd-result-pre">${escapeHtml(output.substring(0, 3000))}</pre>
    `;

    if (result.ok) showToast('✅', `Node test passed (${result.duration}ms)`);
  } catch (err) {
    resultEl.innerHTML = `<div style="color:var(--red);padding:10px">❌ ${escapeHtml(err.message)}</div>`;
  }
}
function addEnvVarRow() {
  const container = document.getElementById('nd-env-vars');
  const row = document.createElement('div');
  row.className = 'env-var-row';
  row.innerHTML = `
    <input class="input env-key" value="" placeholder="KEY">
    <input class="input env-val" type="password" value="" placeholder="value">
    <button class="btn btn-sm env-toggle" onclick="toggleEnvVisibility(this)" title="Show/Hide">👁️</button>
    <button class="btn btn-sm btn-danger env-del" onclick="this.parentElement.remove()" title="Remove">×</button>
  `;
  container.appendChild(row);
  row.querySelector('.env-key').focus();
}
function toggleEnvVisibility(btn) {
  const input = btn.parentElement.querySelector('.env-val');
  input.type = input.type === 'password' ? 'text' : 'password';
  btn.textContent = input.type === 'password' ? '👁️' : '🙈';
}
function collectEnvVars() {
  const env = {};
  document.querySelectorAll('#nd-env-vars .env-var-row').forEach(row => {
    const key = row.querySelector('.env-key')?.value?.trim();
    const val = row.querySelector('.env-val')?.value || '';
    if (key) env[key] = val;
  });
  return env;
}
async function updateNode(nodeId, wfId) {
  const inputs = document.getElementById('nd-inputs').value.split(',').map(s => s.trim()).filter(Boolean);
  const outputs = document.getElementById('nd-outputs').value.split(',').map(s => s.trim()).filter(Boolean);
  const env = collectEnvVars();
  await PUT(`/workflows/nodes/${nodeId}`, {
    name: document.getElementById('nd-name').value,
    description: document.getElementById('nd-desc').value,
    inputs, outputs,
    config: { env },
  });
  closeModal(); await refreshAll(); viewWorkflow(wfId);
}
async function deleteNode(nodeId, wfId) { await DEL(`/workflows/nodes/${nodeId}`); closeModal(); await refreshAll(); viewWorkflow(wfId); }
async function executeWorkflow(wfId) {
  connectSSE(wfId); // Connect SSE for real-time updates
  showToast('⚡', 'Workflow executing...');
  try {
    const wf = await POST(`/workflows/${wfId}/execute`);
    await refreshAll(); updateHeader(); viewWorkflow(wfId);
  } catch (err) {
    showToast('❌', `Execution failed: ${err.message}`);
  }
}
async function deleteWorkflow(wfId) { if (!confirm('Delete?')) return; await DEL(`/workflows/${wfId}`); await refreshAll(); renderWorkflows(document.getElementById('content')); }

// ===================== DRAFTS =====================
async function renderDrafts(el) {
  await refreshAll();
  el.innerHTML = `
    <div class="section-title"><span class="icon">📥</span> Draft Board</div>
    ${state.drafts.length === 0 ? '<div class="empty-state"><div class="empty-icon">📥</div><h3>No drafts</h3><p>Share links in Telegram to save them here</p></div>' :
      `<div class="grid grid-2">${state.drafts.map(d => {
        const statusBadge = d.status === 'processed' ? '<span class="badge badge-green">Processed</span>' : '<span class="badge badge-blue">New</span>';
        return `<div class="card draft-card">
          <div class="card-header">
            <div class="card-title" style="font-size:14px">${escapeHtml(d.title || d.url || 'Untitled')}</div>
            ${statusBadge}
          </div>
          <div class="card-subtitle" style="margin:4px 0">${d.description ? escapeHtml(d.description.substring(0, 120)) : '<span style="color:var(--text2)">No description</span>'}</div>
          ${d.url ? `<a href="${d.url}" target="_blank" style="font-size:11px;color:var(--cyan);display:block;margin:6px 0" onclick="event.stopPropagation()">🔗 ${escapeHtml(d.url.substring(0, 60))}</a>` : ''}
          <div class="draft-actions">
            <button class="btn btn-sm btn-generate" onclick="expandDraft(${d.id})">💡 Expand Idea</button>
            <button class="btn btn-sm btn-primary" onclick="cloneDraft(${d.id})">📋 Clone as Board</button>
            <button class="btn btn-sm btn-danger" onclick="deleteDraft(${d.id})">🗑️</button>
          </div>
        </div>`;
      }).join('')}</div>`}`;
}

async function expandDraft(draftId) {
  showWideModal('💡 Expanding Idea...', '<div class="nd-test-running"><div class="nd-spinner"></div> Analyzing link and generating plans...</div>');

  try {
    const result = await POST(`/drafts/${draftId}/expand`);
    const plans = result.plans || [];
    const knowledge = result.knowledge || '';

    let plansHtml = '';
    if (plans.length > 0) {
      plansHtml = plans.map((p, i) => {
        const diffColor = p.difficulty === 'Easy' ? 'badge-green' : p.difficulty === 'Hard' ? 'badge-red' : 'badge-orange';
        return `<div class="expand-plan-card">
          <div class="expand-plan-header">
            <span class="expand-plan-num">${i + 1}</span>
            <div>
              <div class="expand-plan-title">${escapeHtml(p.title)}</div>
              <span class="badge ${diffColor}">${escapeHtml(p.difficulty || 'Medium')}</span>
            </div>
            <button class="btn btn-sm btn-primary" style="margin-left:auto" onclick="cloneDraft(${draftId}, decodeURIComponent('${encodeURIComponent(p.title)}'), decodeURIComponent('${encodeURIComponent((p.description || '').substring(0, 500))}'))">📋 Build This</button>
          </div>
          <p class="expand-plan-desc">${escapeHtml(p.description || '')}</p>
          ${(p.features || []).length > 0 ? `<div class="expand-plan-section"><strong>Features:</strong> ${p.features.map(f => `<span class="badge badge-blue" style="margin:2px">${escapeHtml(f)}</span>`).join('')}</div>` : ''}
          ${(p.techStack || []).length > 0 ? `<div class="expand-plan-section"><strong>Tech:</strong> ${p.techStack.map(t => `<span class="badge badge-purple" style="margin:2px">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
          ${(p.skills || []).length > 0 ? `<div class="expand-plan-section"><strong>Skills/APIs:</strong> ${p.skills.map(s => `<span class="badge badge-green" style="margin:2px">${escapeHtml(s)}</span>`).join('')}</div>` : ''}
        </div>`;
      }).join('');
    } else {
      // Fallback: show raw text
      plansHtml = `<div class="code-block"><pre>${escapeHtml(result.raw || 'No plans generated')}</pre></div>`;
    }

    const knowledgeHtml = knowledge ? `<div class="expand-knowledge"><div class="nd-section-title" style="margin-top:16px">📚 Knowledge & Skills to Extract</div><div class="code-block"><pre>${escapeHtml(knowledge)}</pre></div></div>` : '';

    showWideModal('💡 Expansion Plans', `
      <p style="color:var(--text2);margin-bottom:16px;font-size:13px">Generated via ${escapeHtml(result.provider || 'LLM')} · ${escapeHtml(result.model || '')}</p>
      <div class="expand-plans">${plansHtml}</div>
      ${knowledgeHtml}
      <div style="margin-top:16px"><button class="btn" onclick="closeModal()">Close</button></div>
    `);

    await refreshAll();
  } catch (err) {
    showModal('❌ Error', `<p style="color:var(--red)">${escapeHtml(err.message)}</p><button class="btn" onclick="closeModal()">Close</button>`);
  }
}

async function cloneDraft(draftId, planTitle, planDescription) {
  closeModal();
  const content = document.getElementById('content');
  content.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><h3>Creating board from plan...</h3></div>';

  try {
    const body = {};
    if (planTitle) body.planTitle = planTitle;
    if (planDescription) body.planDescription = planDescription;
    const result = await POST(`/drafts/${draftId}/clone`, body);
    await refreshAll();
    if (result.board) {
      showToast('📋', 'Board created from draft!');
      viewBoard(result.board.id);
    } else {
      renderDrafts(content);
    }
  } catch (err) {
    showToast('❌', `Clone failed: ${err.message}`);
    renderDrafts(content);
  }
}

async function deleteDraft(id) { await DEL(`/drafts/${id}`); renderDrafts(document.getElementById('content')); }

// ===================== PROJECTS (Exported) =====================
async function renderProjects(el) {
  el.innerHTML = '<div class="section-title"><span class="icon">🚀</span> Exported Projects</div><div style="padding:20px;color:var(--text2)">Loading projects...</div>';

  try {
    const data = await GET('/projects');
    const projects = data.projects || [];

    if (projects.length === 0) {
      el.innerHTML = `
        <div class="section-title"><span class="icon">🚀</span> Exported Projects</div>
        <div class="empty-state">
          <div class="empty-icon">🚀</div>
          <h3>No exported projects</h3>
          <p>Export a workflow as Node.js or API Server to see it here</p>
        </div>`;
      return;
    }

    const projectCards = projects.map(p => {
      const typeBadge = p.types.map(t => {
        const badges = { 'nodejs': 'badge-green', 'api': 'badge-blue', 'docker': 'badge-purple' };
        return `<span class="badge ${badges[t] || 'badge-blue'}">${t}</span>`;
      }).join(' ');
      const statusBadge = p.running
        ? `<span class="badge badge-green" style="animation:pulse 2s infinite">● Running :${p.port}</span>`
        : '<span class="badge" style="background:var(--bg)">○ Stopped</span>';
      const subdomain = p.safeName.toLowerCase();

      return `<div class="card project-card">
        <div class="card-header">
          <div class="card-title">${escapeHtml(p.name)}</div>
          ${statusBadge}
        </div>
        <div style="display:flex;gap:4px;margin:6px 0">${typeBadge}</div>
        <div style="font-size:11px;color:var(--text2);margin-bottom:8px">
          ${p.files} files${p.running ? ` • <a href="http://${subdomain}.localhost:9999" target="_blank" style="color:var(--cyan)">${subdomain}.localhost:9999</a>` : ''}
        </div>
        <div class="btn-group">
          ${p.running
            ? `<button class="btn btn-danger btn-sm" onclick="projectAction('${escapeAttr(p.safeName)}','stop')">⏹ Stop</button>
               <a href="http://${subdomain}.localhost:9999" target="_blank" class="btn btn-sm btn-primary">🌐 Open</a>`
            : `<button class="btn btn-sm btn-primary" onclick="projectAction('${escapeAttr(p.safeName)}','start')">▶ Start</button>`
          }
          <button class="btn btn-sm" onclick="projectLogs('${escapeAttr(p.safeName)}')">📋 Logs</button>
        </div>
      </div>`;
    }).join('');

    el.innerHTML = `
      <div class="section-title"><span class="icon">🚀</span> Exported Projects <span class="badge badge-blue">${projects.length}</span></div>
      <div class="grid grid-2">${projectCards}</div>`;
  } catch (err) {
    el.innerHTML = `<div class="section-title"><span class="icon">🚀</span> Projects</div><p style="color:var(--pink)">Error: ${escapeHtml(err.message)}</p>`;
  }
}

async function projectAction(name, action) {
  try {
    await POST(`/projects/${name}/${action}`);
    showToast(action === 'start' ? '▶' : '⏹', `Project ${action === 'start' ? 'started' : 'stopped'}!`);
    renderProjects(document.getElementById('content'));
  } catch (err) {
    showToast('❌', err.message || 'Error');
  }
}

async function projectLogs(name) {
  try {
    const data = await GET(`/projects/${name}/logs`);
    const logs = data.logs || 'No logs yet';
    showWideModal(`📋 Logs: ${name}`, `
      <pre class="nd-result-pre" style="max-height:500px;overflow-y:auto;font-size:11px;white-space:pre-wrap">${escapeHtml(logs)}</pre>
      <button class="btn btn-sm" style="margin-top:8px" onclick="projectLogs('${escapeAttr(name)}')">🔄 Refresh</button>
    `);
  } catch (err) {
    showToast('❌', err.message || 'Error');
  }
}

// ===================== CHAT =====================
function renderChat(el) {
  el.innerHTML = `
    <div class="chat-container">
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-input-area">
        <input class="input" id="chat-input" placeholder="Type a message..." onkeydown="if(event.key==='Enter')sendChat()">
        <button class="btn btn-primary" onclick="sendChat()">Send</button>
      </div>
    </div>`;
  if (state.chatSessionId) loadChatHistory();
}

async function loadChatHistory() {
  if (!state.chatSessionId) return;
  const msgs = await GET(`/sessions/${state.chatSessionId}/messages`);
  const container = document.getElementById('chat-messages');
  if (!container) return;
  container.innerHTML = msgs.map(m => `<div class="chat-msg ${m.role}">${escapeHtml(m.content)}${m.role === 'assistant' ? '<div class="msg-meta">AI</div>' : ''}</div>`).join('');
  container.scrollTop = container.scrollHeight;
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';

  const container = document.getElementById('chat-messages');
  container.innerHTML += `<div class="chat-msg user">${escapeHtml(msg)}</div>`;
  container.innerHTML += `<div class="chat-msg assistant" id="typing" style="opacity:0.5">Thinking...</div>`;
  container.scrollTop = container.scrollHeight;

  try {
    const result = await POST('/chat', { message: msg, sessionId: state.chatSessionId });
    document.getElementById('typing')?.remove();

    if (result.reply) {
      state.chatSessionId = result.sessionId;
      container.innerHTML += `<div class="chat-msg assistant">${escapeHtml(result.reply)}<div class="msg-meta">${escapeHtml(result.provider)} · ${escapeHtml(result.model)}</div></div>`;
    } else {
      container.innerHTML += `<div class="chat-msg assistant" style="color:var(--red)">Error: ${escapeHtml(result.error)}</div>`;
    }
  } catch (err) {
    document.getElementById('typing')?.remove();
    container.innerHTML += `<div class="chat-msg assistant" style="color:var(--red)">Error: ${escapeHtml(err.message)}</div>`;
  }
  container.scrollTop = container.scrollHeight;
  await refreshAll(); updateHeader();
}

// ===================== ACHIEVEMENTS =====================
function renderAchievements(el) {
  const achievements = state.stats?.achievements || [];
  const earned = achievements.filter(a => a.earned).length;
  el.innerHTML = `
    <div class="section-title"><span class="icon">🏆</span> Achievements <span class="badge badge-green">${earned}/${achievements.length}</span></div>
    <div class="grid grid-4">
      ${achievements.map(a => `
        <div class="ach-card ${a.earned ? 'earned' : 'locked'}">
          <div class="ach-icon">${a.icon}</div>
          <div class="ach-title">${a.title}</div>
          <div class="ach-desc">${a.desc}</div>
        </div>`).join('')}
    </div>`;
}

// ===================== MODAL =====================
function showModal(title, bodyHtml) {
  const existing = document.querySelector('.modal-backdrop');
  if (existing) existing.remove();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.onclick = (e) => { if (e.target === backdrop) closeModal(); };
  const safeTitle = escapeHtml(title);
  backdrop.innerHTML = `<div class="modal"><h3>${safeTitle}</h3>${bodyHtml}</div>`;
  document.body.appendChild(backdrop);
}
function showWideModal(title, bodyHtml) {
  const existing = document.querySelector('.modal-backdrop');
  if (existing) existing.remove();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.onclick = (e) => { if (e.target === backdrop) closeModal(); };
  const safeTitle = escapeHtml(title);
  backdrop.innerHTML = `<div class="modal modal-wide"><h3>${safeTitle}</h3>${bodyHtml}</div>`;
  document.body.appendChild(backdrop);
}
function closeModal() { document.querySelector('.modal-backdrop')?.remove(); }

// ===================== PARTICLES =====================
function createParticles() {
  const container = document.getElementById('particles');
  const colors = ['var(--cyan)', 'var(--purple)', 'var(--green)', 'var(--pink)'];
  for (let i = 0; i < 30; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left = Math.random() * 100 + '%';
    p.style.animationDuration = (15 + Math.random() * 20) + 's';
    p.style.animationDelay = Math.random() * 15 + 's';
    p.style.background = colors[Math.floor(Math.random() * colors.length)];
    p.style.width = (2 + Math.random() * 3) + 'px';
    p.style.height = p.style.width;
    container.appendChild(p);
  }
}

// ===================== TOASTS =====================
function showToast(icon, text) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-text">${escapeHtml(text)}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function closeLevelUp() { document.getElementById('levelup-overlay').classList.add('hidden'); }

// ===================== SEARCH =====================
let _searchDebounce = null;
async function globalSearch(query) {
  state.searchQuery = query;
  clearTimeout(_searchDebounce);
  if (!query.trim()) {
    document.getElementById('search-results')?.remove();
    return;
  }
  _searchDebounce = setTimeout(async () => {
    try {
      const results = await GET(`/search?q=${encodeURIComponent(query)}`);
      showSearchResults(results, query);
    } catch {}
  }, 300);
}

function showSearchResults(results, query) {
  let dropdown = document.getElementById('search-results');
  if (!dropdown) {
    dropdown = document.createElement('div');
    dropdown.id = 'search-results';
    dropdown.className = 'search-dropdown';
    document.querySelector('.header').appendChild(dropdown);
  }

  const items = [];
  for (const b of (results.boards || []).slice(0, 3)) {
    items.push(`<div class="search-item" onclick="viewBoard(${b.id});closeSearch()"><span class="search-type">📋</span> ${escapeHtml(b.title)}</div>`);
  }
  for (const w of (results.workflows || []).slice(0, 3)) {
    items.push(`<div class="search-item" onclick="viewWorkflow(${w.id});closeSearch()"><span class="search-type">🔀</span> ${escapeHtml(w.title)}</div>`);
  }
  for (const d of (results.drafts || []).slice(0, 3)) {
    items.push(`<div class="search-item" onclick="showSection('drafts');closeSearch()"><span class="search-type">📥</span> ${escapeHtml(d.title || d.url || 'Draft')}</div>`);
  }

  dropdown.innerHTML = items.length > 0 ? items.join('') : '<div class="search-empty">No results</div>';
}

function closeSearch() {
  document.getElementById('search-results')?.remove();
  const searchInput = document.getElementById('global-search');
  if (searchInput) searchInput.value = '';
}

// ===================== WORKFLOW SCHEDULER =====================
function scheduleWorkflow(wfId) {
  const existing = state.schedules.find(s => s.workflow_id === wfId);
  const cronPresets = [
    { label: 'Every 5 min', cron: '*/5 * * * *' },
    { label: 'Every 30 min', cron: '*/30 * * * *' },
    { label: 'Hourly', cron: '0 * * * *' },
    { label: 'Daily 9 AM', cron: '0 9 * * *' },
    { label: 'Weekdays 9 AM', cron: '0 9 * * 1-5' },
    { label: 'Weekly Monday', cron: '0 9 * * 1' },
  ];

  showModal('⏰ Schedule Workflow', `
    ${existing ? `<div class="schedule-info"><span class="badge ${existing.enabled ? 'badge-green' : 'badge-red'}">${existing.enabled ? 'Active' : 'Paused'}</span> <span style="color:var(--text2);font-size:12px">${escapeHtml(existing.description || existing.cron_expression)}</span>
      ${existing.last_run_at ? `<div style="font-size:11px;color:var(--text2);margin-top:4px">Last run: ${new Date(existing.last_run_at).toLocaleString()} · Status: ${existing.last_status}</div>` : ''}
      <div class="btn-group" style="margin-top:8px">
        <button class="btn btn-sm" onclick="toggleSchedule(${existing.id})">${existing.enabled ? '⏸ Pause' : '▶ Resume'}</button>
        <button class="btn btn-sm btn-danger" onclick="deleteSchedule(${existing.id},${wfId})">🗑️ Remove</button>
      </div>
    </div>` : ''}
    <div class="form-group">
      <label class="form-label">Preset Schedules</label>
      <div class="btn-group">${cronPresets.map(p =>
        `<button class="btn btn-sm" onclick="document.getElementById('cron-input').value='${p.cron}'">${p.label}</button>`
      ).join('')}</div>
    </div>
    <div class="form-group">
      <label class="form-label">Cron Expression</label>
      <input class="input" id="cron-input" value="${existing?.cron_expression || '0 9 * * *'}" placeholder="min hour day month weekday" style="font-family:monospace">
      <p style="font-size:10px;color:var(--text2);margin-top:4px">Format: minute(0-59) hour(0-23) day(1-31) month(1-12) weekday(0-6, 0=Sun)</p>
    </div>
    <div class="btn-group">
      <button class="btn btn-primary" onclick="saveSchedule(${wfId})">${existing ? '💾 Update' : '⏰ Create'} Schedule</button>
      <button class="btn" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function saveSchedule(wfId) {
  const cron = document.getElementById('cron-input').value.trim();
  if (!cron) return;
  try {
    await POST(`/workflows/${wfId}/schedule`, { cronExpression: cron });
    closeModal();
    showToast('⏰', 'Schedule saved!');
    await refreshAll();
  } catch (err) {
    showToast('❌', err.message);
  }
}

async function toggleSchedule(scheduleId) {
  await PUT(`/schedules/${scheduleId}/toggle`);
  closeModal();
  showToast('⏰', 'Schedule updated!');
  await refreshAll();
}

async function deleteSchedule(scheduleId, wfId) {
  await DEL(`/schedules/${scheduleId}`);
  closeModal();
  showToast('🗑️', 'Schedule removed');
  await refreshAll();
}

// ===================== WEBHOOKS =====================
async function webhookWorkflow(wfId) {
  const wf = state.workflows.find(w => w.id === wfId);
  const hasWebhook = wf?.webhook_id;

  if (hasWebhook) {
    const webhookUrl = `${location.origin}/api/webhook/${wf.webhook_id}`;
    showModal('🔗 Webhook Trigger', `
      <div class="form-group">
        <label class="form-label">Webhook URL</label>
        <div class="key-input-row">
          <input class="input" value="${webhookUrl}" readonly id="webhook-url" style="font-family:monospace;font-size:11px">
          <button class="btn btn-sm" onclick="copyToClipboard('${escapeAttr(webhookUrl)}')">📋</button>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Usage (curl)</label>
        <pre class="nd-result-pre" style="font-size:11px">curl -X POST ${webhookUrl}</pre>
      </div>
      <div class="btn-group">
        <button class="btn btn-danger btn-sm" onclick="deleteWebhook(${wfId})">🗑️ Remove Webhook</button>
        <button class="btn" onclick="closeModal()">Close</button>
      </div>
    `);
  } else {
    try {
      const result = await POST(`/workflows/${wfId}/webhook`);
      const webhookUrl = `${location.origin}${result.url}`;
      showToast('🔗', 'Webhook created!');
      await refreshAll();
      webhookWorkflow(wfId);
    } catch (err) {
      showToast('❌', err.message);
    }
  }
}

async function deleteWebhook(wfId) {
  await DEL(`/workflows/${wfId}/webhook`);
  closeModal();
  showToast('🗑️', 'Webhook removed');
  await refreshAll();
}

// ===================== WORKFLOW IMPORT =====================
function importWorkflow() {
  showModal('📥 Import Workflow', `
    <p style="color:var(--text2);margin-bottom:12px">Paste a JSON workflow export or select a file:</p>
    <div class="form-group">
      <label class="form-label">JSON Data</label>
      <textarea class="textarea" id="import-json" rows="8" placeholder='{"workflow":{...},"nodes":[...],"edges":[...]}'></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Or upload file</label>
      <input type="file" id="import-file" accept=".json" onchange="loadImportFile()" style="color:var(--text2);font-size:12px">
    </div>
    <div class="btn-group">
      <button class="btn btn-primary" onclick="doImport()">📥 Import</button>
      <button class="btn" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

function loadImportFile() {
  const file = document.getElementById('import-file').files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => { document.getElementById('import-json').value = e.target.result; };
  reader.readAsText(file);
}

async function doImport() {
  const raw = document.getElementById('import-json').value.trim();
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    const result = await POST('/workflows/import', { data });
    closeModal();
    showToast('📥', 'Workflow imported!');
    await refreshAll();
    if (result.id) viewWorkflow(result.id);
  } catch (err) {
    showToast('❌', `Import failed: ${err.message}`);
  }
}

// ===================== RUN HISTORY =====================
async function workflowHistory(wfId) {
  try {
    const history = await GET(`/workflows/${wfId}/history`);
    const rows = history.map(h => {
      const statusBadge = h.status === 'completed' ? 'badge-green' : h.status === 'failed' ? 'badge-red' : 'badge-orange';
      const trigger = h.trigger_type === 'schedule' ? '⏰' : h.trigger_type === 'webhook' ? '🔗' : '▶';
      const duration = h.finished_at ? `${Math.round((new Date(h.finished_at) - new Date(h.started_at)) / 1000)}s` : '...';
      return `<div class="history-row">
        <span>${trigger}</span>
        <span style="flex:1;font-size:12px">${new Date(h.started_at).toLocaleString()}</span>
        <span class="badge ${statusBadge}">${h.status}</span>
        <span style="font-size:11px;color:var(--text2)">${duration}</span>
        ${h.node_count ? `<span style="font-size:11px"><span style="color:var(--green)">✅${h.passed_count}</span> <span style="color:var(--red)">❌${h.failed_count}</span></span>` : ''}
      </div>`;
    }).join('');

    showModal('📊 Run History', `
      ${rows || '<div style="color:var(--text2);text-align:center;padding:20px">No runs yet</div>'}
      <button class="btn" style="margin-top:12px" onclick="closeModal()">Close</button>
    `);
  } catch (err) {
    showToast('❌', err.message);
  }
}

// ===================== SSE EXECUTION STREAM =====================
let _activeSSE = null;

function connectSSE(wfId) {
  if (_activeSSE) { _activeSSE.close(); _activeSSE = null; }
  const source = new EventSource(`/api/workflows/${wfId}/stream`);
  _activeSSE = source;

  source.addEventListener('node', (e) => {
    const data = JSON.parse(e.data);
    const nodeEl = document.getElementById(`wfnode-${data.nodeId}`);
    if (nodeEl) {
      nodeEl.className = nodeEl.className.replace(/\b(running|done|error)\b/g, '').trim();
      if (data.status === 'running') nodeEl.classList.add('running');
      else if (data.status === 'done') nodeEl.classList.add('done');
      else if (data.status === 'error') nodeEl.classList.add('error');
    }
  });

  source.addEventListener('complete', (e) => {
    const data = JSON.parse(e.data);
    showToast('⚡', `Workflow done! ✅${data.passed} ❌${data.failed}`);
    source.close();
    _activeSSE = null;
  });

  source.addEventListener('error', (e) => {
    source.close();
    _activeSSE = null;
  });

  return source;
}

function escapeHtml(text) {
  if (text == null) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text) {
  return String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/`/g, '&#96;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
}

// ===================== TEMPLATES MARKETPLACE =====================
async function renderTemplates(el) {
  el.innerHTML = '<div class="section-title"><span class="icon">🏪</span> Template Marketplace</div><div style="padding:20px;color:var(--text2)">Loading templates...</div>';
  try {
    const [tpls, cats] = await Promise.all([GET('/templates'), GET('/templates/categories')]);
    const catBtns = ['all', ...cats].map(c => `<button class="btn btn-sm ${c === 'all' ? 'btn-primary' : ''}" onclick="filterTemplates('${escapeAttr(c)}')">${escapeHtml(c)}</button>`).join(' ');
    const cards = tpls.map(t => {
      const tags = JSON.parse(t.tags || '[]').map(tag => `<span class="badge badge-blue" style="margin:2px;font-size:10px">${escapeHtml(tag)}</span>`).join('');
      const stars = t.rating > 0 ? `⭐ ${t.rating.toFixed(1)}` : '';
      return `<div class="card">
        <div class="card-header"><div class="card-title">${escapeHtml(t.title)}</div><span class="badge badge-purple">${escapeHtml(t.category)}</span></div>
        <p style="color:var(--text2);font-size:12px;margin:6px 0">${escapeHtml(t.description || '')}</p>
        <div style="margin:4px 0">${tags}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
          <span style="font-size:11px;color:var(--text2)">${stars} · ${t.uses} uses</span>
          <button class="btn btn-sm btn-primary" onclick="useTemplate(${t.id})">⚡ Use</button>
        </div>
      </div>`;
    }).join('');
    el.innerHTML = `
      <div class="section-title"><span class="icon">🏪</span> Template Marketplace <span class="badge badge-green">${tpls.length}</span></div>
      <div class="btn-group" style="margin-bottom:12px">${catBtns}</div>
      <div class="grid grid-3">${cards || '<div class="empty-state"><div class="empty-icon">🏪</div><h3>No templates yet</h3></div>'}</div>`;
  } catch (err) {
    el.innerHTML = `<div class="section-title"><span class="icon">🏪</span> Templates</div><p style="color:var(--pink)">Error: ${escapeHtml(err.message)}</p>`;
  }
}

async function filterTemplates(category) {
  const tpls = await GET(`/templates?category=${encodeURIComponent(category)}`);
  const grid = document.querySelector('.grid.grid-3');
  if (!grid) return;
  grid.innerHTML = tpls.map(t => {
    const tags = JSON.parse(t.tags || '[]').map(tag => `<span class="badge badge-blue" style="margin:2px;font-size:10px">${escapeHtml(tag)}</span>`).join('');
    return `<div class="card">
      <div class="card-header"><div class="card-title">${escapeHtml(t.title)}</div><span class="badge badge-purple">${escapeHtml(t.category)}</span></div>
      <p style="color:var(--text2);font-size:12px;margin:6px 0">${escapeHtml(t.description || '')}</p>
      <div style="margin:4px 0">${tags}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
        <span style="font-size:11px;color:var(--text2)">${t.rating > 0 ? '⭐ ' + t.rating.toFixed(1) : ''} · ${t.uses} uses</span>
        <button class="btn btn-sm btn-primary" onclick="useTemplate(${t.id})">⚡ Use</button>
      </div>
    </div>`;
  }).join('') || '<div class="empty-state"><h3>No templates in this category</h3></div>';
}

async function useTemplate(templateId) {
  try {
    const result = await POST(`/templates/${templateId}/use`);
    showToast('⚡', `Template deployed! Workflow #${result.workflowId} created with ${result.nodeCount} nodes`);
    await refreshAll();
    viewWorkflow(result.workflowId);
  } catch (err) {
    showToast('❌', err.message);
  }
}

// ===================== MULTI-MODEL ARENA =====================
async function renderArena(el) {
  const [history, stats] = await Promise.allSettled([GET('/arena/history'), GET('/arena/stats')]);
  const battles = history.status === 'fulfilled' ? history.value : [];
  const winStats = stats.status === 'fulfilled' ? stats.value : {};

  const statsCards = Object.entries(winStats).map(([prov, s]) =>
    `<div class="card" style="text-align:center;padding:12px">
      <div style="font-size:14px;font-weight:bold;color:var(--cyan)">${escapeHtml(prov)}</div>
      <div style="font-size:24px;font-weight:bold;color:var(--green)">${s.winRate}%</div>
      <div style="font-size:11px;color:var(--text2)">${s.wins}/${s.battles} wins</div>
    </div>`
  ).join('');

  const recentBattles = battles.slice(0, 5).map(b => {
    const providers = Object.keys(b.responses);
    return `<div class="card" style="padding:10px;margin-bottom:8px">
      <div style="font-size:12px;color:var(--text2);margin-bottom:4px">${escapeHtml(b.prompt.substring(0, 80))}...</div>
      <div style="display:flex;gap:6px">${providers.map(p =>
        `<span class="badge ${b.winner === p ? 'badge-green' : ''}">${escapeHtml(p)}${b.winner === p ? ' 👑' : ''}</span>`
      ).join('')}</div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="section-title"><span class="icon">⚔️</span> Multi-Model Arena</div>
    <div class="card" style="margin-bottom:16px">
      <h3 style="margin-bottom:8px">New Battle</h3>
      <textarea id="arena-prompt" class="input" rows="3" placeholder="Enter a prompt to test across providers..." style="width:100%;margin-bottom:8px"></textarea>
      <button class="btn btn-primary" onclick="startBattle()">⚔️ Start Battle</button>
    </div>
    ${statsCards ? `<div class="section-title" style="font-size:14px">📊 Win Rates</div><div class="grid grid-4" style="margin-bottom:16px">${statsCards}</div>` : ''}
    ${recentBattles ? `<div class="section-title" style="font-size:14px">🕐 Recent Battles</div>${recentBattles}` : ''}`;
}

async function startBattle() {
  const prompt = document.getElementById('arena-prompt')?.value?.trim();
  if (!prompt) return showToast('⚠️', 'Enter a prompt first');
  showToast('⚔️', 'Battle starting...');
  try {
    const result = await POST('/arena/battle', { prompt });
    showArenaBattle(result);
  } catch (err) {
    showToast('❌', err.message);
  }
}

function showArenaBattle(battle) {
  const responses = Object.entries(battle.responses);
  const cards = responses.map(([prov, r]) => `
    <div class="card arena-response" style="flex:1;min-width:250px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-weight:bold;color:var(--cyan)">${escapeHtml(prov)}</span>
        <span style="font-size:11px;color:var(--text2)">${r.latency || 0}ms${r.model ? ' · ' + escapeHtml(r.model) : ''}</span>
      </div>
      <div style="font-size:13px;color:var(--text1);white-space:pre-wrap;max-height:300px;overflow:auto">${r.error ? `<span style="color:var(--pink)">Error: ${escapeHtml(r.error)}</span>` : escapeHtml(r.reply || '')}</div>
      ${!r.error ? `<button class="btn btn-sm btn-primary" style="margin-top:8px" onclick="voteBattle(${battle.id},'${escapeAttr(prov)}')">👑 Vote Best</button>` : ''}
    </div>
  `).join('');

  showWideModal('⚔️ Arena Battle', `
    <div style="background:var(--bg2);padding:8px;border-radius:6px;margin-bottom:12px;font-size:12px;color:var(--text2)"><strong>Prompt:</strong> ${escapeHtml(battle.prompt)}</div>
    <div style="display:flex;gap:12px;flex-wrap:wrap">${cards}</div>
  `);
}

async function voteBattle(battleId, winner) {
  await POST(`/arena/${battleId}/vote`, { winner });
  closeModal();
  showToast('👑', `Voted for ${winner}!`);
  renderArena(document.getElementById('content'));
}

// ===================== PERSISTENT MEMORY =====================
async function renderMemory(el) {
  try {
    const items = await GET('/memory');
    const cards = items.map(m => `
      <div class="card" style="padding:10px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:bold;color:var(--cyan);font-size:13px">${escapeHtml(m.key)}</span>
          <span class="badge badge-purple" style="font-size:10px">${escapeHtml(m.category)}</span>
        </div>
        <p style="font-size:12px;color:var(--text2);margin:6px 0;white-space:pre-wrap">${escapeHtml(m.value)}</p>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:10px;color:var(--text2)">${new Date(m.updated_at).toLocaleDateString()}</span>
          <button class="btn btn-sm btn-danger" onclick="deleteMemory(${m.id})">🗑</button>
        </div>
      </div>
    `).join('');

    el.innerHTML = `
      <div class="section-title"><span class="icon">🧠</span> Knowledge Base <span class="badge badge-green">${items.length}</span></div>
      <div class="card" style="margin-bottom:16px;padding:12px">
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <input class="input" id="mem-key" placeholder="Key (e.g. 'my stack')" style="flex:1;min-width:150px">
          <input class="input" id="mem-category" placeholder="Category" style="width:120px" value="general">
        </div>
        <textarea id="mem-value" class="input" rows="2" placeholder="Value (e.g. 'Python + FastAPI + Uvicorn')" style="width:100%;margin-top:6px"></textarea>
        <button class="btn btn-sm btn-primary" style="margin-top:6px" onclick="addMemory()">💾 Save</button>
      </div>
      <div class="grid grid-2">${cards || '<div class="empty-state"><div class="empty-icon">🧠</div><h3>No memories yet</h3><p>Add knowledge the AI will remember across chats</p></div>'}</div>`;
  } catch (err) {
    el.innerHTML = `<p style="color:var(--pink)">Error: ${escapeHtml(err.message)}</p>`;
  }
}

async function addMemory() {
  const key = document.getElementById('mem-key')?.value?.trim();
  const value = document.getElementById('mem-value')?.value?.trim();
  const category = document.getElementById('mem-category')?.value?.trim() || 'general';
  if (!key || !value) return showToast('⚠️', 'Key and value required');
  await POST('/memory', { key, value, category });
  showToast('🧠', 'Memory saved!');
  renderMemory(document.getElementById('content'));
}

async function deleteMemory(id) {
  if (!confirm('Delete this memory?')) return;
  await DEL(`/memory/${id}`);
  renderMemory(document.getElementById('content'));
}

// ===================== COST TRACKER =====================
async function renderCosts(el) {
  try {
    const [summary, daily, byAction] = await Promise.all([
      GET('/costs?days=30'), GET('/costs/daily?days=7'), GET('/costs/by-action?days=30')
    ]);

    const totalCost = summary.totals?.total_cost || 0;
    const totalReqs = summary.totals?.request_count || 0;
    const totalTokens = (summary.totals?.total_input || 0) + (summary.totals?.total_output || 0);

    const breakdownRows = (summary.breakdown || []).map(r => `
      <tr>
        <td>${escapeHtml(r.provider)}</td><td>${escapeHtml(r.model || '')}</td>
        <td>${r.request_count}</td><td>${(r.total_input + r.total_output).toLocaleString()}</td>
        <td style="color:var(--green)">$${r.total_cost.toFixed(4)}</td>
      </tr>`).join('');

    const dailyRows = daily.map(d => `
      <tr><td>${d.date}</td><td>${escapeHtml(d.provider)}</td><td>${d.requests}</td>
      <td>${(d.input_tokens + d.output_tokens).toLocaleString()}</td>
      <td style="color:var(--green)">$${d.cost.toFixed(4)}</td></tr>`).join('');

    const actionRows = (byAction || []).map(a => `
      <tr><td>${escapeHtml(a.action)}</td><td>${a.count}</td>
      <td>${(a.input_tokens + a.output_tokens).toLocaleString()}</td>
      <td style="color:var(--green)">$${a.total_cost.toFixed(4)}</td></tr>`).join('');

    el.innerHTML = `
      <div class="section-title"><span class="icon">💰</span> Cost Tracker</div>
      <div class="grid grid-3" style="margin-bottom:16px">
        <div class="card stat-card"><div class="stat-value" style="color:var(--green)">$${totalCost.toFixed(4)}</div><div class="stat-label">30-Day Cost</div></div>
        <div class="card stat-card"><div class="stat-value">${totalReqs}</div><div class="stat-label">Requests</div></div>
        <div class="card stat-card"><div class="stat-value">${totalTokens.toLocaleString()}</div><div class="stat-label">Tokens</div></div>
      </div>
      <div class="card" style="margin-bottom:12px"><h3 style="margin-bottom:8px">Provider Breakdown</h3>
        <table class="data-table"><thead><tr><th>Provider</th><th>Model</th><th>Requests</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>${breakdownRows || '<tr><td colspan="5" style="text-align:center;color:var(--text2)">No usage data yet</td></tr>'}</tbody></table>
      </div>
      <div class="grid grid-2">
        <div class="card"><h3 style="margin-bottom:8px">Daily (7d)</h3>
          <table class="data-table"><thead><tr><th>Date</th><th>Provider</th><th>Reqs</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>${dailyRows || '<tr><td colspan="5" style="text-align:center;color:var(--text2)">No data</td></tr>'}</tbody></table>
        </div>
        <div class="card"><h3 style="margin-bottom:8px">By Action</h3>
          <table class="data-table"><thead><tr><th>Action</th><th>Count</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>${actionRows || '<tr><td colspan="4" style="text-align:center;color:var(--text2)">No data</td></tr>'}</tbody></table>
        </div>
      </div>`;
  } catch (err) {
    el.innerHTML = `<p style="color:var(--pink)">Error: ${escapeHtml(err.message)}</p>`;
  }
}

// ===================== DAILY CHALLENGES =====================
async function renderChallenges(el) {
  try {
    const [daily, streak] = await Promise.all([GET('/challenges'), GET('/challenges/streak')]);
    const challengeCards = daily.map(c => {
      const pct = Math.min(100, Math.round((c.progress / c.target) * 100));
      const done = c.completed;
      return `<div class="card challenge-card ${done ? 'completed' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <span style="font-weight:bold;font-size:14px;color:${done ? 'var(--green)' : 'var(--text1)'}">${done ? '✅ ' : ''}${escapeHtml(c.title)}</span>
          <span class="badge ${done ? 'badge-green' : 'badge-orange'}">+${c.xp_reward} XP</span>
        </div>
        <p style="font-size:12px;color:var(--text2);margin-bottom:8px">${escapeHtml(c.description)}</p>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%;background:${done ? 'var(--green)' : 'var(--cyan)'}"></div></div>
        <div style="font-size:11px;color:var(--text2);margin-top:4px">${c.progress}/${c.target} ${done ? '— Complete!' : ''}</div>
      </div>`;
    }).join('');

    el.innerHTML = `
      <div class="section-title"><span class="icon">🎯</span> Daily Challenges</div>
      <div class="card" style="margin-bottom:16px;text-align:center;padding:16px">
        <div style="font-size:32px">🔥</div>
        <div style="font-size:24px;font-weight:bold;color:var(--orange)">${streak.streak}-Day Streak</div>
        <div style="font-size:12px;color:var(--text2)">${streak.totalCompleted} total challenges completed</div>
      </div>
      <div class="grid grid-3">${challengeCards}</div>`;
  } catch (err) {
    el.innerHTML = `<p style="color:var(--pink)">Error: ${escapeHtml(err.message)}</p>`;
  }
}

// ===================== API KEY VAULT =====================
async function renderVault(el) {
  try {
    const items = await GET('/vault');
    const rows = items.map(v => `
      <tr>
        <td style="font-weight:bold;color:var(--cyan)">${escapeHtml(v.key_name)}</td>
        <td><span class="badge badge-purple">${escapeHtml(v.scope)}</span></td>
        <td style="font-size:12px;color:var(--text2)">${escapeHtml(v.description || '-')}</td>
        <td style="color:var(--text2)">••••••••</td>
        <td><button class="btn btn-sm btn-danger" onclick="deleteVaultKey(${v.id})">🗑</button></td>
      </tr>
    `).join('');

    el.innerHTML = `
      <div class="section-title"><span class="icon">🔐</span> API Key Vault <span class="badge badge-green">${items.length}</span></div>
      <div class="card" style="margin-bottom:16px;padding:12px">
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">
          <input class="input" id="vault-name" placeholder="Key name (e.g. GITHUB_TOKEN)" style="flex:1;min-width:150px">
          <input class="input" id="vault-scope" placeholder="Scope" style="width:120px" value="global">
          <input class="input" id="vault-desc" placeholder="Description" style="flex:1;min-width:150px">
        </div>
        <div style="display:flex;gap:8px">
          <input class="input" id="vault-value" type="password" placeholder="Secret value" style="flex:1">
          <button class="btn btn-primary" onclick="addVaultKey()">🔐 Store</button>
        </div>
      </div>
      <div class="card"><table class="data-table">
        <thead><tr><th>Name</th><th>Scope</th><th>Description</th><th>Value</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" style="text-align:center;color:var(--text2)">No keys stored</td></tr>'}</tbody>
      </table></div>`;
  } catch (err) {
    el.innerHTML = `<p style="color:var(--pink)">Error: ${escapeHtml(err.message)}</p>`;
  }
}

async function addVaultKey() {
  const keyName = document.getElementById('vault-name')?.value?.trim();
  const value = document.getElementById('vault-value')?.value;
  const scope = document.getElementById('vault-scope')?.value?.trim() || 'global';
  const description = document.getElementById('vault-desc')?.value?.trim();
  if (!keyName || !value) return showToast('⚠️', 'Name and value required');
  await POST('/vault', { keyName, value, scope, description });
  showToast('🔐', 'Secret stored!');
  renderVault(document.getElementById('content'));
}

async function deleteVaultKey(id) {
  if (!confirm('Delete this vault key?')) return;
  await DEL(`/vault/${id}`);
  renderVault(document.getElementById('content'));
}

// ===================== PLUGINS =====================
async function renderPlugins(el) {
  try {
    const items = await GET('/plugins');
    const cards = items.map(p => {
      const config = p.config || {};
      return `<div class="card" style="padding:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <span style="font-weight:bold;font-size:14px">${config.emoji || '🔌'} ${escapeHtml(p.name)}</span>
          <span class="badge ${p.enabled ? 'badge-green' : ''}">${p.enabled ? 'Active' : 'Disabled'}</span>
        </div>
        <p style="font-size:12px;color:var(--text2);margin-bottom:8px">${escapeHtml(config.desc || p.file_path)}</p>
        <div class="btn-group">
          <button class="btn btn-sm" onclick="togglePlugin(${p.id})">${p.enabled ? '⏸ Disable' : '▶ Enable'}</button>
          <button class="btn btn-sm" onclick="reloadPlugin('${escapeAttr(p.name)}')">🔄 Reload</button>
        </div>
      </div>`;
    }).join('');

    el.innerHTML = `
      <div class="section-title"><span class="icon">🔌</span> Plugins <span class="badge badge-green">${items.length}</span></div>
      <div style="margin-bottom:12px">
        <button class="btn btn-primary btn-sm" onclick="scanPlugins()">🔍 Scan Plugins</button>
        <span style="font-size:11px;color:var(--text2);margin-left:8px">Drop .js files in /plugins/ folder</span>
      </div>
      <div class="grid grid-3">${cards || '<div class="empty-state"><div class="empty-icon">🔌</div><h3>No plugins</h3><p>Click Scan to discover plugins</p></div>'}</div>`;
  } catch (err) {
    el.innerHTML = `<p style="color:var(--pink)">Error: ${escapeHtml(err.message)}</p>`;
  }
}

async function scanPlugins() {
  showToast('🔍', 'Scanning plugins...');
  const results = await POST('/plugins/scan');
  showToast('🔌', `Found ${results.length} plugin(s)`);
  renderPlugins(document.getElementById('content'));
}

async function togglePlugin(id) {
  await PUT(`/plugins/${id}/toggle`);
  renderPlugins(document.getElementById('content'));
}

async function reloadPlugin(name) {
  await POST(`/plugins/${name}/reload`);
  showToast('🔄', `Plugin ${name} reloaded`);
}

// ===================== LEADERBOARD =====================
async function renderLeaderboard(el) {
  try {
    const [speed, reliability, popular] = await Promise.all([
      GET('/leaderboard?type=speed'), GET('/leaderboard?type=reliability'), GET('/leaderboard?type=popular')
    ]);

    const renderTable = (data, cols) => {
      if (!data.entries?.length) return '<p style="color:var(--text2);text-align:center">No data yet</p>';
      return `<table class="data-table"><thead><tr>${cols.map(c => `<th>${c.label}</th>`).join('')}</tr></thead><tbody>${
        data.entries.map((r, i) => `<tr>${cols.map(c => `<td>${c.render(r, i)}</td>`).join('')}</tr>`).join('')
      }</tbody></table>`;
    };

    el.innerHTML = `
      <div class="section-title"><span class="icon">🏆</span> Workflow Leaderboard</div>
      <div class="grid grid-3">
        <div class="card"><h3 style="margin-bottom:8px">⚡ Fastest</h3>${renderTable(speed, [
          { label: '#', render: (r, i) => `<span style="color:var(--gold)">${i + 1}</span>` },
          { label: 'Workflow', render: r => escapeHtml(r.title) },
          { label: 'Time', render: r => `<span style="color:var(--green)">${r.duration_sec}s</span>` },
          { label: 'Nodes', render: r => r.node_count },
        ])}</div>
        <div class="card"><h3 style="margin-bottom:8px">🛡 Most Reliable</h3>${renderTable(reliability, [
          { label: '#', render: (r, i) => `<span style="color:var(--gold)">${i + 1}</span>` },
          { label: 'Workflow', render: r => escapeHtml(r.title) },
          { label: 'Rate', render: r => `<span style="color:var(--green)">${r.success_rate}%</span>` },
          { label: 'Runs', render: r => r.total_runs },
        ])}</div>
        <div class="card"><h3 style="margin-bottom:8px">🔥 Most Used</h3>${renderTable(popular, [
          { label: '#', render: (r, i) => `<span style="color:var(--gold)">${i + 1}</span>` },
          { label: 'Workflow', render: r => escapeHtml(r.title) },
          { label: 'Runs', render: r => `<span style="color:var(--cyan)">${r.total_runs}</span>` },
        ])}</div>
      </div>`;
  } catch (err) {
    el.innerHTML = `<p style="color:var(--pink)">Error: ${escapeHtml(err.message)}</p>`;
  }
}

// ===================== COLLABORATION =====================
async function renderCollaboration(el) {
  try {
    const [shared, publicWf] = await Promise.all([GET('/my-shares'), GET('/shared')]);
    const myShares = shared.map(s => `
      <div class="card" style="padding:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <span style="font-weight:bold;color:var(--cyan)">${escapeHtml(s.title)}</span>
          <span class="badge ${s.is_public ? 'badge-green' : ''}">${s.is_public ? 'Public' : 'Private'}</span>
        </div>
        <div style="font-size:11px;color:var(--text2);margin-bottom:6px">
          Token: <code style="background:var(--bg);padding:2px 6px;border-radius:4px">${escapeHtml(s.share_token)}</code>
          · ${s.fork_count} forks
        </div>
        <button class="btn btn-sm btn-danger" onclick="unshareWorkflow(${s.workflow_id})">🗑 Unshare</button>
      </div>`).join('');

    const publicCards = publicWf.map(s => `
      <div class="card" style="padding:10px">
        <div style="font-weight:bold;color:var(--text1);margin-bottom:4px">${escapeHtml(s.title)}</div>
        <div style="font-size:11px;color:var(--text2);margin-bottom:6px">${escapeHtml(s.description || 'No description')} · ${s.node_count || '?'} nodes · ${s.fork_count} forks</div>
        <button class="btn btn-sm btn-primary" onclick="forkWorkflow('${escapeAttr(s.share_token)}')">🍴 Fork</button>
      </div>`).join('');

    el.innerHTML = `
      <div class="section-title"><span class="icon">🤝</span> Collaboration</div>
      <div class="card" style="margin-bottom:16px;padding:12px">
        <h3 style="margin-bottom:8px">Import Shared Workflow</h3>
        <div style="display:flex;gap:8px">
          <input class="input" id="fork-token" placeholder="Paste share token..." style="flex:1">
          <button class="btn btn-primary" onclick="forkWorkflow(document.getElementById('fork-token').value.trim())">🍴 Fork</button>
        </div>
      </div>
      ${myShares ? `<div class="section-title" style="font-size:14px">📤 My Shared Workflows</div><div class="grid grid-2" style="margin-bottom:16px">${myShares}</div>` : ''}
      ${publicCards ? `<div class="section-title" style="font-size:14px">🌍 Public Gallery</div><div class="grid grid-3">${publicCards}</div>` : '<div class="empty-state"><h3>No public workflows yet</h3></div>'}`;
  } catch (err) {
    el.innerHTML = `<p style="color:var(--pink)">Error: ${escapeHtml(err.message)}</p>`;
  }
}

async function shareWorkflow(workflowId, isPublic = false) {
  try {
    const result = await POST(`/workflows/${workflowId}/share`, { isPublic });
    showToast('🔗', `Share token: ${result.share_token}`);
    return result;
  } catch (err) { showToast('❌', err.message); }
}

async function unshareWorkflow(workflowId) {
  if (!confirm('Remove sharing?')) return;
  await DEL(`/workflows/${workflowId}/share`);
  renderCollaboration(document.getElementById('content'));
}

async function forkWorkflow(token) {
  if (!token) return showToast('⚠️', 'Enter a share token');
  try {
    const result = await POST(`/shared/${token}/fork`);
    showToast('🍴', `Forked! Workflow #${result.workflowId} created`);
    await refreshAll();
  } catch (err) { showToast('❌', err.message); }
}
