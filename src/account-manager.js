const { v4: uuidv4 } = require('uuid');
const { accountOps, sessionOps, logOps, usageOps } = require('./database');
const freebuff = require('./freebuff-client');

const MAX_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const SESSION_REUSE_THRESHOLD_MS = 60000;
const SESSION_TTL_MS = 55 * 60 * 1000;
const RUN_CACHE_TTL_MS = 10 * 60 * 1000;
const HEALTH_OBSERVATION_TTL_MS = 10 * 60 * 1000;

// In-memory caches
const sessionCache = new Map();   // `${token}:${model}` -> { instanceId, expiresAt }
const runCache = new Map();       // `${token}:${agentId}` -> { runId, childRunId, ts }
const healthCache = new Map();    // token -> { alive, state, checkedAt }
let roundRobinIdx = 0;

function log(level, ...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}]`, ...args);
}

// ==================== Token Selection ====================

function pickToken(model) {
  const accounts = accountOps.getAll();
  if (!accounts.length) return null;

  const now = Date.now();

  // Priority 1: reuse active session
  for (const acct of accounts) {
    if (!acct.alive) continue;
    const cacheKey = `${acct.token}:${model}`;
    const cached = sessionCache.get(cacheKey);
    if (cached && cached.expiresAt > now + SESSION_REUSE_THRESHOLD_MS) {
      return { account: acct, instanceId: cached.instanceId };
    }
  }

  // Priority 2: round-robin skip cooldown
  const eligible = accounts.filter(a => a.alive && a.cooldown_until <= now);
  if (eligible.length > 0) {
    const idx = roundRobinIdx % eligible.length;
    roundRobinIdx = (roundRobinIdx + 1) % eligible.length;
    return { account: eligible[idx] };
  }

  // Fallback: pick oldest cooldown
  const sorted = [...accounts].filter(a => a.alive).sort((a, b) => a.cooldown_until - b.cooldown_until);
  if (sorted.length > 0) return { account: sorted[0] };

  return null;
}

// ==================== Cooldown ====================

function setCooldown(token, retryAfterMs) {
  const duration = Math.min(retryAfterMs || 60000, MAX_COOLDOWN_MS);
  const until = Date.now() + duration;
  accountOps.setCooldown(token, until);
  log('WARN', `Account ${token.slice(0, 8)}... cooldown ${Math.round(duration / 1000)}s`);
}

function parseRetryAfter(response) {
  const header = response.headers?.get?.('Retry-After');
  if (header) {
    const sec = parseInt(header, 10);
    if (!isNaN(sec)) return sec * 1000;
  }
  return null;
}

// ==================== Account Health ====================

function updateHealth(token, state, alive = true) {
  healthCache.set(token, { alive, state, checkedAt: Date.now() });
  accountOps.updateState(token, state, alive);
}

function getHealth(token) {
  const h = healthCache.get(token);
  if (h && (Date.now() - h.checkedAt) < HEALTH_OBSERVATION_TTL_MS) return h;
  return null;
}

// ==================== Session Management ====================

async function ensureSession(token, model) {
  const cacheKey = `${token}:${model}`;
  const cached = sessionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + SESSION_REUSE_THRESHOLD_MS) {
    return { ok: true, instanceId: cached.instanceId };
  }

  // Try GET first
  const get = await freebuff.getSession(token, model);
  if (get.ok && get.data?.instanceId) {
    const expiresAt = Date.now() + SESSION_TTL_MS;
    sessionCache.set(cacheKey, { instanceId: get.data.instanceId, expiresAt });
    return { ok: true, instanceId: get.data.instanceId };
  }

  if (get.reason === 'banned' || get.reason === 'blocked') {
    updateHealth(token, get.reason, false);
    return { ok: false, reason: get.reason };
  }

  if (get.reason === 'rate_limited') {
    const retryMs = get.data?.retryAfterMs || 300000;
    setCooldown(token, retryMs);
    return { ok: false, reason: 'rate_limited' };
  }

  // Create new session
  const instanceId = uuidv4();
  await freebuff.tryAd(token, instanceId);
  await freebuff.tryStreak(token);

  const create = await freebuff.createSession(token, model, instanceId);
  if (create.ok && create.data?.instanceId) {
    const iid = create.data.instanceId;
    const expiresAt = Date.now() + SESSION_TTL_MS;
    sessionCache.set(cacheKey, { instanceId: iid, expiresAt });
    return { ok: true, instanceId: iid };
  }

  log('ERROR', `Create session failed: ${create.reason}`);
  return { ok: false, reason: create.reason };
}

// ==================== Run Management ====================

async function ensureRuns(token, model, agentId, instanceId) {
  const cacheKey = `${token}:${agentId}`;
  const cached = runCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < RUN_CACHE_TTL_MS) {
    return { ok: true, runId: cached.runId, childRunId: cached.childRunId };
  }

  // Start main run
  const main = await freebuff.startRun(token, agentId, instanceId);
  if (!main.ok) return { ok: false, reason: 'start_run_failed' };

  // Start child (context-pruner)
  const child = await freebuff.startChildRun(token, 'context-pruner', instanceId, main.runId);

  // Record step for main
  await freebuff.recordStep(token, main.runId, instanceId, uuidv4());

  runCache.set(cacheKey, {
    runId: main.runId,
    childRunId: child.ok ? child.childRunId : null,
    ts: Date.now()
  });

  return { ok: true, runId: main.runId, childRunId: child.ok ? child.childRunId : null };
}

async function finishRuns(token, agentId, instanceId) {
  const cacheKey = `${token}:${agentId}`;
  const cached = runCache.get(cacheKey);
  if (cached) {
    if (cached.childRunId) await freebuff.finishRun(token, cached.childRunId, instanceId);
    await freebuff.finishRun(token, cached.runId, instanceId);
    runCache.delete(cacheKey);
  }
}

// ==================== Main Request Handler ====================

async function handleRequest(params, onChunk, onEnd, onError) {
  const model = params.model || 'deepseek/deepseek-v4-flash';
  const models = getModels();
  const modelConfig = models.find(m => m.id === model);
  const agentId = modelConfig?.agent || 'base2-free-deepseek-flash';

  const maxRetries = Math.min(accountOps.getAlive().length, 10);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const pick = pickToken(model);
    if (!pick) {
      return onError({ status: 503, message: 'No available accounts' });
    }

    const token = pick.account.token;
    let instanceId = pick.instanceId;

    // Ensure session
    if (!instanceId) {
      const sess = await ensureSession(token, model);
      if (!sess.ok) {
        if (sess.reason === 'banned' || sess.reason === 'blocked') continue;
        setCooldown(token, 60000);
        continue;
      }
      instanceId = sess.instanceId;
    }

    // Ensure runs
    const runs = await ensureRuns(token, model, agentId, instanceId);
    if (!runs.ok) {
      setCooldown(token, 60000);
      continue;
    }

    try {
      const startTime = Date.now();
      const response = await freebuff.chatCompletion(token, params, instanceId, runs.runId);
      const latencyMs = Date.now() - startTime;

      if (response.status >= 400) {
        let errBody;
        try { errBody = await response.json(); } catch { errBody = {}; }

        const errMsg = errBody?.error?.message || `Status ${response.status}`;

        logOps.add({
          accountId: pick.account.id,
          model,
          endpoint: '/v1/chat/completions',
          statusCode: response.status,
          latencyMs,
          errorMessage: errMsg,
        });

        if (response.status === 429) {
          const retryMs = parseRetryAfter(response) || errBody?.retryAfterMs || 300000;
          setCooldown(token, retryMs);
          continue;
        }
        if (response.status === 428 || response.status === 409) {
          const cacheKey = `${token}:${model}`;
          sessionCache.delete(cacheKey);
          await freebuff.deleteSession(token, instanceId);
          continue;
        }
        if (response.status === 401) {
          updateHealth(token, 'token_invalid', false);
          continue;
        }
        if (response.status === 403) {
          updateHealth(token, errBody?.status || 'blocked', false);
          continue;
        }

        return onError({ status: response.status, message: errMsg });
      }

      // Success - stream or aggregate
      if (params.stream === false) {
        const data = await aggregateStream(response, token, model, agentId, instanceId, runs.childRunId);
        logOps.add({
          accountId: pick.account.id, model, endpoint: '/v1/chat/completions',
          statusCode: 200, latencyMs,
          promptTokens: data.usage?.prompt_tokens || 0,
          completionTokens: data.usage?.completion_tokens || 0,
        });
        usageOps.record(pick.account.id, model, data.usage?.prompt_tokens || 0, data.usage?.completion_tokens || 0);
        updateHealth(token, 'ok', true);
        await finishRuns(token, agentId, instanceId);
        return onEnd(data);
      } else {
        await streamResponse(response, token, model, agentId, instanceId, runs.childRunId, onChunk, onEnd, pick.account.id, latencyMs);
        return;
      }
    } catch (e) {
      log('ERROR', `Request failed: ${e.message}`);
      setCooldown(token, 60000);
      continue;
    }
  }

  return onError({ status: 503, message: 'All accounts exhausted' });
}

// ==================== Stream Handling ====================

async function streamResponse(response, token, model, agentId, instanceId, childRunId, onChunk, onEnd, accountId, latencyMs) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (raw === '[DONE]') {
          onChunk('data: [DONE]\n\n');
          continue;
        }
        try {
          const obj = JSON.parse(raw);
          if (obj.usage) {
            promptTokens = obj.usage.prompt_tokens || promptTokens;
            completionTokens = obj.usage.completion_tokens || completionTokens;
          }
          // Unwrap data envelope
          const unwrapped = obj.data || obj;
          onChunk(`data: ${JSON.stringify(unwrapped)}\n\n`);
        } catch {}
      }
    }
  } catch (e) {
    log('ERROR', `Stream error: ${e.message}`);
  }

  logOps.add({
    accountId, model, endpoint: '/v1/chat/completions',
    statusCode: 200, latencyMs,
    promptTokens, completionTokens,
  });
  usageOps.record(accountId, model, promptTokens, completionTokens);
  updateHealth(token, 'ok', true);
  await finishRuns(token, agentId, instanceId);
  onEnd();
}

async function aggregateStream(response, token, model, agentId, instanceId, childRunId) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoningContent = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let finishReason = null;
  let id = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (raw === '[DONE]') continue;
      try {
        const obj = JSON.parse(raw);
        const unwrapped = obj.data || obj;
        if (unwrapped.id && !id) id = unwrapped.id;
        if (unwrapped.usage) {
          promptTokens = unwrapped.usage.prompt_tokens || promptTokens;
          completionTokens = unwrapped.usage.completion_tokens || completionTokens;
        }
        const choice = unwrapped.choices?.[0];
        if (choice) {
          if (choice.delta?.content) content += choice.delta.content;
          if (choice.delta?.reasoning_content) reasoningContent += choice.delta.reasoning_content;
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
      } catch {}
    }
  }

  return {
    id: id || `chatcmpl-${uuidv4()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content, reasoning_content: reasoningContent || undefined },
      finish_reason: finishReason || 'stop',
    }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
}

