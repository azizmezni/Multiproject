// ===================== STATE =====================
let state = {
  stats: null,
  providers: [],
  registry: [],
  boards: [],
  workflows: [],
  drafts: [],
  sessions: [],
  nodeTypes: {},
  chatSessionId: null,
  activeSection: 'home',
};

// ===================== API HELPERS =====================
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
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
  const [statsData, provData, boardsData, wfData, draftsData, sessData, ntData] = await Promise.all([
    GET('/stats'), GET('/providers'), GET('/boards'),
    GET('/workflows'), GET('/drafts'), GET('/sessions'), GET('/node-types'),
  ]);
  state.stats = statsData;
  state.providers = provData.providers || [];
  state.registry = provData.registry || [];
  state.boards = boardsData;
  state.workflows = wfData;
  state.drafts = draftsData;
  state.sessions = sessData;
  state.nodeTypes = ntData;
  updateHeader();
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
  const renderers = { home: renderHome, providers: renderProviders, boards: renderBoards, workflows: renderWorkflows, drafts: renderDrafts, chat: renderChat, achievements: renderAchievements };
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
            <span>${b.title}</span><span class="badge badge-${b.status === 'completed' ? 'green' : b.status === 'executing' ? 'orange' : 'blue'}">${b.status}</span>
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

  el.innerHTML = `
    <div class="section-title"><span class="icon">🔧</span> LLM Providers</div>
    <p style="color:var(--text2);margin-bottom:16px">Drag to reorder. Requests try each enabled provider in order with automatic fallback.</p>
    <div id="prov-list">
      ${providers.map((p, i) => {
        const reg = registry.find(r => r.name === p.name) || {};
        return `<div class="prov-card ${p.enabled ? '' : 'disabled'}" data-name="${p.name}" style="animation-delay:${i * 0.05}s">
          <div class="prov-num">${i + 1}</div>
          <div class="prov-icon">${p.is_local ? '🏠' : '☁️'}</div>
          <div class="prov-info">
            <div class="prov-name">${p.display_name}</div>
            <div class="prov-model">Model: <code>${p.model}</code> ${p.api_key ? '🔑' : '<span style="color:var(--orange)">⚠️ No key</span>'}</div>
            <div class="prov-docs"><a href="${reg.docs || '#'}" target="_blank">📖 Setup docs</a> — ${reg.description || ''}</div>
          </div>
          <div class="prov-actions">
            <button onclick="moveProv('${p.name}','up')" title="Move up">⬆️</button>
            <button onclick="moveProv('${p.name}','down')" title="Move down">⬇️</button>
            <button onclick="toggleProv('${p.name}')" title="Toggle">${p.enabled ? '✅' : '❌'}</button>
            ${!p.is_local ? `<button onclick="promptSetKey('${p.name}','${p.display_name}')" title="Set key">🔑</button>` : ''}
            <button onclick="promptSetModel('${p.name}','${p.display_name}')" title="Change model">📊</button>
          </div>
        </div>`;
      }).join('')}
    </div>`;
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
            <div><div class="card-title">${b.title}</div><div class="card-subtitle">${tasks.length} tasks · ${b.status}</div></div>
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
      <span class="icon">📋</span> ${board.title}
      <span class="badge badge-${board.status === 'completed' ? 'green' : 'blue'}" style="margin-left:8px">${board.status}</span>
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
    <div class="task-title">${needsQ ? '❓ ' : ''}${t.title}</div>
    <div class="task-meta">
      <span class="task-qa ${qaClass}">QA: ${t.qa_status}</span>
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

  showModal(`Task: ${task.title}`, `
    <p style="color:var(--text2);margin-bottom:12px">${task.description || 'No description'}</p>
    <div class="form-group"><label class="form-label">Status</label><div class="btn-group">${statusOpts}</div></div>
    ${task.requires_input ? `<div class="form-group"><label class="form-label">❓ ${task.input_question || 'Input needed'}</label>
      <input class="input" id="task-answer" value="${task.input_answer || ''}" placeholder="Your answer...">
      <button class="btn btn-sm" style="margin-top:6px" onclick="answerTask(${taskId},${boardId})">Save Answer</button></div>` : ''}
    <div class="form-group"><label class="form-label">QA Status: <span class="badge badge-${task.qa_status === 'pass' ? 'green' : task.qa_status === 'fail' ? 'red' : 'blue'}">${task.qa_status}</span></label>
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
    <div class="section-title"><span class="icon">🔀</span> Workflows <button class="btn btn-primary btn-sm" onclick="promptNewWorkflow()" style="margin-left:auto">+ New Workflow</button></div>
    ${state.workflows.length === 0 ? '<div class="empty-state"><div class="empty-icon">🔀</div><h3>No workflows</h3><p>Create n8n-style workflows to automate tasks</p></div>' :
      `<div class="grid grid-2">${state.workflows.map(w => `
        <div class="card" onclick="viewWorkflow(${w.id})" style="cursor:pointer">
          <div class="card-header"><div class="card-title">🔀 ${w.title}</div><span class="badge badge-${w.status === 'completed' ? 'green' : 'blue'}">${w.status}</span></div>
          <div class="card-subtitle">${(w.nodes || []).length} nodes · ${(w.edges || []).length} connections</div>
        </div>`).join('')}</div>`}`;
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

  // Fetch script + connected inputs from API
  let scriptData = { language: 'text', script: '', prompt: '', connectedInputs: {} };
  try { scriptData = await GET(`/workflows/nodes/${nodeId}/script`); } catch {}

  const codeContent = scriptData.script || scriptData.prompt || '// No script';
  const langLabel = scriptData.language === 'prompt' ? 'LLM Prompt' : scriptData.language === 'bash' ? 'Bash' : 'JavaScript';
  const langBadge = scriptData.language === 'prompt' ? 'badge-purple' : scriptData.language === 'bash' ? 'badge-orange' : 'badge-blue';

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
        <div class="btn-group" style="margin-top:12px">
          <button class="btn btn-primary btn-sm" onclick="updateNode(${nodeId},${wfId})">💾 Save</button>
          <button class="btn btn-danger btn-sm" onclick="deleteNode(${nodeId},${wfId})">🗑️ Delete</button>
          <button class="btn btn-sm" onclick="closeModal()">Close</button>
        </div>
      </div>

      <!-- RIGHT: Code + Test -->
      <div class="node-detail-right">
        <!-- Code/Script tab -->
        <div class="nd-section-title">
          Script <span class="badge ${langBadge}" style="margin-left:6px">${langLabel}</span>
          <span class="badge badge-green" style="margin-left:4px">${nt.label}</span>
        </div>
        <div class="code-block" id="nd-code-block"><pre><code>${escapeHtml(codeContent)}</code></pre></div>

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
      </div>
    </div>
  `);
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
async function updateNode(nodeId, wfId) {
  const inputs = document.getElementById('nd-inputs').value.split(',').map(s => s.trim()).filter(Boolean);
  const outputs = document.getElementById('nd-outputs').value.split(',').map(s => s.trim()).filter(Boolean);
  await PUT(`/workflows/nodes/${nodeId}`, { name: document.getElementById('nd-name').value, description: document.getElementById('nd-desc').value, inputs, outputs });
  closeModal(); await refreshAll(); viewWorkflow(wfId);
}
async function deleteNode(nodeId, wfId) { await DEL(`/workflows/nodes/${nodeId}`); closeModal(); await refreshAll(); viewWorkflow(wfId); }
async function executeWorkflow(wfId) {
  const content = document.getElementById('content');
  const wf = await POST(`/workflows/${wfId}/execute`);
  await refreshAll(); updateHeader(); viewWorkflow(wfId);
  showToast('⚡', 'Workflow executed!');
}
async function deleteWorkflow(wfId) { if (!confirm('Delete?')) return; await DEL(`/workflows/${wfId}`); await refreshAll(); renderWorkflows(document.getElementById('content')); }

// ===================== DRAFTS =====================
async function renderDrafts(el) {
  await refreshAll();
  el.innerHTML = `
    <div class="section-title"><span class="icon">📥</span> Draft Board</div>
    ${state.drafts.length === 0 ? '<div class="empty-state"><div class="empty-icon">📥</div><h3>No drafts</h3><p>Share links in Telegram to save them here</p></div>' :
      `<div class="grid grid-3">${state.drafts.map(d => `
        <div class="card">
          <div class="card-title" style="font-size:14px">${d.title || d.url || 'Untitled'}</div>
          <div class="card-subtitle" style="margin:4px 0">${d.description ? d.description.substring(0, 100) : ''}</div>
          ${d.url ? `<a href="${d.url}" target="_blank" style="font-size:11px;color:var(--cyan)">🔗 ${d.url.substring(0, 50)}</a>` : ''}
          <div style="margin-top:8px"><button class="btn btn-sm btn-danger" onclick="deleteDraft(${d.id})">🗑️</button></div>
        </div>`).join('')}</div>`}`;
}
async function deleteDraft(id) { await DEL(`/drafts/${id}`); renderDrafts(document.getElementById('content')); }

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

  const result = await POST('/chat', { message: msg, sessionId: state.chatSessionId });
  document.getElementById('typing')?.remove();

  if (result.reply) {
    state.chatSessionId = result.sessionId;
    container.innerHTML += `<div class="chat-msg assistant">${escapeHtml(result.reply)}<div class="msg-meta">${result.provider} · ${result.model}</div></div>`;
  } else {
    container.innerHTML += `<div class="chat-msg assistant" style="color:var(--red)">Error: ${result.error}</div>`;
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
  backdrop.innerHTML = `<div class="modal"><h3>${title}</h3>${bodyHtml}</div>`;
  document.body.appendChild(backdrop);
}
function showWideModal(title, bodyHtml) {
  const existing = document.querySelector('.modal-backdrop');
  if (existing) existing.remove();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.onclick = (e) => { if (e.target === backdrop) closeModal(); };
  backdrop.innerHTML = `<div class="modal modal-wide"><h3>${title}</h3>${bodyHtml}</div>`;
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
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-text">${text}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function closeLevelUp() { document.getElementById('levelup-overlay').classList.add('hidden'); }

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text) {
  return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
