const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { createServer } = require('node:http');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-models-endpoint-'));
process.env.DATA_DIR = dataDir;
process.env.ROUTER_KEY = 'test-router-key';
process.env.user = 'tester';
process.env.password = 'test-password-123';
const { app } = require('../server');

let router, upstream, origin, cookie;
before(async () => {
  upstream = createServer((req, res) => {
    const ok = req.headers.authorization === 'Bearer saved-key';
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { data: [{ id: 'z-model' }, { id: 'a-model' }] } : { error: { message: 'bad key' } }));
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    providers: [{ id: 'p1', name: 'Saved', type: 'openai', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'saved-key', defaultModel: 'a-model' }],
    activeId: 'p1', routing: { mode: 'manual' },
  }));
  router = app.listen(0, '127.0.0.1'); await once(router, 'listening');
  origin = `http://127.0.0.1:${router.address().port}`;
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'tester', password: 'test-password-123' }) });
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(() => { router.close(); upstream.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const post = (body, auth = true) => fetch(origin + '/api/providers/models', { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { cookie } : {}) }, body: JSON.stringify(body) });

test('endpoint requires dashboard authentication', async () => {
  assert.equal((await post({ providerId: 'p1' }, false)).status, 401);
});

test('saved provider lists models with its stored key, even when the form sends ***', async () => {
  const response = await post({ providerId: 'p1', apiKey: '***' });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).models, [{ id: 'a-model' }, { id: 'z-model' }]);
});

test('unsaved draft uses the key typed into the form and surfaces upstream errors', async () => {
  const base = `http://127.0.0.1:${upstream.address().port}/v1`;
  assert.equal((await (await post({ type: 'openai', baseUrl: base, apiKey: 'saved-key' })).json()).models.length, 2);
  const bad = await post({ type: 'openai', baseUrl: base, apiKey: 'wrong' });
  assert.equal(bad.status, 502); assert.match((await bad.json()).error, /401: bad key/);
  assert.equal((await post({ providerId: 'missing' })).status, 404);
});
