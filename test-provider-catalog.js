const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const { catalog, accountPreset, importAccounts } = require('./lib/provider-catalog');

test('catalog distinguishes verified free tiers from evaluation and unverified presets', () => {
  const entries = catalog();
  for (const id of ['groq', 'gemini', 'mistral', 'openrouter', 'cloudflare', 'electronhub', 'simplellm', 'inferbase']) assert.equal(entries.find(p => p.id === id).group, 'free');
  assert.ok(entries.length >= 30);
  assert.ok(entries.reduce((total, p) => total + p.models.length, 0) >= 300);
  assert.equal(entries.find(p => p.id === 'agnes').verifiedAt, null);
  assert.equal(entries.find(p => p.id === 'cohere').group, 'limited');
  assert.equal(entries.some(p => p.id === 'cerebras' || p.id === 'huggingface'), false);
  for (const entry of entries) {
    assert.equal(new URL(entry.keyUrl).protocol, 'https:');
    assert.equal(new URL(entry.docsUrl).protocol, 'https:');
    assert.ok(entry.models.includes(entry.defaultModel));
    assert.equal(new Set(entry.models).size, entry.models.length);
    assert.equal(entry.modelDetails.length, entry.models.length);
    assert.ok(entry.models.every(id => typeof id === 'string' && id.length > 0));
  }
  entries[0].models.push('modified');
  assert.equal(catalog()[0].models.includes('modified'), false);
});

test('expanded provider presets preserve endpoint, model, and tool compatibility', () => {
  for (const id of ['electronhub', 'sealion', 'xkiro', 'modelscope', 'waterfall', 'simplellm', 'typhoon', 'poolside', 'longcat']) {
    const entry = catalog().find(p => p.id === id);
    const account = accountPreset(id, { apiKey: 'fake-key', accountLabel: 'Work', defaultModel: entry.models.at(-1) });
    assert.equal(account.baseUrl, entry.baseUrl);
    assert.equal(account.defaultModel, entry.models.at(-1));
    assert.equal(account.apiKey, 'fake-key');
    assert.equal(account.userAgent, 'GigaRouter/1.1');
  }
  assert.equal(accountPreset('nvidia', { apiKey: 'fake-key' }).compat.singleToolCall, true);
  const result = importAccounts({ source: 'freellmapi', version: 1, keys: [{ platform: 'electronhub', key: 'fake-key' }, { platform: 'sealion', key: 'fake-key' }] });
  assert.equal(result.accounts.length, 2); assert.equal(result.skipped.length, 0);
});

test('account presets require API keys and validate Cloudflare paths', () => {
  for (const apiKey of ['', '***', 'bad\r\nkey', {}, 'x'.repeat(8193)]) assert.throws(() => accountPreset('groq', { apiKey }));
  assert.throws(() => accountPreset('unknown', { apiKey: 'fake-key' }));
  for (const accountId of ['', '../other', 'g'.repeat(32), 'a'.repeat(33)]) assert.throws(() => accountPreset('cloudflare', { apiKey: 'fake-key', accountId }));
  const account = accountPreset('cloudflare', { apiKey: 'fake-key', accountId: 'a'.repeat(32), accountLabel: 'Work' });
  assert.equal(account.baseUrl, `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/v1`);
  assert.equal(account.name, 'Cloudflare Workers AI · Work');
  assert.throws(() => accountPreset('groq', { apiKey: 'fake-key', accountLabel: 'x'.repeat(81) }));
});

test('imports exclude session accounts and unsupported providers without exposing their fields', () => {
  const document = { source: 'giga-router-apikeys', version: 1, accounts: [
    { catalogId: 'groq', apiKey: 'fake-secret', accountLabel: 'Work' },
    { catalogId: 'groq', authType: 'oauth', apiKey: 'session-secret' },
    { catalogId: 'not-supported-secret', apiKey: 'private-secret', accountLabel: 'private-label' },
  ] };
  const { accounts, skipped } = importAccounts(document);
  assert.equal(accounts.length, 1); assert.equal(skipped.length, 2);
  assert.equal(JSON.stringify(skipped).includes('secret'), false);
  assert.throws(() => importAccounts({ source: 'unknown', accounts: document.accounts }));
  assert.throws(() => importAccounts({ ...document, accounts: [] }));
  assert.throws(() => importAccounts({ ...document, accounts: [{ catalogId: 'groq', apiKey: 'secret\n' }] }), /Account 1: check/);
  const freeLLM = importAccounts({ source: 'freellmapi', version: 1, keys: [{ platform: 'google', label: 'Personal', key: 'fake-key' }] });
  assert.equal(freeLLM.accounts[0].catalogId, 'gemini');
  const cloudflare = importAccounts({ source: 'freellmapi', version: 1, keys: [{ platform: 'cloudflare', key: `${'a'.repeat(32)}:fake-token` }] }).accounts[0];
  assert.equal(cloudflare.apiKey, 'fake-token');
  assert.equal(cloudflare.baseUrl, `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/v1`);
});

