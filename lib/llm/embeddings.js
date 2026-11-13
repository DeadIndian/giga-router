// OpenAI-compatible /v1/embeddings with same-model failover pools.
//
// Vectors from different embedding models live in different spaces, so a pool
// must only list targets that serve the *same* model (for example one open
// model hosted by several providers). Responses are normalised (index, order,
// encoding) and checked against the pool's dimension so a misconfigured target
// fails over instead of silently corrupting a vector index.
const crypto = require('node:crypto');
const { loadConfig } = require('../storage');
const { inputError } = require('../validation');
const { recordActivity } = require('../activity');
const { failure } = require('./failures');
const { providerSlug } = require('./routing');

const health = new Map();
const MAX_INPUTS = 2048;
const timeoutMs = () => Math.max(1000, Math.min(10 * 60_000, Number(process.env.EMBEDDINGS_TIMEOUT_MS) || 60_000));
const POOL_ID = /^[a-z0-9][a-z0-9._-]{0,47}$/;

function embeddingsOf(cfg) {
  const e = cfg.embeddings || {};
  return { pools: Array.isArray(e.pools) ? e.pools : [] };
}

function validatePools(value, cfg) {
  if (!Array.isArray(value) || value.length > 50) throw inputError('Embedding pools must be a list of up to 50 pools');
  const ids = new Set();
  return value.map(pool => {
    if (!pool || typeof pool !== 'object' || Array.isArray(pool)) throw inputError('Each embedding pool must be an object');
    const id = typeof pool.id === 'string' ? pool.id.trim() : '';
    if (!POOL_ID.test(id) || ids.has(id)) throw inputError('Each pool needs a unique lowercase id (letters, numbers, dot, dash, underscore)');
    ids.add(id);
    let dimensions;
    if (pool.dimensions !== undefined && pool.dimensions !== null && pool.dimensions !== '') {
      dimensions = Number(pool.dimensions);
      if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 16384) throw inputError(`Pool ${id}: dimensions must be a whole number`);
    }
    if (!Array.isArray(pool.targets) || !pool.targets.length || pool.targets.length > 20) throw inputError(`Pool ${id}: add 1-20 targets`);
    const targets = pool.targets.map(target => {
      const provider = cfg.providers.find(p => p.id === target?.providerId);
      if (!provider) throw inputError(`Pool ${id}: provider not found`, 404);
      if (provider.type !== 'openai') throw inputError(`Pool ${id}: ${provider.name} is not an OpenAI-compatible provider`);
      const model = typeof target.model === 'string' ? target.model.trim() : '';
      if (!model || model.length > 256 || /[\x00-\x1f\x7f]/.test(model)) throw inputError(`Pool ${id}: each target needs a model name`);
      const out = { providerId: provider.id, model };
      if (target.dimensions !== undefined && target.dimensions !== null && target.dimensions !== '') {
        const d = Number(target.dimensions);
        if (!Number.isInteger(d) || d < 1 || d > 16384) throw inputError(`Pool ${id}: target dimensions must be a whole number`);
        out.dimensions = d;
      }
      return out;
    });
    return { id, ...(dimensions ? { dimensions } : {}), targets, ...(typeof pool.label === 'string' && pool.label.trim() ? { label: pool.label.trim().slice(0, 120) } : {}) };
  });
}

function embeddingUrl(provider) {
  const base = provider.baseUrl.replace(/\/+$/, '');
  return /\/(?:v\d+(?:beta)?|openai)$/.test(base) ? `${base}/embeddings` : `${base}/v1/embeddings`;
}

function upstreamHeaders(provider) {
  const headers = { 'content-type': 'application/json' };
  if (provider.apiKey) headers.authorization = 'Bearer ' + provider.apiKey;
  if (provider.userAgent?.trim()) headers['user-agent'] = provider.userAgent.trim();
  for (const [key, value] of Object.entries(provider.headers || {})) if (typeof value === 'string' && key.trim()) headers[key.trim().toLowerCase()] = value;
  return headers;
}

