const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { modelsUrl, parseModels, listModels } = require('../lib/llm/models');

test('model list URL follows the chat endpoint base rules', () => {
  assert.equal(modelsUrl({ type: 'openai', baseUrl: 'https://api.example.com/v1/' }), 'https://api.example.com/v1/models');
  assert.equal(modelsUrl({ type: 'openai', baseUrl: 'https://api.example.com' }), 'https://api.example.com/v1/models');
  assert.equal(modelsUrl({ type: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' }), 'https://generativelanguage.googleapis.com/v1beta/openai/models');
  assert.equal(modelsUrl({ type: 'anthropic', baseUrl: 'https://api.anthropic.com' }), 'https://api.anthropic.com/v1/models?limit=1000');
});

test('parseModels handles OpenAI, Anthropic, Ollama, Cloudflare and bare-array shapes', () => {
  assert.deepEqual(parseModels({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] }), [{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(parseModels({ data: [{ id: 'claude-x', display_name: 'Claude X' }] }), [{ id: 'claude-x', name: 'Claude X' }]);
  assert.deepEqual(parseModels({ models: [{ name: 'qwen3:8b' }] }), [{ id: 'qwen3:8b' }]);
  assert.deepEqual(parseModels({ result: [{ name: '@cf/meta/llama' }] }), [{ id: '@cf/meta/llama' }]);
  assert.deepEqual(parseModels(['m1', { id: '' }, { id: 'bad\nid' }, 7]), [{ id: 'm1' }]);
  assert.throws(() => parseModels({ error: 'nope' }), /did not return a model list/);
});

test('listModels sends provider auth and reports upstream failures', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, key: req.headers['x-api-key'], custom: req.headers['x-custom'] });
    res.writeHead(req.headers.authorization === 'Bearer good' || req.headers['x-api-key'] === 'good' ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.headers.authorization === 'Bearer good' || req.headers['x-api-key'] === 'good' ? { data: [{ id: 'm' }] } : { error: { message: 'bad key' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await listModels({ type: 'openai', baseUrl: `${base}/v1`, apiKey: 'good', headers: { 'X-Custom': 'yes' } }), [{ id: 'm' }]);
    assert.deepEqual(await listModels({ type: 'anthropic', baseUrl: base, apiKey: 'good' }), [{ id: 'm' }]);
    await assert.rejects(() => listModels({ type: 'openai', baseUrl: `${base}/v1`, apiKey: 'wrong' }), /Provider returned 401: bad key/);
    assert.equal(seen[0].custom, 'yes'); assert.equal(seen[1].key, 'good'); assert.equal(seen[1].url, '/v1/models?limit=1000');
  } finally { server.close(); }
});
