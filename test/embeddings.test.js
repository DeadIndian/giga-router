const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-embeddings-'));
process.env.DATA_DIR = directory;
const express = require('express');
const { saveConfig, loadConfig } = require('../lib/storage');
const embeddings = require('../lib/llm/embeddings');

function upstream(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => { raw += c; });
    req.on('end', () => { const body = JSON.parse(raw || '{}'); hits.push({ url: req.url, auth: req.headers.authorization, body }); handler(body, res, hits.length); });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, hits, url: `http://127.0.0.1:${server.address().port}/v1` })));
}
const send = (res, status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
const vectors = (body, size) => (Array.isArray(body.input) ? body.input : [body.input]).map((_, i) => ({ object: 'embedding', ...(i ? { index: i } : {}), embedding: Array.from({ length: size }, (_, j) => i + j / 10) }));

test('embedding pools fail over, normalise, guard dimensions, and encode base64', async () => {
  const limited = await upstream((body, res) => send(res, 429, { error: { message: 'rate limit' } }, { 'retry-after': '120' }));
  const good = await upstream((body, res) => send(res, 200, { data: vectors(body, 4).reverse(), usage: { prompt_tokens: 3, total_tokens: 3 } }));
  const wrongSize = await upstream((body, res) => send(res, 200, { data: vectors(body, 8) }));
  saveConfig({ providers: [
    { id: 'a', name: 'Limited', type: 'openai', baseUrl: limited.url, apiKey: 'key-a', defaultModel: 'x' },
    { id: 'b', name: 'Good', type: 'openai', baseUrl: good.url, apiKey: 'key-b', defaultModel: 'x' },
    { id: 'c', name: 'Wrong Size', type: 'openai', baseUrl: wrongSize.url, apiKey: 'key-c', defaultModel: 'x' },
    { id: 'd', name: 'Claude', type: 'anthropic', baseUrl: good.url, apiKey: 'key-d', defaultModel: 'x' },
  ], mcpServers: [] });
  const cfg = loadConfig();
  cfg.embeddings = { pools: embeddings.validatePools([
    { id: 'memory', dimensions: 4, targets: [{ providerId: 'a', model: 'bge-m3' }, { providerId: 'b', model: 'bge-m3' }] },
    { id: 'strict', dimensions: 4, targets: [{ providerId: 'c', model: 'bge-m3' }] },
  ], cfg) };
  saveConfig(cfg);

  assert.throws(() => embeddings.validatePools([{ id: 'x', targets: [{ providerId: 'd', model: 'm' }] }], cfg), /OpenAI-compatible/);
  assert.throws(() => embeddings.validatePools([{ id: 'x', targets: [{ providerId: 'zzz', model: 'm' }] }], cfg), /not found/);
  assert.throws(() => embeddings.validatePools([{ id: 'Bad Id', targets: [{ providerId: 'a', model: 'm' }] }], cfg), /unique lowercase id/);
  assert.throws(() => embeddings.validatePools([{ id: 'x', targets: [] }], cfg), /1-20 targets/);

  const app = express(); app.use(express.json());
  app.post('/v1/embeddings', (req, res, next) => embeddings.embed(req, res).catch(next));
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: { message: error.message } }));
  const gateway = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const call = body => fetch(`http://127.0.0.1:${gateway.address().port}/v1/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    let response = await call({ model: 'pool/memory', input: ['one', 'two', 'three'] });
    let data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-llmrouter-fallbacks'), '1');
    assert.equal(data.model, 'pool/memory');
    assert.deepEqual(data.data.map(d => d.index), [0, 1, 2], 'missing index 0 is filled and order restored');
    assert.equal(data.data[0].embedding[0], 0); assert.equal(data.data[2].embedding[0], 2);
    assert.equal(good.hits[0].body.model, 'bge-m3'); assert.equal(good.hits[0].body.encoding_format, 'float');
    assert.equal(good.hits[0].auth, 'Bearer key-b'); assert.equal(limited.hits[0].auth, 'Bearer key-a');

    // The rate-limited target is cooling down (Retry-After), so it is skipped.
    response = await call({ model: 'memory', input: 'solo', encoding_format: 'base64' });
    data = await response.json();
    assert.equal(response.status, 200); assert.equal(limited.hits.length, 1);
    const b = Buffer.from(data.data[0].embedding, 'base64');
    assert.deepEqual(Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)).map(v => Math.round(v * 10) / 10), [0, 0.1, 0.2, 0.3]);

    // A target returning the wrong vector size can never be accepted.
    response = await call({ model: 'pool/strict', input: 'x' });
    assert.equal(response.status, 502); assert.match((await response.json()).error.message, /8 dimensions; pool expects 4/);

    // Direct provider/model routing has no failover.
    response = await call({ model: 'limited/bge-m3', input: 'x' });
    assert.equal(response.status, 429); assert.equal(limited.hits.length, 2);
    response = await call({ model: 'good/other-model', input: 'x' });
    assert.equal(response.status, 200); assert.equal(good.hits.at(-1).body.model, 'other-model');

    assert.equal((await call({ model: 'pool/nope', input: 'x' })).status, 404);
    assert.equal((await call({ model: 'pool/memory', input: [] })).status, 400);
    assert.equal(embeddings.embeddingHealth(loadConfig())[0].targets[0].cooling, true);
  } finally {
    for (const s of [gateway, limited.server, good.server, wrongSize.server]) s.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
