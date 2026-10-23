const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { gunzipSync } = require('node:zlib');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-router-defaults-'));
process.env.DATA_DIR = dataDir;
process.env.user = 'defaults-user';
process.env.password = 'defaults-password';
process.env.GIGA_ROUTER_DEFAULT_MARKETPLACES = 'true';
const { app } = require('../server');
const { loadConfig, saveConfig, writeJson } = require('../lib/storage');
const { DEFAULT_MARKETPLACES, SNAPSHOT_DIR, seedDefaultMarketplaces } = require('../lib/marketplace-defaults');
const { listMarketplace, previewEntry } = require('../lib/skills');

const manifest = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, 'manifest.json'), 'utf8'));
let listener, base, cookie;
async function request(endpoint, method = 'GET', body) {
  const response = await fetch(base + endpoint, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}

before(async () => {
  listener = app.listen(0, '127.0.0.1'); await once(listener, 'listening');
  base = `http://127.0.0.1:${listener.address().port}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'defaults-user', password: 'defaults-password' }) });
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  listener.closeAllConnections(); await new Promise((resolve) => listener.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('fresh self-hosted installs seed complete offline catalogs without installing skills', async () => {
  const originalFetch = global.fetch;
  global.fetch = () => { throw Error('Startup must not contact GitHub'); };
  try { assert.equal(seedDefaultMarketplaces().added, DEFAULT_MARKETPLACES.length); }
  finally { global.fetch = originalFetch; }
  const config = loadConfig();
  assert.equal(config.sources.length, 10);
  assert.equal(config.skills.length, 0);
  assert.ok(config.sources.every((source) => source.builtinId && source.commit && source.count > 0));
  const catalog = listMarketplace();
  assert.equal(catalog.length, manifest.sources.reduce((count, source) => count + source.skillCount, 0));
  assert.ok(catalog.length > 1000);
  for (const definition of DEFAULT_MARKETPLACES) {
    const source = config.sources.find((entry) => entry.builtinId === definition.id);
    const skill = catalog.find((entry) => entry.sourceId === source.id);
    const preview = previewEntry(source.id, skill.path);
    assert.ok(preview.text.length > 0); assert.ok(preview.content.length > 0);
    const index = JSON.parse(fs.readFileSync(path.join(dataDir, 'marketplace', `${source.id}.json`), 'utf8'));
    assert.match(index.repositoryLicense.content, /Permission is hereby granted/);
    assert.equal(index.source.license, 'MIT');
    assert.ok(index.tree.some((entry) => entry.path === `${skill.path}/SKILL.md`));
  }
  const marketplace = await request('/api/marketplace');
  assert.equal(marketplace.status, 200); assert.equal(marketplace.data.defaultsEnabled, true); assert.equal(marketplace.data.sources.length, 10);
});

test('built-in removal persists across a new process and keeps installed copies', async () => {
  const source = loadConfig().sources.find((entry) => entry.builtinId === 'superpowers');
  const local = await request('/api/skills', 'POST', { name: 'retained-copy', content: 'Keep this installed skill.' });
  const config = loadConfig();
  config.skills.find((entry) => entry.id === local.data.id).sourceId = source.id;
  saveConfig(config);
  const removed = await request(`/api/sources/${source.id}`, 'DELETE');
  assert.equal(removed.status, 200);
  assert.deepEqual(loadConfig().removedDefaultMarketplaces, ['superpowers']);
  assert.equal(fs.existsSync(path.join(dataDir, 'marketplace', `${source.id}.json`)), false);
  const child = execFileSync(process.execPath, ['-e', 'const {seedDefaultMarketplaces}=require("./lib/marketplace-defaults");const {loadConfig}=require("./lib/storage");seedDefaultMarketplaces();console.log(JSON.stringify(loadConfig().sources.map(s=>s.builtinId)))'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dataDir } });
  assert.equal(JSON.parse(child).includes('superpowers'), false);
  assert.equal((await request(`/api/skills/${local.data.id}`)).status, 200);
  const marketplace = await request('/api/marketplace');
  assert.ok(!marketplace.data.items.some((entry) => entry.sourceId === source.id));
  assert.deepEqual(marketplace.data.removedDefaults, ['superpowers']);
});

test('restoring defaults is explicit and does not duplicate active sources', async () => {
  const restored = await request('/api/sources/restore-defaults', 'POST');
  assert.equal(restored.status, 200); assert.equal(restored.data.added, 1); assert.equal(restored.data.sources.length, 10);
  assert.deepEqual(loadConfig().removedDefaultMarketplaces, []);
  const before = fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8');
  assert.deepEqual(seedDefaultMarketplaces(), { added: 0, adopted: 0, repaired: 0 });
  assert.equal(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'), before);
  assert.equal((await request('/api/sources/restore-defaults', 'POST')).data.added, 0);
});

test('upgrade adopts existing repository sources and preserves custom names, refreshed indexes, and provider settings', () => {
  const definition = DEFAULT_MARKETPLACES.find((entry) => entry.id === 'superpowers');
  const source = { id: 'custom-source', name: 'My Superpowers', owner: 'obra', repo: 'superpowers', url: definition.url, ref: 'main', path: '', count: 1, commit: 'custom-refreshed-commit' };
  const config = { providers: [{ id: 'provider', apiKey: 'existing-secret', headers: { 'X-Test': 'preserved' } }], activeId: 'provider', routing: { mode: 'manual', schedules: [{ label: 'existing-schedule' }] }, sources: [source], skills: [] };
  saveConfig(config);
  const file = path.join(dataDir, 'marketplace', 'custom-source.json');
  writeJson(file, { source, tree: [], entries: [{ name: 'custom', path: 'skills/custom' }] });
  const indexBefore = fs.readFileSync(file, 'utf8');
  const beforeProvider = JSON.stringify(loadConfig().providers);
  assert.equal(seedDefaultMarketplaces({ definitions: [definition] }).adopted, 1);
  const updated = loadConfig();
  assert.equal(updated.sources.length, 1); assert.equal(updated.sources[0].id, 'custom-source'); assert.equal(updated.sources[0].name, 'My Superpowers');
  assert.equal(updated.sources[0].builtinId, 'superpowers'); assert.equal(updated.sources[0].commit, 'custom-refreshed-commit');
  assert.equal(fs.readFileSync(file, 'utf8'), indexBefore); assert.equal(JSON.stringify(updated.providers), beforeProvider);
  assert.deepEqual(updated.routing, config.routing);
});

test('operator opt-out suppresses seeding and restore, while missing enabled indexes can be repaired', async () => {
  const config = loadConfig(); config.sources = []; saveConfig(config);
  const before = fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8');
  process.env.GIGA_ROUTER_DEFAULT_MARKETPLACES = 'false';
  assert.deepEqual(seedDefaultMarketplaces(), { added: 0, adopted: 0, repaired: 0 });
  assert.equal(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'), before);
  assert.equal((await request('/api/sources/restore-defaults', 'POST')).status, 400);
  process.env.GIGA_ROUTER_DEFAULT_MARKETPLACES = 'true';
  seedDefaultMarketplaces();
  const source = loadConfig().sources.find((entry) => entry.builtinId === 'supabase');
  fs.unlinkSync(path.join(dataDir, 'marketplace', `${source.id}.json`));
  assert.equal(seedDefaultMarketplaces().repaired, 1);
  assert.ok(previewEntry(source.id, listMarketplace().find((entry) => entry.sourceId === source.id).path).text);
});

test('packaged manifest matches each compressed source and its pinned upstream attribution', () => {
  assert.equal(manifest.sources.length, DEFAULT_MARKETPLACES.length);
  for (const source of manifest.sources) {
    const bytes = fs.readFileSync(path.join(SNAPSHOT_DIR, `${source.id}.json.gz`));
    const index = JSON.parse(gunzipSync(bytes).toString('utf8'));
    assert.equal(bytes.length, source.compressedBytes); assert.equal(index.source.commit, source.commit); assert.equal(index.entries.length, source.skillCount);
    assert.equal(index.source.url, source.url); assert.equal(index.source.path, source.path); assert.equal(index.source.license, 'MIT');
    assert.ok(index.entries.every((entry) => entry.sourceUrl.includes(source.commit)));
  }
});
