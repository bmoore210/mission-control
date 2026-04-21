const DEFAULTS = window.MISSION_CONTROL_DEFAULTS || {};

const VIEWS = [
  { id: 'overview', label: 'Overview', hint: 'KPIs, watchlists, and current queue' },
  { id: 'agents', label: 'Agents', hint: 'Fleet status and per-agent drill-down' },
  { id: 'topology', label: 'Topology', hint: 'Org chart, roles, and working relationships' },
  { id: 'schedule', label: 'Schedule', hint: 'Upcoming calendar and proactive work' },
  { id: 'tasks', label: 'Tasks', hint: 'Priority queue with pagination' },
  { id: 'inbox', label: 'Inbox', hint: 'Peer channel and thread inspection' },
  { id: 'activity', label: 'Activity', hint: 'Paginated event log with filters' },
  { id: 'tokens', label: 'Tokens', hint: 'Claude token telemetry and playbook' },
];

const state = {
  view: location.hash.replace('#', '') || 'overview',
  live: true,
  refreshMs: 5000,
  taskStatus: 'open',
  scheduleWindowHours: 48,
  config: {
    supabaseUrl: localStorage.getItem('mission-control.supabaseUrl') || DEFAULTS.supabaseUrl || '',
    supabaseAnonKey: localStorage.getItem('mission-control.supabaseAnonKey') || DEFAULTS.supabaseAnonKey || '',
  },
  page: {
    tasks: 0,
    inbox: 0,
    activity: 0,
  },
  selected: null,
  tokenSnapshot: loadStoredTokenSnapshot(),
  orgChart: loadOrgChart(),
};

let refreshHandle = null;

const els = {
  nav: document.getElementById('nav'),
  toolbar: document.getElementById('toolbar'),
  metrics: document.getElementById('metrics'),
  listTitle: document.getElementById('listTitle'),
  listActions: document.getElementById('listActions'),
  listContent: document.getElementById('listContent'),
  detailContent: document.getElementById('detailContent'),
  detailActions: document.getElementById('detailActions'),
  pager: document.getElementById('pager'),
  viewTitle: document.getElementById('viewTitle'),
  refreshPill: document.getElementById('refreshPill'),
  connectionPill: document.getElementById('connectionPill'),
  liveToggle: document.getElementById('liveToggle'),
  refreshMs: document.getElementById('refreshMs'),
  refreshNow: document.getElementById('refreshNow'),
  openConfig: document.getElementById('openConfig'),
  configDialog: document.getElementById('configDialog'),
  configForm: document.getElementById('configForm'),
  supabaseUrlInput: document.getElementById('supabaseUrlInput'),
  supabaseAnonKeyInput: document.getElementById('supabaseAnonKeyInput'),
  clearConfig: document.getElementById('clearConfig'),
};

