const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { unzipSync, strFromU8 } = require('fflate');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const types = require('@modelcontextprotocol/sdk/types.js');
const express = require('express');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-router-test-'));
process.env.DATA_DIR = directory;
process.env.ROUTER_KEY = 'test-gateway-key';
process.env.user = 'tester';
process.env.password = 'test-password';
const { app, closeAllMcp } = require('../server');
const { loadConfig, updateConfig, writeJson } = require('../lib/storage');
const { parseGitHubSource } = require('../lib/github-source');
const { parseSkill, indexSource, installSkill } = require('../lib/skills');

let listener, backend, base, cookie, mcpId, keyToken, keyId;
const clients = [];
const upstreamHeaders = [];
const backendSessions = new Map();
const sseSessions = new Map();
const sseHeaders = [];
const rawSkill = '---\nname: code-review\ndescription: Review a change carefully.\nlicense: MIT\n---\n\n# Review a change\n\nRead the diff, trace its behavior, and report concrete bugs.\n';
const chatSkill = '# Review a change\n\nRead the diff, trace its behavior, and report concrete bugs.';

async function request(endpoint, method = 'GET', body, extraHeaders = {}) {
  const response = await fetch(base + endpoint, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

before(async () => {
  const backendApp = express();
  backendApp.use(express.json());
  backendApp.get('/sse', async (req, res) => {
    sseHeaders.push(req.headers);
    const server = new Server({ name: 'sse-test', version: '1.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(types.ListToolsRequestSchema, () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }));
    server.setRequestHandler(types.CallToolRequestSchema, (request) => ({ content: [{ type: 'text', text: request.params.arguments.text }] }));
    const transport = new SSEServerTransport('/sse-messages', res);
    sseSessions.set(transport.sessionId, { transport, server });
    await server.connect(transport);
  });
  backendApp.post('/sse-messages', async (req, res) => {
    sseHeaders.push(req.headers);
    const session = sseSessions.get(req.query.sessionId);
    if (!session) return res.sendStatus(404);
    await session.transport.handlePostMessage(req, res, req.body);
  });
  backendApp.all('/mcp', async (req, res) => {
    upstreamHeaders.push(req.headers);
    let item = backendSessions.get(req.headers['mcp-session-id']);
    if (!item && req.method === 'POST' && types.isInitializeRequest(req.body)) {
      const server = new Server({ name: 'authless-test', version: '1.0.0' }, { capabilities: { tools: {}, prompts: {}, resources: {} } });
      const serial = backendSessions.size + 1;
      let calls = 0;
      server.setRequestHandler(types.ListToolsRequestSchema, () => ({ tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }));
      server.setRequestHandler(types.CallToolRequestSchema, (rpc) => ({ content: [{ type: 'text', text: `${serial}:${++calls}:${rpc.params.arguments.text}` }] }));
      server.setRequestHandler(types.ListPromptsRequestSchema, () => ({ prompts: [{ name: 'welcome', description: 'Test prompt' }] }));
      server.setRequestHandler(types.GetPromptRequestSchema, () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'Welcome' } }] }));
      server.setRequestHandler(types.ListResourcesRequestSchema, () => ({ resources: [{ name: 'test', uri: 'test://data', mimeType: 'text/plain' }] }));
      server.setRequestHandler(types.ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: [] }));
      server.setRequestHandler(types.ReadResourceRequestSchema, () => ({ contents: [{ uri: 'test://data', text: 'RESOURCE_OK' }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => require('node:crypto').randomUUID(), enableJsonResponse: true,
        onsessioninitialized: (id) => backendSessions.set(id, { server, transport }) });
      await server.connect(transport); item = { server, transport };
    }
    if (!item) return res.status(404).json({ error: 'unknown session' });
    await item.transport.handleRequest(req, res, req.body);
  });
  backend = backendApp.listen(0, '127.0.0.1'); await once(backend, 'listening');
  listener = app.listen(0, '127.0.0.1'); await once(listener, 'listening');
  base = `http://127.0.0.1:${listener.address().port}`;
  const response = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'tester', password: 'test-password' }) });
  assert.equal(response.status, 200);
  cookie = response.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  for (const { client, transport } of clients) { await transport.terminateSession().catch(() => {}); await client.close(); }
  await closeAllMcp();
  await Promise.all([...backendSessions.values()].map((item) => item.server.close()));
  await Promise.all([...sseSessions.values()].map((item) => item.server.close()));
  for (const server of [listener, backend]) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  fs.rmSync(directory, { recursive: true, force: true });
});

