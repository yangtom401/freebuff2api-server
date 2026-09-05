const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { adminAuth } = require('../middleware/auth');
const { accountOps, logOps, usageOps } = require('../database');
const { getAllModels } = require('../models');
const { updateHealth, getHealth, log } = require('../account-manager');
const freebuff = require('../freebuff-client');

const router = express.Router();

// In-memory OAuth session tracking
const oauthSessions = new Map();

// All admin routes require password
router.use(adminAuth);

// ==================== Dashboard ====================

router.get('/api/dashboard', (req, res) => {
  const accounts = accountOps.getAll();
  const aliveCount = accounts.filter(a => a.alive).length;
  const now = Date.now();
  const cooldownCount = accounts.filter(a => a.cooldown_until > now).length;

  const todayStats = logOps.getStats();
  const totalRequests = todayStats.reduce((s, r) => s + (r.total_requests || 0), 0);
  const totalSuccess = todayStats.reduce((s, r) => s + (r.success_count || 0), 0);
  const totalTokens = todayStats.reduce((s, r) => s + (r.total_prompt_tokens || 0) + (r.total_completion_tokens || 0), 0);

  res.json({
    accounts: { total: accounts.length, alive: aliveCount, cooldown: cooldownCount },
    requests: { today: totalRequests, success: totalSuccess, errorRate: totalRequests ? ((1 - totalSuccess / totalRequests) * 100).toFixed(1) + '%' : '0%' },
    tokens: { today: totalTokens },
    models: { total: getAllModels().length },
    version: '1.0.0',
    uptime: Math.floor(process.uptime()),
  });
});

// ==================== Accounts ====================

router.get('/api/accounts', (req, res) => {
  const accounts = accountOps.getAll();
  const now = Date.now();
  res.json(accounts.map(a => ({
    id: a.id,
    email: a.email,
    token: a.token.slice(0, 8) + '...' + a.token.slice(-4),
    tokenFull: a.token,
    state: a.state,
    alive: !!a.alive,
    cooldownUntil: a.cooldown_until,
    inCooldown: a.cooldown_until > now,
    createdAt: a.created_at,
  })));
});

router.post('/api/accounts', (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string' || token.length < 10) {
    return res.status(400).json({ error: 'Invalid token' });
  }

  const id = uuidv4();
  accountOps.upsert({ id, email: null, token: token.trim(), uid: null, state: 'unknown', alive: true, quota: {} });
  log('INFO', `Account added: ${token.slice(0, 8)}...`);

  res.json({ ok: true, id, message: 'Account added' });
});

router.delete('/api/accounts/:id', (req, res) => {
  const { id } = req.params;
  const acct = accountOps.getById(id);
  if (!acct) return res.status(404).json({ error: 'Account not found' });

  accountOps.delete(id);
  log('INFO', `Account deleted: ${acct.token.slice(0, 8)}...`);
  res.json({ ok: true });
});