function loadStoredTokenSnapshot() {
  try {
    const raw = localStorage.getItem('mission-control.tokenSnapshot');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function loadOrgChart() {
  try {
    const raw = localStorage.getItem('mission-control.orgChart');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveOrgChart(chart) {
  if (chart) {
    localStorage.setItem('mission-control.orgChart', JSON.stringify(chart));
  } else {
    localStorage.removeItem('mission-control.orgChart');
  }
}

function saveTokenSnapshot(snapshot) {
  state.tokenSnapshot = snapshot;
  if (snapshot) {
    localStorage.setItem('mission-control.tokenSnapshot', JSON.stringify(snapshot));
  } else {
    localStorage.removeItem('mission-control.tokenSnapshot');
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtNum(value) {
  return new Intl.NumberFormat('en-US').format(Number(value || 0));
}

function fmtShort(value) {
  const num = Number(value || 0);
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return String(num);
}

function relTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.round(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

function statusClass(value) {
  const lower = String(value || '').toLowerCase();
  if (lower.includes('error') || lower.includes('failed')) return 'err';
  if (lower.includes('warn') || lower.includes('review') || lower.includes('unread')) return 'warn';
  if (lower.includes('ok') || lower.includes('active') || lower.includes('read')) return 'ok';
  return '';
}

function buildNav() {
  els.nav.innerHTML = VIEWS.map((view) => `
    <button data-view="${view.id}" class="${state.view === view.id ? 'active' : ''}">
      <span class="label">${view.label}</span>
      <span class="hint">${view.hint}</span>
    </button>
  `).join('');
  els.nav.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', () => {
      state.view = button.dataset.view;
      location.hash = state.view;
      state.selected = null;
      render();
    });
  });
}

function normalizeView() {
  if (!VIEWS.some((entry) => entry.id === state.view)) {
    state.view = 'overview';
    location.hash = state.view;
  }
}

function updateHeader() {
  const view = VIEWS.find((entry) => entry.id === state.view) || VIEWS[0];
  els.viewTitle.textContent = view.label;
  const configured = Boolean(state.config.supabaseUrl && state.config.supabaseAnonKey);
  els.connectionPill.textContent = configured ? 'supabase configured' : 'config needed';
  els.connectionPill.className = `pill ${configured ? 'ok' : 'warn'}`;
  els.refreshPill.textContent = state.live ? `live ${state.refreshMs}ms` : 'refresh paused';
  els.refreshPill.className = `pill ${state.live ? 'ok' : 'warn'}`;
}

function configureRefreshLoop() {
  if (refreshHandle) clearInterval(refreshHandle);
  if (!state.live) return;
  refreshHandle = setInterval(() => {
    if (document.visibilityState === 'visible') render();
  }, state.refreshMs);
}

function configReady() {
  return Boolean(state.config.supabaseUrl && state.config.supabaseAnonKey);
}

async function sbFetch(pathWithQuery) {
  const base = state.config.supabaseUrl.replace(/\/$/, '');
  const url = `${base}/rest/v1/${pathWithQuery}`;
  const response = await fetch(url, {
    headers: {
      apikey: state.config.supabaseAnonKey,
      Authorization: `Bearer ${state.config.supabaseAnonKey}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return response.json();
}

async function safeQuery(pathWithQuery, fallback = []) {
  try {
    return await sbFetch(pathWithQuery);
  } catch (error) {
    console.error('Mission Control query failed', pathWithQuery, error);
    return fallback;
  }
}

function renderMetrics(metrics) {
  els.metrics.innerHTML = metrics.map((metric) => `
    <div class="metric">
      <div class="label">${escapeHtml(metric.label)}</div>
      <div class="value">${escapeHtml(metric.value)}</div>
      <div class="meta">${escapeHtml(metric.meta || '')}</div>
    </div>
  `).join('');
}

function setPager({ page = 0, hasPrev = false, hasNext = false, onPrev = null, onNext = null, note = '' } = {}) {
  els.pager.innerHTML = `
    <span class="muted">${escapeHtml(note)}</span>
    <button class="secondary" ${hasPrev ? '' : 'disabled'} id="pagerPrev">Prev</button>
    <span class="muted">page ${page + 1}</span>
    <button class="secondary" ${hasNext ? '' : 'disabled'} id="pagerNext">Next</button>
  `;
  const prev = document.getElementById('pagerPrev');
  const next = document.getElementById('pagerNext');
  if (prev && onPrev) prev.addEventListener('click', onPrev);
  if (next && onNext) next.addEventListener('click', onNext);
}

function setDetail(html, actionsHtml = '') {
  els.detailContent.classList.remove('empty-state');
  els.detailContent.innerHTML = html;
  els.detailActions.innerHTML = actionsHtml;
}

function clearDetail(message = 'Select an item to inspect details, history, and next actions.') {
  els.detailActions.innerHTML = '';
  els.detailContent.className = 'panel-body detail-body empty-state';
  els.detailContent.textContent = message;
}

function renderToolbar(html) {
  els.toolbar.innerHTML = html;
}

async function renderOverview() {
  els.listTitle.textContent = 'Overview';
  els.listActions.innerHTML = '';
  clearDetail('Overview summarizes what needs attention now. Click into agents, tasks, inbox, activity, or tokens for drill-down.');

  if (!configReady()) {
    renderToolbar('<div class="callout">Set your Supabase URL + anon key to unlock live data.</div>');
    renderMetrics([
      { label: 'Supabase', value: 'Not configured', meta: 'Use the config dialog in the sidebar.' },
      { label: 'Token snapshot', value: state.tokenSnapshot ? 'Loaded' : 'Missing', meta: 'Upload a generated token snapshot in the Tokens view.' },
    ]);
    els.listContent.innerHTML = '<div class="empty-state">Mission Control v1 is ready, but it needs a Supabase URL + anon key to start pulling live operations data.</div>';
    setPager();
    return;
  }

  renderToolbar('<div class="field"><span class="muted">Overview is live. Use the left nav to drill into queues and telemetry.</span></div>');

  const [agents, inbox, tasks, activity, messages] = await Promise.all([
    safeQuery('agent_status_now?select=*&order=last_event_at.desc', []),
    safeQuery('agent_inbox?select=*', []),
    safeQuery('tasks?select=id,title,priority,status,due_at&status=neq.completed&order=priority.asc,due_at.asc&limit=8', []),
    safeQuery('agent_live_feed?select=*&limit=12', []),
    safeQuery('agent_messages?select=id,thread_id,from_agent,to_agent,kind,state,created_at,body&state=eq.unread&order=created_at.desc&limit=8', []),
  ]);

  const unreadTotal = inbox.reduce((sum, row) => sum + Number(row.unread || 0), 0);
  const errors24h = agents.reduce((sum, row) => sum + Number(row.errors_last_24h || 0), 0);
  const tokenTotals = state.tokenSnapshot?.totals;

  renderMetrics([
    { label: 'Active agents', value: String(agents.filter((row) => row.active_last_2min).length), meta: `${agents.length} total tracked` },
    { label: 'Unread inbox', value: String(unreadTotal), meta: messages.length ? `${messages.length} recent unread shown` : 'No unread rows returned' },
    { label: 'Open tasks', value: String(tasks.length), meta: 'Top priority tasks only' },
    { label: 'Errors 24h', value: String(errors24h), meta: 'Aggregated from agent_status_now' },
    { label: 'Token input', value: tokenTotals ? fmtShort(tokenTotals.input_tokens) : '—', meta: tokenTotals ? 'From local Claude logs' : 'Load token snapshot' },
    { label: 'Cache read', value: tokenTotals ? fmtShort(tokenTotals.cache_read_input_tokens) : '—', meta: tokenTotals ? 'Large reread = long-lived sessions' : 'Load token snapshot' },
  ]);

  const tokenInsight = state.tokenSnapshot?.insights?.slice(0, 2) || [];
  const cards = [
    summaryCard('Watchlist: unread threads', messages.map((row) => `${row.from_agent} → ${row.to_agent} · ${row.kind} · ${relTime(row.created_at)}`)),
    summaryCard('Top tasks', tasks.map((row) => `${row.priority || 3} · ${row.title || 'Untitled task'}${row.due_at ? ` · due ${relTime(row.due_at)}` : ''}`)),
    summaryCard('Recent activity', activity.map((row) => `${row.agent_id} · ${row.event}${row.tool_name ? ` · ${row.tool_name}` : ''} · ${row.ts || ''}`)),
    summaryCard('Token hygiene', tokenInsight.length ? tokenInsight : ['Check /context in fresh sessions.', 'Compact earlier and delegate more.']),
  ];
  els.listContent.innerHTML = cards.join('');
  setPager({ note: 'Overview is intentionally summary-first to avoid flooding the UI.' });
}

function summaryCard(title, lines) {
  const items = (lines || []).slice(0, 8).map((line) => `<li>${escapeHtml(line)}</li>`).join('') || '<li>Nothing to show.</li>';
  return `<div class="summary-card"><h3>${escapeHtml(title)}</h3><ul class="mini-list">${items}</ul></div>`;
}

async function renderAgents() {
  els.listTitle.textContent = 'Agents';
  els.listActions.innerHTML = '';
  renderToolbar(`
    <label>
      <span>Search agent</span>
      <input id="agentSearch" type="text" placeholder="hermes, claude-code, ..." />
    </label>
  `);
  clearDetail('Choose an agent to view recent events, errors, and thread activity.');

  if (!configReady()) {
    renderMetrics([{ label: 'Agents', value: 'No config', meta: 'Set Supabase config first.' }]);
    els.listContent.innerHTML = '<div class="empty-state">Live agent state requires Supabase config.</div>';
    setPager();
    return;
  }

  const rows = await safeQuery('agent_status_now?select=*&order=last_event_at.desc', []);
  const inbox = await safeQuery('agent_inbox?select=*', []);
  const inboxMap = new Map(inbox.map((row) => [row.to_agent, row]));
  renderMetrics([
    { label: 'Tracked agents', value: String(rows.length), meta: 'From agent_status_now' },
    { label: 'Active now', value: String(rows.filter((row) => row.active_last_2min).length), meta: '2-minute activity window' },
    { label: 'Unread queues', value: String(inbox.filter((row) => Number(row.unread || 0) > 0).length), meta: 'Agents with unread messages' },
  ]);

  const renderList = (filter = '') => {
    const lower = filter.trim().toLowerCase();
    const filtered = rows.filter((row) => !lower || String(row.agent_id).toLowerCase().includes(lower));
    els.listContent.innerHTML = filtered.map((row) => {
      const inboxRow = inboxMap.get(row.agent_id) || {};
      return `
        <button class="list-item ${state.selected?.kind === 'agent' && state.selected.agent_id === row.agent_id ? 'active' : ''}" data-agent="${escapeHtml(row.agent_id)}">
          <h3>${escapeHtml(row.agent_id)}</h3>
          <div class="list-meta">
            <span class="badge ${row.active_last_2min ? 'ok' : ''}">${row.active_last_2min ? 'active' : 'idle'}</span>
            <span>${escapeHtml(relTime(row.last_event_at))}</span>
            <span>${fmtNum(row.events_last_hour || 0)} ev/hr</span>
            <span class="badge ${Number(row.errors_last_24h || 0) ? 'err' : 'ok'}">${fmtNum(row.errors_last_24h || 0)} errors 24h</span>
            <span>${fmtNum(inboxRow.unread || 0)} unread</span>
          </div>
        </button>
      `;
    }).join('') || '<div class="empty-state">No agents matched the filter.</div>';
    els.listContent.querySelectorAll('[data-agent]').forEach((button) => {
      button.addEventListener('click', async () => {
        const agentId = button.dataset.agent;
        state.selected = { kind: 'agent', agent_id: agentId };
        await showAgentDetail(agentId, inboxMap.get(agentId));
      });
    });
    setPager({ note: 'Agent detail shows recent activity and message involvement, not a full replay.' });
  };

  renderList();
  document.getElementById('agentSearch')?.addEventListener('input', (event) => renderList(event.target.value));
}

async function showAgentDetail(agentId, inboxRow = {}) {
  const [activity, received, sent] = await Promise.all([
    safeQuery(`agent_activity?select=created_at,agent_id,event,tool_name,status,duration_ms,session_id,payload_sample&agent_id=eq.${encodeURIComponent(agentId)}&order=created_at.desc&limit=20`, []),
    safeQuery(`agent_messages?select=id,thread_id,from_agent,to_agent,kind,state,created_at,body&to_agent=eq.${encodeURIComponent(agentId)}&order=created_at.desc&limit=10`, []),
    safeQuery(`agent_messages?select=id,thread_id,from_agent,to_agent,kind,state,created_at,body&from_agent=eq.${encodeURIComponent(agentId)}&order=created_at.desc&limit=10`, []),
  ]);
  setDetail(`
    <div class="detail-section">
      <h3>${escapeHtml(agentId)}</h3>
      <div class="detail-kv">
        <div>Unread inbox</div><div>${fmtNum(inboxRow?.unread || 0)}</div>
        <div>Open read</div><div>${fmtNum(inboxRow?.read_open || 0)}</div>
        <div>Latest unread</div><div>${escapeHtml(relTime(inboxRow?.latest_unread_at))}</div>
      </div>
    </div>
    <div class="detail-section">
      <h3>Recent activity</h3>
      ${activity.length ? activity.map((row) => `
        <div class="activity-row">
          <div class="headline"><strong>${escapeHtml(row.event)}</strong><span class="badge ${statusClass(row.status)}">${escapeHtml(row.status || '—')}</span></div>
          <div class="activity-meta">
            <span>${escapeHtml(row.tool_name || 'no tool')}</span>
            <span>${escapeHtml(relTime(row.created_at))}</span>
            <span>${row.duration_ms ? `${fmtNum(row.duration_ms)}ms` : 'no duration'}</span>
            <span>${escapeHtml(row.session_id || 'no session')}</span>
          </div>
        </div>
      `).join('') : '<div class="empty-state">No recent activity rows.</div>'}
    </div>
    <div class="detail-section">
      <h3>Recent messages received</h3>
      ${renderThreadSummary(received)}
    </div>
    <div class="detail-section">
      <h3>Recent messages sent</h3>
      ${renderThreadSummary(sent)}
    </div>
  `);
}

function renderThreadSummary(rows) {
  if (!rows.length) return '<div class="muted">No messages.</div>';
  return rows.map((row) => `
    <div class="thread-item">
      <div class="list-meta">
        <span>${escapeHtml(row.from_agent)} → ${escapeHtml(row.to_agent)}</span>
        <span>${escapeHtml(row.kind)}</span>
        <span class="badge ${statusClass(row.state)}">${escapeHtml(row.state)}</span>
        <span>${escapeHtml(relTime(row.created_at))}</span>
      </div>
      <div class="muted small">${escapeHtml(typeof row.body === 'string' ? row.body : JSON.stringify(row.body)).slice(0, 220)}</div>
    </div>
  `).join('');
}

async function renderTopology() {
  els.listTitle.textContent = 'Topology';
  els.listActions.innerHTML = '';
  clearDetail('Upload or load an org chart to model your agent army. The app will overlay live message and activity signals on top of that structure.');
  renderToolbar(`
    <button id="loadOrgChartExample" class="secondary">Load ./org_chart.example.json</button>
    <button id="uploadOrgChart" class="secondary">Upload org chart JSON</button>
    <button id="clearOrgChart" class="secondary">Clear org chart</button>
  `);

  const chart = state.orgChart;
  const agents = configReady()
    ? await safeQuery('agent_status_now?select=*&order=last_event_at.desc', [])
    : [];
  const messages = configReady()
    ? await safeQuery('agent_messages?select=from_agent,to_agent,kind,state,created_at&order=created_at.desc&limit=200', [])
    : [];

  const edgeMap = new Map();
  for (const row of messages) {
    const key = `${row.from_agent}=>${row.to_agent}`;
    const entry = edgeMap.get(key) || { from: row.from_agent, to: row.to_agent, count: 0, latest: row.created_at, unread: 0 };
    entry.count += 1;
    if (row.state === 'unread') entry.unread += 1;
    if (!entry.latest || row.created_at > entry.latest) entry.latest = row.created_at;
    edgeMap.set(key, entry);
  }
  const edges = [...edgeMap.values()].sort((a, b) => b.count - a.count);

  renderMetrics([
    { label: 'Org nodes', value: String(chart?.agents?.length || 0), meta: chart ? 'Loaded from local org chart JSON' : 'No org chart loaded' },
    { label: 'Live agents', value: String(agents.length), meta: configReady() ? 'From Supabase' : 'Requires Supabase config' },
    { label: 'Observed edges', value: String(edges.length), meta: 'Recent message relationships' },
  ]);

  if (!chart) {
    els.listContent.innerHTML = `${summaryCard('Why this view exists', [
      'The agent-army video emphasizes an explicit org chart: who exists, what they do, which model/device they run on, and how work gets routed.',
      'Mission Control v1 now supports that as a first-class, uploadable JSON artifact rather than leaving it implicit.',
      'Load the example file, then customize it for Hermes, Claude Code, coding muscles, research muscles, and future workers.'
    ])}`;
  } else {
    const liveMap = new Map(agents.map((row) => [row.agent_id, row]));
    els.listContent.innerHTML = (chart.agents || []).map((agent, index) => {
      const live = liveMap.get(agent.id);
      const reports = (chart.agents || []).filter((candidate) => candidate.reports_to === agent.id).length;
      return `
        <button class="list-item ${state.selected?.kind === 'topology' && state.selected.id === agent.id ? 'active' : ''}" data-topology-index="${index}">
          <h3>${escapeHtml(agent.name || agent.id)}</h3>
          <div class="list-meta">
            <span class="badge ${live?.active_last_2min ? 'ok' : ''}">${live ? (live.active_last_2min ? 'active now' : 'idle') : 'planned'}</span>
            <span>${escapeHtml(agent.role || 'no role')}</span>
            <span>${escapeHtml(agent.model || 'model n/a')}</span>
            <span>${escapeHtml(agent.device || 'device n/a')}</span>
            <span>${reports} reports</span>
          </div>
        </button>
      `;
    }).join('') || '<div class="empty-state">Org chart loaded, but it has no agents.</div>';

    els.listContent.querySelectorAll('[data-topology-index]').forEach((button) => {
      button.addEventListener('click', () => {
        const agent = chart.agents[Number(button.dataset.topologyIndex)];
        const live = liveMap.get(agent.id);
        const inbound = edges.filter((edge) => edge.to === agent.id).slice(0, 8);
        const outbound = edges.filter((edge) => edge.from === agent.id).slice(0, 8);
        const reports = (chart.agents || []).filter((candidate) => candidate.reports_to === agent.id);
        state.selected = { kind: 'topology', id: agent.id };
        setDetail(`
          <div class="detail-section">
            <h3>${escapeHtml(agent.name || agent.id)}</h3>
            <div class="detail-kv">
              <div>ID</div><div>${escapeHtml(agent.id)}</div>
              <div>Role</div><div>${escapeHtml(agent.role || '—')}</div>
              <div>Model</div><div>${escapeHtml(agent.model || '—')}</div>
              <div>Device</div><div>${escapeHtml(agent.device || '—')}</div>
              <div>Reports to</div><div>${escapeHtml(agent.reports_to || '—')}</div>
              <div>Mission</div><div>${escapeHtml(agent.mission || '—')}</div>
              <div>Live status</div><div>${live ? (live.active_last_2min ? 'active' : 'idle') : 'not observed in Supabase'}</div>
            </div>
          </div>
          <div class="detail-section">
            <h3>Direct reports</h3>
            ${reports.length ? reports.map((row) => `<div class="thread-item"><strong>${escapeHtml(row.name || row.id)}</strong><div class="muted small">${escapeHtml(row.role || '—')} · ${escapeHtml(row.model || '—')}</div></div>`).join('') : '<div class="muted">No direct reports.</div>'}
          </div>
          <div class="detail-section">
            <h3>Observed inbound relationships</h3>
            ${inbound.length ? inbound.map((edge) => `<div class="thread-item"><strong>${escapeHtml(edge.from)} → ${escapeHtml(edge.to)}</strong><div class="muted small">${edge.count} msgs · ${edge.unread} unread · latest ${escapeHtml(relTime(edge.latest))}</div></div>`).join('') : '<div class="muted">No recent inbound message relationships.</div>'}
          </div>
          <div class="detail-section">
            <h3>Observed outbound relationships</h3>
            ${outbound.length ? outbound.map((edge) => `<div class="thread-item"><strong>${escapeHtml(edge.from)} → ${escapeHtml(edge.to)}</strong><div class="muted small">${edge.count} msgs · ${edge.unread} unread · latest ${escapeHtml(relTime(edge.latest))}</div></div>`).join('') : '<div class="muted">No recent outbound message relationships.</div>'}
          </div>
        `);
      });
    });
  }

  els.detailActions.innerHTML = '';
  document.getElementById('loadOrgChartExample')?.addEventListener('click', async () => {
    if (location.protocol === 'file:') {
      alert('Loading ./org_chart.example.json via fetch is unreliable from file:// pages. Use Upload org chart JSON instead, or serve the app over a tiny local HTTP server.');
      return;
    }
    try {
      const response = await fetch('./org_chart.example.json');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const chartData = await response.json();
      state.orgChart = chartData;
      saveOrgChart(chartData);
      renderTopology();
    } catch (error) {
      alert(`Could not load ./org_chart.example.json: ${error.message}`);
    }
  });
  document.getElementById('uploadOrgChart')?.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const chartData = JSON.parse(text);
        state.orgChart = chartData;
        saveOrgChart(chartData);
        renderTopology();
      } catch (error) {
        alert(`Could not parse org chart JSON: ${error.message}`);
      }
    });
    input.click();
  });
  document.getElementById('clearOrgChart')?.addEventListener('click', () => {
    state.orgChart = null;
    saveOrgChart(null);
    renderTopology();
  });

  setPager({ note: 'Topology combines a custom org chart with observed live message relationships.' });
}

async function renderSchedule() {
  els.listTitle.textContent = 'Schedule';
  els.listActions.innerHTML = '';
  clearDetail('Select a calendar event or due task to inspect timing, ownership, and next actions.');
  renderToolbar(`
    <label>
      <span>Window</span>
      <select id="scheduleWindow">
        <option value="24" ${state.scheduleWindowHours === 24 ? 'selected' : ''}>Next 24h</option>
        <option value="48" ${state.scheduleWindowHours === 48 ? 'selected' : ''}>Next 48h</option>
        <option value="168" ${state.scheduleWindowHours === 168 ? 'selected' : ''}>Next 7d</option>
      </select>
    </label>
    <label>
      <span>Search</span>
      <input id="scheduleSearch" type="text" placeholder="subject, organizer, task title" />
    </label>
  `);

  if (!configReady()) {
    renderMetrics([{ label: 'Schedule', value: 'No config', meta: 'Set Supabase config first.' }]);
    els.listContent.innerHTML = '<div class="empty-state">Calendar and proactive work visibility require Supabase config.</div>';
    setPager();
    return;
  }

  const now = new Date();
  const end = new Date(now.getTime() + state.scheduleWindowHours * 3600 * 1000);
  const startIso = now.toISOString();
  const endIso = end.toISOString();
  const [events, tasks] = await Promise.all([
    safeQuery(`calendar_events?select=id,outlook_event_id,subject,start_at,end_at,is_all_day,show_as,organizer_name,organizer_address,location,response_status,web_link,updated_at&start_at=gte.${encodeURIComponent(startIso)}&start_at=lte.${encodeURIComponent(endIso)}&order=start_at.asc&limit=60`, []),
    safeQuery(`tasks?select=id,title,priority,status,due_at&status=neq.completed&due_at=gte.${encodeURIComponent(startIso)}&due_at=lte.${encodeURIComponent(endIso)}&order=due_at.asc&limit=40`, []),
  ]);

  const rows = [
    ...events.map((row) => ({ ...row, item_type: 'calendar', sort_at: row.start_at })),
    ...tasks.map((row) => ({ ...row, item_type: 'task', sort_at: row.due_at })),
  ].sort((a, b) => new Date(a.sort_at || 0) - new Date(b.sort_at || 0));

  renderMetrics([
    { label: 'Calendar events', value: String(events.length), meta: `Window: ${state.scheduleWindowHours}h` },
    { label: 'Due tasks', value: String(tasks.length), meta: `Tasks with due_at in ${state.scheduleWindowHours}h` },
    { label: 'All-day events', value: String(events.filter((row) => row.is_all_day).length), meta: 'Current window' },
    { label: 'Busy events', value: String(events.filter((row) => String(row.show_as || '').toLowerCase() === 'busy').length), meta: 'Current window' },
  ]);

  const renderList = (needle = '') => {
    const lower = needle.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      const haystack = row.item_type === 'calendar'
        ? `${row.subject || ''} ${row.organizer_name || ''} ${row.organizer_address || ''} ${row.location || ''}`
        : `${row.title || ''}`;
      return !lower || haystack.toLowerCase().includes(lower);
    });

    if (!events.length && !tasks.length) {
      els.listContent.innerHTML = `
        <div class="callout">
          <strong>Important:</strong> if calendar rows do not appear here, the likely missing piece is anon access to <code>public.calendar_events</code>. I added a migration for that in <code>db/migrations/009_calendar_events_anon_for_mission_control.sql</code>.
        </div>
        <div class="empty-state">No upcoming calendar events or due tasks were returned for this window.</div>
      `;
      setPager({ note: 'Schedule view combines calendar_events with due tasks.' });
      return;
    }

    els.listContent.innerHTML = filtered.map((row, index) => {
      if (row.item_type === 'calendar') {
        return `
          <button class="list-item ${state.selected?.kind === 'schedule' && state.selected.item_type === 'calendar' && state.selected.id === row.id ? 'active' : ''}" data-schedule-index="${index}">
            <h3>${escapeHtml(row.subject || '(untitled event)')}</h3>
            <div class="list-meta">
              <span class="badge ${statusClass(row.show_as || '')}">${escapeHtml(row.show_as || 'event')}</span>
              <span>${escapeHtml(relTime(row.start_at))}</span>
              <span>${escapeHtml(row.organizer_name || row.organizer_address || 'no organizer')}</span>
              <span>${row.is_all_day ? 'all day' : (row.end_at ? `${new Date(row.start_at).toLocaleString()} → ${new Date(row.end_at).toLocaleTimeString()}` : 'no end')}</span>
            </div>
          </button>
        `;
      }
      return `
        <button class="task-row ${state.selected?.kind === 'schedule' && state.selected.item_type === 'task' && state.selected.id === row.id ? 'active' : ''}" data-schedule-index="${index}">
          <h3>${escapeHtml(row.title || 'Untitled task')}</h3>
          <div class="list-meta">
            <span class="badge ${Number(row.priority || 3) <= 2 ? 'warn' : ''}">P${escapeHtml(row.priority || 3)}</span>
            <span>${escapeHtml(row.status || 'unknown')}</span>
            <span>${row.due_at ? new Date(row.due_at).toLocaleString() : 'no due date'}</span>
          </div>
        </button>
      `;
    }).join('') || '<div class="empty-state">No scheduled items matched the current filter.</div>';

    els.listContent.querySelectorAll('[data-schedule-index]').forEach((button) => {
      button.addEventListener('click', () => {
        const row = filtered[Number(button.dataset.scheduleIndex)];
        state.selected = { kind: 'schedule', item_type: row.item_type, id: row.id };
        if (row.item_type === 'calendar') {
          setDetail(`
            <div class="detail-section">
              <h3>${escapeHtml(row.subject || '(untitled event)')}</h3>
              <div class="detail-kv">
                <div>Start</div><div>${row.start_at ? escapeHtml(new Date(row.start_at).toLocaleString()) : '—'}</div>
                <div>End</div><div>${row.end_at ? escapeHtml(new Date(row.end_at).toLocaleString()) : '—'}</div>
                <div>All day</div><div>${row.is_all_day ? 'yes' : 'no'}</div>
                <div>Show as</div><div>${escapeHtml(row.show_as || '—')}</div>
                <div>Organizer</div><div>${escapeHtml(row.organizer_name || row.organizer_address || '—')}</div>
                <div>Location</div><div>${escapeHtml(row.location || '—')}</div>
                <div>Response</div><div>${escapeHtml(row.response_status || '—')}</div>
                <div>Updated</div><div>${escapeHtml(relTime(row.updated_at))}</div>
              </div>
            </div>
            <div class="detail-section">
              <h3>Links</h3>
              ${row.web_link ? `<pre>${escapeHtml(row.web_link)}</pre>` : '<div class="muted">No web link stored.</div>'}
            </div>
          `);
        } else {
          setDetail(`
            <div class="detail-section">
              <h3>${escapeHtml(row.title || 'Untitled task')}</h3>
              <div class="detail-kv">
                <div>Due</div><div>${row.due_at ? escapeHtml(new Date(row.due_at).toLocaleString()) : '—'}</div>
                <div>Status</div><div>${escapeHtml(row.status || '—')}</div>
                <div>Priority</div><div>${escapeHtml(row.priority || 3)}</div>
                <div>ID</div><div><code>${escapeHtml(row.id)}</code></div>
              </div>
            </div>
            <div class="callout">This surfaces proactive work currently represented in the public task queue. If you want cron/routine visibility too, the next extension is a dedicated scheduled-jobs surface.</div>
          `);
        }
      });
    });

    setPager({ note: 'Schedule view combines calendar_events with due tasks.' });
  };

  renderList();
  document.getElementById('scheduleWindow')?.addEventListener('change', (event) => {
    state.scheduleWindowHours = Number(event.target.value);
    renderSchedule();
  });
  document.getElementById('scheduleSearch')?.addEventListener('input', (event) => renderList(event.target.value));
}

async function renderTasks() {
  const limit = 50;
  const offset = state.page.tasks * limit;
  els.listTitle.textContent = 'Tasks';
  clearDetail('Select a task card to inspect details. This board is optimized for execution visibility: backlog, in progress, review, done.');
  renderToolbar(`
    <label>
      <span>Status filter</span>
      <select id="taskStatusFilter">
        <option value="open" ${state.taskStatus === 'open' ? 'selected' : ''}>Open only</option>
        <option value="all" ${state.taskStatus === 'all' ? 'selected' : ''}>All visible</option>
      </select>
    </label>
    <label>
      <span>Title contains</span>
      <input id="taskSearch" type="text" placeholder="priority keyword" />
    </label>
  `);

  if (!configReady()) {
    renderMetrics([{ label: 'Tasks', value: 'No config', meta: 'Set Supabase config first.' }]);
    els.listContent.innerHTML = '<div class="empty-state">Live tasks require Supabase config.</div>';
    setPager();
    return;
  }

  const statusValue = state.taskStatus;
  let query = `tasks?select=id,title,priority,status,due_at,description,thought_id&order=priority.asc,due_at.asc.nullslast&limit=${limit + 1}&offset=${offset}`;
  if (statusValue === 'open') query += '&status=neq.completed';
  const rows = await safeQuery(query, []);
  const hasNext = rows.length > limit;
  const visible = rows.slice(0, limit);

  const normalizeTaskColumn = (status) => {
    const s = String(status || '').toLowerCase();
    if (!s || ['pending', 'todo', 'backlog', 'queued', 'open'].includes(s)) return 'backlog';
    if (['in_progress', 'in-progress', 'doing', 'active', 'working'].includes(s)) return 'in_progress';
    if (['review', 'needs_review', 'blocked', 'waiting'].includes(s)) return 'review';
    if (['done', 'completed', 'complete', 'closed'].includes(s)) return 'done';
    return 'other';
  };

  const columnMeta = {
    backlog: { label: 'Backlog', hint: 'Queued or pending work' },
    in_progress: { label: 'In Progress', hint: 'Actively being worked' },
    review: { label: 'Review', hint: 'Needs human or agent follow-up' },
    done: { label: 'Done', hint: 'Completed items' },
    other: { label: 'Other', hint: 'Unmapped statuses' },
  };

  renderMetrics([
    { label: 'Visible tasks', value: String(visible.length), meta: `page ${state.page.tasks + 1}` },
    { label: 'High priority', value: String(visible.filter((row) => Number(row.priority || 3) <= 2).length), meta: 'priority 1-2 on current page' },
    { label: 'In progress', value: String(visible.filter((row) => normalizeTaskColumn(row.status) === 'in_progress').length), meta: 'execution lane' },
    { label: 'Review', value: String(visible.filter((row) => normalizeTaskColumn(row.status) === 'review').length), meta: 'needs follow-up' },
  ]);

  const renderBoard = (needle = '') => {
    const lower = needle.trim().toLowerCase();
    const filtered = visible.filter((row) => !lower || `${row.title || ''} ${row.description || ''}`.toLowerCase().includes(lower));
    const grouped = {
      backlog: [],
      in_progress: [],
      review: [],
      done: [],
      other: [],
    };
    for (const row of filtered) grouped[normalizeTaskColumn(row.status)].push(row);

    const totalShown = Object.values(grouped).reduce((sum, arr) => sum + arr.length, 0);
    if (!totalShown) {
      els.listContent.innerHTML = `
        <div class="callout">
          <strong>No task cards matched.</strong> If your board is empty, either the public tasks table is still sparsely populated or your current filter removed everything.
        </div>
        <div class="kanban-board empty-board">
          ${Object.entries(columnMeta).map(([key, meta]) => `
            <section class="kanban-column">
              <header class="kanban-column-head">
                <div>
                  <h3>${escapeHtml(meta.label)}</h3>
                  <div class="muted small">${escapeHtml(meta.hint)}</div>
                </div>
                <span class="badge">0</span>
              </header>
              <div class="kanban-column-body empty-state">No cards</div>
            </section>
          `).join('')}
        </div>
      `;
    } else {
      els.listContent.innerHTML = `
        <div class="kanban-board">
          ${Object.entries(columnMeta).map(([key, meta]) => `
            <section class="kanban-column">
              <header class="kanban-column-head">
                <div>
                  <h3>${escapeHtml(meta.label)}</h3>
                  <div class="muted small">${escapeHtml(meta.hint)}</div>
                </div>
                <span class="badge">${grouped[key].length}</span>
              </header>
              <div class="kanban-column-body">
                ${grouped[key].length ? grouped[key].map((row) => `
                  <button class="kanban-card ${state.selected?.kind === 'task' && state.selected.id === row.id ? 'active' : ''}" data-task="${row.id}">
                    <div class="kanban-card-title">${escapeHtml(row.title || 'Untitled task')}</div>
                    <div class="list-meta">
                      <span class="badge ${Number(row.priority || 3) <= 2 ? 'warn' : ''}">P${escapeHtml(row.priority || 3)}</span>
                      <span>${escapeHtml(row.status || 'unknown')}</span>
                    </div>
                    <div class="muted small">${row.due_at ? `Due ${escapeHtml(new Date(row.due_at).toLocaleString())}` : 'No due date'}</div>
                  </button>
                `).join('') : '<div class="kanban-empty">No cards</div>'}
              </div>
            </section>
          `).join('')}
        </div>
      `;
    }

    els.listContent.querySelectorAll('[data-task]').forEach((button) => {
      button.addEventListener('click', () => {
        const row = filtered.find((entry) => String(entry.id) === String(button.dataset.task));
        state.selected = { kind: 'task', id: row.id };
        setDetail(`
          <div class="detail-section">
            <h3>${escapeHtml(row.title || 'Untitled task')}</h3>
            <div class="detail-kv">
              <div>Priority</div><div>${escapeHtml(row.priority || 3)}</div>
              <div>Status</div><div>${escapeHtml(row.status || 'unknown')}</div>
              <div>Lane</div><div>${escapeHtml(columnMeta[normalizeTaskColumn(row.status)].label)}</div>
              <div>Due</div><div>${row.due_at ? escapeHtml(new Date(row.due_at).toLocaleString()) : '—'}</div>
              <div>Thought</div><div>${row.thought_id ? `<code>${escapeHtml(row.thought_id)}</code>` : '—'}</div>
              <div>ID</div><div><code>${escapeHtml(row.id)}</code></div>
            </div>
          </div>
          <div class="detail-section">
            <h3>Description</h3>
            ${row.description ? `<pre>${escapeHtml(row.description)}</pre>` : '<div class="muted">No description stored.</div>'}
          </div>
          <div class="callout">This kanban groups task rows by status and is meant to mirror the mission-control pattern from the videos: backlog, active work, review, and done. For live movement between lanes, the next extension would be authenticated write actions.</div>
        `);
      });
    });

    setPager({
      page: state.page.tasks,
      hasPrev: state.page.tasks > 0,
      hasNext,
      onPrev: () => { state.page.tasks -= 1; renderTasks(); },
      onNext: () => { state.page.tasks += 1; renderTasks(); },
      note: 'Kanban is page-scoped so the board stays responsive as task history grows.',
    });
  };

  renderBoard();
  document.getElementById('taskStatusFilter')?.addEventListener('change', (event) => {
    state.taskStatus = event.target.value;
    state.page.tasks = 0;
    renderTasks();
  });
  document.getElementById('taskSearch')?.addEventListener('input', (event) => renderBoard(event.target.value));
}

async function renderInbox() {
  const limit = 20;
  const offset = state.page.inbox * limit;
  els.listTitle.textContent = 'Inbox';
  clearDetail('Select a message row to load the entire thread.');
  renderToolbar(`
    <label>
      <span>State</span>
      <select id="messageStateFilter">
        <option value="all">All</option>
        <option value="unread">Unread</option>
        <option value="read">Read</option>
      </select>
    </label>
    <label>
      <span>Agent contains</span>
      <input id="messageAgentFilter" type="text" placeholder="hermes, claude-code" />
    </label>
  `);

  if (!configReady()) {
    renderMetrics([{ label: 'Inbox', value: 'No config', meta: 'Set Supabase config first.' }]);
    els.listContent.innerHTML = '<div class="empty-state">Peer messaging requires Supabase config.</div>';
    setPager();
    return;
  }

  const rows = await safeQuery(`agent_messages?select=id,thread_id,from_agent,to_agent,kind,state,priority,created_at,body&order=created_at.desc&limit=${limit + 1}&offset=${offset}`, []);
  const hasNext = rows.length > limit;
  const visible = rows.slice(0, limit);
  renderMetrics([
    { label: 'Messages shown', value: String(visible.length), meta: `page ${state.page.inbox + 1}` },
    { label: 'Unread shown', value: String(visible.filter((row) => row.state === 'unread').length), meta: 'current page' },
  ]);

  const renderList = (agentNeedle = '', stateNeedle = 'all') => {
    const lower = agentNeedle.trim().toLowerCase();
    const filtered = visible.filter((row) => {
      const agentMatch = !lower || String(row.from_agent).toLowerCase().includes(lower) || String(row.to_agent).toLowerCase().includes(lower);
      const stateMatch = stateNeedle === 'all' || row.state === stateNeedle;
      return agentMatch && stateMatch;
    });
    els.listContent.innerHTML = filtered.map((row) => `
      <button class="thread-item ${state.selected?.kind === 'message' && state.selected.id === row.id ? 'active' : ''}" data-message="${row.id}" data-thread="${row.thread_id}">
        <h3>${escapeHtml(row.from_agent)} → ${escapeHtml(row.to_agent)}</h3>
        <div class="list-meta">
          <span class="badge ${statusClass(row.state)}">${escapeHtml(row.state)}</span>
          <span>${escapeHtml(row.kind)}</span>
          <span>P${escapeHtml(row.priority || 3)}</span>
          <span>${escapeHtml(relTime(row.created_at))}</span>
        </div>
        <div class="muted small">${escapeHtml(typeof row.body === 'string' ? row.body : JSON.stringify(row.body)).slice(0, 240)}</div>
      </button>
    `).join('') || '<div class="empty-state">No messages matched the current filter.</div>';

    els.listContent.querySelectorAll('[data-thread]').forEach((button) => {
      button.addEventListener('click', async () => {
        const threadId = button.dataset.thread;
        const id = button.dataset.message;
        state.selected = { kind: 'message', id };
        const thread = await safeQuery(`agent_messages?select=id,thread_id,from_agent,to_agent,kind,state,priority,created_at,body&thread_id=eq.${encodeURIComponent(threadId)}&order=created_at.asc`, []);
        setDetail(`
          <div class="detail-section">
            <h3>Thread ${escapeHtml(threadId)}</h3>
            ${thread.map((row) => `
              <div class="thread-item">
                <div class="list-meta">
                  <span>${escapeHtml(row.from_agent)} → ${escapeHtml(row.to_agent)}</span>
                  <span class="badge ${statusClass(row.state)}">${escapeHtml(row.state)}</span>
                  <span>${escapeHtml(row.kind)}</span>
                  <span>P${escapeHtml(row.priority || 3)}</span>
                  <span>${escapeHtml(new Date(row.created_at).toLocaleString())}</span>
                </div>
                <pre>${escapeHtml(typeof row.body === 'string' ? row.body : JSON.stringify(row.body, null, 2))}</pre>
              </div>
            `).join('')}
          </div>
        `);
      });
    });

    setPager({
      page: state.page.inbox,
      hasPrev: state.page.inbox > 0,
      hasNext,
      onPrev: () => { state.page.inbox -= 1; renderInbox(); },
      onNext: () => { state.page.inbox += 1; renderInbox(); },
      note: 'Inbox stays fast by paging and loading full threads only on click.',
    });
  };

  renderList();
  const stateFilter = document.getElementById('messageStateFilter');
  const agentFilter = document.getElementById('messageAgentFilter');
  const rerender = () => renderList(agentFilter?.value || '', stateFilter?.value || 'all');
  stateFilter?.addEventListener('change', rerender);
  agentFilter?.addEventListener('input', rerender);
}

async function renderActivity() {
  const limit = 25;
  const offset = state.page.activity * limit;
  els.listTitle.textContent = 'Activity';
  clearDetail('Select an event row to inspect payload samples and session correlation.');
  renderToolbar(`
    <label>
      <span>Agent</span>
      <input id="activityAgentFilter" type="text" placeholder="claude-code" />
    </label>
    <label>
      <span>Status</span>
      <select id="activityStatusFilter">
        <option value="all">All</option>
        <option value="ok">ok</option>
        <option value="error">error</option>
        <option value="denied">denied</option>
      </select>
    </label>
    <label>
      <span>Event</span>
      <select id="activityEventFilter">
        <option value="all">All</option>
        <option value="tool_pre">tool_pre</option>
        <option value="tool_post">tool_post</option>
        <option value="task_created">task_created</option>
        <option value="task_completed">task_completed</option>
        <option value="session_start">session_start</option>
        <option value="session_end">session_end</option>
      </select>
    </label>
  `);

  if (!configReady()) {
    renderMetrics([{ label: 'Activity', value: 'No config', meta: 'Set Supabase config first.' }]);
    els.listContent.innerHTML = '<div class="empty-state">Live activity requires Supabase config.</div>';
    setPager();
    return;
  }

  const rows = await safeQuery(`agent_activity?select=created_at,agent_id,event,tool_name,status,duration_ms,session_id,payload_sample&order=created_at.desc&limit=${limit + 1}&offset=${offset}`, []);
  const hasNext = rows.length > limit;
  const visible = rows.slice(0, limit);
  renderMetrics([
    { label: 'Events shown', value: String(visible.length), meta: `page ${state.page.activity + 1}` },
    { label: 'Errors shown', value: String(visible.filter((row) => row.status === 'error').length), meta: 'current page' },
    { label: 'Tool posts', value: String(visible.filter((row) => row.event === 'tool_post').length), meta: 'current page' },
  ]);

  const renderList = () => {
    const agentNeedle = (document.getElementById('activityAgentFilter')?.value || '').trim().toLowerCase();
    const statusNeedle = document.getElementById('activityStatusFilter')?.value || 'all';
    const eventNeedle = document.getElementById('activityEventFilter')?.value || 'all';
    const filtered = visible.filter((row) => {
      const agentMatch = !agentNeedle || String(row.agent_id).toLowerCase().includes(agentNeedle);
      const statusMatch = statusNeedle === 'all' || String(row.status) === statusNeedle;
      const eventMatch = eventNeedle === 'all' || String(row.event) === eventNeedle;
      return agentMatch && statusMatch && eventMatch;
    });

    els.listContent.innerHTML = filtered.map((row, index) => `
      <button class="activity-row ${state.selected?.kind === 'activity' && state.selected.index === index ? 'active' : ''}" data-index="${index}">
        <div class="headline">
          <strong>${escapeHtml(row.agent_id)} · ${escapeHtml(row.event)}</strong>
          <span class="badge ${statusClass(row.status)}">${escapeHtml(row.status || '—')}</span>
        </div>
        <div class="activity-meta">
          <span>${escapeHtml(row.tool_name || 'no tool')}</span>
          <span>${escapeHtml(relTime(row.created_at))}</span>
          <span>${row.duration_ms ? `${fmtNum(row.duration_ms)}ms` : 'no duration'}</span>
          <span>${escapeHtml(row.session_id || 'no session')}</span>
        </div>
      </button>
    `).join('') || '<div class="empty-state">No activity rows matched the current filter.</div>';

    els.listContent.querySelectorAll('[data-index]').forEach((button) => {
      button.addEventListener('click', () => {
        const row = filtered[Number(button.dataset.index)];
        state.selected = { kind: 'activity', index: Number(button.dataset.index) };
        setDetail(`
          <div class="detail-section">
            <h3>${escapeHtml(row.agent_id)} · ${escapeHtml(row.event)}</h3>
            <div class="detail-kv">
              <div>Status</div><div>${escapeHtml(row.status || '—')}</div>
              <div>Tool</div><div>${escapeHtml(row.tool_name || '—')}</div>
              <div>Duration</div><div>${row.duration_ms ? `${fmtNum(row.duration_ms)}ms` : '—'}</div>
              <div>Session</div><div>${escapeHtml(row.session_id || '—')}</div>
              <div>Created</div><div>${escapeHtml(new Date(row.created_at).toLocaleString())}</div>
            </div>
          </div>
          <div class="detail-section">
            <h3>Payload sample</h3>
            <pre>${escapeHtml(JSON.stringify(row.payload_sample || {}, null, 2))}</pre>
          </div>
        `);
      });
    });

    setPager({
      page: state.page.activity,
      hasPrev: state.page.activity > 0,
      hasNext,
      onPrev: () => { state.page.activity -= 1; renderActivity(); },
      onNext: () => { state.page.activity += 1; renderActivity(); },
      note: 'Activity uses narrow pages plus filters so more telemetry does not bog down the UI.',
    });
  };

  renderList();
  document.getElementById('activityAgentFilter')?.addEventListener('input', renderList);
  document.getElementById('activityStatusFilter')?.addEventListener('change', renderList);
  document.getElementById('activityEventFilter')?.addEventListener('change', renderList);
}

function renderTokens() {
  els.listTitle.textContent = 'Tokens';
  els.listActions.innerHTML = '';
  renderToolbar(`
    <button id="loadTokenSnapshot" class="secondary">Load ./token_snapshot.json</button>
    <button id="uploadTokenSnapshot" class="secondary">Upload snapshot file</button>
    <button id="clearTokenSnapshot" class="secondary">Clear snapshot</button>
  `);
  clearDetail('Token detail explains how to reduce reread costs and when to split context.');

  const snapshot = state.tokenSnapshot;
  const totals = snapshot?.totals || null;
  renderMetrics([
    { label: 'Snapshot', value: snapshot ? 'Loaded' : 'Missing', meta: snapshot?.generated_at ? `Generated ${relTime(snapshot.generated_at)}` : 'Use the generator script' },
    { label: 'Sessions', value: snapshot ? String(snapshot.session_count || 0) : '—', meta: snapshot ? `${snapshot.main_session_count || 0} main / ${snapshot.subagent_session_count || 0} subagent` : 'No snapshot loaded' },
    { label: 'Input tokens', value: totals ? fmtShort(totals.input_tokens) : '—', meta: 'Prompt + reread input' },
    { label: 'Output tokens', value: totals ? fmtShort(totals.output_tokens) : '—', meta: 'Model-generated output' },
    { label: 'Cache read', value: totals ? fmtShort(totals.cache_read_input_tokens) : '—', meta: 'High value = many rereads' },
    { label: 'Cache create', value: totals ? fmtShort(totals.cache_creation_input_tokens) : '—', meta: 'Context creation cost' },
  ]);

  const instructions = `
    <div class="callout">
      <strong>Recommended workflow:</strong> run <code>python3 scripts/generate_claude_token_snapshot.py --write apps/mission-control-v1/token_snapshot.json</code>, then load the snapshot here or upload the app directory.
    </div>
  `;

  if (!snapshot) {
    els.listContent.innerHTML = `${instructions}
      ${summaryCard('Token-saving playbook', [
        'Check /context in fresh sessions to catch invisible startup overhead.',
        'Manually compact around 60% instead of waiting for late auto-compaction.',
        'Start fresh sessions for new topics instead of stuffing everything into one thread.',
        'Use subagents for research/review so the main session gets only the summary.',
        'Use cheaper models for subagents when quality is still acceptable.',
        'Watch input-heavy sessions: they usually indicate excessive rereads or oversized file loads.',
      ])}
    `;
  } else {
    const recentSessions = (snapshot.recent_sessions || []).slice(0, 12).map((session) => `
      <div class="token-card">
        <h3>${escapeHtml(session.title || session.session_id)}</h3>
        <div class="token-grid">
          <div class="kv">Project<strong>${escapeHtml(session.project_key || 'unknown')}</strong></div>
          <div class="kv">Model<strong>${escapeHtml(session.model || 'unknown')}</strong></div>
          <div class="kv">Input<strong>${fmtNum(session.input_tokens)}</strong></div>
          <div class="kv">Output<strong>${fmtNum(session.output_tokens)}</strong></div>
          <div class="kv">Cache read<strong>${fmtNum(session.cache_read_input_tokens)}</strong></div>
          <div class="kv">Turns<strong>${fmtNum(session.turns)}</strong></div>
        </div>
        <div class="list-meta">
          <span>${session.is_subagent ? 'subagent' : 'main session'}</span>
          <span>${escapeHtml(relTime(session.last_seen))}</span>
          <span>${fmtNum(session.tool_uses || 0)} tool-use turns</span>
        </div>
      </div>
    `).join('');

    const byProject = (snapshot.by_project || []).slice(0, 6).map((row) => `
      <div class="kv">${escapeHtml(row.project_key || 'unknown')}<strong>${fmtShort(row.total_tracked_tokens)}</strong></div>
    `).join('') || '<div class="muted">No project summary.</div>';

    const byModel = (snapshot.by_model || []).slice(0, 6).map((row) => `
      <div class="kv">${escapeHtml(row.model || 'unknown')}<strong>${fmtShort(row.total_tracked_tokens)}</strong></div>
    `).join('') || '<div class="muted">No model summary.</div>';

    const byDay = (snapshot.by_day || []).slice(0, 7).map((row) => `
      <div class="kv">${escapeHtml(row.day)}<strong>${fmtShort(row.total_tracked_tokens)}</strong></div>
    `).join('') || '<div class="muted">No daily summary.</div>';

    els.listContent.innerHTML = `${instructions}
      ${summaryCard('Insights', snapshot.insights?.length ? snapshot.insights : ['No insights generated.'])}
      <div class="summary-card">
        <h3>Project hot spots</h3>
        <div class="summary-grid">${byProject}</div>
      </div>
      <div class="summary-card">
        <h3>Model hot spots</h3>
        <div class="summary-grid">${byModel}</div>
      </div>
      <div class="summary-card">
        <h3>Daily burn</h3>
        <div class="summary-grid">${byDay}</div>
      </div>
      <div class="summary-card">
        <h3>Recent heavy sessions</h3>
        ${recentSessions || '<div class="muted">No recent session data.</div>'}
      </div>
    `;
  }

  setDetail(`
    <div class="detail-section">
      <h3>Token strategy implemented from the video guidance</h3>
      <ul class="mini-list">
        <li>Visibility first: this dashboard surfaces input, output, cache read, cache create, sessions, and project hot spots.</li>
        <li>Earlier manual compaction: target roughly 60% context instead of waiting for late automatic compaction.</li>
        <li>Fresh windows by topic: separate workstreams reduce exponential reread costs.</li>
        <li>Subagents as token savers: send bulky research/review into fresh windows and return only summaries.</li>
        <li>Cheaper subagents where acceptable: move lighter tasks off the most expensive orchestrator model.</li>
      </ul>
    </div>
    <div class="detail-section">
      <h3>How to use</h3>
      <pre>python3 scripts/generate_claude_token_snapshot.py --write apps/mission-control-v1/token_snapshot.json</pre>
    </div>
  `);

  document.getElementById('loadTokenSnapshot')?.addEventListener('click', async () => {
    if (location.protocol === 'file:') {
      alert('Loading ./token_snapshot.json via fetch is unreliable from file:// pages. Use Upload snapshot file instead, or serve the app over a tiny local HTTP server.');
      return;
    }
    try {
      const response = await fetch('./token_snapshot.json');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      saveTokenSnapshot(await response.json());
      renderTokens();
    } catch (error) {
      alert(`Could not load ./token_snapshot.json: ${error.message}`);
    }
  });

  document.getElementById('uploadTokenSnapshot')?.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        saveTokenSnapshot(JSON.parse(text));
        renderTokens();
      } catch (error) {
        alert(`Could not parse token snapshot JSON: ${error.message}`);
      }
    });
    input.click();
  });

  document.getElementById('clearTokenSnapshot')?.addEventListener('click', () => {
    saveTokenSnapshot(null);
    renderTokens();
  });

  setPager({ note: 'Token analytics come from local Claude JSONL sessions, not Supabase.' });
}

async function render() {
  normalizeView();
  buildNav();
  updateHeader();
  configureRefreshLoop();
  switch (state.view) {
    case 'agents':
      await renderAgents();
      break;
    case 'topology':
      await renderTopology();
      break;
    case 'schedule':
      await renderSchedule();
      break;
    case 'tasks':
      await renderTasks();
      break;
    case 'inbox':
      await renderInbox();
      break;
    case 'activity':
      await renderActivity();
      break;
    case 'tokens':
      renderTokens();
      break;
    case 'overview':
    default:
      await renderOverview();
      break;
  }
}

function wireGlobalControls() {
  els.liveToggle.checked = state.live;
  els.refreshMs.value = String(state.refreshMs);
  els.liveToggle.addEventListener('change', () => {
    state.live = els.liveToggle.checked;
    updateHeader();
    configureRefreshLoop();
  });
  els.refreshMs.addEventListener('change', () => {
    state.refreshMs = Number(els.refreshMs.value);
    updateHeader();
    configureRefreshLoop();
  });
  els.refreshNow.addEventListener('click', () => render());
  els.openConfig.addEventListener('click', () => {
    els.supabaseUrlInput.value = state.config.supabaseUrl;
    els.supabaseAnonKeyInput.value = state.config.supabaseAnonKey;
    els.configDialog.showModal();
  });
  els.configForm.addEventListener('submit', (event) => {
    event.preventDefault();
    state.config.supabaseUrl = els.supabaseUrlInput.value.trim();
    state.config.supabaseAnonKey = els.supabaseAnonKeyInput.value.trim();
    localStorage.setItem('mission-control.supabaseUrl', state.config.supabaseUrl);
    localStorage.setItem('mission-control.supabaseAnonKey', state.config.supabaseAnonKey);
    els.configDialog.close();
    render();
  });
  els.clearConfig.addEventListener('click', () => {
    state.config.supabaseUrl = '';
    state.config.supabaseAnonKey = '';
    localStorage.removeItem('mission-control.supabaseUrl');
    localStorage.removeItem('mission-control.supabaseAnonKey');
    els.supabaseUrlInput.value = '';
    els.supabaseAnonKeyInput.value = '';
  });
  window.addEventListener('hashchange', () => {
    state.view = location.hash.replace('#', '') || 'overview';
    state.selected = null;
    render();
  });
}

wireGlobalControls();
render();
