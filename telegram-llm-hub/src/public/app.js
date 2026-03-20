// ===================== STATE =====================
let state = {
  stats: null,
  providers: [],
  registry: [],
  boards: [],
  genprojects: [],
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

// Sidebar category collapse/expand
function toggleCategory(el) {
  el.classList.toggle('collapsed');
  const group = el.nextElementSibling;
  if (group && group.classList.contains('nav-group')) {
    group.classList.toggle('collapsed');
  }
}

async function refreshAll() {
  try {
    const results = await Promise.allSettled([
      GET('/stats'), GET('/providers'), GET('/boards'),
      GET('/workflows'), GET('/drafts'), GET('/sessions'), GET('/node-types'),
      GET('/schedules'), GET('/gen'),
    ]);
    const val = (i, fallback) => results[i].status === 'fulfilled' ? results[i].value : fallback;
    state.stats = val(0, state.stats);
    const provData = val(1, { providers: state.providers, registry: state.registry });
    state.providers = provData.providers || [];
    state.registry = provData.registry || [];
    state.lastUsedProvider = provData.lastUsed || null;
    state.boards = val(2, state.boards || []);
    state.workflows = val(3, state.workflows || []);
    state.drafts = val(4, state.drafts || []);
    state.sessions = val(5, state.sessions || []);
    state.nodeTypes = val(6, state.nodeTypes || {});
    state.schedules = val(7, state.schedules || []);
    state.genprojects = val(8, state.genprojects || []);
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
  updateActiveProviderWidget();
}

// Active provider widget in header
function updateActiveProviderWidget() {
  const providers = state.providers || [];
  const enabled = providers.filter(p => p.enabled);
  // Primary = first enabled provider by priority (what would be tried first)
  const primary = enabled[0];
  // lastUsed = the provider that actually handled the last LLM call (may differ due to fallback)
  const lastUsed = state.lastUsedProvider;
  const nameEl = document.getElementById('apw-name');

  const modelEl = document.getElementById('apw-model');
  if (lastUsed && primary && lastUsed.name !== primary.name) {
    // Fallback happened — show which provider actually ran
    nameEl.innerHTML = `${escapeHtml(lastUsed.displayName)} <span style="font-size:10px;opacity:0.6">(fallback)</span>`;
    modelEl.textContent = lastUsed.model || '';
  } else if (primary) {
    nameEl.textContent = primary.display_name;
    modelEl.textContent = primary.model || '';
  } else {
    nameEl.textContent = 'None';
    modelEl.textContent = '';
  }

  // Build dropdown menu — show all enabled providers, mark which is active and which last-used
  const menu = document.getElementById('apw-menu');
  menu.innerHTML = enabled.map(p => {
    const isPrimary = primary && p.name === primary.name;
    const isLastUsed = lastUsed && p.name === lastUsed.name;
    const hasKey = p.api_key || p.is_local;
    const dotClass = hasKey ? 'on' : 'nokey';
    const badge = isLastUsed && !isPrimary ? ' <span style="font-size:9px;color:var(--yellow)">(in use)</span>' : '';
    return `<div class="apw-item ${isPrimary ? 'active' : ''}" onclick="switchActiveProvider('${p.name}')">
      <span class="apw-dot ${dotClass}"></span>
      <span>${escapeHtml(p.display_name)}${badge}</span>
      <span class="apw-item-model">${escapeHtml(p.model)}</span>
    </div>`;
  }).join('') + (enabled.length === 0 ? '<div class="apw-item" style="color:var(--text2)">No providers enabled</div>' : '');
}

function toggleProviderDropdown() {
  const dd = document.getElementById('apw-dropdown');
  dd.classList.toggle('open');
  // Close on outside click
  if (dd.classList.contains('open')) {
    const close = (e) => { if (!dd.contains(e.target)) { dd.classList.remove('open'); document.removeEventListener('click', close); } };
    setTimeout(() => document.addEventListener('click', close), 0);
  }
}

async function switchActiveProvider(name) {
  document.getElementById('apw-dropdown').classList.remove('open');
  const target = (state.providers || []).find(p => p.name === name);
  if (!target) return;
  await PUT(`/providers/${name}/set-active`, {});
  await refreshAll();
  if (state.activeSection === 'providers') renderProviders(document.getElementById('content'));
  showToast(`Switched to ${target.display_name}`, 'success');
}

// ===================== SECTIONS =====================
function showSection(name) {
  state.activeSection = name;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.section === name));
  const content = document.getElementById('content');
  const renderers = { home: renderHome, providers: renderProviders, boards: renderGenProjects, workflows: renderWorkflows, drafts: renderDrafts, projects: renderProjects, chat: renderChat, achievements: renderAchievements, templates: renderTemplates, arena: renderArena, memory: renderMemory, costs: renderCosts, challenges: renderChallenges, vault: renderVault, plugins: renderPlugins, leaderboard: renderLeaderboard, collaboration: renderCollaboration, selfimprove: renderSelfImprove, gitrepos: renderGitRepos };
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

  // Categorize providers
  const free = providers.filter(p => { const r = registry.find(x => x.name === p.name); return r && r.free && !p.is_local; });
  const paid = providers.filter(p => { const r = registry.find(x => x.name === p.name); return !p.is_local && !(r && r.free); });
  const local = providers.filter(p => p.is_local);

  const enabledCount = providers.filter(p => p.enabled).length;

  function provStatus(p) {
    if (!p.enabled) return { dot: 'status-off', label: 'Disabled' };
    if (p.is_local) return { dot: 'status-on', label: 'Local' };
    if (p.api_key) return { dot: 'status-on', label: 'Active' };
    return { dot: 'status-warn', label: 'No key' };
  }

  function renderCard(p, i) {
    const reg = registry.find(r => r.name === p.name) || {};
    const st = provStatus(p);
    const isFree = reg.free;
    return `<div class="prov-card ${p.enabled ? '' : 'disabled'} prov-${st.dot}" data-name="${p.name}" style="animation-delay:${i * 0.03}s">
      <div class="prov-status-dot ${st.dot}" title="${st.label}"></div>
      <div class="prov-info">
        <div class="prov-name">${p.display_name}
          ${isFree ? '<span class="prov-badge prov-badge-free">🆓 FREE</span>' : ''}
          ${p.is_local ? '<span class="prov-badge prov-badge-local">🏠 LOCAL</span>' : ''}
          ${!isFree && !p.is_local ? '<span class="prov-badge prov-badge-paid">💎 PAID</span>' : ''}
        </div>
        <div class="prov-tagline">${reg.tagline || reg.description || ''}</div>
        <div class="prov-model">Model: <code>${p.model}</code></div>
      </div>
      <div class="prov-actions">
        <button onclick="toggleProv('${p.name}')" title="Toggle" class="prov-toggle-btn ${p.enabled ? 'active' : ''}">${p.enabled ? 'ON' : 'OFF'}</button>
        ${!p.is_local ? `<button onclick="promptSetKey('${p.name}','${p.display_name}')" title="Set API key">🔑</button>` : ''}
        <button onclick="promptSetModel('${p.name}','${p.display_name}')" title="Change model">📊</button>
        <button onclick="testProvider('${p.name}')" title="Test" id="test-btn-${p.name}">🏓</button>
        <a href="${reg.docs || '#'}" target="_blank" title="Docs" class="prov-doc-link">📖</a>
      </div>
    </div>`;
  }

  function renderSection(id, icon, label, items, badgeClass, open = true) {
    const enabledInGroup = items.filter(p => p.enabled).length;
    return `
      <div class="prov-section">
        <div class="prov-section-header" onclick="toggleProvSection('${id}')">
          <span class="prov-section-icon">${icon}</span>
          <span class="prov-section-label">${label}</span>
          <span class="badge ${badgeClass}">${enabledInGroup}/${items.length} enabled</span>
          <span class="prov-section-arrow ${open ? 'open' : ''}" id="prov-arrow-${id}">▸</span>
        </div>
        <div class="prov-section-body ${open ? 'open' : ''}" id="prov-body-${id}">
          ${items.map((p, i) => renderCard(p, i)).join('') || '<div style="padding:12px;color:var(--text2);font-style:italic">No providers in this category</div>'}
        </div>
      </div>`;
  }

  el.innerHTML = `
    <div class="section-title"><span class="icon">🔧</span> LLM Providers
      <span class="badge badge-blue">${providers.length} total</span>
      <span class="badge badge-green">${enabledCount} enabled</span>
    </div>
    <p style="color:var(--text2);margin-bottom:16px">Requests try each enabled provider in priority order with automatic fallback.</p>
    ${renderSection('free', '🆓', 'Free Tier', free, 'badge-green', true)}
    ${renderSection('paid', '💎', 'Premium', paid, 'badge-purple', true)}
    ${renderSection('local', '🏠', 'Local', local, 'badge-orange', true)}`;
}

