const crypto = require('node:crypto');
const { once } = require('node:events');
const { loadConfig } = require('../storage');
const { inputError } = require('../validation');
const { recordActivity } = require('../activity');
const { planRoute, markProviderFailure, markSuccess, acquireProbe, healthy } = require('./routing');
const { buildUpstream, endpointUrl, errorFor, openAIToAnthropicResp, anthropicToOpenAIResp, openaiStreamToAnthropic, anthropicStreamToOpenAI } = require('./protocol');
const { sseFrames, encodeSSE } = require('./sse');
const { failure } = require('./failures');
const { streamState } = require('./stream-state');
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT = ': heartbeat\n\n';
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const duration = (name, fallback) => Math.max(50, Math.min(30 * 60_000, Number(process.env[name]) || fallback));
const headerValue = value => /^[\x20-\x7e]*$/.test(value) ? value : encodeURIComponent(value);
function tokenUsage(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  return Object.fromEntries(['input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
    .filter(key => Number.isFinite(raw[key]) && raw[key] >= 0).map(key => [key, raw[key]]));
}

async function readBytes(response, maxBytes = MAX_RESPONSE_BYTES) {
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw failure(502, 'Upstream response exceeds the size limit'); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length; if (size > maxBytes) throw failure(502, 'Upstream response exceeds the size limit'); chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function write(res, bytes, signal) {
  signal.throwIfAborted();
  if (res.destroyed) throw failure(499, 'Client cancelled the request', null, 'cancelled');
  if (!res.write(bytes)) await once(res, 'drain', { signal });
}
function meaningful(obj, format) {
  if (format === 'responses') return !['response.created', 'response.in_progress'].includes(obj.type) && !/\.added$/.test(obj.type || '');
  if (format === 'anthropic') return obj.type === 'content_block_delta' || (obj.type === 'content_block_start' && (obj.content_block?.type === 'tool_use' || obj.content_block?.text));
  return (obj.choices || []).some(c => c.delta?.content || c.delta?.refusal || c.delta?.tool_calls?.length || c.delta?.reasoning_content);
}
async function streamAttempt(res, upstream, same, body, clientFormat, context) {
  const upstreamFormat = same ? clientFormat : clientFormat === 'anthropic' ? 'openai' : 'anthropic';
  const state = streamState(upstreamFormat);
  const validator = same ? null : upstreamFormat === 'anthropic' ? anthropicStreamToOpenAI({ includeUsage: !!body.stream_options?.include_usage }) : openaiStreamToAnthropic();
  const serialize = obj => encodeSSE(obj, clientFormat === 'anthropic' ? obj.type : undefined);
  let buffered = [], bufferBytes = 0, finalFrames = [], finalBytes = 0, heartbeat;
  const flush = async () => {
    if (!context.committed) {
      context.commit(); res.setHeader('content-type', 'text/event-stream'); res.setHeader('cache-control', 'no-cache'); res.setHeader('x-accel-buffering', 'no'); res.flushHeaders();
      heartbeat = setInterval(() => { if (!res.destroyed && !res.writableNeedDrain) res.write(HEARTBEAT); }, HEARTBEAT_INTERVAL_MS);
    }
    for (const bytes of buffered) await write(res, bytes, context.signal);
    buffered = []; bufferBytes = 0;
  };
  try {
    for await (const frame of sseFrames(upstream.body)) {
      context.touch(); const obj = frame.data;
      if (obj.error || obj.type === 'error' || obj.type === 'response.failed') throw failure(502, obj.error?.message || obj.response?.error?.message || 'Upstream stream failed');
      state.observe(obj);
      let converted = [];
      if (validator) converted = upstreamFormat === 'anthropic' ? validator.onEvent(obj) : validator.onData(obj);
      if (obj.usage || obj.message?.usage || obj.response?.usage) context.usage = { ...context.usage, ...(obj.usage || obj.message?.usage || obj.response?.usage) };
      const output = same ? [encodeSSE(obj, frame.event || (clientFormat === 'anthropic' ? obj.type : undefined))] : converted.map(serialize);
      const hasOutput = meaningful(obj, upstreamFormat);
      if (hasOutput && context.firstTokenMs === null) { context.firstTokenMs = Date.now() - context.started; context.outputStarted(); }
      // Hold native terminal frames until validation succeeds; a malformed tail
      // must not follow a success marker already consumed by the client SDK.
      const finishing = same && (obj.type === 'message_stop' || ['response.completed', 'response.incomplete'].includes(obj.type) || obj.choices?.some(c => c.finish_reason));
      if (finishing || finalFrames.length) {
        finalFrames.push(...output); finalBytes += output.reduce((n, s) => n + Buffer.byteLength(s), 0);
        if (finalBytes > 1024 * 1024) throw failure(502, 'Upstream terminal event buffer exceeds 1 MiB');
        continue;
      }
      buffered.push(...output); bufferBytes += output.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
      if (context.committed || hasOutput || buffered.length >= 64 || bufferBytes >= 256 * 1024) await flush();
    }
    const tail = [];
    state.finish();
    if (validator) validator.forceStop(tail);
    buffered.push(...finalFrames);
    if (!same) buffered.push(...tail.map(serialize));
    if (clientFormat === 'openai') buffered.push('data: [DONE]\n\n');
    await flush(); res.end();
  } finally { clearInterval(heartbeat); }
}
function validateRequest(body, format) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw inputError('Request body must be a JSON object');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw inputError('stream must be a boolean');
  if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim())) throw inputError('model must be a non-empty string');
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw inputError('tools must be an array');
  if (format === 'count_tokens' && body.stream) throw inputError('Token counting does not support streaming');
  if (format === 'responses') {
    if (body.input === undefined && !body.previous_response_id) throw inputError('Responses requests need input or previous_response_id');
  } else {
    if (!Array.isArray(body.messages) || !body.messages.length || body.messages.some(m => !m || typeof m !== 'object' || !['system', 'developer', 'user', 'assistant', 'tool'].includes(m.role))) throw inputError('messages must be a non-empty array of conversation messages');
  }
  for (const name of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) if (body[name] !== undefined && (!Number.isInteger(body[name]) || body[name] < 1)) throw inputError(`${name} must be a positive integer`);
}
async function proxyRequest(req, res, clientFormat) {
  const body = req.body || {}; validateRequest(body, clientFormat);
  const started = Date.now(), requestId = crypto.randomUUID(), attempts = [];
  res.setHeader('x-request-id', requestId);
  const config = loadConfig();
  const plan = planRoute(config, { body, provider: req.headers['x-giga-provider'], format: clientFormat });
  if (!plan.providers.length) {
    const capability = plan.skipped.some(s => s.category === 'capability_mismatch');
    recordActivity({ kind: 'llm', requestId, name: 'Router', status: 'error', durationMs: Date.now() - started, attempts, skipped: plan.skipped });
    throw inputError(capability ? 'No provider supports this request. Check provider capabilities in the dashboard.' : 'No provider available; enabled providers may be cooling down. Check Live routing.', capability ? 400 : 503);
  }
  const request = new AbortController();
  const totalTimer = setTimeout(() => request.abort(failure(504, 'Request deadline exceeded', null, 'timeout')), duration('LLM_REQUEST_TIMEOUT_MS', 300_000));
  const disconnect = () => { if (!res.writableEnded) request.abort(failure(499, 'Client cancelled the request', null, 'cancelled')); };
  res.on('close', disconnect);
  let last, outcome = 'error', chosen, firstTokenMs = null, usage;
  try {
    for (const provider of plan.providers) {
      if (request.signal.aborted) throw request.signal.reason;
      if (plan.allowFailover && !healthy(provider)) {
        plan.skipped.push({ id: provider.id, name: provider.name, reason: 'account cooldown started during this request' }); continue;
      }
      const release = plan.allowFailover ? acquireProbe(provider) : () => {};
      if (!release) continue;
      const controller = new AbortController(), signal = AbortSignal.any([request.signal, controller.signal]);
      let stageTimer, idleTimer, upstream, context, committed = false;
      const armStage = (ms, message) => { clearTimeout(stageTimer); stageTimer = setTimeout(() => controller.abort(failure(504, message, null, 'timeout')), ms); };
      const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => controller.abort(failure(504, 'Upstream stream stalled', null, 'timeout')), duration('LLM_STREAM_IDLE_TIMEOUT_MS', 60_000)); };
      const attempt = { providerId: provider.id, provider: provider.name, model: provider.defaultModel, startedAt: new Date().toISOString() };
      const attemptStart = Date.now(); attempts.push(attempt);
      try {
        const { same, upstreamBody, headers } = buildUpstream(provider, body, clientFormat);
        if (same && provider.type === 'anthropic') for (const name of ['anthropic-version', 'anthropic-beta']) if (req.headers[name] && !provider.headers?.[name]) headers[name] = req.headers[name];
        armStage(duration('LLM_HEADERS_TIMEOUT_MS', 30_000), 'Upstream response headers timed out');
        upstream = await fetch(endpointUrl(provider, clientFormat), { method: 'POST', headers, body: JSON.stringify(upstreamBody), signal, redirect: 'error' });
        attempt.upstreamRequestId = upstream.headers.get('request-id') || upstream.headers.get('x-request-id') || undefined;
        attempt.code = upstream.status;
        armStage(duration('LLM_HEADERS_TIMEOUT_MS', 30_000), 'Upstream response body timed out');
        if (!upstream.ok) {
          const text = await readBytes(upstream, 64 * 1024); let message = text;
          try { const data = JSON.parse(text); message = data.error?.message || data.message || text; } catch {}
          throw failure(upstream.status, message || upstream.statusText, upstream.headers);
        }
        const commit = () => {
          committed = true; res.setHeader('x-llmrouter-provider', headerValue(provider.name)); res.setHeader('x-giga-provider-id', provider.id);
          res.setHeader('x-llmrouter-reason', headerValue(plan.reason)); if (attempts.length > 1) res.setHeader('x-llmrouter-fallbacks', String(attempts.length - 1));
        };
        if (body.stream) {
          armStage(duration('LLM_FIRST_TOKEN_TIMEOUT_MS', 30_000), 'Upstream first token timed out'); touch();
          context = { signal, started, firstTokenMs: null, commit, touch, outputStarted: () => clearTimeout(stageTimer), get committed() { return committed; } };
          await streamAttempt(res, upstream, same, body, clientFormat, context); firstTokenMs = context.firstTokenMs; usage = context.usage;
        } else {
          let data; try { data = JSON.parse(await readBytes(upstream)); } catch (error) { throw failure(502, error instanceof SyntaxError ? 'Invalid JSON in upstream response' : error.message); }
          if (data.error || data.status === 'failed') throw failure(502, data.error?.message || 'Upstream returned an error');
          if (same && clientFormat === 'openai' && !data.choices?.[0]?.message) throw failure(502, 'Upstream returned no assistant message');
          if (same && clientFormat === 'anthropic' && !Array.isArray(data.content)) throw failure(502, 'Upstream returned no assistant content');
          if (clientFormat === 'responses' && !Array.isArray(data.output)) throw failure(502, 'Upstream returned no response output');
          if (clientFormat === 'count_tokens' && !Number.isFinite(data.input_tokens)) throw failure(502, 'Upstream returned no token count');
          const response = same ? data : clientFormat === 'anthropic' ? openAIToAnthropicResp(data) : anthropicToOpenAIResp(data);
          usage = data.usage; commit(); res.json(req.diagnostic ? { ok: true, providerId: provider.id, model: data.model || provider.defaultModel, latencyMs: Date.now() - attemptStart, stages: ['endpoint', 'authentication', 'model inference', 'response validation'] } : response);
        }
        markSuccess(provider.id); chosen = provider; attempt.status = 'ok'; outcome = 'ok'; return;
      } catch (error) {
        last = signal.aborted ? signal.reason : failure(error.status || 502, error.message, null, error.category);
        if (error.retryMs) { last.retryMs = error.retryMs; last.cooldownMs = error.cooldownMs; }
        attempt.status = last.category === 'cancelled' ? 'cancelled' : 'error'; attempt.category = last.category; attempt.code = last.status || 502;
        if (last.penalize) markProviderFailure(provider, config, last);
        if (last.category === 'cancelled') { outcome = 'cancelled'; return; }
        if (committed || request.signal.aborted) throw last;
        if (!plan.allowFailover || !last.retryable) break;
      } finally {
        if (context) { firstTokenMs = context.firstTokenMs; usage = context.usage; }
        attempt.durationMs = Date.now() - attemptStart;
        clearTimeout(stageTimer); clearTimeout(idleTimer); controller.abort(); release();
        if (upstream?.body && !upstream.body.locked) await upstream.body.cancel().catch(() => {});
      }
    }
    if (!last) last = failure(503, 'Provider recovery is already being checked; retry shortly');
    if (last.retryMs) res.setHeader('retry-after', String(Math.ceil(last.retryMs / 1000)));
    res.status(last.status || 502).json(errorFor(clientFormat, `all providers failed (${attempts.map(a => `${a.provider}:${a.code}`).join(', ')}) — ${last.message}`));
  } finally {
    clearTimeout(totalTimer); res.off('close', disconnect);
    recordActivity({ kind: 'llm', requestId, name: chosen?.name || attempts.at(-1)?.provider || 'Router', model: chosen?.defaultModel || attempts.at(-1)?.model,
      status: outcome, keyName: req.gatewayKey?.name, durationMs: Date.now() - started, firstTokenMs, usage: tokenUsage(usage), attempts, skipped: plan.skipped });
  }
}
module.exports = { proxyRequest, validateRequest, readBytes, write, HEARTBEAT, HEARTBEAT_INTERVAL_MS };
