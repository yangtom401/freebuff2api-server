const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'freebuff.db');

let db;

function init() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT,
      token TEXT UNIQUE NOT NULL,
      uid TEXT,
      state TEXT DEFAULT 'unknown',
      alive INTEGER DEFAULT 1,
      quota_json TEXT,
      cooldown_until INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      model TEXT NOT NULL,
      instance_id TEXT,
      run_id TEXT,
      status TEXT DEFAULT 'active',
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT,
      model TEXT,
      endpoint TEXT,
      status_code INTEGER,
      latency_ms INTEGER,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS usage_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      model TEXT NOT NULL,
      date TEXT NOT NULL,
      session_count INTEGER DEFAULT 0,
      request_count INTEGER DEFAULT 0,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      UNIQUE(account_id, model, date)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_token ON accounts(token);
    CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
    CREATE INDEX IF NOT EXISTS idx_logs_account ON request_logs(account_id);
    CREATE INDEX IF NOT EXISTS idx_logs_created ON request_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_daily(date);
  `);

  return db;
}

function getDb() {
  if (!db) init();
  return db;
}

// Account operations
const accountOps = {
  getAll() {
    return getDb().prepare('SELECT * FROM accounts ORDER BY created_at DESC').all();
  },
  getByToken(token) {
    return getDb().prepare('SELECT * FROM accounts WHERE token = ?').get(token);
  },
  getById(id) {
    return getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  },
  upsert(account) {
    const stmt = getDb().prepare(`
      INSERT INTO accounts (id, email, token, uid, state, alive, quota_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET
        email = excluded.email, uid = excluded.uid, state = excluded.state,
        alive = excluded.alive, quota_json = excluded.quota_json, updated_at = datetime('now')
    `);
    return stmt.run(account.id, account.email, account.token, account.uid,
      account.state || 'unknown', account.alive ? 1 : 0, JSON.stringify(account.quota || {}));
  },
  updateState(token, state, alive) {
    getDb().prepare('UPDATE accounts SET state = ?, alive = ?, updated_at = datetime(\'now\') WHERE token = ?')
      .run(state, alive ? 1 : 0, token);
  },
  setCooldown(token, until) {
    getDb().prepare('UPDATE accounts SET cooldown_until = ?, updated_at = datetime(\'now\') WHERE token = ?')
      .run(until, token);
  },
  delete(id) {
    getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id);
  },
  getAlive() {
    return getDb().prepare('SELECT * FROM accounts WHERE alive = 1').all();
  },
  clearCooldowns() {
    getDb().prepare('UPDATE accounts SET cooldown_until = 0').run();
  }
};

// Session operations
const sessionOps = {
  create(accountId, model, instanceId, runId, expiresAt) {
    return getDb().prepare(
      'INSERT INTO sessions (account_id, model, instance_id, run_id, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run(accountId, model, instanceId, runId, expiresAt);
  },
  getActive(accountId, model) {
    return getDb().prepare(
      'SELECT * FROM sessions WHERE account_id = ? AND model = ? AND status = \'active\' AND expires_at > datetime(\'now\')'
    ).get(accountId, model);
  },
  getAllActive() {
    return getDb().prepare(
      'SELECT * FROM sessions WHERE status = \'active\' AND expires_at > datetime(\'now\')'
    ).all();
  },
  expire(id) {
    getDb().prepare('UPDATE sessions SET status = \'expired\' WHERE id = ?').run(id);
  },
  cleanup() {
    getDb().prepare('UPDATE sessions SET status = \'expired\' WHERE expires_at <= datetime(\'now\') AND status = \'active\'').run();
  }
};

// Log operations
const logOps = {
  add(log) {
    return getDb().prepare(
      'INSERT INTO request_logs (account_id, model, endpoint, status_code, latency_ms, prompt_tokens, completion_tokens, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(log.accountId, log.model, log.endpoint, log.statusCode, log.latencyMs, log.promptTokens || 0, log.completionTokens || 0, log.errorMessage || null);
  },
  getRecent(limit = 100) {
    return getDb().prepare('SELECT * FROM request_logs ORDER BY created_at DESC LIMIT ?').all(limit);
  },
  getByAccount(accountId, limit = 50) {
    return getDb().prepare('SELECT * FROM request_logs WHERE account_id = ? ORDER BY created_at DESC LIMIT ?').all(accountId, limit);
  },
  getStats() {
    return getDb().prepare(`
      SELECT
        model,
        COUNT(*) as total_requests,
        SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) as success_count,
        SUM(prompt_tokens) as total_prompt_tokens,
        SUM(completion_tokens) as total_completion_tokens,
        AVG(latency_ms) as avg_latency_ms
      FROM request_logs
      WHERE created_at >= datetime('now', '-1 day')
      GROUP BY model
    `).all();
  },
  getAccountStats() {
    return getDb().prepare(`
      SELECT
        a.id, a.email, a.token, a.state, a.alive,
        COUNT(l.id) as total_requests,
        SUM(l.prompt_tokens) as total_prompt_tokens,
        SUM(l.completion_tokens) as total_completion_tokens
      FROM accounts a
      LEFT JOIN request_logs l ON a.id = l.account_id AND l.created_at >= datetime('now', '-1 day')
      GROUP BY a.id
    `).all();
  },
  cleanup(days = 7) {
    getDb().prepare(`DELETE FROM request_logs WHERE created_at < datetime('now', '-${days} days')`).run();
  }
};

// Usage daily operations
const usageOps = {
  record(accountId, model, promptTokens, completionTokens) {
    const today = new Date().toISOString().split('T')[0];
    const stmt = getDb().prepare(`
      INSERT INTO usage_daily (account_id, model, date, session_count, request_count, prompt_tokens, completion_tokens)
      VALUES (?, ?, ?, 0, 1, ?, ?)
      ON CONFLICT(account_id, model, date) DO UPDATE SET
        request_count = request_count + 1,
        prompt_tokens = prompt_tokens + excluded.prompt_tokens,
        completion_tokens = completion_tokens + excluded.completion_tokens
    `);
    return stmt.run(accountId, model, today, promptTokens, completionTokens);
  },
  getDaily(date) {
    return getDb().prepare('SELECT * FROM usage_daily WHERE date = ?').all(date);
  },
  getRange(startDate, endDate) {
    return getDb().prepare('SELECT * FROM usage_daily WHERE date BETWEEN ? AND ?').all(startDate, endDate);
  }
};

// Settings operations
const settingOps = {
  get(key) {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  },
  set(key, value) {
    getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }
};

module.exports = { init, getDb, accountOps, sessionOps, logOps, usageOps, settingOps };