test('OmniRoute exporter reads only API keys, saves a private file, and refuses overwrite', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-router-export-'));
  try {
    const database = path.join(directory, 'storage.sqlite'), output = path.join(directory, 'keys.json');
    const create = spawnSync('python3', ['-c', `import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
 db.execute('CREATE TABLE provider_connections (provider TEXT, name TEXT, api_key TEXT, default_model TEXT, auth_type TEXT)')
 db.executemany('INSERT INTO provider_connections VALUES (?,?,?,?,?)', [('groq','Personal','fake-private-key',None,'apikey'),('groq','Browser','fake-session-key','model','oauth')])`, database]);
    assert.equal(create.status, 0, create.stderr?.toString());
    const run = spawnSync('python3', [path.join(__dirname, 'scripts/export-omniroute-keys.py'), '--database', database, '--output', output]);
    assert.equal(run.status, 0, run.stderr?.toString());
    assert.equal(run.stdout.toString().includes('fake-private-key'), false);
    const exported = JSON.parse(fs.readFileSync(output));
    assert.equal(exported.accounts.length, 1); assert.equal(exported.accounts[0].apiKey, 'fake-private-key');
    assert.equal(fs.readFileSync(output, 'utf8').includes('fake-session-key'), false);
    if (process.platform !== 'win32') assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    const repeated = spawnSync('python3', [path.join(__dirname, 'scripts/export-omniroute-keys.py'), '--database', database, '--output', output]);
    assert.notEqual(repeated.status, 0);
    const listing = spawnSync('python3', [path.join(__dirname, 'scripts/export-omniroute-keys.py'), '--database', database, '--list']);
    assert.equal(listing.status, 0); assert.equal(listing.stdout.toString().includes('fake-private-key'), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('account APIs preserve routing, isolate credentials, and apply imports atomically', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-router-providers-'));
  process.env.DATA_DIR = dataDir;
  process.env.user = 'provider-user'; process.env.password = 'provider-password';
  process.env.ROUTER_KEY = 'test-gateway-key';
  const { app, resolveCandidates, buildUpstream } = require('./server');
  const { saveConfig, loadConfig } = require('./lib/storage');
  const routing = { mode: 'manual', autoOrder: ['kept'], schedules: [{ id: 'window', providerId: 'kept', start: '01:00', end: '02:00' }] };
  saveConfig({ providers: [{ id: 'kept', name: 'Existing', type: 'openai', baseUrl: 'https://existing.example/v1', defaultModel: 'existing-model', apiKey: 'existing-private-key' }], activeId: 'kept', routing });
  const listener = app.listen(0, '127.0.0.1');
  try {
    await once(listener, 'listening');
    const origin = `http://127.0.0.1:${listener.address().port}`;
    let cookie;
    const request = (endpoint, body, method = body ? 'POST' : 'GET', authenticated = true) => fetch(origin + endpoint, {
      method, headers: { 'Content-Type': 'application/json', ...(authenticated && cookie ? { cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000),
    });
    const login = await request('/api/login', { user: 'provider-user', password: 'provider-password' });
    cookie = login.headers.get('set-cookie').split(';')[0];
    const create = body => request('/api/providers/catalog/groq/accounts', body);
    await t.test('catalog, creation, and import require dashboard authentication', async () => {
      assert.equal((await request('/api/providers/catalog', null, 'GET', false)).status, 401);
      assert.equal((await request('/api/providers/catalog/groq/accounts', { apiKey: 'fake-key' }, 'POST', false)).status, 401);
      assert.equal((await request('/api/providers/import', { apply: false }, 'POST', false)).status, 401);
    });
    let first, second;
    await t.test('several labeled accounts keep independent IDs, aliases, and masked keys', async () => {
      first = await create({ apiKey: 'first-private-key', accountLabel: 'Personal' }).then(r => r.json());
      second = await create({ apiKey: 'second-private-key', accountLabel: 'Personal' }).then(r => r.json());
      assert.equal(first.apiKey, '***'); assert.equal(second.apiKey, '***');
      assert.notEqual(first.id, second.id); assert.notEqual(first.slug, second.slug);
      assert.equal(first.name, 'Groq · Personal'); assert.equal(second.name, 'Groq · Personal 2');
      const cfg = loadConfig();
      assert.equal(cfg.activeId, 'kept'); assert.deepEqual(cfg.routing, routing);
      assert.equal(cfg.providers[1].apiKey, 'first-private-key'); assert.equal(cfg.providers[2].apiKey, 'second-private-key');
      const candidates = resolveCandidates({ ...cfg, routing: { mode: 'auto', autoOrder: [second.id, first.id, 'kept'] } }).providers;
      assert.deepEqual(candidates.map(p => p.id), [second.id, first.id, 'kept']);
      assert.equal(buildUpstream(candidates[0], { messages: [] }, 'openai').headers.authorization, 'Bearer second-private-key');
      assert.equal(buildUpstream(candidates[1], { messages: [] }, 'openai').headers.authorization, 'Bearer first-private-key');
      const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json')));
      assert.equal(disk.providers[2].apiKey, 'second-private-key');
    });
    await t.test('editing and deleting one account preserves other credentials and selection', async () => {
      assert.equal((await request(`/api/providers/${first.id}`, { apiKey: '***', defaultModel: 'openai/gpt-oss-20b' }, 'PUT')).status, 200);
      assert.equal(loadConfig().providers[1].apiKey, 'first-private-key');
      assert.equal((await request(`/api/providers/${first.id}`, null, 'DELETE')).status, 200);
      const cfg = loadConfig(); assert.equal(cfg.providers.find(p => p.id === second.id).apiKey, 'second-private-key');
      assert.equal(cfg.activeId, 'kept'); assert.deepEqual(cfg.routing, routing);
    });
    await t.test('invalid import is atomic, preview never writes, repeat import skips duplicates', async () => {
      const document = { source: 'freellmapi', version: 1, keys: [
        { platform: 'mistral', label: 'Work', key: 'import-private-key' },
        { platform: 'unsupported', key: 'never-expose-this' },
      ] };
      const before = fs.readFileSync(path.join(dataDir, 'config.json'));
      const preview = await request('/api/providers/import', { document, apply: false }).then(r => r.json());
      assert.equal(preview.items.length, 1); assert.equal(preview.skipped.length, 1);
      assert.equal(JSON.stringify(preview).includes('private-key'), false);
      assert.deepEqual(fs.readFileSync(path.join(dataDir, 'config.json')), before);
      const invalid = structuredClone(document); invalid.keys.push({ platform: 'groq', key: '' });
      assert.equal((await request('/api/providers/import', { document: invalid, apply: true })).status, 400);
      assert.deepEqual(fs.readFileSync(path.join(dataDir, 'config.json')), before);
      const result = await request('/api/providers/import', { document, apply: true }).then(r => r.json());
      assert.equal(result.items.length, 1); assert.equal(loadConfig().providers.at(-1).apiKey, 'import-private-key');
      const repeat = await request('/api/providers/import', { document, apply: true }).then(r => r.json());
      assert.equal(repeat.items.length, 0); assert.equal(repeat.duplicates.length, 1);
      assert.deepEqual(loadConfig().routing, routing); assert.equal(loadConfig().activeId, 'kept');
    });
    await t.test('invalid presets cannot change saved config and public model aliases are independent', async () => {
      const before = fs.readFileSync(path.join(dataDir, 'config.json'));
      assert.equal((await create({ apiKey: '***' })).status, 400);
      assert.equal((await request('/api/providers/catalog/unknown/accounts', { apiKey: 'fake-key' })).status, 404);
      assert.deepEqual(fs.readFileSync(path.join(dataDir, 'config.json')), before);
      const config = await request('/api/config').then(r => r.json());
      assert.equal(JSON.stringify(config).includes('private-key'), false);
      const models = await fetch(origin + '/v1/models', { headers: { authorization: 'Bearer test-gateway-key' } }).then(r => r.json());
      assert.ok(models.data.some(model => model.id === `${second.slug}/${second.defaultModel}`));
    });
  } finally {
    listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
