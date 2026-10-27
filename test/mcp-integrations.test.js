const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { once } = require('node:events');
const express = require('express');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const types = require('@modelcontextprotocol/sdk/types.js');

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-integrations-'));
const realDirectory = path.join(workspace, 'data');
const directory = path.join(workspace, 'data-alias');
fs.mkdirSync(realDirectory);
// Windows TEMP can use an 8.3 alias. A junction/symlink reproduces the same
// mismatch between an API path and the filesystem server's canonical allowlist.
fs.symlinkSync(realDirectory, directory, process.platform === 'win32' ? 'junction' : 'dir');
process.env.DATA_DIR = directory;
process.env.ROUTER_KEY = 'gateway-integration-test';
process.env.user = 'integration-user';
process.env.password = 'integration-password';
const { app, closeAllMcp } = require('../server');
const { loadConfig } = require('../lib/storage');
const { integrationById } = require('../lib/mcp-catalog');
const { readCredentials, writeCredentials, KEY_PATH } = require('../lib/mcp-vault');
const oauth = require('../lib/mcp-oauth');
let router, provider, base, providerBase, cookie, proof, notionId, filesId;
let currentAccess = 'access-1', currentRefresh = 'refresh-1', refreshCount = 0;
let rejectRefresh = false;
const codes = new Map();
const requests = [];
const transports = new Map();
const clients = [];

async function api(endpoint, method = 'GET', body, headers = {}) {
  const response = await fetch(base + endpoint, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'manual' });
  return { response, data: await response.json().catch(() => ({})) };
}
async function mcpClient() {
  const client = new Client({ name: 'integration-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer gateway-integration-test' } } });
  await client.connect(transport); clients.push({ client, transport }); return client;
}
async function signInStart() {
  const result = await api(`/api/mcp/servers/${notionId}/oauth/start`, 'POST', {});
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  proof = result.response.headers.get('set-cookie').split(';')[0];
  const authorization = await fetch(result.data.authorizationUrl, { redirect: 'manual' });
  return { ...result.data, callback: authorization.headers.get('location') };
}

