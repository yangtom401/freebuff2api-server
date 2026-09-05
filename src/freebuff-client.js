const { v4: uuidv4 } = require('uuid');

const CODEBUFF_API = 'https://www.codebuff.com';
const TIMEOUT_MS = 20000;
const NONSTREAM_TIMEOUT_MS = 45000;
const SESSION_POLL_INTERVAL_MS = 1500;
const SESSION_POLL_MAX = 8;
const CHAIN_GAP_MS = 300;

let chainTail = Promise.resolve();

function enqueue(fn) {
  const prev = chainTail;
  chainTail = prev.then(fn, fn);
  return chainTail;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

// ==================== Session Management ====================

async function getSession(token, model) {
  try {
    const resp = await fetchWithTimeout(`${CODEBUFF_API}/api/v1/freebuff/session`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-freebuff-include-unused-rate-limits': '1',
      }
    });
    if (resp.status === 200) {
      const data = await resp.json();
      return { ok: true, data };
    }
    if (resp.status === 404) return { ok: false, reason: 'no_session' };
    if (resp.status === 429) {
      const data = await resp.json().catch(() => ({}));
      return { ok: false, reason: 'rate_limited', data };
    }
    if (resp.status === 403) {
      const data = await resp.json().catch(() => ({}));
      return { ok: false, reason: 'blocked', data };
    }
    if (resp.status === 428) return { ok: false, reason: 'waiting_room' };
    if (resp.status === 409) return { ok: false, reason: 'session_superseded' };
    return { ok: false, reason: 'unknown', status: resp.status };
  } catch (e) {
    return { ok: false, reason: 'error', error: e.message };
  }
}

async function createSession(token, model, instanceId) {
  try {
    const resp = await fetchWithTimeout(`${CODEBUFF_API}/api/v1/freebuff/session`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-freebuff-model': model,
        'x-freebuff-instance-id': instanceId,
      },
      body: JSON.stringify({})
    });
    if (resp.status === 200) {
      const data = await resp.json();
      if (data.status === 'queued') {
        for (let i = 0; i < SESSION_POLL_MAX; i++) {
          await new Promise(r => setTimeout(r, SESSION_POLL_INTERVAL_MS));
          const check = await fetchWithTimeout(`${CODEBUFF_API}/api/v1/freebuff/session`, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${token}`,
              'x-freebuff-include-unused-rate-limits': '1',
            }
          });
          if (check.status === 200) {
            const q = await check.json();
            if (q.status === 'active') return { ok: true, data: q };
          }
        }
        return { ok: false, reason: 'still_queued' };
      }
      return { ok: true, data };
    }
    const data = await resp.json().catch(() => ({}));
    return { ok: false, reason: `status_${resp.status}`, data };
  } catch (e) {
    return { ok: false, reason: 'error', error: e.message };
  }
}

async function deleteSession(token, instanceId) {
  try {
    await fetchWithTimeout(`${CODEBUFF_API}/api/v1/freebuff/session`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-freebuff-instance-id': instanceId,
      }
    });
  } catch {}
}

// ==================== Agent Runs ====================

async function startRun(token, agentId, instanceId) {
  try {
    const resp = await fetchWithTimeout(`${CODEBUFF_API}/api/v1/agent-runs`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-freebuff-instance-id': instanceId,
      },
      body: JSON.stringify({
        action: 'START',
        agentId,
        ancestorRunIds: [],
      })
    });
    if (resp.status === 200) {
      const data = await resp.json();
      return { ok: true, runId: data.runId };
    }
    return { ok: false, status: resp.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function startChildRun(token, agentId, instanceId, parentRunId) {
  try {
    const resp = await fetchWithTimeout(`${CODEBUFF_API}/api/v1/agent-runs`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-freebuff-instance-id': instanceId,
      },
      body: JSON.stringify({
        action: 'START',
        agentId,
        ancestorRunIds: [parentRunId],
      })
    });
    if (resp.status === 200) {
      const data = await resp.json();
      return { ok: true, childRunId: data.runId };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

async function finishRun(token, runId, instanceId) {
  try {
    await fetchWithTimeout(`${CODEBUFF_API}/api/v1/agent-runs`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-freebuff-instance-id': instanceId,
      },
      body: JSON.stringify({
        action: 'FINISH',
        runId,
        status: 'completed',
        totalSteps: 1,
        directCredits: 0,
        totalCredits: 0,
      })
    });
  } catch {}
}

async function recordStep(token, runId, instanceId, messageId) {
  try {
    await fetchWithTimeout(`${CODEBUFF_API}/api/v1/agent-runs/${runId}/steps`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-freebuff-instance-id': instanceId,
      },
      body: JSON.stringify({
        stepNumber: 1,
        credits: 0,
        childRunIds: [],
        messageId,
        status: 'completed',
        startTime: Date.now(),
      })
    });
  } catch {}
}

// ==================== Chat Completions ====================

function buildBuffyMessages(messages) {
  const msgs = Array.isArray(messages) ? [...messages] : [];
  const buffyPrefix = 'You are Buffy, the strategic coding assistant.';
  if (msgs.length > 0 && msgs[0].role === 'system') {
    if (!msgs[0].content.startsWith(buffyPrefix)) {
      msgs[0] = { ...msgs[0], content: `${buffyPrefix}\n\n${msgs[0].content}` };
    }
  } else {
    msgs.unshift({ role: 'system', content: buffyPrefix });
  }
  return msgs;
}

function buildUpstreamBody(params, instanceId, runId) {
  const body = {
    model: params.model || 'deepseek/deepseek-v4-flash',
    messages: buildBuffyMessages(params.messages),
    stream: true,
    stop: ['"cb_easp"'],
    provider: { data_collection: 'deny' },
    codebuff_metadata: {
      freebuff_instance_id: instanceId,
      trace_session_id: instanceId,
      run_id: runId,
      cost_mode: 'free',
    },
  };
  if (params.max_tokens) body.max_tokens = params.max_tokens;
  if (params.temperature != null) body.temperature = params.temperature;
  if (params.top_p != null) body.top_p = params.top_p;
  if (params.tools) {
    body.tools = params.tools;
    body.tool_choice = params.tool_choice || 'auto';
    body.stop = [...(body.stop || []), '"cb_tool_use"'];
  }
  if (params.stream === false) body.stream = false;
  return body;
}

async function chatCompletion(token, params, instanceId, runId) {
  const body = buildUpstreamBody(params, instanceId, runId);
  const resp = await fetchWithTimeout(`${CODEBUFF_API}/api/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-freebuff-instance-id': instanceId,
      'User-Agent': 'Codebuff/0.0.51',
    },
    body: JSON.stringify(body),
  }, params.stream === false ? NONSTREAM_TIMEOUT_MS : TIMEOUT_MS);
  return resp;
}

