// ==================== State ====================
let adminPassword = '';
let currentPage = 'dashboard';
let oauthSessionId = null;
let oauthPollTimer = null;

// ==================== API ====================
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (adminPassword) headers['x-admin-password'] = adminPassword;
  try {
    const resp = await fetch(path, { ...opts, headers });
    if (resp.status === 401) {
      showLoginModal();
      return null;
    }
    return await resp.json();
  } catch (e) {
    console.error('API error:', e);
    return null;
  }
}

// ==================== Login ====================
function showLoginModal() {
  document.getElementById('login-modal').style.display = 'flex';
  document.getElementById('login-password').focus();
}

function hideLoginModal() {
  document.getElementById('login-modal').style.display = 'none';
}

async function doLogin() {
  adminPassword = document.getElementById('login-password').value;
  const data = await api('/admin/api/dashboard');
  if (data) {
    hideLoginModal();
    navigateTo('dashboard');
  }
}

// ==================== Navigation ====================
function navigateTo(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const pageEl = document.getElementById('page-' + page);
  const navEl = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (pageEl) pageEl.classList.add('active');
  if (navEl) navEl.classList.add('active');

  loadPage(page);
}

async function loadPage(page) {
  switch (page) {
    case 'dashboard': return loadDashboard();
    case 'accounts': return loadAccounts();
    case 'logs': return loadLogs();
    case 'usage': return loadUsage();
    case 'models': return loadModels();
  }
}