function planEmbedding(cfg, model) {
  if (typeof model !== 'string' || !model.trim()) throw inputError('model is required');
  const id = model.startsWith('pool/') ? model.slice(5) : model;
  const pool = embeddingsOf(cfg).pools.find(p => p.id === id);
  if (pool) {
    const targets = pool.targets.map(t => ({ ...t, provider: cfg.providers.find(p => p.id === t.providerId) })).filter(t => t.provider && t.provider.enabled !== false);
    return { pool, targets, failover: true };
  }
  const slash = model.indexOf('/');
  if (slash > 0) {
    const name = model.slice(0, slash).toLowerCase();
    const provider = cfg.providers.find(p => providerSlug(p) === name || p.name.toLowerCase() === name || p.id === name);
    if (provider && provider.enabled !== false) {
      if (provider.type !== 'openai') throw inputError('Embeddings need an OpenAI-compatible provider');
      return { pool: null, targets: [{ provider, model: model.slice(slash + 1) }], failover: false };
    }
  }
  throw inputError('Unknown embedding model. Use pool/<id> or <provider>/<model>.', 404);
}

function countInputs(input) {
  if (typeof input === 'string') return 1;
  if (!Array.isArray(input) || !input.length) return 0;
  return typeof input[0] === 'number' ? 1 : input.length;
}

const decodeBase64 = text => { const b = Buffer.from(text, 'base64'); return Array.from(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4))); };
const encodeBase64 = vector => Buffer.from(new Float32Array(vector).buffer).toString('base64');