// ==================== Models ====================

const STATIC_MODELS = [
  { id: 'deepseek/deepseek-v4-flash', session: 'deepseek/deepseek-v4-flash', agent: 'base2-free-deepseek-flash', upstream: 'deepseek/deepseek-v4-flash', category: 'standard' },
  { id: 'mimo/mimo-v2.5', session: 'mimo/mimo-v2.5', agent: 'base2-free-mimo', upstream: 'mimo/mimo-v2.5', category: 'standard' },
  { id: 'deepseek/deepseek-v4-pro', session: 'deepseek/deepseek-v4-pro', agent: 'base2-free-deepseek', upstream: 'deepseek/deepseek-v4-pro', category: 'premium' },
  { id: 'minimax/minimax-m3', session: 'minimax/minimax-m3', agent: 'base2-free-minimax-m3', upstream: 'minimax/minimax-m3', category: 'premium' },
  { id: 'openai/gpt-5.6-luna', session: 'openai/gpt-5.6-luna', agent: 'base2-free-luna', upstream: 'openai/gpt-5.6-luna', category: 'premium' },
  { id: 'poolside/laguna-s-2.1', session: 'poolside/laguna-s-2.1', agent: 'base2-free-laguna-s-2-1', upstream: 'poolside/laguna-s-2.1', category: 'premium' },
  { id: 'openrouter/poolside/laguna-s-2.1', session: 'openrouter/poolside/laguna-s-2.1', agent: 'base2-free-laguna-s-2-1-openrouter', upstream: 'openrouter/poolside/laguna-s-2.1', category: 'premium' },
  { id: 'inclusionai/ling-3.0-flash:free', session: 'inclusionai/ling-3.0-flash:free', agent: 'base2-free-ling-3-flash', upstream: 'inclusionai/ling-3.0-flash:free', category: 'premium' },
  { id: 'crof/greg-2-ultra', session: 'crof/greg-2-ultra', agent: 'base2-free-greg-2-ultra', upstream: 'crof/greg-2-ultra', category: 'premium' },
  { id: 'crof/greg-2-super', session: 'crof/greg-2-super', agent: 'base2-free-greg-2-super', upstream: 'crof/greg-2-super', category: 'premium' },
  { id: 'meta/muse-spark-1.2-contributor', session: 'meta/muse-spark-1.2-contributor', agent: 'base2-free-muse-spark', upstream: 'meta/muse-spark-1.2-contributor', category: 'premium' },
  { id: 'z-ai/glm-5.3-flash', session: 'z-ai/glm-5.3-flash', agent: 'base2-free-glm', upstream: 'z-ai/glm-5.3-flash', category: 'glm' },
  { id: 'anthropic/claude-fable-5', session: 'anthropic/claude-fable-5', agent: 'base2-free-fable', upstream: 'anthropic/claude-fable-5', category: 'special' },
];