// ==================== Streak & Ad ====================

async function tryStreak(token) {
  try {
    await fetchWithTimeout(`${CODEBUFF_API}/api/v1/freebuff/streak`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
  } catch {}
}

async function tryAd(token, instanceId) {
  try {
    await fetchWithTimeout(`${CODEBUFF_API}/api/v1/ads`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-freebuff-instance-id': instanceId,
      },
      body: JSON.stringify({ type: 'session' })
    });
  } catch {}
}

// ==================== OAuth Login ====================

async function startOAuthLogin() {
  const fingerprintId = 'codebuff-cli-' + Math.random().toString(36).slice(2, 8) + '-' + Math.random().toString(36).slice(2, 4);
  try {
    const resp = await fetchWithTimeout(`${CODEBUFF_API}/api/auth/cli/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fingerprintId })
    });
    if (resp.status === 200) {
      const data = await resp.json();
      return { ok: true, loginUrl: data.loginUrl, fingerprintId, fingerprintHash: data.fingerprintHash, expiresAt: data.expiresAt };
    }
    return { ok: false, status: resp.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function pollOAuthStatus(fingerprintId, fingerprintHash, expiresAt) {
  const url = `${CODEBUFF_API}/api/auth/cli/status?fingerprintId=${encodeURIComponent(fingerprintId)}&fingerprintHash=${encodeURIComponent(fingerprintHash)}&expiresAt=${encodeURIComponent(expiresAt)}`;
  try {
    const resp = await fetchWithTimeout(url, { method: 'GET' });
    if (resp.status === 200) {
      const data = await resp.json();
      if (data.user) return { ok: true, user: data.user };
    }
    return { ok: false, status: resp.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  CODEBUFF_API,
  CHAIN_GAP_MS,
  enqueue,
  fetchWithTimeout,
  getSession,
  createSession,
  deleteSession,
  startRun,
  startChildRun,
  finishRun,
  recordStep,
  chatCompletion,
  buildBuffyMessages,
  buildUpstreamBody,
  tryStreak,
  tryAd,
  startOAuthLogin,
  pollOAuthStatus,
};