router.post('/api/accounts/:id/refresh', async (req, res) => {
  const { id } = req.params;
  const acct = accountOps.getById(id);
  if (!acct) return res.status(404).json({ error: 'Account not found' });

  try {
    const result = await freebuff.getSession(acct.token, 'deepseek/deepseek-v4-flash');
    if (result.ok) {
      updateHealth(acct.token, 'ok', true);
      res.json({ ok: true, state: 'ok', alive: true, data: result.data });
    } else if (result.reason === 'banned' || result.reason === 'blocked') {
      updateHealth(acct.token, result.reason, false);
      res.json({ ok: true, state: result.reason, alive: false });
    } else if (result.reason === 'rate_limited') {
      updateHealth(acct.token, 'rate_limited', true);
      res.json({ ok: true, state: 'rate_limited', alive: true, retryAfterMs: result.data?.retryAfterMs });
    } else {
      res.json({ ok: true, state: result.reason, alive: acct.alive });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== OAuth Login ====================

router.get('/api/oauth/start', async (req, res) => {
  // Check if there's already an active login
  for (const [key, session] of oauthSessions) {
    if (session.active && (Date.now() - session.startedAt) < 300000) {
      return res.status(409).json({ error: 'Login already in progress' });
    }
  }

  try {
    const result = await freebuff.startOAuthLogin();
    if (!result.ok) {
      return res.status(500).json({ error: 'Failed to start login', detail: result.error });
    }

    const sessionId = uuidv4();
    oauthSessions.set(sessionId, {
      fingerprintId: result.fingerprintId,
      fingerprintHash: result.fingerprintHash,
      expiresAt: result.expiresAt,
      loginUrl: result.loginUrl,
      active: true,
      startedAt: Date.now(),
      result: null,
    });

    // Start polling in background
    pollOAuth(sessionId);

    log('INFO', `OAuth login started: ${result.fingerprintId}`);
    res.json({ ok: true, sessionId, loginUrl: result.loginUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/oauth/poll', (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const session = oauthSessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  if (session.result) {
    // Done
    oauthSessions.delete(sessionId);
    return res.json(session.result);
  }

  if (Date.now() - session.startedAt > 300000) {
    // Timeout
    session.active = false;
    oauthSessions.delete(sessionId);
    return res.json({ ok: false, status: 'timeout', message: 'Login timed out (5 minutes)' });
  }

  res.json({ ok: false, status: 'pending', message: 'Waiting for login...' });
});

router.get('/api/oauth/status', (req, res) => {
  const active = [];
  for (const [id, session] of oauthSessions) {
    if (session.active) {
      active.push({
        sessionId: id,
        startedAt: session.startedAt,
        elapsed: Math.floor((Date.now() - session.startedAt) / 1000),
      });
    }
  }
  res.json({ active });
});

async function pollOAuth(sessionId) {
  const session = oauthSessions.get(sessionId);
  if (!session || !session.active) return;

  try {
    const result = await freebuff.pollOAuthStatus(
      session.fingerprintId,
      session.fingerprintHash,
      session.expiresAt
    );

    if (result.ok && result.user) {
      // Success - save account
      const user = result.user;
      accountOps.upsert({
        id: user.id || uuidv4(),
        email: user.email || null,
        token: user.authToken,
        uid: user.id || null,
        state: 'ok',
        alive: true,
        quota: user.credits ? { credits: user.credits } : {},
      });

      session.result = { ok: true, email: user.email, token: user.authToken, message: 'Login successful' };
      session.active = false;
      log('INFO', `OAuth login success: ${user.email}`);
      return;
    }

    if (result.status === 400) {
      // Expired
      session.result = { ok: false, status: 'expired', message: 'Login expired' };
      session.active = false;
      return;
    }

    // Not yet logged in - continue polling
    if (session.active) {
      setTimeout(() => pollOAuth(sessionId), 3000);
    }
  } catch (e) {
    log('ERROR', `OAuth poll error: ${e.message}`);
    if (session.active) {
      setTimeout(() => pollOAuth(sessionId), 3000);
    }
  }
}

// ==================== Logs ====================

router.get('/api/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const logs = logOps.getRecent(limit);
  res.json(logs);
});

router.get('/api/logs/:accountId', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const logs = logOps.getByAccount(req.params.accountId, limit);
  res.json(logs);
});

// ==================== Usage ====================

router.get('/api/usage', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const daily = usageOps.getDaily(today);
  const accountStats = logOps.getAccountStats();
  res.json({ today, daily, accountStats });
});

router.get('/api/usage/range', (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required (YYYY-MM-DD)' });
  const data = usageOps.getRange(start, end);
  res.json(data);
});

// ==================== Models ====================

router.get('/api/models', (req, res) => {
  res.json(getAllModels());
});

// ==================== Settings ====================

router.get('/api/settings', (req, res) => {
  res.json({
    apiKey: process.env.API_KEY || 'freebuff-default-key',
    adminPassword: process.env.ADMIN_PASSWORD ? '***' : '',
    port: process.env.PORT || 3000,
  });
});

module.exports = router;
