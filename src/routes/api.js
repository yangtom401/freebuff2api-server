const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { apiKeyAuth } = require('../middleware/auth');
const { getAllModels, findModel } = require('../models');
const { handleRequest } = require('../account-manager');

const router = express.Router();

// ==================== Models ====================

router.get('/v1/models', apiKeyAuth, (req, res) => {
  const models = getAllModels();
  res.json({
    object: 'list',
    data: models.map(m => ({
      id: m.id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'freebuff',
      permission: [],
      root: m.id,
      parent: null,
    }))
  });
});

// ==================== OpenAI Chat Completions ====================

router.post('/v1/chat/completions', apiKeyAuth, (req, res) => {
  const params = req.body;
  if (!params.messages || !Array.isArray(params.messages)) {
    return res.status(400).json({ error: { message: 'messages is required', type: 'invalid_request_error' } });
  }

  const model = params.model || 'deepseek/deepseek-v4-flash';
  const modelConfig = findModel(model);
  if (!modelConfig) {
    return res.status(400).json({ error: { message: `Model not available: ${model}`, type: 'invalid_request_error' } });
  }

  const stream = params.stream !== false;

  if (!stream) {
    // Non-streaming
    handleRequest(params, null, (data) => {
      res.json(data);
    }, (err) => {
      res.status(err.status || 500).json({ error: { message: err.message, type: 'server_error' } });
    });
  } else {
    // Streaming - set headers first
    let headersSent = false;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    headersSent = true;

    handleRequest(params, (chunk) => {
      if (!res.writableEnded) res.write(chunk);
    }, () => {
      if (!res.writableEnded) res.end();
    }, (err) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'server_error' } })}\n\n`);
        res.end();
      }
    });
  }
});

// ==================== OpenAI Responses API ====================

router.post('/v1/responses', apiKeyAuth, (req, res) => {
  const body = req.body;
  const input = body.input;
  const instructions = body.instructions;

  // Convert to chat messages
  const messages = [];
  if (instructions) messages.push({ role: 'system', content: instructions });
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
      } else if (item.type === 'message' && item.content) {
        const role = item.role || 'user';
        if (typeof item.content === 'string') {
          messages.push({ role, content: item.content });
        } else if (Array.isArray(item.content)) {
          const text = item.content.filter(p => p.type === 'output_text').map(p => p.text).join('');
          if (text) messages.push({ role, content: text });
        }
      }
    }
  }

  const params = {
    model: body.model || 'deepseek/deepseek-v4-flash',
    messages,
    stream: body.stream !== false,
    max_tokens: body.max_output_tokens,
    temperature: body.temperature,
  };

  const stream = params.stream;

  if (!stream) {
    handleRequest(params, null, (data) => {
      // Convert to Responses format
      const response = {
        id: data.id,
        object: 'response',
        created_at: data.created,
        model: data.model,
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: data.choices?.[0]?.message?.content || '',
          }]
        }],
        usage: data.usage,
      };
      res.json(response);
    }, (err) => {
      res.status(err.status || 500).json({ error: { message: err.message } });
    });
  } else {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const responseId = `resp_${uuidv4().replace(/-/g, '').slice(0, 24)}`;

    // Send initial events
    res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: responseId, object: 'response', model: params.model, output: [] } })}\n\n`);
    res.write(`event: response.in_progress\ndata: ${JSON.stringify({ type: 'response.in_progress', response: { id: responseId } })}\n\n`);

    handleRequest(params, (chunk) => {
      // Parse SSE chunk and convert to Responses format
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (raw === '[DONE]') {
          res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: responseId, status: 'completed' } })}\n\n`);
          continue;
        }
        try {
          const obj = JSON.parse(raw);
          const choice = obj.choices?.[0];
          if (choice?.delta?.content) {
            res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: choice.delta.content, item_id: responseId })}\n\n`);
          }
        } catch {}
      }
    }, () => {
      res.end();
    }, (err) => {
      res.end();
    });
  }
});

// ==================== Anthropic Messages API ====================

function anthropicText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
}

function anthropicContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text' && typeof p.text === 'string') out.push({ type: 'text', text: p.text });
    if (p.type === 'image' && p.source && typeof p.source === 'object') {
      const s = p.source;
      if (s.type === 'base64' && s.media_type && s.data) out.push({ type: 'image_url', image_url: { url: `data:${s.media_type};base64,${s.data}` } });
      else if (s.type === 'url' && s.url) out.push({ type: 'image_url', image_url: { url: s.url } });
    }
  }
  return out;
}

function anthropicToChat(body, modelId) {
  const chat = { model: modelId, stream: !!body.stream, messages: [] };
  if (body.stream) chat.stream_options = { include_usage: true };

  const system = anthropicText(body.system);
  if (system) chat.messages.push({ role: 'system', content: system });
  if (body.max_tokens != null) chat.max_tokens = body.max_tokens;
  for (const k of ['temperature', 'top_p', 'top_k', 'presence_penalty', 'frequency_penalty']) {
    if (body[k] != null) chat[k] = body[k];
  }
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) chat.stop = body.stop_sequences;
  if (body.thinking?.type === 'enabled' && Number.isFinite(body.thinking.budget_tokens)) {
    chat.reasoning_effort = body.thinking.budget_tokens >= 16000 ? 'high' : body.thinking.budget_tokens >= 8000 ? 'medium' : 'low';
  }

  if (Array.isArray(body.tools) && body.tools.length) {
    chat.tools = body.tools.filter(t => t?.name).map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } }
    }));
    const tc = body.tool_choice;
    if (tc?.type === 'auto') chat.tool_choice = 'auto';
    else if (tc?.type === 'any') chat.tool_choice = 'required';
    else if (tc?.type === 'none') chat.tool_choice = 'none';
    else if (tc?.type === 'tool' && tc.name) chat.tool_choice = { type: 'function', function: { name: tc.name } };
  }

  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'user') {
      const parts = Array.isArray(m.content) ? m.content : [];
      const results = parts.filter(p => p?.type === 'tool_result');
      if (results.length) {
        for (const p of results) chat.messages.push({ role: 'tool', tool_call_id: p.tool_use_id || '', content: anthropicContent(p.content) });
        const text = parts.filter(p => p?.type === 'text' && p.text).map(p => p.text).join('\n');
        if (text) chat.messages.push({ role: 'user', content: text });
      } else {
        chat.messages.push({ role: 'user', content: anthropicContent(m.content) });
      }
    } else if (m.role === 'assistant') {
      const uses = Array.isArray(m.content) ? m.content.filter(p => p?.type === 'tool_use') : [];
      if (uses.length) {
        chat.messages.push({
          role: 'assistant',
          content: anthropicText(m.content),
          tool_calls: uses.map(p => ({
            id: p.id || `call_${Math.random().toString(36).slice(2, 10)}`,
            type: 'function',
            function: { name: p.name || '', arguments: JSON.stringify(p.input ?? {}) }
          }))
        });
      } else {
        chat.messages.push({ role: 'assistant', content: anthropicText(m.content) });
      }
    }
  }
  return chat;
}

function anthropicStopReason(reason) {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  return 'end_turn';
}

function anthropicFromChat(oai, modelId) {
  const choice = oai?.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
    content.push({ type: 'tool_use', id: tc.id || `toolu_${Math.random().toString(36).slice(2, 10)}`, name: tc.function?.name || '', input });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  const u = oai?.usage || {};
  return {
    id: oai?.id || `msg_${Math.random().toString(36).slice(2, 10)}`,
    type: 'message', role: 'assistant', model: modelId, content,
    stop_reason: anthropicStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 }
  };
}

function anthropicError(message, type, status) {
  return { status, body: { type: 'error', error: { type: type || 'api_error', message: String(message || 'Upstream error') } } };
}

function estimateAnthropicTokens(value) {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((n, x) => n + estimateAnthropicTokens(x), 0);
  if (value && typeof value === 'object') return Object.entries(value).reduce((n, [k, v]) => n + k.length + estimateAnthropicTokens(v), 0);
  return 0;
}