function toggleProvSection(id) {
  const body = document.getElementById(`prov-body-${id}`);
  const arrow = document.getElementById(`prov-arrow-${id}`);
  if (!body) return;
  body.classList.toggle('open');
  arrow.classList.toggle('open');
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
  const keyLink = reg.keyUrl || reg.docs || '#';
  showModal(`🔑 Set API Key — ${displayName}`, `
    <p style="margin-bottom:12px;color:var(--text2)">
      <a href="${keyLink}" target="_blank" style="color:var(--cyan);font-weight:600;text-decoration:none;display:inline-flex;align-items:center;gap:4px">
        🔗 Get your API key here ↗
      </a>
    </p>
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

async function promptSetModel(name, displayName) {
  const reg = state.registry.find(r => r.name === name) || {};

  // For dynamic providers, fetch live models from the server
  if (reg.dynamicModels) {
    showModal(`📊 Set Model — ${displayName}`, `
      <div class="form-group" id="model-list-container" style="max-height:400px;overflow-y:auto">
        <div style="text-align:center;padding:20px;color:var(--text2)">
          <div style="font-size:24px;margin-bottom:8px">⏳</div>
          Fetching models from ${escapeHtml(displayName)}...
        </div>
      </div>
      <div style="margin-top:8px;display:flex;gap:6px;align-items:center">
        <input class="input" id="modal-custom-model" placeholder="Or type a custom model ID..." style="flex:1;font-size:12px">
        <button class="btn btn-primary btn-sm" onclick="submitModel('${name}',document.getElementById('modal-custom-model').value)">Set</button>
      </div>
      <div style="margin-top:6px;display:flex;gap:6px">
        <button class="btn btn-sm" onclick="fetchLiveModels('${name}','${escapeHtml(displayName)}')">🔄 Refresh</button>
        <button class="btn btn-sm" onclick="closeModal()">Cancel</button>
      </div>
    `);
    await fetchLiveModels(name, displayName);
  } else if (reg.modelGroups) {
    // Static grouped UI (fallback)
    showModelGroupsModal(name, displayName, reg.modelGroups);
  } else {
    const models = reg.models || [];
    showModal(`📊 Set Model — ${displayName}`, `
      <div class="form-group">
        <label class="form-label">Select Model</label>
        ${models.map(m => `<button class="btn" style="margin:4px" onclick="submitModel('${name}','${m}')">${m}</button>`).join('')}
      </div>
      <button class="btn" onclick="closeModal()">Cancel</button>
    `);
  }
}

function showModelGroupsModal(name, displayName, groups) {
  let groupsHtml = '';
  for (const [groupName, models] of Object.entries(groups)) {
    const isFree = groupName.includes('Free');
    groupsHtml += `
      <div style="margin-bottom:12px">
        <div style="font-weight:700;font-size:13px;margin-bottom:6px;color:${isFree ? 'var(--green)' : 'var(--purple)'}">${groupName}</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px">
          ${models.map(m => {
            const short = m.split('/').pop();
            return `<button class="btn btn-sm" style="font-size:11px;padding:3px 8px" onclick="submitModel('${name}','${m}')" title="${m}">${short}</button>`;
          }).join('')}
        </div>
      </div>`;
  }
  showModal(`📊 Set Model — ${displayName}`, `
    <div class="form-group" style="max-height:400px;overflow-y:auto">${groupsHtml}</div>
    <div style="margin-top:8px;display:flex;gap:6px;align-items:center">
      <input class="input" id="modal-custom-model" placeholder="Or type a custom model ID..." style="flex:1;font-size:12px">
      <button class="btn btn-primary btn-sm" onclick="submitModel('${name}',document.getElementById('modal-custom-model').value)">Set</button>
    </div>
    <button class="btn" style="margin-top:8px" onclick="closeModal()">Cancel</button>
  `);
}

async function fetchLiveModels(name, displayName) {
  const container = document.getElementById('model-list-container');
  if (!container) return;
  const reg = state.registry.find(r => r.name === name) || {};

  try {
    const data = await GET(`/providers/${name}/models`);
    const liveModels = data.models || [];

    if (liveModels.length === 0 && !reg.modelGroups) {
      // No live models, fall back to static list
      const fallback = reg.models || [];
      container.innerHTML = `
        <div style="color:var(--yellow);font-size:12px;margin-bottom:8px">⚠️ Couldn't fetch live models${data.error ? ': ' + escapeHtml(data.error) : ''}. Showing defaults:</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px">
          ${fallback.map(m => `<button class="btn btn-sm" style="font-size:11px;padding:3px 8px" onclick="submitModel('${name}','${m}')">${m}</button>`).join('')}
        </div>`;
      return;
    }

    let html = '';

    // For OpenRouter: group into Free vs Premium from live data
    if (name === 'openrouter') {
      const freeModels = liveModels.filter(m => m.id.includes(':free') || m.id === 'openrouter/free' || m.id === 'openrouter/auto');
      const otherModels = liveModels.filter(m => !m.id.includes(':free') && m.id !== 'openrouter/free' && m.id !== 'openrouter/auto');
      html += renderModelGroup('🆓 Free Models (' + freeModels.length + ')', freeModels, name, 'var(--green)');
      if (otherModels.length > 0) {
        html += renderModelGroup('💎 Other Free', otherModels, name, 'var(--cyan)');
      }
      // Also show static premium
      if (reg.modelGroups?.['💎 Premium (key required)']) {
        const premium = reg.modelGroups['💎 Premium (key required)'].map(id => ({ id, name: id }));
        html += renderModelGroup('💎 Premium (key required)', premium, name, 'var(--purple)');
      }
    } else {
      // Ollama / LM Studio: show live models with size info
      const label = `🖥️ Available Models (${liveModels.length})`;
      html += renderModelGroup(label, liveModels, name, 'var(--cyan)');
    }

    container.innerHTML = html || '<div style="color:var(--text2);padding:12px">No models found</div>';
  } catch (err) {
    container.innerHTML = `<div style="color:var(--red);padding:12px">❌ Failed to fetch: ${escapeHtml(err.message)}</div>`;
  }
}

function renderModelGroup(title, models, provName, color) {
  return `
    <div style="margin-bottom:12px">
      <div style="font-weight:700;font-size:13px;margin-bottom:6px;color:${color}">${title}</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px">
        ${models.map(m => {
          const short = m.id.split('/').pop();
          const sizeTag = m.size ? ` <span style="font-size:9px;color:var(--text2)">${m.size}</span>` : '';
          return `<button class="btn btn-sm" style="font-size:11px;padding:3px 8px" onclick="submitModel('${provName}','${m.id}')" title="${m.id}">${short}${sizeTag}</button>`;
        }).join('')}
      </div>
    </div>`;
}

async function submitModel(name, model) {
  await PUT(`/providers/${name}/model`, { model });
  closeModal();
  renderProviders(document.getElementById('content'));
}

// ===================== AI PROJECTS =====================
async function renderGenProjects(el) {
  await refreshAll();
  el.innerHTML = `
    <div class="section-title"><span class="icon">🚀</span> Projects <button class="btn btn-primary btn-sm" onclick="promptNewProject()" style="margin-left:auto">+ New Project</button></div>
    ${state.genprojects.length === 0 ? '<div class="empty-state"><div class="empty-icon">🚀</div><h3>No projects yet</h3><p>Describe an idea and the AI will build it</p><button class="btn btn-primary" onclick="promptNewProject()">Create Project</button></div>' :
      state.genprojects.map(p => {
        const statusColors = { draft: 'blue', generating: 'orange', ready: 'green', running: 'cyan' };
        const statusIcons = { draft: '📝', generating: '⚙️', ready: '✅', running: '▶️' };
        return `<div class="card" style="cursor:pointer" onclick="viewGenProject(${p.id})">
          <div class="card-header">
            <div>
              <div class="card-title">${escapeHtml(p.title)}</div>
              <div class="card-subtitle">${escapeHtml(p.tech_stack)} · ${(p.keypoints||[]).length} features · ${escapeHtml(p.description||'').substring(0, 80)}</div>
            </div>
            <div style="display:flex;gap:6px;align-items:center">
              <span class="badge badge-${statusColors[p.status] || 'blue'}">${statusIcons[p.status] || '📝'} ${escapeHtml(p.status)}</span>
              <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();deleteGenProject(${p.id})">🗑️</button>
            </div>
          </div>
        </div>`;
      }).join('')}`;
}

function promptNewProject() {
  showModal('🚀 New Project', `
    <div class="form-group">
      <label class="form-label">Describe your project idea</label>
      <textarea class="textarea" id="project-idea" rows="4" placeholder="e.g. A real-time chat application with rooms, user authentication, and message history..."></textarea>
    </div>
    <div class="btn-group">
      <button class="btn btn-primary" onclick="createGenProject()">🤖 Generate Project Plan</button>
      <button class="btn" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function createGenProject() {
  const idea = document.getElementById('project-idea').value.trim();
  if (!idea) return;
  closeModal();
  const content = document.getElementById('content');
  content.innerHTML = '<div class="empty-state"><div class="empty-icon" style="animation:spin 2s linear infinite">🤖</div><h3>Analyzing your idea...</h3><p>AI is breaking it into key features and recommending the best tech stack</p></div>';
  try {
    const result = await POST('/gen', { idea });
    await refreshAll();
    viewGenProject(result.project.id);
  } catch (err) {
    content.innerHTML = `<div class="empty-state"><div class="empty-icon">❌</div><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`;
  }
}

async function deleteGenProject(id) {
  if (!confirm('Delete this project?')) return;
  await DEL(`/gen/${id}`);
  await refreshAll();
  renderGenProjects(document.getElementById('content'));
}

let projectPollInterval = null;
function stopProjectPolling() { if (projectPollInterval) { clearInterval(projectPollInterval); projectPollInterval = null; } }

async function viewGenProject(id) {
  const proj = await GET(`/gen/${id}`);
  if (!proj) return;
  const content = document.getElementById('content');

  // Auto-poll while generating
  if (proj.status === 'generating' && !projectPollInterval) {
    projectPollInterval = setInterval(() => viewGenProject(id), 3000);
  } else if (proj.status !== 'generating') {
    stopProjectPolling();
  }

  const kpList = (proj.keypoints || []).map((k, i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
      <span style="color:var(--cyan);font-weight:bold;min-width:20px">${i + 1}.</span>
      <span style="flex:1">${escapeHtml(k)}</span>
      <button class="btn btn-xs btn-danger" onclick="removeKeypoint(${id},${i})" style="font-size:10px;padding:1px 4px">✕</button>
    </div>
  `).join('');

  content.innerHTML = `
    <div class="section-title">
      <span class="icon">🚀</span> ${escapeHtml(proj.title)}
      <span class="badge badge-${proj.tech_stack === 'python' ? 'orange' : 'green'}" style="margin-left:8px">${escapeHtml(proj.tech_stack)}</span>
      <span class="badge badge-blue" style="margin-left:4px">${escapeHtml(proj.status)}</span>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-sm" onclick="stopProjectPolling();renderGenProjects(document.getElementById('content'))">← Back</button>
        <button class="btn btn-sm btn-danger" onclick="deleteGenProject(${id})">🗑️</button>
      </div>
    </div>

    <p style="color:var(--text2);margin-bottom:16px">${escapeHtml(proj.description || '')}</p>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <!-- Left: Keypoints -->
      <div class="card" style="margin:0">
        <div class="card-header">
          <div class="card-title">🔑 Key Features (${(proj.keypoints||[]).length})</div>
        </div>
        <div style="padding:8px 0">${kpList || '<div style="color:var(--text2)">No keypoints yet</div>'}</div>
        <div style="display:flex;gap:6px;margin-top:8px">
          <input class="input" id="new-kp" placeholder="Add a feature..." style="flex:1" onkeydown="if(event.key==='Enter')addKeypoint(${id})">
          <button class="btn btn-sm btn-primary" onclick="addKeypoint(${id})">+ Add</button>
        </div>
      </div>

      <!-- Right: Info -->
      <div class="card" style="margin:0">
        <div class="card-header">
          <div class="card-title">📋 Project Info</div>
        </div>
        <div style="padding:8px 0;font-size:13px">
          <div style="margin-bottom:8px"><span style="color:var(--text2)">Tech:</span> <code>${escapeHtml(proj.tech_stack)}</code></div>
          <div style="margin-bottom:8px"><span style="color:var(--text2)">Run:</span> <code>${escapeHtml(proj.run_command || 'not set')}</code></div>
          <div style="margin-bottom:8px"><span style="color:var(--text2)">Install:</span> <code>${escapeHtml(proj.install_command || 'not set')}</code></div>
          <div style="margin-bottom:8px"><span style="color:var(--text2)">Status:</span> <span class="badge badge-${proj.status === 'ready' ? 'green' : proj.status === 'running' ? 'blue' : 'orange'}">${escapeHtml(proj.status)}</span></div>
          ${proj.project_path ? `<div style="margin-bottom:8px"><span style="color:var(--text2)">Path:</span> <code style="font-size:11px;word-break:break-all">${escapeHtml(proj.project_path)}</code></div>` : ''}
          <div style="color:var(--text2)">Chat messages: ${(proj.chat_history||[]).length}</div>
        </div>
      </div>
    </div>

    <!-- Action buttons -->
    <div class="card" id="project-actions-card" style="margin-top:16px;text-align:center">
      ${proj.status === 'generating'
        ? `<div><span style="animation:spin 2s linear infinite;display:inline-block">⚙️</span> <b>Generating project files...</b> This may take 30-60 seconds</div>`
        : proj.status === 'ready' || proj.status === 'running'
          ? `<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
              <button class="btn btn-primary" onclick="generateProject(${id})">🔄 Regenerate</button>
              <button class="btn" style="background:var(--green);color:#000" onclick="viewGenFiles(${id})">📂 View Files</button>
              <button class="btn" style="background:var(--yellow);color:#000" onclick="openProjectFolder(${id})">📁 Open Folder</button>
              <button class="btn" style="background:#a78bfa;color:#000" onclick="openTerminal(${id})">🖥️ Terminal</button>
              <button class="btn" style="background:#e879f9;color:#000" onclick="fixGenProject(${id})">🔧 Fix Bugs</button>
              ${proj.status === 'running'
                ? `<button class="btn" style="background:var(--red);color:#fff" onclick="stopGenProject(${id})">⏹ Stop</button>`
                : `<button class="btn" style="background:var(--cyan);color:#000" onclick="runGenProject(${id})">▶️ Run Project</button>`}
            </div>`
          : `<button class="btn btn-primary" style="font-size:16px;padding:12px 32px" onclick="generateProject(${id})">⚡ Generate Project — create all files</button>
             <div style="margin-top:8px;color:var(--text2)">The AI will generate a complete, runnable ${escapeHtml(proj.tech_stack)} project from your ${(proj.keypoints||[]).length} keypoints</div>`}
    </div>

    <!-- Output + Chat side by side (only when project is generated) -->
    ${proj.status === 'ready' || proj.status === 'running' ? `
    <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:0;margin-top:16px">

      <!-- Left: Run Output -->
      <div class="card" style="margin:0;display:flex;flex-direction:column">
        <div class="card-header" style="display:flex;align-items:center;gap:8px">
          <div class="card-title" style="margin:0">📟 Output</div>
          <div style="margin-left:auto">
            <button class="btn btn-xs" style="background:var(--bg3);font-size:11px" onclick="clearRunLogs(${id})">Clear</button>
          </div>
        </div>
        <pre id="run-logs" style="background:var(--bg1);padding:12px;border-radius:6px;flex:1;min-height:200px;max-height:450px;overflow:auto;font-size:12px;white-space:pre-wrap;margin:0;line-height:1.5">Loading logs...</pre>
      </div>

      <!-- Center: Send logs to chat arrow -->
      <div style="display:flex;align-items:center;padding:0 4px">
        <button class="btn" onclick="sendLogsToChat(${id})" title="Send last run output to Code Chat for LLM to fix"
                style="background:var(--orange);color:#000;font-size:18px;padding:8px 6px;border-radius:8px;line-height:1;cursor:pointer;writing-mode:horizontal-tb">⇒</button>
      </div>

      <!-- Right: Code Chat -->
      <div class="card" style="margin:0;display:flex;flex-direction:column">
        <div class="card-header" style="display:flex;align-items:center;gap:8px">
          <div class="card-title" style="margin:0">💬 Code Chat</div>
          <div style="margin-left:auto">
            <button class="btn btn-xs" style="background:var(--bg3);font-size:11px" onclick="clearCodeChat(${id})">Clear</button>
          </div>
        </div>
        <div id="code-chat-messages" style="flex:1;min-height:200px;max-height:380px;overflow-y:auto;padding:4px 0">
          ${(proj.chat_history || []).length > 0
            ? (proj.chat_history || []).map(m => `
              <div style="padding:8px 10px;margin:3px 0;border-radius:6px;background:${m.role === 'user' ? 'var(--bg3)' : 'rgba(0,255,255,0.04)'};border-left:3px solid ${m.role === 'user' ? 'var(--orange)' : 'var(--cyan)'}">
                <div style="font-size:10px;color:var(--text2);margin-bottom:2px;font-weight:600">${m.role === 'user' ? '👤 You' : '🤖 AI'}</div>
                <div style="font-size:12px;white-space:pre-wrap;line-height:1.4">${escapeHtml(m.content).substring(0, 2000)}</div>
              </div>
            `).join('')
            : `<div style="color:var(--text2);padding:16px;text-align:center;font-size:12px">
                💡 Talk to LLM to fix bugs.<br>It sees all project files.<br>
                <span style="font-size:11px;color:var(--text3)">e.g. "main.py crashes on line 15"</span>
              </div>`
          }
        </div>
        <div style="display:flex;gap:6px;padding-top:8px;border-top:1px solid var(--border);margin-top:auto">
          <input class="input" id="code-chat-input" placeholder="Describe bug or what to fix..." style="flex:1;font-size:13px;padding:8px 10px"
                 onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendCodeChat(${id})}">
          <button class="btn btn-primary" id="code-chat-send" onclick="sendCodeChat(${id})" style="padding:8px 16px;font-size:13px">Send</button>
        </div>
      </div>

    </div>` : ''}
  `;

  // Always load persisted logs if project is generated
  if (proj.status === 'running' || proj.status === 'ready') {
    // Small delay to let DOM render the <pre> element first
    setTimeout(async () => {
      await loadProjectLogs(id);
      // Show fallback if no logs at all
      const el = document.getElementById('run-logs');
      if (el && (!el.textContent || el.textContent === 'Loading logs...')) {
        el.textContent = 'Click ▶️ Run Project to see output here.\nLogs persist between runs.';
      }
    }, 100);
    if (proj.status === 'running' && !projectPollInterval) {
      projectPollInterval = setInterval(() => loadProjectLogs(id), 2000);
    }
  }

  // Scroll chat to bottom
  const chatEl = document.getElementById('code-chat-messages');
  if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
}

async function addKeypoint(id) {
  const input = document.getElementById('new-kp');
  const kp = input.value.trim();
  if (!kp) return;
  const proj = await GET(`/gen/${id}`);
  const kps = [...(proj.keypoints || []), kp];
  await PUT(`/gen/${id}/keypoints`, { keypoints: kps });
  viewGenProject(id);
}

async function removeKeypoint(id, index) {
  const proj = await GET(`/gen/${id}`);
  const kps = (proj.keypoints || []).filter((_, i) => i !== index);
  await PUT(`/gen/${id}/keypoints`, { keypoints: kps });
  viewGenProject(id);
}

async function sendProjectChat(id) {
  const input = document.getElementById('chat-msg');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  input.disabled = true;

  // Show user message immediately
  const chatDiv = document.getElementById('project-chat');
  chatDiv.innerHTML += `<div style="padding:8px;margin:4px 0;border-radius:6px;background:var(--bg3);border-left:3px solid var(--orange)"><div style="font-size:11px;color:var(--text2);margin-bottom:4px">👤 You</div><div style="font-size:13px">${escapeHtml(msg)}</div></div>`;
  chatDiv.innerHTML += `<div style="padding:8px;color:var(--text2)">🤖 Thinking...</div>`;
  chatDiv.scrollTop = chatDiv.scrollHeight;

  try {
    const result = await POST(`/gen/${id}/chat`, { message: msg });
    viewGenProject(id); // Full refresh to show updated chat
  } catch (err) {
    chatDiv.innerHTML += `<div style="padding:8px;color:var(--red)">Error: ${escapeHtml(err.message)}</div>`;
  }
  input.disabled = false;
}

async function sendCodeChat(id) {
  const input = document.getElementById('code-chat-input');
  const sendBtn = document.getElementById('code-chat-send');
  const msg = input.value.trim();
  if (!msg) return;

  input.value = '';
  input.disabled = true;
  sendBtn.disabled = true;
  sendBtn.textContent = '⏳';

  // Show user message immediately
  const chatDiv = document.getElementById('code-chat-messages');
  // Remove placeholder if present
  const placeholder = chatDiv.querySelector('[style*="text-align:center"]');
  if (placeholder) placeholder.remove();

  chatDiv.insertAdjacentHTML('beforeend', `
    <div style="padding:8px 10px;margin:3px 0;border-radius:6px;background:var(--bg3);border-left:3px solid var(--orange)">
      <div style="font-size:10px;color:var(--text2);margin-bottom:2px;font-weight:600">👤 You</div>
      <div style="font-size:12px;white-space:pre-wrap">${escapeHtml(msg.substring(0, 1000))}${msg.length > 1000 ? '...' : ''}</div>
    </div>
    <div id="code-chat-thinking" style="padding:8px 10px;margin:3px 0;border-radius:6px;background:rgba(0,255,255,0.04);border-left:3px solid var(--cyan)">
      <div style="font-size:10px;color:var(--text2);margin-bottom:2px;font-weight:600">🤖 AI</div>
      <div style="font-size:12px;color:var(--text2)"><span style="animation:spin 2s linear infinite;display:inline-block">⚙️</span> Analyzing project files & thinking...</div>
    </div>`);
  chatDiv.scrollTop = chatDiv.scrollHeight;

  try {
    // Truncate very long messages (e.g. pasted logs) to avoid payload issues
    const truncMsg = msg.length > 10000 ? msg.substring(0, 10000) + '\n...(truncated)' : msg;
    // Use a 120s timeout — LLM calls with full project context can be slow
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    let result;
    try {
      const res = await fetch(`/api/gen/${id}/code-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: truncMsg }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(`Server returned HTML instead of JSON (HTTP ${res.status}). Try refreshing the page.`);
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      result = data;
    } catch (e) {
      clearTimeout(timeout);
      if (e.name === 'AbortError') throw new Error('Request timed out (120s). LLM may be slow or unresponsive.');
      throw e;
    }
    // Remove thinking indicator and show response
    const thinking = document.getElementById('code-chat-thinking');
    if (thinking) {
      let replyHtml = `
        <div style="font-size:11px;color:var(--text2);margin-bottom:4px;font-weight:600">🤖 AI</div>
        <div style="font-size:13px;white-space:pre-wrap;line-height:1.5">${escapeHtml(result.reply)}</div>`;
      if (result.filesFixed?.length > 0) {
        replyHtml += `<div style="margin-top:8px;padding:6px 10px;background:rgba(0,255,100,0.1);border-radius:4px;font-size:12px;color:var(--green)">✅ Applied fixes to: ${result.filesFixed.map(f => `<code>${escapeHtml(f)}</code>`).join(', ')}</div>`;
      }
      if (result.provider) {
        replyHtml += `<div style="font-size:10px;color:var(--text3);margin-top:4px">via ${escapeHtml(result.provider)}</div>`;
      }
      thinking.innerHTML = replyHtml;
    }
    chatDiv.scrollTop = chatDiv.scrollHeight;
  } catch (err) {
    const thinking = document.getElementById('code-chat-thinking');
    if (thinking) {
      thinking.innerHTML = `
        <div style="font-size:11px;color:var(--text2);margin-bottom:4px;font-weight:600">🤖 AI</div>
        <div style="font-size:13px;color:var(--red)">❌ Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  input.disabled = false;
  sendBtn.disabled = false;
  sendBtn.textContent = 'Send';
  input.focus();
}

async function clearCodeChat(id) {
  try {
    await POST(`/gen/${id}/clear-chat`);
    viewGenProject(id);
  } catch (err) {
    showModal('Error', `<p>${escapeHtml(err.message)}</p><button class="btn" onclick="closeModal()">Close</button>`);
  }
}

let _generatingLock = false;
async function generateProject(id) {
  // Prevent double-click
  if (_generatingLock) return;
  _generatingLock = true;

  // Disable all generate/regenerate buttons immediately
  document.querySelectorAll('button').forEach(btn => {
    if (btn.textContent.includes('Generate') || btn.textContent.includes('Regenerate')) {
      btn.disabled = true;
      btn.style.opacity = '0.5';
      btn.style.cursor = 'not-allowed';
    }
  });

  // Show inline progress immediately
  const content = document.getElementById('content');
  const actionCard = content.querySelector('.card:last-of-type');
  if (actionCard) {
    actionCard.innerHTML = `
      <div style="text-align:center;padding:24px">
        <div style="font-size:40px;animation:spin 2s linear infinite;display:inline-block">⚙️</div>
        <h3 style="margin:12px 0 4px">Generating Project Files...</h3>
        <div id="gen-progress-text" style="color:var(--text2);font-size:13px">Sending to LLM — this may take 30-120 seconds</div>
        <div style="margin-top:16px">
          <div style="background:var(--bg1);border-radius:8px;height:8px;overflow:hidden;max-width:400px;margin:0 auto">
            <div id="gen-progress-bar" style="height:100%;background:linear-gradient(90deg,var(--orange),var(--yellow));width:5%;transition:width 1s ease;border-radius:8px"></div>
          </div>
        </div>
        <div style="margin-top:12px;font-size:11px;color:var(--text2)">💡 The AI generates all project files in a single pass</div>
      </div>
    `;
  }

  // Animate progress bar while waiting
  let progressPercent = 5;
  const progressInterval = setInterval(() => {
    progressPercent = Math.min(progressPercent + Math.random() * 3, 90);
    const bar = document.getElementById('gen-progress-bar');
    const txt = document.getElementById('gen-progress-text');
    if (bar) bar.style.width = `${progressPercent}%`;
    if (txt) {
      if (progressPercent < 20) txt.textContent = 'Sending to LLM — this may take 30-120 seconds';
      else if (progressPercent < 40) txt.textContent = 'AI is analyzing your keypoints...';
      else if (progressPercent < 60) txt.textContent = 'Generating project structure & files...';
      else if (progressPercent < 80) txt.textContent = 'Writing code & configuration...';
      else txt.textContent = 'Almost done — finalizing output...';
    }
  }, 2000);

  try {
    const result = await POST(`/gen/${id}/generate`);
    clearInterval(progressInterval);
    const bar = document.getElementById('gen-progress-bar');
    if (bar) bar.style.width = '100%';
    const txt = document.getElementById('gen-progress-text');
    const warnMsg = result.warnings?.length ? ` — ${result.warnings[0]}` : '';
    if (txt) txt.textContent = `✅ Done! ${result.files?.length || 0} file(s) created${warnMsg}`;
    // Small delay so user sees the 100% bar
    await new Promise(r => setTimeout(r, warnMsg ? 2500 : 800));
  } catch (err) {
    clearInterval(progressInterval);
    const txt = document.getElementById('gen-progress-text');
    if (txt) txt.textContent = `❌ Failed: ${err.message}`;
    await new Promise(r => setTimeout(r, 2000));
  }

  _generatingLock = false;
  viewGenProject(id);
}

async function viewGenFiles(id) {
  const content = document.getElementById('content');
  const data = await GET(`/gen/${id}/files`);
  const proj = await GET(`/gen/${id}`);
  if (!data.ok || !data.files?.length) {
    showModal('📂 No Files', '<p>Project not generated yet.</p><button class="btn" onclick="closeModal()">Close</button>');
    return;
  }
  content.innerHTML = `
    <div class="section-title">
      <span class="icon">📂</span> ${escapeHtml(proj.title)} — Files
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-sm" onclick="viewGenProject(${id})">← Project</button>
        <button class="btn btn-sm btn-primary" onclick="generateProject(${id})">🔄 Regenerate</button>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:250px 1fr;gap:16px;height:calc(100vh - 160px)">
      <div class="card" style="overflow:auto;margin:0;padding:8px">
        <div style="font-weight:bold;padding:8px;border-bottom:1px solid var(--border)">📁 ${data.files.length} files</div>
        ${data.files.map(f => `
          <div onclick="loadGenFile(${id},'${escapeAttr(f.path)}')" style="padding:6px 8px;cursor:pointer;border-radius:4px;font-family:monospace;font-size:12px;transition:background 0.2s"
               onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background='transparent'">
            ${f.path.endsWith('.js') ? '🟨' : f.path.endsWith('.py') ? '🐍' : f.path.endsWith('.md') ? '📝' : f.path.endsWith('.json') ? '📋' : '📄'} ${escapeHtml(f.path)}
          </div>
        `).join('')}
      </div>
      <div class="card" id="gen-file-viewer" style="overflow:auto;margin:0;padding:16px">
        <div class="empty-state"><div class="empty-icon">👈</div><h3>Select a file</h3></div>
      </div>
    </div>
  `;
}

async function loadGenFile(id, path) {
  const viewer = document.getElementById('gen-file-viewer');
  viewer.innerHTML = '<div style="text-align:center;padding:20px">⏳ Loading...</div>';
  try {
    const data = await GET(`/gen/${id}/file?path=${encodeURIComponent(path)}`);
    viewer.innerHTML = `
      <div style="display:flex;justify-content:space-between;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--border)">
        <span style="font-family:monospace;font-weight:bold">${escapeHtml(path)}</span>
        <span style="color:var(--text2);font-size:12px">${data.content.length} chars</span>
      </div>
      <pre style="background:var(--bg1);padding:12px;border-radius:6px;overflow:auto;font-size:12px;line-height:1.5;white-space:pre-wrap;border:1px solid var(--border);max-height:calc(100vh - 250px)">${escapeHtml(data.content)}</pre>
    `;
  } catch (err) {
    viewer.innerHTML = `<div style="color:var(--red)">Error: ${escapeHtml(err.message)}</div>`;
  }
}

async function runGenProject(id) {
  try {
    const result = await POST(`/gen/${id}/run`);
    // Update buttons to show Stop instead of Run
    await updateProjectButtons(id);
    // Clear old "click to run" placeholder and start polling
    const el = document.getElementById('run-logs');
    if (el && (!el.textContent || el.textContent.includes('Click'))) {
      el.textContent = '📦 Starting...\n';
    }
    if (!projectPollInterval) {
      projectPollInterval = setInterval(() => loadProjectLogs(id), 2000);
    }
    // Load immediately
    loadProjectLogs(id);
  } catch (err) {
    showModal('❌ Run Failed', `<p>${escapeHtml(err.message)}</p><button class="btn" onclick="closeModal()">Close</button>`);
  }
}

async function stopGenProject(id) {
  await POST(`/gen/${id}/stop`);
  stopProjectPolling();
  // Just update buttons, don't re-render (preserves logs)
  const el = document.getElementById('run-logs');
  const savedLogs = el?.textContent || '';
  await updateProjectButtons(id, savedLogs);
}

async function openProjectFolder(id) {
  try {
    await POST(`/gen/${id}/open-folder`);
  } catch (err) {
    showModal('❌ Error', `<p>Could not open folder: ${escapeHtml(err.message)}</p><button class="btn" onclick="closeModal()">Close</button>`);
  }
}

async function openTerminal(id) {
  try {
    await POST(`/gen/${id}/open-terminal`);
  } catch (err) {
    showModal('❌ Error', `<p>Could not open terminal: ${escapeHtml(err.message)}</p><button class="btn" onclick="closeModal()">Close</button>`);
  }
}

let _fixingLock = false;
async function fixGenProject(id) {
  if (_fixingLock) return;
  _fixingLock = true;

  // Replace action buttons with progress UI
  const content = document.getElementById('content');
  const cards = content.querySelectorAll('.card');
  const actionCard = cards[cards.length - 2]; // Action buttons card (before logs card)
  if (actionCard) {
    actionCard.innerHTML = `
      <div style="text-align:center;padding:24px">
        <div style="font-size:40px;animation:spin 2s linear infinite;display:inline-block">🔧</div>
        <h3 style="margin:12px 0 4px">Auto-Fixing Project...</h3>
        <div id="fix-progress-text" style="color:var(--text2);font-size:13px">Running project to detect errors...</div>
        <div style="margin-top:16px">
          <div style="background:var(--bg1);border-radius:8px;height:8px;overflow:hidden;max-width:400px;margin:0 auto">
            <div id="fix-progress-bar" style="height:100%;background:linear-gradient(90deg,#e879f9,var(--cyan));width:10%;transition:width 1s ease;border-radius:8px"></div>
          </div>
        </div>
      </div>
    `;
  }

  let progressPercent = 10;
  const progressInterval = setInterval(() => {
    progressPercent = Math.min(progressPercent + Math.random() * 5, 90);
    const bar = document.getElementById('fix-progress-bar');
    const txt = document.getElementById('fix-progress-text');
    if (bar) bar.style.width = `${progressPercent}%`;
    if (txt) {
      if (progressPercent < 30) txt.textContent = 'Running project to detect errors...';
      else if (progressPercent < 50) txt.textContent = 'Crash detected — sending error to LLM for repair...';
      else if (progressPercent < 70) txt.textContent = 'LLM is analyzing and fixing the code...';
      else txt.textContent = 'Applying fixes and re-testing...';
    }
  }, 2000);

  try {
    const result = await POST(`/gen/${id}/fix`);
    clearInterval(progressInterval);
    const bar = document.getElementById('fix-progress-bar');
    if (bar) bar.style.width = '100%';
    const txt = document.getElementById('fix-progress-text');
    if (result.ok) {
      if (result.fixes?.length > 0) {
        if (txt) txt.textContent = `✅ Fixed ${result.fixes.length} issue(s)! Files: ${result.filesFixed?.join(', ') || 'updated'}`;
      } else {
        if (txt) txt.textContent = '✅ No bugs found — project runs correctly!';
      }
    } else {
      if (txt) txt.textContent = `⚠️ Some issues remain after ${result.fixes?.length || 0} fix attempt(s)`;
    }
    await new Promise(r => setTimeout(r, 2000));
  } catch (err) {
    clearInterval(progressInterval);
    const txt = document.getElementById('fix-progress-text');
    if (txt) txt.textContent = `❌ Fix failed: ${err.message}`;
    await new Promise(r => setTimeout(r, 2000));
  }

  _fixingLock = false;
  viewGenProject(id);
}

async function loadProjectLogs(id) {
  try {
    const data = await GET(`/gen/${id}/logs`);
    const el = document.getElementById('run-logs');
    if (el && data.logs && data.logs.trim()) {
      el.textContent = data.logs;
      el.scrollTop = el.scrollHeight;
    }
    // Don't replace existing logs with placeholder — only show placeholder
    // if element is empty/has placeholder AND there's truly nothing from API
    if (!data.running && projectPollInterval) {
      stopProjectPolling();
      // Prefer DOM content (visible to user), fallback to API response
      const savedLogs = (el?.textContent && !el.textContent.includes('Click') && !el.textContent.includes('Loading'))
        ? el.textContent
        : (data.logs || '');
      setTimeout(() => {
        updateProjectButtons(id, savedLogs);
      }, 500);
    }
  } catch {}
}

// Partial refresh: update only the action buttons without wiping logs/chat
async function updateProjectButtons(id, preservedLogs) {
  const proj = await GET(`/gen/${id}`);
  if (!proj) return;

  // Target the action card by ID
  const card = document.getElementById('project-actions-card');
  if (card) {
    const isReady = proj.status === 'ready' || proj.status === 'running';
    if (isReady) {
      card.innerHTML = `<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="generateProject(${id})">🔄 Regenerate</button>
        <button class="btn" style="background:var(--green);color:#000" onclick="viewGenFiles(${id})">📂 View Files</button>
        <button class="btn" style="background:var(--yellow);color:#000" onclick="openProjectFolder(${id})">📁 Open Folder</button>
        <button class="btn" style="background:#a78bfa;color:#000" onclick="openTerminal(${id})">🖥️ Terminal</button>
        <button class="btn" style="background:#e879f9;color:#000" onclick="fixGenProject(${id})">🔧 Fix Bugs</button>
        ${proj.status === 'running'
          ? `<button class="btn" style="background:var(--red);color:#fff" onclick="stopGenProject(${id})">⏹ Stop</button>`
          : `<button class="btn" style="background:var(--cyan);color:#000" onclick="runGenProject(${id})">▶️ Run Project</button>`}
      </div>`;
    }
  }

  // Update status badge
  const badges = document.querySelectorAll('.badge-blue');
  for (const b of badges) {
    if (['draft', 'generating', 'ready', 'running'].includes(b.textContent.trim())) {
      b.textContent = proj.status;
    }
  }

  // Re-apply preserved logs
  if (preservedLogs) {
    const el = document.getElementById('run-logs');
    if (el) {
      el.textContent = preservedLogs;
      el.scrollTop = el.scrollHeight;
    }
  }
}

async function clearRunLogs(id) {
  try {
    await POST(`/gen/${id}/clear-logs`);
    const el = document.getElementById('run-logs');
    if (el) el.textContent = 'Logs cleared.';
  } catch {}
}

function sendLogsToChat(id) {
  const el = document.getElementById('run-logs');
  if (!el) return;
  const fullLogs = el.textContent || '';
  if (!fullLogs.trim() || fullLogs.includes('Click') || fullLogs === 'Loading logs...') {
    return; // nothing to send
  }

  // Extract only the LAST run (after the last separator)
  const separator = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const parts = fullLogs.split(separator);
  const lastRun = parts.length > 1 ? parts[parts.length - 1].trim() : fullLogs.trim();

  // Truncate if too long
  const logSnippet = lastRun.length > 3000 ? lastRun.substring(lastRun.length - 3000) : lastRun;

  // Put it in the chat input with a prefix
  const input = document.getElementById('code-chat-input');
  if (input) {
    input.value = `Here is the output from the last run, fix the errors:\n\n${logSnippet}`;
    input.focus();
    // Auto-send
    sendCodeChat(id);
  }
}

// ===================== OLD BOARDS (legacy) =====================
async function renderOldBoards(el) {
  await refreshAll();
  el.innerHTML = `
    <div class="section-title"><span class="icon">📋</span> Project Boards <button class="btn btn-primary btn-sm" onclick="promptNewBoard()" style="margin-left:auto">+ New Board</button></div>
    ${state.boards.length === 0 ? '<div class="empty-state"><div class="empty-icon">📋</div><h3>No boards yet</h3><p>Create a project board to break down tasks</p></div>' :
      state.boards.map(b => {
        const tasks = b.tasks || [];
        const done = tasks.filter(t => t.status === 'done').length;
        const pct = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0;
        const isRunning = b.status === 'executing';
        const hasUnfinished = tasks.some(t => t.status !== 'done');
        return `<div class="card" style="cursor:pointer">
          <div onclick="viewBoard(${b.id})">
            <div class="card-header">
              <div><div class="card-title">${escapeHtml(b.title)}</div><div class="card-subtitle">${tasks.length} tasks · ${done} done · ${escapeHtml(b.status)}</div></div>
              <div class="badge badge-${b.status === 'completed' ? 'green' : isRunning ? 'orange' : 'blue'}">${pct}%</div>
            </div>
            <div style="height:4px;background:var(--bg3);border-radius:2px;overflow:hidden;margin-bottom:8px"><div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--cyan),var(--green));border-radius:2px;transition:width 0.5s"></div></div>
          </div>
          <div style="display:flex;gap:6px;justify-content:flex-end">
            ${isRunning
              ? `<button class="btn btn-sm" style="background:var(--orange);color:#000" onclick="event.stopPropagation();pauseBoard(${b.id})">⏸ Pause</button>`
              : hasUnfinished
                ? `<button class="btn btn-sm btn-primary" onclick="event.stopPropagation();runBoard(${b.id})">▶️ Run</button>`
                : `<span class="badge badge-green" style="padding:4px 8px">✅ Complete</span>`}
            <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();deleteBoard(${b.id})">🗑️</button>
          </div>
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

let boardPollInterval = null;
function stopBoardPolling() { if (boardPollInterval) { clearInterval(boardPollInterval); boardPollInterval = null; } }

async function viewBoard(boardId) {
  const data = await GET(`/boards/${boardId}`);
  if (!data.board) return;
  const { board, tasks, pending, inProgress, done, needsInput } = data;
  const content = document.getElementById('content');
  const isRunning = board.status === 'executing';
  const hasUnfinished = pending.length + inProgress.length > 0;

  // Auto-poll while executing
  if (isRunning && !boardPollInterval) {
    boardPollInterval = setInterval(() => viewBoard(boardId), 3000);
  } else if (!isRunning) {
    stopBoardPolling();
  }

  const isComplete = board.status === 'completed' || (!hasUnfinished && done.length > 0);

  content.innerHTML = `
    <div class="section-title">
      <span class="icon">📋</span> ${escapeHtml(board.title)}
      <span class="badge badge-${board.status === 'completed' ? 'green' : isRunning ? 'orange' : 'blue'}" style="margin-left:8px">${escapeHtml(board.status)}</span>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-sm" onclick="stopBoardPolling();renderBoards(document.getElementById('content'))">← Back</button>
        ${isRunning
          ? `<button class="btn btn-sm" style="background:var(--orange);color:#000" onclick="pauseBoard(${board.id})">⏸ Pause</button>`
          : hasUnfinished
            ? `<button class="btn btn-sm btn-primary" onclick="runBoard(${board.id})">🚀 Run Project</button>`
            : ''}
        ${isComplete ? `<button class="btn btn-sm" style="background:var(--green);color:#000" onclick="buildProject(${board.id})">📦 Build Project</button>` : ''}
        ${isComplete ? `<button class="btn btn-sm" onclick="viewProject(${board.id})">📂 View Files</button>` : ''}
        <button class="btn btn-sm btn-primary" onclick="addTaskPrompt(${board.id})">+ Task</button>
        <button class="btn btn-sm btn-danger" onclick="deleteBoard(${board.id})">🗑️</button>
      </div>
    </div>
    ${isRunning ? `<div class="card" style="border-color:var(--cyan);background:rgba(0,255,255,0.05)"><b>⚡ Executing tasks automatically...</b> <span style="color:var(--text2)">${done.length}/${tasks.length} done</span></div>` : ''}
    ${isComplete ? `<div class="card" style="border-color:var(--green);background:rgba(0,255,0,0.05)">
      <b>✅ All ${done.length} tasks completed!</b>
      <div style="margin-top:8px;display:flex;gap:8px">
        <button class="btn btn-primary" onclick="buildProject(${board.id})">📦 Build Project — assemble all scripts into runnable files</button>
        <button class="btn" onclick="viewProject(${board.id})">📂 View Files</button>
      </div>
    </div>` : ''}
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
  return `<div class="task-card">
    <div class="task-title" onclick="taskDetail(${t.id}, ${boardId})" style="cursor:pointer">${needsQ ? '❓ ' : ''}${escapeHtml(t.title)}</div>
    <div class="task-meta">
      ${t.status === 'pending' ? `<button class="btn btn-xs btn-primary" onclick="executeTask(${t.id},${boardId})" style="font-size:11px;padding:2px 6px">⚡ Execute</button>` : ''}
      ${t.status === 'in_progress' ? `<span style="color:var(--cyan);font-size:12px">⏳ Running...</span>` : ''}
      ${t.status === 'done' && t.execution_log ? `<button class="btn btn-xs" onclick="viewTaskLog(${t.id},${boardId})" style="font-size:11px;padding:2px 6px">📜 Result</button>` : ''}
      <span class="task-qa ${qaClass}">QA: ${escapeHtml(t.qa_status)}</span>
    </div>
  </div>`;
}

async function taskDetail(taskId, boardId) {
  const data = await GET(`/boards/${boardId}`);
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) return;

  const statusOpts = ['pending', 'in_progress', 'done'].map(s =>
    `<button class="btn btn-sm ${task.status === s ? 'btn-primary' : ''}" onclick="setTaskStatus(${taskId},${boardId},'${s}')">${s}</button>`).join('');

  const logPreview = task.execution_log
    ? `<div class="form-group"><label class="form-label">📜 Execution Result</label><pre style="background:var(--bg2);padding:12px;border-radius:6px;max-height:300px;overflow:auto;font-size:12px;white-space:pre-wrap;border:1px solid var(--border)">${escapeHtml(task.execution_log.substring(0, 3000))}${task.execution_log.length > 3000 ? '\n...(truncated)' : ''}</pre></div>`
    : '';

  showModal(`Task: ${escapeHtml(task.title)}`, `
    <p style="color:var(--text2);margin-bottom:12px">${escapeHtml(task.description || 'No description')}</p>
    <div class="form-group"><label class="form-label">Status</label><div class="btn-group">${statusOpts}</div></div>
    ${task.status === 'pending' ? `<div class="form-group"><button class="btn btn-primary" onclick="executeTask(${taskId},${boardId});closeModal()">⚡ Execute \u2014 generate script for this task</button></div>` : ''}
    ${logPreview}
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
async function deleteBoard(boardId) { if (!confirm('Delete this board?')) return; stopBoardPolling(); await DEL(`/boards/${boardId}`); await refreshAll(); renderBoards(document.getElementById('content')); }
async function runBoard(boardId) { await POST(`/boards/${boardId}/execute`); viewBoard(boardId); }
async function pauseBoard(boardId) { stopBoardPolling(); await POST(`/boards/${boardId}/pause`); viewBoard(boardId); }
async function executeTask(taskId, boardId) { await POST(`/tasks/${taskId}/execute`); viewBoard(boardId); }
function viewTaskLog(taskId, boardId) { taskDetail(taskId, boardId); }

async function buildProject(boardId) {
  const content = document.getElementById('content');
  const buildBtn = content.querySelector('[onclick*="buildProject"]');
  if (buildBtn) { buildBtn.disabled = true; buildBtn.textContent = '⏳ Building...'; }
  showModal('📦 Building Project', `
    <div class="empty-state">
      <div class="empty-icon" style="animation:spin 2s linear infinite">⚙️</div>
      <h3>Assembling project...</h3>
      <p>The AI is combining all task outputs into proper files with correct imports, structure, and a main entry point.</p>
      <p style="color:var(--text2);font-size:12px">This may take 30-60 seconds</p>
    </div>
  `);
  try {
    const result = await POST(`/boards/${boardId}/build`);
    closeModal();
    if (result.ok) {
      showModal('📦 Project Built!', `
        <div style="margin-bottom:12px">
          <span class="badge badge-green">✅ ${result.files.length} files created</span>
          <span style="color:var(--text2);margin-left:8px">via ${escapeHtml(result.provider || 'LLM')}</span>
        </div>
        <div style="background:var(--bg2);border-radius:6px;padding:12px;border:1px solid var(--border);max-height:300px;overflow:auto">
          ${result.files.map(f => `<div style="padding:4px 0;font-family:monospace;font-size:13px;cursor:pointer;color:var(--cyan)" onclick="closeModal();viewProjectFile(${boardId},'${escapeAttr(f.path)}')">
            📄 ${escapeHtml(f.path)} <span style="color:var(--text2);font-size:11px">(${f.size} bytes)</span>
          </div>`).join('')}
        </div>
        <div style="margin-top:12px">
          <p style="color:var(--text2);font-size:12px">📁 Saved to: <code>${escapeHtml(result.projectDir || '')}</code></p>
        </div>
        <div class="btn-group" style="margin-top:12px">
          <button class="btn btn-primary" onclick="closeModal();viewProject(${boardId})">📂 Browse Files</button>
          <button class="btn" onclick="closeModal()">Close</button>
        </div>
      `);
    } else {
      showModal('❌ Build Failed', `<p>${escapeHtml(result.error || 'Unknown error')}</p><button class="btn" onclick="closeModal()">Close</button>`);
    }
  } catch (err) {
    closeModal();
    showModal('❌ Build Error', `<p>${escapeHtml(err.message || 'Failed to build')}</p><button class="btn" onclick="closeModal()">Close</button>`);
  }
}

async function viewProject(boardId) {
  const content = document.getElementById('content');
  const data = await GET(`/boards/${boardId}/project`);
  const board = (await GET(`/boards/${boardId}`)).board;
  const title = board ? escapeHtml(board.title) : 'Project';

  if (!data.ok || !data.files || data.files.length === 0) {
    showModal('📂 No Project Files', `
      <p>${escapeHtml(data.message || 'No files found. Build the project first.')}</p>
      <div class="btn-group" style="margin-top:12px">
        <button class="btn btn-primary" onclick="closeModal();buildProject(${boardId})">📦 Build Now</button>
        <button class="btn" onclick="closeModal()">Cancel</button>
      </div>
    `);
    return;
  }

  content.innerHTML = `
    <div class="section-title">
      <span class="icon">📂</span> ${title} — Project Files
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-sm" onclick="viewBoard(${boardId})">← Board</button>
        <button class="btn btn-sm btn-primary" onclick="buildProject(${boardId})">🔄 Rebuild</button>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:250px 1fr;gap:16px;height:calc(100vh - 160px)">
      <div class="card" style="overflow:auto;margin:0;padding:8px">
        <div style="font-weight:bold;padding:8px;border-bottom:1px solid var(--border);margin-bottom:4px">📁 Files (${data.files.length})</div>
        ${data.files.map(f => `
          <div class="file-item" onclick="viewProjectFile(${boardId},'${escapeAttr(f.path)}')" style="padding:6px 8px;cursor:pointer;border-radius:4px;font-family:monospace;font-size:12px;transition:background 0.2s"
               onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background='transparent'">
            ${f.path.endsWith('.js') ? '🟨' : f.path.endsWith('.py') ? '🐍' : f.path.endsWith('.md') ? '📝' : f.path.endsWith('.json') ? '📋' : '📄'} ${escapeHtml(f.path)}
          </div>
        `).join('')}
      </div>
      <div class="card" id="file-viewer" style="overflow:auto;margin:0;padding:16px">
        <div class="empty-state"><div class="empty-icon">👈</div><h3>Select a file</h3><p>Click a file from the list to view its contents</p></div>
      </div>
    </div>
  `;
}

async function viewProjectFile(boardId, filePath) {
  const viewer = document.getElementById('file-viewer');
  if (!viewer) { await viewProject(boardId); return; }
  viewer.innerHTML = '<div style="text-align:center;padding:20px">⏳ Loading...</div>';
  try {
    const data = await GET(`/boards/${boardId}/project/file?path=${encodeURIComponent(filePath)}`);
    if (data.ok) {
      viewer.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--border)">
          <span style="font-family:monospace;font-weight:bold">${escapeHtml(filePath)}</span>
          <span style="color:var(--text2);font-size:12px">${data.content.length} chars · ${data.content.split('\\n').length} lines</span>
        </div>
        <pre style="background:var(--bg1);padding:12px;border-radius:6px;overflow:auto;font-size:12px;line-height:1.5;white-space:pre-wrap;border:1px solid var(--border);max-height:calc(100vh - 250px)">${escapeHtml(data.content)}</pre>
      `;
    } else {
      viewer.innerHTML = `<div class="empty-state"><div class="empty-icon">❌</div><h3>Error</h3><p>${escapeHtml(data.error || 'Failed to load')}</p></div>`;
    }
  } catch (err) {
    viewer.innerHTML = `<div class="empty-state"><div class="empty-icon">❌</div><h3>Error</h3><p>${escapeHtml(err.message)}</p></div>`;
  }
}

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

// ===================== CONGRESS (LLM PARLIAMENT) =====================
async function renderArena(el) {
  const [history, stats, congressHistory] = await Promise.allSettled([
    GET('/arena/history'), GET('/arena/stats'), GET('/congress/history'),
  ]);
  const battles = history.status === 'fulfilled' ? history.value : [];
  const winStats = stats.status === 'fulfilled' ? stats.value : {};
  const congresses = congressHistory.status === 'fulfilled' ? congressHistory.value : [];

  const statsCards = Object.entries(winStats).map(([prov, s]) =>
    `<div class="card" style="text-align:center;padding:12px">
      <div style="font-size:14px;font-weight:bold;color:var(--cyan)">${escapeHtml(prov)}</div>
      <div style="font-size:24px;font-weight:bold;color:var(--green)">${s.winRate}%</div>
      <div style="font-size:11px;color:var(--text2)">${s.wins}/${s.battles} wins</div>
    </div>`
  ).join('');

  // Recent congress sessions
  const recentCongress = congresses.slice(0, 5).map(b => {
    const ranked = b.votes?.ranked || [];
    const medals = ['🏆', '🥈', '🥉'];
    return `<div class="card" style="padding:10px;margin-bottom:8px;cursor:pointer" onclick="viewCongress(${b.id})">
      <div style="font-size:12px;color:var(--text2);margin-bottom:6px">${escapeHtml(b.prompt.substring(0, 100))}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">${ranked.slice(0, 4).map((r, i) =>
        `<span class="badge ${i === 0 ? 'badge-green' : ''}">${medals[i] || ''} ${escapeHtml(r.displayName || r.provider)} <span style="opacity:0.7">${r.avgScore}/100</span></span>`
      ).join('')}</div>
      <div style="font-size:10px;color:var(--text2);margin-top:4px">${b.created_at || ''}</div>
    </div>`;
  }).join('');

  // Recent arena battles
  const recentBattles = battles.filter(b => b.mode !== 'congress').slice(0, 5).map(b => {
    const providers = Object.keys(b.responses);
    return `<div class="card" style="padding:10px;margin-bottom:8px">
      <div style="font-size:12px;color:var(--text2);margin-bottom:4px">${escapeHtml(b.prompt.substring(0, 80))}</div>
      <div style="display:flex;gap:6px">${providers.map(p =>
        `<span class="badge ${b.winner === p ? 'badge-green' : ''}">${escapeHtml(p)}${b.winner === p ? ' 👑' : ''}</span>`
      ).join('')}</div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="section-title"><span class="icon">🏛️</span> Congress <span class="badge badge-blue">LLM Parliament</span></div>

    <div class="card" style="margin-bottom:16px">
      <h3 style="margin-bottom:4px">🏛️ New Congress Session</h3>
      <p style="font-size:12px;color:var(--text2);margin-bottom:8px">All enabled LLMs respond, then each votes on others' answers. Best response wins automatically.</p>
      <textarea id="congress-prompt" class="input" rows="3" placeholder="Ask all LLMs a question... e.g. 'How should I build a REST API for this project?'" style="width:100%;margin-bottom:8px"></textarea>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" onclick="startCongress()">🏛️ Start Congress</button>
        <button class="btn" onclick="startBattle()">⚔️ Quick Arena (3 LLMs, manual vote)</button>
      </div>
    </div>

    ${statsCards ? `<div class="section-title" style="font-size:14px">📊 Provider Win Rates</div><div class="grid grid-4" style="margin-bottom:16px">${statsCards}</div>` : ''}
    ${recentCongress ? `<div class="section-title" style="font-size:14px">🏛️ Recent Congress Sessions</div>${recentCongress}` : ''}
    ${recentBattles ? `<div class="section-title" style="font-size:14px">⚔️ Recent Arena Battles</div>${recentBattles}` : ''}`;
}

async function startCongress() {
  const prompt = document.getElementById('congress-prompt')?.value?.trim();
  if (!prompt) return showToast('Enter a prompt first', 'warn');
  showToast('Congress in session — collecting proposals from all LLMs...', 'info');
  try {
    const result = await POST('/congress', { prompt });
    showCongressResult(result);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function showCongressResult(result) {
  const ranked = result.ranked || [];
  const medals = ['🏆', '🥈', '🥉'];

  // Response cards ranked by score
  const cards = ranked.map((r, i) => {
    const resp = result.responses[r.provider];
    const medal = medals[i] || `#${i + 1}`;
    const isWinner = i === 0;
    const reply = resp?.reply || resp?.error || 'No response';
    const voters = r.voters || [];

    return `<div class="card" style="flex:1;min-width:280px;border:${isWinner ? '2px solid var(--green)' : '1px solid var(--border)'}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-size:16px">${medal} <strong style="color:${isWinner ? 'var(--green)' : 'var(--cyan)'}">${escapeHtml(r.displayName || r.provider)}</strong></span>
        <span class="badge ${isWinner ? 'badge-green' : ''}" style="font-size:14px">${r.avgScore}/100</span>
      </div>
      <div style="font-size:13px;color:var(--text1);white-space:pre-wrap;max-height:250px;overflow:auto;margin-bottom:8px">${resp?.error ? `<span style="color:var(--pink)">Error: ${escapeHtml(resp.error)}</span>` : escapeHtml(reply.substring(0, 800))}${reply.length > 800 ? '...' : ''}</div>
      <div style="font-size:11px;color:var(--text2);border-top:1px solid var(--border);padding-top:6px">
        <strong>Votes received:</strong><br>
        ${voters.map(v => `${escapeHtml(v.voterName)}: <strong>${v.score}</strong>/100 — <em>${escapeHtml(v.reason || '')}</em>`).join('<br>')}
      </div>
      ${resp?.latency ? `<div style="font-size:10px;color:var(--text2);margin-top:4px">${resp.latency}ms · ${escapeHtml(resp.model || '')}</div>` : ''}
    </div>`;
  }).join('');

  // Vote matrix table
  const allVotes = result.votes || {};
  const providers = ranked.map(r => r.provider);
  let matrix = '<table style="width:100%;font-size:11px;border-collapse:collapse;margin-top:8px"><tr><th style="padding:4px;border:1px solid var(--border)">Voter ↓ / Target →</th>';
  for (const p of providers) matrix += `<th style="padding:4px;border:1px solid var(--border);color:var(--cyan)">${escapeHtml(p)}</th>`;
  matrix += '</tr>';
  for (const voter of providers) {
    matrix += `<tr><td style="padding:4px;border:1px solid var(--border);font-weight:bold">${escapeHtml(voter)}</td>`;
    for (const target of providers) {
      if (voter === target) {
        matrix += '<td style="padding:4px;border:1px solid var(--border);text-align:center;color:var(--text2)">—</td>';
      } else {
        const vote = allVotes[voter]?.[target];
        const score = vote?.score ?? '—';
        const color = typeof score === 'number' ? (score >= 80 ? 'var(--green)' : score >= 50 ? 'var(--yellow)' : 'var(--pink)') : 'var(--text2)';
        matrix += `<td style="padding:4px;border:1px solid var(--border);text-align:center;color:${color};font-weight:bold" title="${escapeHtml(vote?.reason || '')}">${score}</td>`;
      }
    }
    matrix += '</tr>';
  }
  matrix += '</table>';

  showWideModal('🏛️ Congress Results', `
    <div style="background:var(--bg2);padding:8px;border-radius:6px;margin-bottom:12px;font-size:12px;color:var(--text2)"><strong>Prompt:</strong> ${escapeHtml(result.prompt)}</div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">${cards}</div>
    <div class="card" style="padding:12px">
      <h4 style="margin-bottom:4px">📊 Vote Matrix</h4>
      <p style="font-size:11px;color:var(--text2);margin-bottom:8px">Hover scores to see reasons. Each LLM rated all others (skipped itself).</p>
      ${matrix}
    </div>
    <div style="margin-top:12px;display:flex;gap:8px">
      <button class="btn btn-primary" onclick="executeCongress(${result.id})">✅ Execute Winner's Plan</button>
      <button class="btn" onclick="closeModal()">Close</button>
    </div>
  `);
}

async function executeCongress(id) {
  showToast('Executing winning plan...', 'info');
  try {
    const result = await POST(`/congress/${id}/execute`, {});
    closeModal();
    showWideModal('✅ Execution Result', `
      <div style="font-size:12px;color:var(--text2);margin-bottom:8px">Executed by: <strong>${escapeHtml(result.provider || '')}</strong></div>
      <div style="font-size:13px;color:var(--text1);white-space:pre-wrap;max-height:500px;overflow:auto">${escapeHtml(result.text || '')}</div>
    `);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function viewCongress(id) {
  try {
    const battle = await GET(`/congress/${id}`);
    showCongressResult({
      id: battle.id,
      prompt: battle.prompt,
      responses: battle.responses,
      votes: battle.votes?.allVotes || {},
      ranked: battle.votes?.ranked || [],
      winner: battle.winner,
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function startBattle() {
  const prompt = document.getElementById('congress-prompt')?.value?.trim();
  if (!prompt) return showToast('Enter a prompt first', 'warn');
  showToast('Battle starting...', 'info');
  try {
    const result = await POST('/arena/battle', { prompt });
    showArenaBattle(result);
  } catch (err) {
    showToast(err.message, 'error');
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
  showToast(`Voted for ${winner}!`, 'success');
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

// ===================== SELF-IMPROVE =====================
let selfImproveHistory = [];

async function renderSelfImprove(el) {
  // Load history
  try { selfImproveHistory = await GET('/self-improve/history'); } catch { selfImproveHistory = []; }

  el.innerHTML = `
    <div class="section-header">
      <h2>🧬 Self-Improve</h2>
      <p class="section-desc">Describe a feature or bug fix. The LLM will read all source files and apply changes automatically.</p>
    </div>

    <!-- Chat Interface -->
    <div class="card" style="margin-bottom:16px">
      <div class="card-header" style="display:flex;align-items:center;gap:8px">
        <div class="card-title" style="margin:0">💬 Request</div>
        <div style="margin-left:auto">
          <button class="btn btn-xs" style="background:var(--bg3);font-size:11px" onclick="clearSelfImproveHistory()">Clear History</button>
        </div>
      </div>

      <div id="si-messages" style="min-height:120px;max-height:500px;overflow-y:auto;padding:8px 0">
        ${selfImproveHistory.length > 0
          ? selfImproveHistory.slice().reverse().map(h => {
              const files = h.files_changed || [];
              const date = new Date(h.created_at).toLocaleString();
              return `
                <div style="padding:10px 12px;margin:4px 0;border-radius:6px;background:var(--bg3);border-left:3px solid var(--orange)">
                  <div style="display:flex;justify-content:space-between;align-items:center">
                    <div style="font-size:11px;color:var(--text2);font-weight:600">👤 You</div>
                    <div style="font-size:10px;color:var(--text3)">${escapeHtml(date)}</div>
                  </div>
                  <div style="font-size:13px;margin-top:4px">${escapeHtml(h.request.substring(0, 200))}</div>
                </div>
                <div style="padding:10px 12px;margin:4px 0;border-radius:6px;background:rgba(0,255,255,0.04);border-left:3px solid var(--cyan)">
                  <div style="font-size:11px;color:var(--text2);font-weight:600">🤖 AI</div>
                  ${files.length > 0
                    ? `<div style="margin-top:4px;padding:6px 10px;background:rgba(0,255,100,0.1);border-radius:4px;font-size:12px;color:var(--green)">
                        ✅ Modified ${files.length} file(s): ${files.map(f => '<code>' + escapeHtml(f) + '</code>').join(', ')}
                      </div>`
                    : `<div style="font-size:12px;color:var(--text2);margin-top:4px">No file changes</div>`}
                  ${h.provider ? `<div style="font-size:10px;color:var(--text3);margin-top:4px">via ${escapeHtml(h.provider)}</div>` : ''}
                </div>`;
            }).join('')
          : `<div style="color:var(--text2);padding:24px;text-align:center;font-size:13px">
              🧬 Tell me what to change about this bot.<br>
              I'll read all source files and apply the fix.<br><br>
              <span style="font-size:12px;color:var(--text3)">
                Examples:<br>
                "add /ping command that replies pong"<br>
                "fix the terminal button not opening"<br>
                "add export to JSON button on boards"
              </span>
            </div>`}
      </div>

      <div style="display:flex;gap:8px;padding-top:10px;border-top:1px solid var(--border)">
        <input class="input" id="si-input" placeholder="Describe feature or bug fix..."
               style="flex:1;font-size:14px;padding:10px 12px"
               onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendSelfImprove()}">
        <button class="btn btn-primary" id="si-send" onclick="sendSelfImprove()" style="padding:10px 20px;font-size:14px">🧬 Send</button>
      </div>
    </div>

    <!-- Info -->
    <div class="card" style="background:rgba(0,255,255,0.03)">
      <div style="font-size:13px;color:var(--text2);line-height:1.6">
        <b>How it works:</b><br>
        1. Your request is sent to the LLM with all <code>src/</code> files as context<br>
        2. The LLM generates modified source files<br>
        3. Changes are written to disk automatically<br>
        4. <b>Restart the bot</b> to apply changes<br><br>
        <b>Safety:</b> Only files under <code>src/</code> can be modified. Database and config files are protected.
      </div>
    </div>
  `;
}

async function sendSelfImprove() {
  const input = document.getElementById('si-input');
  const sendBtn = document.getElementById('si-send');
  const msg = input.value.trim();
  if (!msg) return;

  input.value = '';
  input.disabled = true;
  sendBtn.disabled = true;
  sendBtn.textContent = '⏳';

  const messagesDiv = document.getElementById('si-messages');
  // Remove placeholder
  const placeholder = messagesDiv.querySelector('[style*="text-align:center"]');
  if (placeholder) placeholder.remove();

  // Show user message
  messagesDiv.insertAdjacentHTML('beforeend', `
    <div style="padding:10px 12px;margin:4px 0;border-radius:6px;background:var(--bg3);border-left:3px solid var(--orange)">
      <div style="font-size:11px;color:var(--text2);font-weight:600">👤 You</div>
      <div style="font-size:13px;margin-top:4px">${escapeHtml(msg)}</div>
    </div>
    <div id="si-thinking" style="padding:10px 12px;margin:4px 0;border-radius:6px;background:rgba(0,255,255,0.04);border-left:3px solid var(--cyan)">
      <div style="font-size:11px;color:var(--text2);font-weight:600">🤖 AI</div>
      <div style="font-size:13px;color:var(--text2)"><span style="animation:spin 2s linear infinite;display:inline-block">⚙️</span> Reading source files & generating changes...</div>
    </div>`);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000); // 3 min timeout

    const res = await fetch('/api/self-improve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error(`Server returned HTML instead of JSON (HTTP ${res.status}). Try refreshing.`);
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const thinking = document.getElementById('si-thinking');
    if (thinking) {
      let html = `<div style="font-size:11px;color:var(--text2);font-weight:600">🤖 AI</div>`;
      if (data.reply) {
        html += `<div style="font-size:13px;white-space:pre-wrap;line-height:1.5;margin-top:4px">${escapeHtml(data.reply)}</div>`;
      }
      if (data.filesChanged?.length > 0) {
        html += `<div style="margin-top:8px;padding:8px 12px;background:rgba(0,255,100,0.1);border-radius:4px;font-size:12px;color:var(--green)">
          ✅ Modified ${data.filesChanged.length} file(s): ${data.filesChanged.map(f => '<code>' + escapeHtml(f) + '</code>').join(', ')}
        </div>
        <div style="margin-top:6px;font-size:11px;color:var(--yellow)">⚠️ Restart the bot to apply changes</div>`;
      }
      if (data.provider) {
        html += `<div style="font-size:10px;color:var(--text3);margin-top:4px">via ${escapeHtml(data.provider)} — scanned ${data.totalFiles || '?'} files</div>`;
      }
      thinking.innerHTML = html;
    }
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  } catch (err) {
    const thinking = document.getElementById('si-thinking');
    if (thinking) {
      thinking.innerHTML = `
        <div style="font-size:11px;color:var(--text2);font-weight:600">🤖 AI</div>
        <div style="font-size:13px;color:var(--red);margin-top:4px">❌ Error: ${escapeHtml(err.message)}</div>`;
    }
  }

  input.disabled = false;
  sendBtn.disabled = false;
  sendBtn.textContent = '🧬 Send';
  input.focus();
}

async function clearSelfImproveHistory() {
  if (!confirm('Clear all self-improvement history?')) return;
  try {
    await POST('/self-improve/clear');
    renderSelfImprove(document.getElementById('content'));
  } catch (err) {
    showToast('❌', err.message);
  }
}

// ===================== GIT REPOS =====================
let gitRepoPollInterval = null;

async function renderGitRepos(el) {
  let repos = [];
  try {
    repos = await GET('/git-repos');
    if (!Array.isArray(repos)) repos = [];
  } catch (err) {
    el.innerHTML = `
      <div class="section-title"><span class="icon">📚</span> Git Repos</div>
      <div class="card" style="text-align:center;padding:40px">
        <div style="color:var(--red)">❌ Failed to load repos: ${escapeHtml(err.message)}</div>
        <p style="color:var(--text3);margin-top:8px">Make sure the dashboard server is restarted after the update.</p>
        <button class="btn" style="background:var(--cyan);color:#000;margin-top:12px" onclick="renderGitRepos(document.getElementById('content'))">🔄 Retry</button>
      </div>`;
    return;
  }

  const typeIcons = { node: '🟢', python: '🐍', rust: '🦀', go: '🔵', unknown: '📦' };
  const statusColors = { cloned: 'green', running: 'cyan', cloning: 'orange', error: 'red' };

  el.innerHTML = `
    <div class="section-title">
      <span class="icon">📚</span> Git Repos
      <button class="btn" style="background:var(--cyan);color:#000;margin-left:auto;font-size:12px" onclick="promptCloneRepo()">+ Clone Repo</button>
    </div>
    ${repos.length === 0 ? `
      <div class="card" style="text-align:center;padding:40px">
        <div style="font-size:48px;margin-bottom:16px">📚</div>
        <h3 style="color:var(--text1)">No Git Repos Yet</h3>
        <p style="color:var(--text3);margin:12px 0">Clone a repo from GitHub, GitLab, or any Git URL</p>
        <button class="btn" style="background:var(--cyan);color:#000" onclick="promptCloneRepo()">📥 Clone Your First Repo</button>
      </div>
    ` : repos.map(r => `
        <div class="card" style="cursor:pointer;margin-bottom:8px" onclick="viewGitRepo(${r.id})">
          <div style="display:flex;justify-content:space-between;align-items:flex-start">
            <div style="flex:1;min-width:0">
              <div style="font-weight:700;font-size:14px;color:var(--text1)">${typeIcons[r.project_type] || '📦'} ${escapeHtml(r.name)}</div>
              <div style="font-size:11px;color:var(--text3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.url)}</div>
              ${r.readme_summary ? `<div style="font-size:12px;color:var(--text2);margin-top:6px">${escapeHtml(r.readme_summary).substring(0, 100)}</div>` : ''}
              ${(r.skills || []).length > 0 ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${r.skills.slice(0, 5).map(s => `<span style="font-size:10px;padding:2px 6px;background:rgba(99,102,241,0.2);color:var(--purple);border-radius:4px">${escapeHtml(s)}</span>`).join('')}</div>` : ''}
            </div>
            <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end;margin-left:8px">
              <span style="font-size:10px;padding:2px 8px;border-radius:4px;background:var(--${statusColors[r.status] || 'blue'});color:#000;font-weight:600">${r._running ? '● Running' : r.status}</span>
              ${r._running && (r._port || r.port) ? `<a href="http://localhost:${r._port || r.port}" target="_blank" style="font-size:11px;color:var(--cyan);text-decoration:none" onclick="event.stopPropagation()">🌐 localhost:${r._port || r.port}</a>` : ''}
              <div style="display:flex;gap:4px">
                <button class="btn" style="font-size:11px;padding:2px 8px;background:${r._running ? 'var(--red)' : 'var(--green)'};color:#000" onclick="event.stopPropagation();toggleGitRepo(${r.id},${r._running})">${r._running ? '⏹' : '▶️'}</button>
                <button class="btn" style="font-size:11px;padding:2px 8px;background:var(--surface2)" onclick="event.stopPropagation();deleteGitRepo(${r.id})">🗑</button>
              </div>
            </div>
          </div>
        </div>
      `).join('')}`;
}

async function viewGitRepo(id) {
  if (gitRepoPollInterval) { clearInterval(gitRepoPollInterval); gitRepoPollInterval = null; }
  let repo;
  try {
    repo = await GET(`/git-repos/${id}`);
  } catch (err) {
    showToast('❌', err.message);
    return;
  }
  if (!repo) return;
  const el = document.getElementById('content');
  const typeNames = { node: '🟢 Node.js', python: '🐍 Python', rust: '🦀 Rust', go: '🔵 Go', unknown: '📦 Unknown' };

  const portNum = repo._port || repo.port;
  const runningBadge = repo._running
    ? `<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 12px;background:rgba(34,197,94,0.15);border:1px solid var(--green);border-radius:20px;font-size:12px;color:var(--green);font-weight:600">
        <span style="width:8px;height:8px;border-radius:50%;background:var(--green);animation:pulse 1.5s infinite"></span> Running${portNum ? ` on :${portNum}` : ''}
       </span>`
    : `<span style="padding:4px 12px;background:rgba(148,163,184,0.1);border:1px solid var(--border);border-radius:20px;font-size:12px;color:var(--text2)">● Stopped</span>`;

  el.innerHTML = `
    <div class="section-title">
      <span class="icon">📚</span> ${escapeHtml(repo.name)}
      <button class="btn" style="font-size:12px;margin-left:auto" onclick="renderGitRepos(document.getElementById('content'))">◀️ Back</button>
    </div>

    <!-- Introduction Card -->
    <div class="card" style="border-left:3px solid var(--cyan);padding:20px 24px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
            <span style="font-size:24px">${typeNames[repo.project_type]?.split(' ')[0] || '📦'}</span>
            <div>
              <h2 style="font-size:20px;font-weight:700;color:var(--text1);margin:0">${escapeHtml(repo.name)}</h2>
              <a href="${escapeHtml(repo.url)}" target="_blank" style="font-size:11px;color:var(--text3);text-decoration:none">${escapeHtml(repo.url)}</a>
            </div>
            ${runningBadge}
          </div>
          ${repo.readme_summary ? `<p style="font-size:14px;color:var(--text2);margin:10px 0 0;line-height:1.5">📝 ${escapeHtml(repo.readme_summary)}</p>` : ''}
          ${(repo.skills || []).length > 0 ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:10px">${repo.skills.map(s => `<span style="font-size:10px;padding:3px 8px;background:rgba(99,102,241,0.15);color:var(--purple);border-radius:12px;border:1px solid rgba(99,102,241,0.2)">${escapeHtml(s)}</span>`).join('')}</div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;flex-shrink:0">
          ${repo._running
            ? `<button class="btn" style="background:var(--red);color:#fff;font-size:14px;padding:10px 24px;font-weight:700" onclick="toggleGitRepo(${id},true)">⏹ Stop</button>
               ${portNum ? `<a href="http://localhost:${portNum}" target="_blank" class="btn" style="background:var(--cyan);color:#000;text-decoration:none;font-size:13px;padding:8px 20px;font-weight:600">🌐 Open localhost:${portNum}</a>` : ''}`
            : `<button class="btn" style="background:var(--green);color:#000;font-size:14px;padding:10px 24px;font-weight:700" onclick="toggleGitRepo(${id},false)">▶️ Run Project</button>`
          }
        </div>
      </div>
    </div>

    <!-- How to Run + Actions -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px">
      <div class="card">
        <h3 style="color:var(--cyan);margin-bottom:12px">🖥️ How to Run</h3>
        <div style="font-size:13px;color:var(--text2);line-height:2">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:10px;padding:2px 8px;background:var(--purple);color:#fff;border-radius:4px;font-weight:700">1</span>
            <span>Open terminal in:</span>
          </div>
          <code style="display:block;background:var(--surface2);padding:8px 12px;border-radius:6px;margin:4px 0 8px 28px;font-size:12px;color:var(--text1);cursor:pointer;user-select:all" title="Click to copy">${escapeHtml(repo.clone_dir)}</code>

          ${repo.install_cmd ? `
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:10px;padding:2px 8px;background:var(--purple);color:#fff;border-radius:4px;font-weight:700">2</span>
            <span>Install dependencies:</span>
          </div>
          <code style="display:block;background:var(--surface2);padding:8px 12px;border-radius:6px;margin:4px 0 8px 28px;font-size:12px;color:var(--green);cursor:pointer;user-select:all" title="Click to copy">${escapeHtml(repo.install_cmd)}</code>
          ` : ''}

          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:10px;padding:2px 8px;background:var(--purple);color:#fff;border-radius:4px;font-weight:700">${repo.install_cmd ? '3' : '2'}</span>
            <span>Run the project:</span>
          </div>
          <code style="display:block;background:var(--surface2);padding:8px 12px;border-radius:6px;margin:4px 0 8px 28px;font-size:12px;color:var(--green);cursor:pointer;user-select:all" title="Click to copy">${escapeHtml(repo.run_cmd || 'N/A')}</code>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn" style="background:var(--cyan);color:#000;font-size:12px" onclick="openGitRepoTerminal(${id})">🖥️ Open Terminal</button>
          <button class="btn" style="background:var(--yellow);color:#000;font-size:12px" onclick="openGitRepoFolder(${id})">📂 Open Folder</button>
        </div>
      </div>

      <div class="card" id="git-actions-card">
        <h3 style="color:var(--cyan);margin-bottom:12px">⚡ Actions</h3>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          <button class="btn" style="background:var(--purple);color:#000" onclick="pullGitRepo(${id})">🔄 Git Pull</button>
          <button class="btn" style="background:var(--orange,#f97316);color:#000" onclick="reanalyzeGitRepo(${id})">🔍 Re-analyze</button>
          <button class="btn" style="background:var(--red);color:#000" onclick="deleteGitRepo(${id})">🗑 Delete</button>
        </div>
        <div style="margin-top:16px;font-size:13px;color:var(--text2);line-height:1.8">
          <div>📦 Type: ${typeNames[repo.project_type] || repo.project_type}</div>
          <div style="font-size:11px;color:var(--text3);margin-top:4px">📁 ${escapeHtml(repo.clone_dir)}</div>
          <div style="font-size:11px;color:var(--text3)">📅 Cloned: ${new Date(repo.created_at).toLocaleDateString()}</div>
        </div>
      </div>
    </div>

    <!-- Logs -->
    <div class="card" style="margin-top:16px">
      <h3 style="color:var(--cyan);margin-bottom:12px">📋 Logs</h3>
      <pre id="git-run-logs" style="background:var(--surface1);color:var(--text2);padding:12px;border-radius:8px;max-height:400px;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-word">${repo._running ? 'Loading logs...' : 'Click ▶️ Run Project to start'}</pre>
    </div>`;

  // Load existing logs and start polling
  loadGitRepoLogs(id);
  gitRepoPollInterval = setInterval(() => loadGitRepoLogs(id), 2000);
}

async function loadGitRepoLogs(id) {
  try {
    const data = await GET(`/git-repos/${id}/logs`);
    const el = document.getElementById('git-run-logs');
    if (el && data.logs && data.logs.trim()) {
      el.textContent = data.logs;
      el.scrollTop = el.scrollHeight;
    }
    if (!data.running && gitRepoPollInterval) {
      // Keep polling for a bit in case auto-fix restarts
      const phase = data.phase;
      if (phase !== 'installing') {
        // Actually stopped
      }
    }
  } catch {}
}

function promptCloneRepo() {
  const el = document.getElementById('content');
  const existing = el.innerHTML;
  // Create modal overlay
  const modal = document.createElement('div');
  modal.id = 'clone-modal';
  modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:1000';
  modal.innerHTML = `
    <div style="background:var(--surface1);border:1px solid var(--border);border-radius:12px;padding:24px;width:500px;max-width:90vw">
      <h3 style="color:var(--cyan);margin-bottom:16px">📥 Clone Git Repo</h3>
      <input id="clone-url-input" class="input" style="width:100%;padding:10px;background:var(--surface2);border:1px solid var(--border);color:var(--text1);border-radius:8px;font-size:14px" placeholder="https://github.com/user/repo" autofocus>
      <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
        <button class="btn" style="background:var(--surface2)" onclick="document.getElementById('clone-modal').remove()">Cancel</button>
        <button class="btn" style="background:var(--cyan);color:#000" onclick="cloneGitRepo()">📥 Clone</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  setTimeout(() => document.getElementById('clone-url-input')?.focus(), 100);
  // Enter key
  document.getElementById('clone-url-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') cloneGitRepo();
  });
}

async function cloneGitRepo() {
  const input = document.getElementById('clone-url-input');
  const url = input?.value?.trim();
  if (!url) return;
  document.getElementById('clone-modal')?.remove();

  showToast('📥', 'Cloning repo...');
  try {
    const res = await fetch('/api/git-repos/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (data.status === 'exists') {
      showToast('📚', 'Repo already tracked!');
    } else {
      showToast('✅', 'Clone started! Refresh in a moment...');
    }
    // Refresh after a delay to let clone finish
    setTimeout(() => renderGitRepos(document.getElementById('content')), 5000);
    // Keep checking
    setTimeout(() => renderGitRepos(document.getElementById('content')), 15000);
    setTimeout(() => renderGitRepos(document.getElementById('content')), 30000);
  } catch (err) {
    showToast('❌', err.message);
  }
}

async function toggleGitRepo(id, isRunning) {
  try {
    if (isRunning) {
      await POST(`/git-repos/${id}/stop`);
      showToast('⏹', 'Stopped');
    } else {
      await POST(`/git-repos/${id}/run`);
      showToast('▶️', 'Starting...');
    }
    // Refresh view
    if (document.getElementById('git-run-logs')) {
      viewGitRepo(id);
    } else {
      setTimeout(() => renderGitRepos(document.getElementById('content')), 1000);
    }
  } catch (err) {
    showToast('❌', err.message);
  }
}

async function deleteGitRepo(id) {
  if (!confirm('Delete this repo? This removes it from tracking.')) return;
  try {
    await fetch(`/api/git-repos/${id}`, { method: 'DELETE' });
    showToast('🗑', 'Deleted');
    renderGitRepos(document.getElementById('content'));
  } catch (err) {
    showToast('❌', err.message);
  }
}

async function pullGitRepo(id) {
  showToast('🔄', 'Pulling...');
  try {
    const res = await POST(`/git-repos/${id}/pull`);
    showToast(res.ok ? '✅' : '⚠️', res.ok ? 'Pull complete' : (res.stderr || 'Pull had issues'));
  } catch (err) {
    showToast('❌', err.message);
  }
}

async function reanalyzeGitRepo(id) {
  showToast('🔍', 'Re-analyzing repo with LLM...');
  try {
    const res = await POST(`/git-repos/${id}/reanalyze`);
    if (res.ok) {
      showToast('✅', `Detected: ${res.runCmd || 'N/A'}`);
      viewGitRepo(id); // refresh the view
    } else {
      showToast('❌', res.error || 'Re-analysis failed');
    }
  } catch (err) {
    showToast('❌', err.message);
  }
}

async function openGitRepoTerminal(id) {
  try {
    await POST(`/git-repos/${id}/open-terminal`);
    showToast('🖥️', 'Terminal opened');
  } catch (err) {
    showToast('❌', err.message);
  }
}

async function openGitRepoFolder(id) {
  try {
    await POST(`/git-repos/${id}/open-folder`);
    showToast('📂', 'Folder opened');
  } catch (err) {
    showToast('❌', err.message);
  }
}