function normalise(data, count, dimensions) {
  if (!Array.isArray(data?.data) || data.data.length !== count) throw failure(502, 'Upstream returned the wrong number of embeddings');
  // Some providers omit `index` when it is 0 (protobuf default). Give items without
  // an index the unused indices in order; if the given indices are unusable, fall
  // back to response order.
  const given = data.data.map(item => Number.isInteger(item?.index) ? item.index : null);
  const present = given.filter(i => i !== null);
  const valid = new Set(present).size === present.length && present.every(i => i >= 0 && i < count);
  const unused = valid ? [...Array(count).keys()].filter(i => !present.includes(i)) : [];
  const items = data.data.map((item, position) => {
    const vector = typeof item?.embedding === 'string' ? decodeBase64(item.embedding) : item?.embedding;
    if (!Array.isArray(vector) || !vector.length || vector.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw failure(502, 'Upstream returned an invalid embedding');
    return { object: 'embedding', index: !valid ? position : given[position] ?? unused.shift(), embedding: vector };
  }).sort((a, b) => a.index - b.index);
  const size = items[0].embedding.length;
  if (items.some(item => item.embedding.length !== size)) throw failure(502, 'Upstream returned mixed embedding sizes');
  if (dimensions && size !== dimensions) throw failure(502, `Upstream returned ${size} dimensions; pool expects ${dimensions}`, null, 'capability_mismatch');
  return items;
}

async function embed(req, res) {
  const body = req.body || {}, started = Date.now(), requestId = crypto.randomUUID(), attempts = [], skipped = [];
  res.setHeader('x-request-id', requestId);
  const count = countInputs(body.input);
  if (!count || count > MAX_INPUTS) throw inputError(`input must be a string or a list of 1-${MAX_INPUTS} inputs`);
  if (body.encoding_format !== undefined && !['float', 'base64'].includes(body.encoding_format)) throw inputError('encoding_format must be float or base64');
  const plan = planEmbedding(loadConfig(), body.model);
  if (!plan.targets.length) throw inputError('This embedding pool has no enabled providers', 503);
  let last, chosen, outcome = 'error', usage;
  try {
    for (const target of plan.targets) {
      const key = `${plan.pool?.id || 'direct'}:${target.provider.id}:${target.model}`;
      if (plan.failover && (health.get(key)?.until || 0) > Date.now()) { skipped.push({ id: target.provider.id, name: target.provider.name, reason: 'cooldown' }); continue; }
      const attempt = { providerId: target.provider.id, provider: target.provider.name, model: target.model, startedAt: new Date().toISOString() }, attemptStart = Date.now();
      attempts.push(attempt);
      try {
        const upstreamBody = { model: target.model, input: body.input, encoding_format: 'float' };
        const dims = target.dimensions || (body.dimensions && !plan.pool ? body.dimensions : undefined);
        if (dims) upstreamBody.dimensions = dims;
        if (typeof body.user === 'string') upstreamBody.user = body.user;
        const upstream = await fetch(embeddingUrl(target.provider), { method: 'POST', headers: upstreamHeaders(target.provider), body: JSON.stringify(upstreamBody), signal: AbortSignal.timeout(timeoutMs()), redirect: 'error' });
        attempt.code = upstream.status;
        const text = await upstream.text();
        if (!upstream.ok) {
          let message = text; try { const data = JSON.parse(text); message = data.error?.message || data.message || text; } catch {}
          throw failure(upstream.status, String(message || upstream.statusText).slice(0, 500), upstream.headers);
        }
        let data; try { data = JSON.parse(text); } catch { throw failure(502, 'Invalid JSON in upstream response'); }
        const items = normalise(data, count, plan.pool?.dimensions);
        health.delete(key); chosen = target; attempt.status = 'ok'; outcome = 'ok'; usage = data.usage;
        res.setHeader('x-giga-provider-id', target.provider.id);
        res.setHeader('x-llmrouter-provider', encodeURIComponent(target.provider.name));
        if (attempts.length > 1) res.setHeader('x-llmrouter-fallbacks', String(attempts.length - 1));
        const base64 = body.encoding_format === 'base64';
        res.json({ object: 'list', model: body.model, data: items.map(item => ({ ...item, embedding: base64 ? encodeBase64(item.embedding) : item.embedding })),
          usage: { prompt_tokens: usage?.prompt_tokens ?? 0, total_tokens: usage?.total_tokens ?? usage?.prompt_tokens ?? 0 } });
        return;
      } catch (error) {
        last = error.category ? error : failure(error.name === 'TimeoutError' ? 504 : 502, error.message, null, error.name === 'TimeoutError' ? 'timeout' : undefined);
        attempt.status = 'error'; attempt.category = last.category; attempt.code = last.status || 502; attempt.durationMs = Date.now() - attemptStart;
        if (plan.failover && last.penalize) health.set(key, { until: Date.now() + (last.cooldownMs || 60_000), category: last.category });
        if (!plan.failover || !last.retryable) break;
      }
    }
    if (!last) last = failure(503, 'Every provider in this pool is cooling down; retry shortly');
    if (last.retryMs) res.setHeader('retry-after', String(Math.ceil(last.retryMs / 1000)));
    res.status(last.status || 502).json({ error: { message: `all embedding providers failed (${attempts.map(a => `${a.provider}:${a.code}`).join(', ') || 'none tried'}) — ${last.message}` } });
  } finally {
    recordActivity({ kind: 'llm', requestId, name: chosen?.provider.name || attempts.at(-1)?.provider || 'Embeddings', model: chosen?.model || body.model,
      status: outcome, keyName: req.gatewayKey?.name, durationMs: Date.now() - started, attempts, skipped });
  }
}

function embeddingHealth(cfg) {
  const now = Date.now();
  return embeddingsOf(cfg).pools.map(pool => ({ id: pool.id, targets: pool.targets.map(t => {
    const h = health.get(`${pool.id}:${t.providerId}:${t.model}`);
    return { providerId: t.providerId, model: t.model, cooling: (h?.until || 0) > now, coolingUntil: (h?.until || 0) > now ? h.until : null, category: h?.category || null };
  }) }));
}

module.exports = { embed, planEmbedding, validatePools, embeddingsOf, embeddingHealth, normalise, health };