router.post('/v1/messages', apiKeyAuth, (req, res) => {
  const body = req.body;
  if (!body.messages || !Array.isArray(body.messages)) {
    const err = anthropicError('messages is required', 'invalid_request_error', 400);
    return res.status(err.status).json(err.body);
  }

  const model = body.model || 'deepseek/deepseek-v4-flash';
  const modelConfig = findModel(model);
  if (!modelConfig) {
    const err = anthropicError(`Model not available: ${model}`, 'invalid_request_error', 400);
    return res.status(err.status).json(err.body);
  }

  const chat = anthropicToChat(body, modelConfig.id);
  const stream = chat.stream;

  if (!stream) {
    handleRequest(chat, null, (data) => {
      res.json(anthropicFromChat(data, modelConfig.id));
    }, (err) => {
      const types = { 400: 'invalid_request_error', 401: 'authentication_error', 429: 'rate_limit_error', 503: 'overloaded_error' };
      const aErr = anthropicError(err.message, types[err.status] || 'api_error', err.status || 500);
      res.status(aErr.status).json(aErr.body);
    });
  } else {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sendEvent = (name, data) => {
      if (!data.type) data.type = name;
      if (!res.writableEnded) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let started = false;
    let blockIndex = -1;
    let block = null;
    let reason = 'end_turn';
    let inputTokens = 0;
    let outputTokens = 0;

    const closeBlock = () => {
      if (block) {
        sendEvent('content_block_stop', { index: block.index });
        block = null;
      }
    };

    handleRequest(chat, (chunk) => {
      // Parse upstream SSE and convert to Anthropic format
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (raw === '[DONE]') continue;
        try {
          const obj = JSON.parse(raw);
          const choice = obj.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta || {};

          if (!started) {
            started = true;
            sendEvent('message_start', {
              message: { id: `msg_${Math.random().toString(36).slice(2, 10)}`, type: 'message', role: 'assistant', model: modelConfig.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } }
            });
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const fn = tc.function || {};
              const idx = tc.index ?? 0;
              if (!block || block.kind !== 'tool' || block.sourceIndex !== idx) {
                closeBlock();
                block = { index: ++blockIndex, kind: 'tool', sourceIndex: idx };
                sendEvent('content_block_start', { index: block.index, content_block: { type: 'tool_use', id: tc.id || `toolu_${Math.random().toString(36).slice(2, 10)}`, name: fn.name || '', input: {} } });
              }
              if (fn.arguments) sendEvent('content_block_delta', { index: block.index, delta: { type: 'input_json_delta', partial_json: fn.arguments } });
            }
          } else if (delta.content) {
            if (!block || block.kind !== 'text') {
              closeBlock();
              block = { index: ++blockIndex, kind: 'text' };
              sendEvent('content_block_start', { index: block.index, content_block: { type: 'text', text: '' } });
            }
            sendEvent('content_block_delta', { index: block.index, delta: { type: 'text_delta', text: delta.content } });
          }

          if (choice.finish_reason) reason = anthropicStopReason(choice.finish_reason);
        } catch {}
      }
    }, () => {
      if (!res.writableEnded) {
        closeBlock();
        sendEvent('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: outputTokens } });
        sendEvent('message_stop', {});
        res.end();
      }
    }, (err) => {
      if (!res.writableEnded) {
        const aErr = anthropicError(err.message, 'api_error', err.status || 500);
        res.write(`event: error\ndata: ${JSON.stringify(aErr.body)}\n\n`);
        res.end();
      }
    });
  }
});

router.post('/messages', apiKeyAuth, (req, res) => {
  req.url = '/v1/messages';
  router.handle(req, res);
});

// ==================== Token Count ====================

router.post('/v1/messages/count_tokens', apiKeyAuth, (req, res) => {
  const body = req.body;
  const model = body.model || 'deepseek/deepseek-v4-flash';
  const modelConfig = findModel(model);
  if (!modelConfig) {
    return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: `Model not available: ${model}` } });
  }
  const chat = anthropicToChat(body, modelConfig.id);
  const tokens = Math.max(1, Math.ceil(estimateAnthropicTokens(chat.messages) / 4));
  res.json({ input_tokens: tokens });
});

router.post('/messages/count_tokens', apiKeyAuth, (req, res) => {
  req.url = '/v1/messages/count_tokens';
  router.handle(req, res);
});

module.exports = router;
