const { settingOps } = require('../database');

function getApiKey(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return req.headers['x-api-key'] || null;
}

function apiKeyAuth(req, res, next) {
  const expected = process.env.API_KEY || 'freebuff-default-key';
  const provided = getApiKey(req);
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: { message: 'Invalid API key', type: 'auth_error' } });
  }
  next();
}

function adminAuth(req, res, next) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return next();

  const provided = req.headers['x-admin-password'] || req.query.password;
  if (provided !== password) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = { apiKeyAuth, adminAuth, getApiKey };