let dynamicModels = [];
let lastDynamicFetch = 0;
const DYNAMIC_REFRESH_MS = 6 * 60 * 60 * 1000;

async function refreshDynamicModels() {
  if (Date.now() - lastDynamicFetch < DYNAMIC_REFRESH_MS) return;
  try {
    const resp = await freebuff.fetchWithTimeout('https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/constants/free-agents.ts', {}, 10000);
    if (resp.ok) {
      const text = await resp.text();
      const match = text.match(/FREEBUFF_ROOT_AGENT_ID_BY_MODEL\s*=\s*\{([^}]+)\}/s);
      if (match) {
        const pairs = match[1].matchAll(/["']([^"']+)["']\s*:\s*["']([^"']+)["']/g);
        dynamicModels = [...pairs].map(([_, model, agent]) => ({
          id: model, session: model, agent, upstream: model, category: 'dynamic'
        }));
        lastDynamicFetch = Date.now();
        log('INFO', `Refreshed ${dynamicModels.length} dynamic models`);
      }
    }
  } catch (e) {
    log('WARN', `Dynamic model refresh failed: ${e.message}`);
  }
}

function getModels() {
  return [...STATIC_MODELS, ...dynamicModels];
}

module.exports = {
  pickToken,
  setCooldown,
  updateHealth,
  getHealth,
  ensureSession,
  ensureRuns,
  finishRuns,
  handleRequest,
  getModels,
  refreshDynamicModels,
  sessionCache,
  runCache,
  healthCache,
  log,
};