// ==================== Dashboard ====================
async function loadDashboard() {
  const data = await api('/admin/api/dashboard');
  if (!data) return;
  document.getElementById('stat-accounts').textContent = data.accounts.total;
  document.getElementById('stat-alive').textContent = data.accounts.alive;
  document.getElementById('stat-requests').textContent = data.requests.today;
  document.getElementById('stat-error-rate').textContent = data.requests.errorRate;
  document.getElementById('stat-tokens').textContent = data.tokens.today.toLocaleString();
  document.getElementById('stat-models').textContent = data.models.total;
  document.getElementById('server-version').textContent = 'v' + data.version;
  document.getElementById('stat-uptime').textContent = formatUptime(data.uptime);
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ==================== Accounts ====================
async function loadAccounts() {
  const data = await api('/admin/api/accounts');
  if (!data) return;
  const container = document.getElementById('accounts-list');
  if (!data.length) {
    container.innerHTML = '<div class="card"><p style="color:var(--text-dim)">No accounts. Click "+ Add Account" to get started.</p></div>';
    return;
  }
  container.innerHTML = data.map(a => `
    <div class="account-card">
      <div class="account-info">
        <div class="account-email">${a.email || 'Unknown'}</div>
        <div class="account-token">${a.token}</div>
      </div>
      <div class="account-status">
        <span class="status-dot ${a.alive ? (a.inCooldown ? 'cooldown' : 'alive') : 'dead'}"></span>
        <span style="font-size:12px;color:var(--text-dim)">${a.state}${a.inCooldown ? ' (cooldown)' : ''}</span>
      </div>
      <div class="account-actions">
        <button class="btn-secondary btn-small" onclick="refreshAccount('${a.id}')">Refresh</button>
        <button class="btn-danger btn-small" onclick="deleteAccount('${a.id}', '${a.email || a.token}')">Delete</button>
      </div>
    </div>
  `).join('');
}

function showAddAccount() {
  document.getElementById('add-account-modal').style.display = 'flex';
}

function hideAddAccount() {
  document.getElementById('add-account-modal').style.display = 'none';
  document.getElementById('oauth-status').style.display = 'none';
  document.getElementById('manual-token').value = '';
  if (oauthPollTimer) { clearTimeout(oauthPollTimer); oauthPollTimer = null; }
  oauthSessionId = null;
}

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[onclick="switchTab('${tab}')"]`).classList.add('active');
  document.getElementById('tab-' + tab).classList.add('active');
}

// OAuth
async function startOAuth() {
  const btn = document.getElementById('btn-oauth');
  btn.disabled = true;
  btn.textContent = 'Starting...';

  const data = await api('/admin/api/oauth/start');
  if (!data || !data.ok) {
    btn.disabled = false;
    btn.textContent = 'Login with Freebuff';
    alert(data?.error || 'Failed to start login');
    return;
  }

  oauthSessionId = data.sessionId;

  // Open login page in new window
  window.open(data.loginUrl, '_blank', 'width=500,height=600');

  // Show status
  document.getElementById('oauth-status').style.display = 'flex';
  document.getElementById('oauth-status-text').textContent = 'Waiting for login...';

  // Start polling
  pollOAuth();
}

async function pollOAuth() {
  if (!oauthSessionId) return;

  const data = await api(`/admin/api/oauth/poll?sessionId=${oauthSessionId}`);
  if (!data) {
    oauthPollTimer = setTimeout(pollOAuth, 3000);
    return;
  }

  if (data.ok) {
    document.getElementById('oauth-status-text').textContent = `Success! Email: ${data.email}`;
    document.getElementById('oauth-status').querySelector('.spinner')?.remove();
    loadAccounts();
    setTimeout(hideAddAccount, 2000);
  } else if (data.status === 'pending') {
    document.getElementById('oauth-status-text').textContent = 'Waiting for login...';
    oauthPollTimer = setTimeout(pollOAuth, 3000);
  } else {
    document.getElementById('oauth-status-text').textContent = data.message || 'Failed';
    document.getElementById('oauth-status').querySelector('.spinner')?.remove();
  }
}

// Manual token
async function addManualToken() {
  const token = document.getElementById('manual-token').value.trim();
  if (!token) return alert('Please enter a token');

  const data = await api('/admin/api/accounts', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });

  if (data?.ok) {
    hideAddAccount();
    loadAccounts();
  } else {
    alert(data?.error || 'Failed to add account');
  }
}

async function refreshAccount(id) {
  const data = await api(`/admin/api/accounts/${id}/refresh`, { method: 'POST' });
  loadAccounts();
}

async function deleteAccount(id, name) {
  if (!confirm(`Delete account ${name}?`)) return;
  await api(`/admin/api/accounts/${id}`, { method: 'DELETE' });
  loadAccounts();
}

// ==================== Logs ====================
async function loadLogs() {
  const data = await api('/admin/api/logs?limit=100');
  if (!data) return;
  const container = document.getElementById('logs-list');
  if (!data.length) {
    container.innerHTML = '<div class="card"><p style="color:var(--text-dim)">No logs yet.</p></div>';
    return;
  }
  container.innerHTML = data.map(l => `
    <div class="log-entry">
      <div class="log-time">${formatTime(l.created_at)}</div>
      <div class="log-model">${l.model || '-'}</div>
      <div class="log-status ${l.status_code < 300 ? 'success' : 'error'}">${l.status_code}</div>
      <div class="log-latency">${l.latency_ms}ms</div>
      <div class="log-tokens">${l.prompt_tokens + l.completion_tokens} tok</div>
    </div>
  `).join('');
}

function refreshLogs() { loadLogs(); }

function formatTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts + 'Z');
  return d.toLocaleTimeString();
}

// ==================== Usage ====================
async function loadUsage() {
  const data = await api('/admin/api/usage');
  if (!data) return;
  const container = document.getElementById('usage-stats');

  let html = '<div class="card"><h3>Today\'s Usage by Account</h3>';
  if (data.accountStats.length) {
    for (const a of data.accountStats) {
      const email = a.email || a.token?.slice(0, 8) + '...' || 'Unknown';
      html += `<div class="stat-row"><span>${email}</span><span>${a.total_requests || 0} requests | ${(a.total_prompt_tokens || 0) + (a.total_completion_tokens || 0)} tokens</span></div>`;
    }
  } else {
    html += '<p style="color:var(--text-dim)">No data yet.</p>';
  }
  html += '</div>';

  html += '<div class="card" style="margin-top:16px"><h3>Today\'s Usage by Model</h3>';
  if (data.daily.length) {
    for (const d of data.daily) {
      html += `<div class="stat-row"><span>${d.model}</span><span>${d.request_count} requests | ${d.prompt_tokens + d.completion_tokens} tokens</span></div>`;
    }
  } else {
    html += '<p style="color:var(--text-dim)">No data yet.</p>';
  }
  html += '</div>';

  container.innerHTML = html;
}

// ==================== Models ====================
async function loadModels() {
  const data = await api('/admin/api/models');
  if (!data) return;
  const container = document.getElementById('models-list');
  container.innerHTML = data.map(m => `
    <div class="model-card">
      <div>
        <div class="model-id">${m.id}</div>
        <div class="model-desc">${m.desc || ''}</div>
      </div>
      <span class="model-category ${m.category}">${m.category}</span>
    </div>
  `).join('');
}

// ==================== Init ====================
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo(item.dataset.page);
  });
});

// Auto-refresh dashboard
setInterval(() => {
  if (currentPage === 'dashboard') loadDashboard();
}, 10000);

// Initial load - check if auth needed
(async () => {
  const data = await api('/admin/api/dashboard');
  if (data) {
    navigateTo('dashboard');
  } else {
    showLoginModal();
  }
})();
