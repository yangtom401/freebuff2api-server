const express = require('express');
const { accountOps } = require('../database');
const { healthCache, sessionCache } = require('../account-manager');

const router = express.Router();

const VERSION = '1.0.0';

router.get('/healthz', (req, res) => {
  const accounts = accountOps.getAll();
  const now = Date.now();
  let aliveCount = 0;
  let unknownCount = 0;
  const states = {};
  const details = [];

  for (const a of accounts) {
    const health = healthCache.get(a.token);
    const state = health?.state || a.state || 'unknown';
    const alive = health?.alive ?? !!a.alive;

    if (alive) aliveCount++;
    else unknownCount++;

    states[state] = (states[state] || 0) + 1;

    details.push({
      token: a.token.slice(0, 8) + '...',
      alive,
      state,
      uid: a.uid,
      cooldown: a.cooldown_until > now,
    });
  }

  const status = aliveCount > 0 ? 'ok' : accounts.length > 0 ? 'critical' : 'no_accounts';

  res.json({
    status,
    version: VERSION,
    accounts: accounts.length,
    alive_accounts: aliveCount,
    unknown_accounts: unknownCount,
    account_states: states,
    account_details: details,
    health_source: 'runtime',
    time: new Date().toISOString(),
  });
});

module.exports = router;