before(async () => {
  const upstream = express();
  upstream.use(express.json()); upstream.use(express.urlencoded({ extended: false }));
  upstream.get('/.well-known/oauth-protected-resource/mcp', (req, res) => res.json({ resource: providerBase + '/mcp', authorization_servers: [providerBase], scopes_supported: ['default'] }));
  upstream.get('/.well-known/oauth-authorization-server', (req, res) => res.json({ issuer: providerBase, authorization_endpoint: providerBase + '/authorize', token_endpoint: providerBase + '/token', registration_endpoint: providerBase + '/register', revocation_endpoint: providerBase + '/revoke', scopes_supported: ['default'], response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post'], code_challenge_methods_supported: ['S256'] }));
  upstream.post('/register', (req, res) => res.status(201).json({ ...req.body, client_id: 'test-client', client_id_issued_at: 1 }));
  upstream.get('/authorize', (req, res) => {
    assert.equal(req.query.code_challenge_method, 'S256');
    const code = crypto.randomUUID(); codes.set(code, { challenge: req.query.code_challenge, redirect: req.query.redirect_uri });
    const redirect = new URL(req.query.redirect_uri); redirect.searchParams.set('code', code); redirect.searchParams.set('state', req.query.state); redirect.searchParams.set('iss', providerBase);
    res.redirect(redirect.toString());
  });
  upstream.post('/token', (req, res) => {
    requests.push({ path: '/token', body: req.body });
    assert.equal(req.body.client_id, 'test-client'); assert.equal(req.body.resource, providerBase + '/mcp');
    if (req.body.grant_type === 'authorization_code') {
      const issued = codes.get(req.body.code);
      if (!issued || crypto.createHash('sha256').update(req.body.code_verifier).digest('base64url') !== issued.challenge) return res.status(400).json({ error: 'invalid_grant' });
      assert.equal(req.body.redirect_uri, issued.redirect); codes.delete(req.body.code);
    } else {
      refreshCount++;
      if (rejectRefresh || req.body.refresh_token !== currentRefresh) return res.status(400).json({ error: 'invalid_grant' });
      currentAccess = `access-${refreshCount + 1}`; currentRefresh = `refresh-${refreshCount + 1}`;
    }
    res.json({ access_token: currentAccess, refresh_token: currentRefresh, token_type: 'Bearer', expires_in: 3600 });
  });
  upstream.post('/revoke', (req, res) => { requests.push({ path: '/revoke', body: req.body }); res.sendStatus(200); });
  upstream.all('/mcp', async (req, res) => {
    requests.push({ path: '/mcp', authorization: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${currentAccess}`) return res.status(401).json({ error: 'unauthorized' });
    let transport = transports.get(req.headers['mcp-session-id']);
    if (!transport && types.isInitializeRequest(req.body)) {
      const server = new Server({ name: 'mock-notion', version: '1' }, { capabilities: { tools: {} } });
      server.setRequestHandler(types.ListToolsRequestSchema, () => ({ tools: [{ name: 'read_notes', description: 'Read test notes', inputSchema: { type: 'object' } }] }));
      server.setRequestHandler(types.CallToolRequestSchema, () => ({ content: [{ type: 'text', text: 'NOTES_OK' }] }));
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true, onsessioninitialized: (id) => transports.set(id, transport) });
      await server.connect(transport);
    }
    if (!transport) return res.sendStatus(404);
    await transport.handleRequest(req, res, req.body);
  });
  provider = upstream.listen(0, '127.0.0.1'); await once(provider, 'listening'); providerBase = `http://127.0.0.1:${provider.address().port}`;
  // Only this process's fixture catalog points at a credential-free test server.
  const notion = integrationById('notion'); notion.url = providerBase + '/mcp'; notion.oauth.origins = [providerBase];
  router = app.listen(0, '127.0.0.1'); await once(router, 'listening'); base = `http://127.0.0.1:${router.address().port}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'integration-user', password: 'integration-password' }) });
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  for (const { client, transport } of clients) { await transport.terminateSession().catch(() => {}); await client.close(); }
  await closeAllMcp(); for (const transport of transports.values()) await transport.close();
  for (const server of [router, provider]) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('curated catalog supplies beginner instructions and local activation templates without running anything', async () => {
  const result = await api('/api/mcp/catalog'); assert.equal(result.response.status, 200); assert.equal(result.data.items.length, 9);
  assert.ok(result.data.items.find((entry) => entry.id === 'github').tokenSteps.length > 3);
  assert.ok(result.data.items.filter((entry) => entry.oauth).every((entry) => entry.docs && entry.oauth.origins.length));
  assert.equal(loadConfig().mcpServers.length, 0); assert.equal(result.data.setup.callbackUrl, base + '/api/mcp/oauth/callback');
  assert.equal((await fetch(base + '/api/mcp/catalog')).status, 401);
});

test('local Files activates, exposes real tools, and serves uploaded documents through the gateway', async () => {
  const result = await api('/api/mcp/catalog/files/connect', 'POST', { method: 'none', values: {} });
  assert.equal(result.response.status, 200); assert.equal(result.data.next, 'ready'); filesId = result.data.server.id;
  assert.equal(result.data.server.sharedFolder, true); assert.ok(result.data.discovery.tools > 5);
  const upload = await api(`/api/mcp/servers/${filesId}/files`, 'POST', { name: 'readme.txt', data: Buffer.from('Hello from the shared folder').toString('base64') });
  assert.equal(upload.response.status, 201);
  const files = await api(`/api/mcp/servers/${filesId}/files`); assert.equal(files.data.items[0].name, 'readme.txt');
  const client = await mcpClient();
  const read = await client.callTool({ name: 'files__read_text_file', arguments: { path: path.join(files.data.folder, 'readme.txt') } });
  assert.equal(read.content[0].text, 'Hello from the shared folder');
  const listed = await client.callTool({ name: 'files__list_directory', arguments: { path: files.data.folder } });
  assert.notEqual(listed.isError, true); assert.match(listed.content[0].text, /readme\.txt/);
  // Use a canonical outside path so this tests the directory boundary itself,
  // rather than passing because an unresolved alias was rejected first.
  const blocked = await client.callTool({ name: 'files__read_text_file', arguments: { path: fs.realpathSync.native(path.join(directory, 'config.json')) } });
  assert.equal(blocked.isError, true);
  assert.equal((await api(`/api/mcp/servers/${filesId}/files`, 'POST', { name: '../outside', data: 'YQ==' })).response.status, 400);
});

test('Memory and Thinking activate from pinned packages, and concurrent sessions preserve memory facts', async () => {
  const memory = await api('/api/mcp/catalog/memory/connect', 'POST', { method: 'none', values: {} });
  assert.equal(memory.data.next, 'ready');
  const thinking = await api('/api/mcp/catalog/thinking/connect', 'POST', { method: 'none', values: {} });
  assert.equal(thinking.data.next, 'ready');
  const first = await mcpClient(); const second = await mcpClient();
  await Promise.all([first.callTool({ name: 'memory__create_entities', arguments: { entities: [{ name: 'first', entityType: 'test', observations: ['a'] }] } }), second.callTool({ name: 'memory__create_entities', arguments: { entities: [{ name: 'second', entityType: 'test', observations: ['b'] }] } })]);
  const graph = await first.callTool({ name: 'memory__read_graph', arguments: {} });
  const text = graph.content[0].text; assert.match(text, /first/); assert.match(text, /second/);
});

test('guided token setup encrypts credentials and does not expose them in catalog or server responses', async () => {
  const github = integrationById('github'); github.url = providerBase + '/mcp';
  const result = await api('/api/mcp/catalog/github/connect', 'POST', { method: 'token', token: currentAccess, values: { readOnly: true } });
  assert.equal(result.data.next, 'ready'); const id = result.data.server.id;
  assert.ok(!JSON.stringify(result.data).includes(currentAccess));
  assert.ok(!fs.readFileSync(path.join(directory, 'config.json'), 'utf8').includes(currentAccess));
  const vault = fs.readFileSync(path.join(directory, 'mcp-credentials', id + '.json'), 'utf8'); assert.ok(!vault.includes(currentAccess));
  assert.equal(readCredentials(id).token, currentAccess);
  if (process.platform !== 'win32') assert.equal(fs.statSync(KEY_PATH).mode & 0o777, 0o600);
  const catalog = await api('/api/mcp/catalog'); assert.ok(!JSON.stringify(catalog.data).includes(currentAccess));
  const update = await api('/api/mcp/catalog/github/connect', 'POST', { method: 'token', values: { readOnly: true } }); assert.equal(update.data.server.id, id);
  assert.equal((await api(`/api/mcp/servers/${id}`, 'PUT', { url: 'http://elsewhere/mcp' })).response.status, 400);
});

test('OAuth discovery, dynamic registration, PKCE callback, and gateway requests use the actual SDK', async () => {
  const added = await api('/api/mcp/catalog/notion/connect', 'POST', { method: 'oauth', values: {} });
  notionId = added.data.server.id; assert.equal(added.data.next, 'sign_in'); assert.equal(added.data.server.enabled, false);
  const started = await signInStart();
  const authorization = new URL(started.authorizationUrl); assert.equal(authorization.searchParams.get('client_id'), 'test-client');
  const bad = await fetch(started.callback, { headers: { cookie: 'giga_oauth=bad' }, redirect: 'manual' }); assert.equal(bad.status, 403);
  // Dashboard cookie may not be sent on a cross-site redirect; the short-lived
  // browser proof and still-valid server-side dashboard session bind the callback.
  const callback = await fetch(started.callback, { headers: { cookie: proof }, redirect: 'manual' });
  assert.equal(callback.status, 302); assert.match(callback.headers.get('location'), /mcp_oauth=/);
  const saved = readCredentials(notionId); assert.equal(saved.tokens.access_token, currentAccess); assert.equal(saved.client.client_id, 'test-client');
  assert.ok(!JSON.stringify(loadConfig()).includes(currentAccess));
  assert.equal((await fetch(started.callback, { headers: { cookie: proof }, redirect: 'manual' })).status, 400);
  const checked = await api(`/api/mcp/servers/${notionId}/check`, 'POST'); assert.equal(checked.data.discovery.tools, 1);
  const client = await mcpClient(); assert.equal((await client.callTool({ name: 'notion__read_notes', arguments: {} })).content[0].text, 'NOTES_OK');
  assert.ok(requests.filter((entry) => entry.path === '/mcp').every((entry) => entry.authorization !== 'Bearer gateway-integration-test'));
});

test('parallel token refresh rotates once, persists the replacement, and invalid grants require reconnect', async () => {
  const server = loadConfig().mcpServers.find((entry) => entry.id === notionId);
  const saved = readCredentials(notionId); saved.expiresAt = new Date(Date.now() - 1000).toISOString(); writeCredentials(notionId, saved);
  const tokens = await Promise.all([oauth.accessToken(server), oauth.accessToken(server), oauth.accessToken(server)]);
  assert.equal(new Set(tokens).size, 1); assert.equal(refreshCount, 1); assert.equal(readCredentials(notionId).tokens.refresh_token, currentRefresh);
  const invalid = readCredentials(notionId); invalid.expiresAt = new Date(Date.now() - 1000).toISOString(); writeCredentials(notionId, invalid); rejectRefresh = true;
  await assert.rejects(oauth.accessToken(server), /no longer valid/); assert.equal(readCredentials(notionId).tokens, undefined);
  await assert.rejects(oauth.accessToken(server), /sign in/); assert.equal(refreshCount, 2, 'invalid_grant is not retried'); rejectRefresh = false;
});

test('OAuth destination checks refuse untrusted issuers and insecure public callback addresses', async () => {
  assert.throws(() => oauth.callbackOrigin('http://public.example.com'), /HTTPS/);
  const definition = integrationById('notion');
  assert.throws(() => oauth.validateDiscovery({ authorizationServerUrl: 'https://evil.example', authorizationServerMetadata: { code_challenge_methods_supported: ['S256'] } }, definition), /Unexpected/);
  const server = loadConfig().mcpServers.find((entry) => entry.id === notionId);
  await assert.rejects(oauth.oauthFetch(server)('https://evil.example/token', { method: 'POST' }), /unexpected sign-in address/);
  const pending = await signInStart();
  await api(`/api/mcp/servers/${notionId}/disconnect`, 'POST');
  assert.equal((await fetch(pending.callback, { headers: { cookie: proof }, redirect: 'manual' })).status, 400);
  assert.equal(readCredentials(notionId)?.tokens, undefined);
  const catalog = await api('/api/mcp/catalog');
  assert.equal(catalog.data.items.find((entry) => entry.id === 'notion').connectedServer.health.state, 'disconnected');
});

test('HTTPS metadata-document sign-in works without dynamic registration and exposes only public client metadata', async () => {
  const added = await api('/api/mcp/catalog/linear/connect', 'POST', { method: 'oauth', values: { readOnly: true } });
  const server = loadConfig().mcpServers.find((entry) => entry.id === added.data.server.id);
  const discovery = { authorizationServerUrl: 'https://mcp.linear.app',
    authorizationServerMetadata: { issuer: 'https://mcp.linear.app', authorization_endpoint: 'https://mcp.linear.app/authorize', token_endpoint: 'https://mcp.linear.app/token', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], client_id_metadata_document_supported: true },
    resourceMetadata: { resource: 'https://mcp.linear.app/mcp', authorization_servers: ['https://mcp.linear.app'] } };
  const started = await oauth.startSignIn(server, { origin: 'https://router.example.com', session: 'test-session', browserProof: 'proof' }, { discover: async () => discovery, fetch: () => { throw Error('No registration should be needed'); } });
  const metadata = oauth.clientMetadata(server.id);
  assert.equal(metadata.client_id, 'https://router.example.com/api/mcp/oauth/client-metadata/' + server.id);
  assert.equal(new URL(started.authorizationUrl).searchParams.get('client_id'), metadata.client_id);
  assert.ok(!JSON.stringify(metadata).includes('secret'));
  assert.equal((await fetch(base + '/api/mcp/oauth/client-metadata/' + server.id)).status, 200);
  oauth.clearPendingSignIn(server.id);
});

test('expired authorization in an existing gateway session refreshes and retries without exposing the router key', async () => {
  const started = await signInStart();
  const callback = await fetch(started.callback, { headers: { cookie: proof }, redirect: 'manual' }); assert.equal(callback.status, 302);
  await api(`/api/mcp/servers/${notionId}/check`, 'POST');
  const client = await mcpClient(); await client.listTools();
  const server = loadConfig().mcpServers.find((entry) => entry.id === notionId);
  const saved = readCredentials(notionId); saved.tokens.access_token = 'expired-access'; writeCredentials(notionId, saved);
  const count = refreshCount;
  const read = await client.callTool({ name: 'notion__read_notes', arguments: {} });
  assert.equal(read.content[0].text, 'NOTES_OK'); assert.equal(refreshCount, count + 1);
  assert.ok(readCredentials(notionId).tokens.access_token !== 'expired-access');
});

test('GitHub app setup uses static credentials, hides its secret, and keeps registration after disconnect', async () => {
  const definition = integrationById('github'); definition.oauth.origins = [providerBase];
  const added = await api('/api/mcp/catalog/github/connect', 'POST', { method: 'oauth', values: { readOnly: true } });
  const id = added.data.server.id;
  const noApp = await api(`/api/mcp/servers/${id}/oauth/start`, 'POST', {});
  assert.equal(noApp.response.status, 400); assert.match(noApp.data.error, /one-time app setup/);
  const started = await api(`/api/mcp/servers/${id}/oauth/start`, 'POST', { clientId: 'test-client', clientSecret: 'static-app-secret' });
  assert.equal(started.response.status, 200);
  const browserProof = started.response.headers.get('set-cookie').split(';')[0];
  const authorization = await fetch(started.data.authorizationUrl, { redirect: 'manual' });
  const callback = await fetch(authorization.headers.get('location'), { headers: { cookie: browserProof }, redirect: 'manual' });
  assert.equal(callback.status, 302);
  const exchange = requests.findLast((entry) => entry.path === '/token' && entry.body.grant_type === 'authorization_code');
  assert.equal(exchange.body.client_secret, 'static-app-secret');
  const catalog = await api('/api/mcp/catalog'); assert.ok(!JSON.stringify(catalog.data).includes('static-app-secret'));
  assert.ok(!fs.readFileSync(path.join(directory, 'config.json'), 'utf8').includes('static-app-secret'));
  assert.ok(!fs.readFileSync(path.join(directory, 'mcp-credentials', id + '.json'), 'utf8').includes('static-app-secret'));
  await api(`/api/mcp/servers/${id}/disconnect`, 'POST');
  assert.equal(readCredentials(id).client.client_id, 'test-client'); assert.equal(readCredentials(id).tokens, undefined);
});