test('dashboard and installed-skill APIs require login and reject cross-origin mutations', async () => {
  const response = await fetch(base + '/api/skills'); assert.equal(response.status, 401);
  assert.equal((await request('/api/skills', 'POST', { name: 'bad', content: 'bad' }, { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await request('/styles.css')).status, 200);
});

test('provider edits preserve masked secrets, custom headers, and legacy compatibility settings', async () => {
  const created = await request('/api/providers', 'POST', { name: 'My provider', type: 'openai', baseUrl: 'http://127.0.0.1:8765/v1', apiKey: 'provider-secret', defaultModel: 'test-model', headers: { 'X-Test': 'header-secret' }, userAgent: 'legacy-agent', compat: { noReasoningEffortWithTools: true } });
  assert.equal(created.status, 200);
  assert.equal(created.data.apiKey, '***'); assert.equal(created.data.headers['X-Test'], '***');
  const edited = await request(`/api/providers/${created.data.id}`, 'PUT', { defaultModel: 'other-model', apiKey: '***', headers: { 'X-Test': '***' } });
  assert.equal(edited.status, 200);
  const saved = loadConfig().providers[0];
  assert.equal(saved.apiKey, 'provider-secret'); assert.equal(saved.headers['X-Test'], 'header-secret'); assert.equal(saved.userAgent, 'legacy-agent');
  assert.equal(saved.compat.noReasoningEffortWithTools, true);
  const models = await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer test-gateway-key' } }).then((r) => r.json());
  assert.equal(models.data[0].id, 'my-provider/other-model');
});

test('manual skill persistence keeps exact raw content and returns clean chat instructions', async () => {
  const result = await request('/api/skills', 'POST', { name: 'code-review', description: 'Personal review checklist', content: rawSkill });
  assert.equal(result.status, 201); assert.equal(result.data.text, chatSkill); assert.equal(result.data.content, rawSkill);
  assert.equal(result.data.description, 'Personal review checklist');
  const saved = await request(`/api/skills/${result.data.id}`); assert.equal(saved.data.text, chatSkill);
  const archive = await fetch(base + `/api/skills/${result.data.id}/download`, { headers: { cookie } });
  assert.equal(archive.headers.get('content-type'), 'application/zip');
  const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  assert.equal(strFromU8(files['code-review/SKILL.md']), rawSkill);
  assert.equal(fs.readFileSync(path.join(directory, result.data.portablePath, 'SKILL.md'), 'utf8'), rawSkill);
});

test('GitHub source parsing supports scoped URLs and refuses traversal or lookalike hosts', () => {
  assert.deepEqual(parseGitHubSource('https://github.com/owner/repo/tree/main/skills'), { owner: 'owner', repo: 'repo', ref: 'main', path: 'skills', url: 'https://github.com/owner/repo' });
  assert.equal(parseGitHubSource('owner/repo', { ref: 'feature/skills', path: 'skills' }).ref, 'feature/skills');
  assert.equal(parseGitHubSource('https://github.com/owner/repo/blob/main/skills/test/SKILL.md').path, 'skills/test');
  for (const value of ['https://github.com.evil.example/owner/repo', 'https://github.com/owner/repo/tree/main/%2e%2e/secret', 'owner/repo/../../secret']) assert.throws(() => parseGitHubSource(value));
  assert.throws(() => parseGitHubSource('owner/repo', { path: 'C:/outside' }));
  assert.equal(parseSkill(rawSkill).text, chatSkill);
  assert.throws(() => parseSkill('Instructions', '..'), /safe name/);
});

test('marketplace index/install uses pinned commits, includes supporting files and licensing, and updates cleanly', async () => {
  const calls = [];
  const files = { skillsha: rawSkill, refsha: 'Support reference', scriptsha: 'print("downloaded only")', licensesha: 'MIT License test' };
  const github = {
    async request(endpoint) {
      calls.push(endpoint);
      if (endpoint.endsWith('/commits/main')) return { sha: 'commit-one', commit: { tree: { sha: 'root-tree' } } };
      if (endpoint.endsWith('/git/trees/root-tree')) return { tree: [{ path: 'skills', type: 'tree', sha: 'skills-tree' }] };
      if (endpoint.endsWith('/git/trees/skills-tree?recursive=1')) return { tree: [
        { path: 'review/SKILL.md', type: 'blob', sha: 'skillsha', size: rawSkill.length },
        { path: 'review/references/checklist.md', type: 'blob', sha: 'refsha', size: 17 },
        { path: 'review/scripts/check.py', type: 'blob', sha: 'scriptsha', size: 20 },
        { path: 'review/symlink', type: 'blob', mode: '120000', sha: 'no', size: 1 },
      ] };
      if (endpoint.includes('/contents?ref=')) return [{ name: 'LICENSE', type: 'file', sha: 'licensesha' }];
      if (endpoint === '/repos/owner/repo') return { default_branch: 'main', license: { spdx_id: 'MIT' } };
      throw new Error('Unexpected endpoint ' + endpoint);
    },
    async blob(source, sha, maxBytes, filePath) { assert.equal(source.commit, 'commit-one'); return Buffer.from(files[sha]); },
  };
  const index = await indexSource({ url: 'owner/repo', path: 'skills' }, github);
  assert.equal(index.entries.length, 1); assert.equal(index.source.commit, 'commit-one'); assert.equal(index.entries[0].path, 'skills/review');
  assert.ok(!calls.some((endpoint) => endpoint.endsWith('root-tree?recursive=1')));
  index.source.id = 'test-source';
  writeJson(path.join(directory, 'marketplace', 'test-source.json'), index);
  updateConfig((config) => config.sources.push(index.source));
  const installed = await installSkill('test-source', 'skills/review', github);
  assert.equal(installed.text, chatSkill); assert.equal(installed.license, 'MIT');
  assert.ok(installed.files.some((file) => file.path === 'scripts/check.py'));
  assert.ok(installed.files.some((file) => file.path === 'SOURCE-LICENSE.txt'));
  assert.ok(!installed.files.some((file) => file.path.includes('symlink')));
  const marketplace = await request('/api/marketplace'); assert.equal(marketplace.data.items[0].installedId, installed.id);
  index.entries[0].bundleHash = 'changed-reference-hash';
  writeJson(path.join(directory, 'marketplace', 'test-source.json'), index);
  assert.equal((await request('/api/marketplace')).data.items[0].updateAvailable, true, 'Supporting file changes are updates even when SKILL.md is unchanged');
  index.tree = index.tree.filter((file) => !file.path.endsWith('scripts/check.py'));
  writeJson(path.join(directory, 'marketplace', 'test-source.json'), index);
  const updated = await installSkill('test-source', 'skills/review', github);
  assert.equal(fs.existsSync(path.join(directory, updated.portablePath, 'scripts', 'check.py')), false);
  await request('/api/sources/test-source', 'DELETE');
  assert.equal((await request(`/api/skills/${installed.id}`)).status, 200);
});

test('MCP gateway adds authentication to auth-less backends and namespaces tools, prompts, and resources', async () => {
  const added = await request('/api/mcp/servers', 'POST', { name: 'Search', slug: 'search', transport: 'http', url: `http://127.0.0.1:${backend.address().port}/mcp` });
  assert.equal(added.status, 201); mcpId = added.data.id;
  const discover = await request(`/api/mcp/servers/${mcpId}/discover`, 'POST');
  assert.equal(discover.status, 200); assert.equal(discover.data.items[0].name, 'search__echo');
  const unauthorized = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(unauthorized.status, 401);
  const minted = await request('/api/access/keys', 'POST', { name: 'Coding agent', scopes: ['mcp'], serverIds: [mcpId] });
  keyToken = minted.data.key; keyId = minted.data.id;
  const client = new Client({ name: 'integration-client', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${keyToken}` } } });
  await client.connect(transport); clients.push({ client, transport });
  const tools = await client.listTools(); assert.ok(tools.tools.some((tool) => tool.name === 'search__echo')); assert.ok(tools.tools.some((tool) => tool.name === 'giga__skill'));
  const result = await client.callTool({ name: 'search__echo', arguments: { text: 'MCP_OK' } }); assert.match(result.content[0].text, /:1:MCP_OK$/);
  const prompts = await client.listPrompts(); assert.ok(prompts.prompts.some((prompt) => prompt.name === 'search__welcome')); assert.ok(prompts.prompts.some((prompt) => prompt.name.startsWith('skill__')));
  const resources = await client.listResources(); assert.ok(resources.resources.some((resource) => resource.uri === 'giga://search/test://data'));
  assert.equal((await client.readResource({ uri: 'giga://search/test://data' })).contents[0].text, 'RESOURCE_OK');
  assert.ok(upstreamHeaders.every((headers) => !headers.authorization && !headers['x-gateway-key'] && !headers['x-api-key']));
  assert.equal((await fetch(base + '/v1/models', { headers: { Authorization: `Bearer ${keyToken}` } })).status, 403);
});

test('MCP sessions isolate backend state and enforce server restrictions on list and call', async () => {
  const restricted = await request('/api/access/keys', 'POST', { name: 'Skills only', scopes: ['mcp'], serverIds: [] });
  const client = new Client({ name: 'restricted', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${restricted.data.key}` } } });
  await client.connect(transport); clients.push({ client, transport });
  assert.ok(!(await client.listTools()).tools.some((tool) => tool.name === 'search__echo'));
  await assert.rejects(client.callTool({ name: 'search__echo', arguments: { text: 'denied' } }), /not allowed/);
  const other = new Client({ name: 'other-client', version: '1' });
  const otherTransport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${keyToken}` } } });
  await other.connect(otherTransport); clients.push({ client: other, transport: otherTransport });
  await other.listTools();
  assert.match((await other.callTool({ name: 'search__echo', arguments: { text: 'OTHER' } })).content[0].text, /:1:OTHER$/);
  assert.match((await clients[0].client.callTool({ name: 'search__echo', arguments: { text: 'FIRST' } })).content[0].text, /:2:FIRST$/);
  const forbiddenSession = await fetch(base + '/mcp', { headers: { Authorization: `Bearer ${restricted.data.key}`, 'Mcp-Session-Id': otherTransport.sessionId, Accept: 'text/event-stream' } });
  assert.equal(forbiddenSession.status, 404);
  await request(`/api/mcp/servers/${mcpId}`, 'PUT', { enabled: false });
  assert.ok(!(await other.listTools()).tools.some((tool) => tool.name === 'search__echo'));
  await assert.rejects(other.callTool({ name: 'search__echo', arguments: { text: 'disabled' } }), /disabled/);
  await request(`/api/access/keys/${keyId}`, 'DELETE');
  assert.equal((await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${keyToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).status, 401);
});

test('legacy SSE backends receive only their own credentials and complete a real gateway round trip', async () => {
  const added = await request('/api/mcp/servers', 'POST', { name: 'Legacy', slug: 'legacy', transport: 'sse', url: `http://127.0.0.1:${backend.address().port}/sse`, headers: { Authorization: 'Bearer backend-sse-key' } });
  assert.equal(added.status, 201);
  const client = new Client({ name: 'sse-through-gateway', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer test-gateway-key' } } });
  await client.connect(transport); clients.push({ client, transport });
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'legacy__echo'));
  assert.equal((await client.callTool({ name: 'legacy__echo', arguments: { text: 'SSE_OK' } })).content[0].text, 'SSE_OK');
  assert.ok(sseHeaders.every((headers) => headers.authorization === 'Bearer backend-sse-key'));
});

test('stdio backends work through HTTP and inherit only configured/safe environment values', async () => {
  const added = await request('/api/mcp/servers', 'POST', { name: 'Local', slug: 'local', transport: 'stdio', command: process.execPath, args: [path.join(__dirname, '../fixtures', 'mcp-stdio.cjs')], env: { FIXTURE_VALUE: 'configured' } });
  assert.equal(added.status, 201);
  const discovery = await request(`/api/mcp/servers/${added.data.id}/discover`, 'POST');
  assert.equal(discovery.status, 200); assert.equal(discovery.data.items[0].name, 'local__echo');
  const client = new Client({ name: 'stdio-through-gateway', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer test-gateway-key' } } });
  await client.connect(transport); clients.push({ client, transport });
  assert.equal((await client.callTool({ name: 'local__echo', arguments: { text: 'STDIO_OK' } })).content[0].text, 'STDIO_OK:configured:isolated');
  await request(`/api/mcp/servers/${added.data.id}`, 'DELETE');
  await assert.rejects(client.callTool({ name: 'local__echo', arguments: { text: 'removed' } }), /missing/);
});
