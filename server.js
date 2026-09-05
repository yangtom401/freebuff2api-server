require('dotenv').config();
const express = require('express');
const path = require('path');
const { init: initDB } = require('./src/database');
const { refreshDynamicModels, log } = require('./src/account-manager');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== Init ====================
log('INFO', 'Starting freebuff2api-server...');
initDB();
log('INFO', 'Database initialized');

// ==================== Middleware ====================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, x-admin-password, x-freebuff-instance-id, anthropic-version, anthropic-beta');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// ==================== Routes ====================

// Health check (no auth)
app.use('/', require('./src/routes/health'));

// API routes (API key auth)
app.use('/', require('./src/routes/api'));

// Admin routes (password auth)
app.use('/admin', require('./src/routes/admin'));

// SPA fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/admin') || req.path.startsWith('/v1')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  log('ERROR', `Unhandled error: ${err.message}`);
  res.status(500).json({ error: { message: 'Internal server error', type: 'server_error' } });
});

// ==================== Start ====================

// Refresh dynamic models on startup and every 6 hours
refreshDynamicModels();
setInterval(refreshDynamicModels, 6 * 60 * 60 * 1000);

// Cleanup old logs daily
setInterval(() => {
  try {
    const { logOps } = require('./src/database');
    logOps.cleanup(7);
    log('INFO', 'Cleaned up old logs (>7 days)');
  } catch {}
}, 24 * 60 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  log('INFO', `Server running on http://0.0.0.0:${PORT}`);
  log('INFO', `Dashboard: http://localhost:${PORT}`);
  log('INFO', `API: http://localhost:${PORT}/v1/chat/completions`);
  log('INFO', `Health: http://localhost:${PORT}/healthz`);
});
