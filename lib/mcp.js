// Uses the official MIT-licensed MCP SDK client/server transports. Each gateway
// session owns its own server and backend clients; credentials never cross sessions.
const crypto = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const types = require('@modelcontextprotocol/sdk/types.js');
const { loadConfig, updateConfig } = require('./storage');
const { gatewayAuth } = require('./auth');
const { httpUrl, inputError, headerMap, maskedMap } = require('./validation');
const { mapLimit, skillDetail, skillFiles } = require('./skills');
const { recordActivity } = require('./activity');
const { readCredentials, deleteCredentials } = require('./mcp-vault');
const { accessToken, summary: oauthSummary, clearPendingSignIn } = require('./mcp-oauth');
const { integrationById } = require('./mcp-catalog');

const sessions = new Map();
const serverHealth = new Map();
const SESSION_IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 100;
const sharedMemory = new Map();
const memoryCalls = new Map();
const sweeper = setInterval(() => {
  for (const [id, session] of sessions) if (Date.now() - session.lastAt > SESSION_IDLE_MS) closeSession(id).catch(() => {});
}, 60_000);
sweeper.unref();

function publicServer(server) {
  const status = server.authKind === 'oauth' ? oauthSummary(server.id) : { connected: server.authKind !== 'token' || !!readCredentials(server.id)?.token, state: 'configured' };
  return { ...server, headers: maskedMap(server.headers), env: maskedMap(server.env), auth: status,
    integrationName: integrationById(server.integrationId)?.name || null,
    health: serverHealth.get(server.id) || server.connection || { state: 'unknown' } };
}

function validateServer(body, previous = {}) {
  const name = typeof body.name === 'string' ? body.name.trim() : previous.name;
  const slug = typeof body.slug === 'string' ? body.slug.trim() : previous.slug || name?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  const transport = body.transport || previous.transport || 'http';
  if (!name || name.length > 120 || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(slug || '') || ['giga', 'skill'].includes(slug)) throw inputError('A name and a unique lowercase slug (up to 32 letters, numbers, or dashes) are required');
  if (!['http', 'sse', 'stdio'].includes(transport)) throw inputError('Transport must be http, sse, or stdio');
  const server = { id: previous.id || crypto.randomUUID(), name, slug, transport, enabled: body.enabled ?? previous.enabled ?? true,
    timeoutMs: body.timeoutMs ?? previous.timeoutMs ?? 30_000, headers: headerMap(body.headers, previous.headers), env: {},
    createdAt: previous.createdAt || new Date().toISOString() };
  for (const field of ['integrationId', 'authKind', 'setupValues', 'sharedFolder', 'oauthScope', 'connection', 'credentialVersion']) {
    if (previous[field] !== undefined) server[field] = previous[field];
  }
  if (typeof server.enabled !== 'boolean' || !Number.isInteger(server.timeoutMs) || server.timeoutMs < 1000 || server.timeoutMs > 600_000) throw inputError('Timeout must be between 1,000 and 600,000 ms');
  if (transport === 'stdio') {
    server.command = typeof body.command === 'string' ? body.command.trim() : previous.command;
    server.args = body.args ?? previous.args ?? [];
    server.env = headerMap(body.env, previous.env);
    server.cwd = body.cwd?.trim() || previous.cwd || undefined;
    if (!server.command || /[\0\r\n]/.test(server.command) || !Array.isArray(server.args) || server.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw inputError('Stdio needs an executable and an array of string arguments');
  } else {
    server.url = httpUrl(body.url || previous.url).toString();
  }
  return server;
}

function allowedServers(key) {
  return loadConfig().mcpServers.filter((server) => server.enabled !== false && (key.serverIds === null || key.serverIds === undefined || key.serverIds.includes(server.id)));
}

function createBackendTransport(server) {
  if (server.transport === 'stdio') return new StdioClientTransport({ command: server.command, args: server.args, cwd: server.cwd,
    env: { ...getDefaultEnvironment(), ...server.env }, stderr: 'pipe' });
  const url = httpUrl(server.url);
  const fetcher = async (input, init = {}) => {
    // Remote SSE servers can publish a separate POST URL. Keep those requests on
    // the configured origin so server-controlled URLs cannot collect auth headers.
    const target = new URL(typeof input === 'string' ? input : input.url || input.toString());
    if (target.origin !== url.origin) throw inputError('MCP server requested a cross-origin transport URL');
    const headers = new Headers(init.headers);
    let token;
    if (server.authKind === 'oauth') {
      token = await accessToken(server);
      headers.set('Authorization', `Bearer ${token}`);
    } else if (server.authKind === 'token') {
      token = readCredentials(server.id)?.token;
      if (!token) throw inputError('Add your access token in this connection’s setup guide.', 401);
      headers.set('Authorization', `Bearer ${token}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), server.timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    // Bound a stalled connection/header response while allowing an established
    // SSE stream to remain open. The SDK bounds individual JSON-RPC calls.
    try {
      let response = await fetch(input, { ...init, headers, signal, redirect: 'error' });
      if (response.status === 401 && server.authKind === 'oauth') {
        await response.body?.cancel();
        const renewed = await accessToken(server, { forceRefresh: true, rejectedToken: token });
        headers.set('Authorization', `Bearer ${renewed}`);
        response = await fetch(input, { ...init, headers, signal, redirect: 'error' });
      }
      return response;
    } finally { clearTimeout(timer); }
  };
  const options = { requestInit: { headers: server.headers || {} }, fetch: fetcher };
  return server.transport === 'sse' ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options);
}

async function connectBackend(server) {
  const client = new Client({ name: 'giga-router', version: '1.1.0' }, { capabilities: {} });
  const transport = createBackendTransport(server);
  // Drain stderr without copying potentially sensitive server logs into our logs.
  transport.stderr?.resume();
  const start = Date.now();
  try {
    await client.connect(transport, { timeout: server.timeoutMs });
    serverHealth.set(server.id, { state: 'connected', checkedAt: new Date().toISOString(), latencyMs: Date.now() - start });
    return { client, transport, signature: JSON.stringify(server) };
  } catch (error) {
    await client.close().catch(() => {});
    serverHealth.set(server.id, { state: 'error', checkedAt: new Date().toISOString(), error: 'Connection failed. Check the endpoint and credentials.' });
    throw error;
  }
}

async function closeBackend(connection) {
  if (!connection) return;
  if (connection.transport.terminateSession) await connection.transport.terminateSession().catch(() => {});
  await connection.client.close().catch(() => {});
}

class BackendPool {
  constructor() { this.connections = new Map(); this.pending = new Map(); this.closed = false; this.closing = null; }

  async get(server) {
    if (this.closed) throw new Error('MCP session is closed');
    if (server.integrationId === 'memory') {
      const existing = sharedMemory.get(server.id);
      if (existing?.signature === JSON.stringify(server)) return (await existing.promise).client;
      const entry = { signature: JSON.stringify(server), promise: (async () => {
        if (existing) await closeBackend(await existing.promise.catch(() => null));
        const connection = await connectBackend(server);
        connection.client.onclose = () => { if (sharedMemory.get(server.id) === entry) sharedMemory.delete(server.id); };
        return connection;
      })() };
      sharedMemory.set(server.id, entry);
      try { return (await entry.promise).client; } catch (error) { if (sharedMemory.get(server.id) === entry) sharedMemory.delete(server.id); throw error; }
    }
    const existing = this.connections.get(server.id);
    if (existing?.signature === JSON.stringify(server)) return existing.client;
    if (this.pending.has(server.id)) return this.pending.get(server.id);
    const pending = (async () => {
      await closeBackend(existing);
      const connection = await connectBackend(server);
      if (this.closed) { await closeBackend(connection); throw new Error('MCP session ended while connecting'); }
      this.connections.set(server.id, connection);
      connection.client.onclose = () => {
        if (this.connections.get(server.id) === connection) this.connections.delete(server.id);
      };
      return connection.client;
    })();
    this.pending.set(server.id, pending);
    try { return await pending; } finally { this.pending.delete(server.id); }
  }

  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await Promise.allSettled([...this.pending.values()]);
      await Promise.all([...this.connections.values()].map(closeBackend));
      this.connections.clear();
    })();
    return this.closing;
  }
}

async function listAll(client, method, field, server) {
  const items = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const result = await client[method](cursor ? { cursor } : {}, { timeout: server.timeoutMs });
    items.push(...(result[field] || []));
    if (!result.nextCursor) return items;
    if (result.nextCursor === cursor) throw new Error('MCP server returned a repeating cursor');
    cursor = result.nextCursor;
  }
  throw new Error('MCP list exceeds 50 pages');
}

function wrapUri(slug, uri) { return `giga://${slug}/${uri}`; }
function enabledSkills() { return loadConfig().skills.filter((skill) => skill.enabled !== false); }

async function backendTool(client, server, params, options) {
  const call = () => client.callTool(params, types.CallToolResultSchema, options);
  if (server.integrationId !== 'memory') return call();
  // The bundled graph server reads/writes one file. A single shared process and
  // serialized calls keep parallel agent sessions from losing each other’s facts.
  const previous = memoryCalls.get(server.id) || Promise.resolve();
  const pending = previous.catch(() => {}).then(call);
  memoryCalls.set(server.id, pending);
  try { return await pending; } finally { if (memoryCalls.get(server.id) === pending) memoryCalls.delete(server.id); }
}

function qualifyTool(tool, backend) {
  const directory = backend.integrationId === 'files' ? backend.args?.[1] : null;
  return { ...tool, name: `${backend.slug}__${tool.name}`, ...(directory ? { description: `${tool.description || ''}\nThis Files connection allows the folder ${directory}. Use this path to list documents or read uploaded files.` } : {}) };
}

function createGatewayServer(key, pool) {
  const server = new Server({ name: 'giga-router', version: '1.1.0' }, { capabilities: { tools: { listChanged: true }, prompts: { listChanged: true }, resources: { listChanged: true } },
    instructions: 'Tools are namespaced as server__tool. Installed skills are available through giga__skill and skill__ prompts. Load a relevant skill when you need its instructions.' });
  const resolve = (name) => {
    const index = name.indexOf('__');
    const slug = name.slice(0, index);
    const backend = allowedServers(key).find((entry) => entry.slug === slug);
    if (index < 1 || !backend) throw new types.McpError(-32003, 'MCP server is missing, disabled, or not allowed for this key');
    return { backend, name: name.slice(index + 2) };
  };
  const aggregate = async (capability, method, field, convert) => {
    const lists = await mapLimit(allowedServers(key), 4, async (backend) => {
      try {
        const client = await pool.get(backend);
        if (!client.getServerCapabilities()?.[capability]) return [];
        return (await listAll(client, method, field, backend)).map((item) => convert(item, backend));
      } catch {
        serverHealth.set(backend.id, { state: 'error', checkedAt: new Date().toISOString(), error: 'Discovery failed. Check the endpoint and credentials.' });
        return [];
      }
    });
    return lists.flat();
  };

  server.setRequestHandler(types.ListToolsRequestSchema, async () => ({ tools: [
    ...(enabledSkills().length ? [{ name: 'giga__skill', description: 'Read an installed skill by its name or id. Optionally read a supporting file.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string', description: 'Defaults to SKILL.md' } }, required: ['name'] }, annotations: { readOnlyHint: true } }] : []),
    ...await aggregate('tools', 'listTools', 'tools', qualifyTool),
  ] }));

  server.setRequestHandler(types.CallToolRequestSchema, async (request, extra) => {
    if (request.params.name === 'giga__skill') {
      const skill = enabledSkills().find((entry) => entry.name === request.params.arguments?.name || entry.id === request.params.arguments?.name);
      if (!skill) throw new types.McpError(-32602, 'Installed skill not found or disabled');
      const filePath = request.params.arguments?.path || 'SKILL.md';
      const file = skillFiles(skill).find((entry) => entry.path === filePath);
      if (!file) throw new types.McpError(-32602, 'Skill file not found');
      if (!/\.(md|txt|json|yaml|yml|csv|xml|toml|js|ts|py|sh)$/i.test(filePath)) throw new types.McpError(-32602, 'This is a binary asset. Download the skill bundle to use it.');
      recordActivity({ kind: 'mcp', name: skill.name, keyName: key.name, status: 'ok' });
      return { content: [{ type: 'text', text: Buffer.from(file.data, 'base64').toString('utf8') }] };
    }
    const target = resolve(request.params.name);
    const start = Date.now();
    try {
      const client = await pool.get(target.backend);
      const result = await backendTool(client, target.backend, { ...request.params, name: target.name }, { timeout: target.backend.timeoutMs, signal: extra.signal });
      recordActivity({ kind: 'mcp', name: request.params.name, keyName: key.name, status: result.isError ? 'error' : 'ok', durationMs: Date.now() - start });
      return result;
    } catch (error) {
      recordActivity({ kind: 'mcp', name: request.params.name, keyName: key.name, status: 'error', durationMs: Date.now() - start });
      if (error instanceof types.McpError) throw error;
      throw new types.McpError(-32603, 'MCP tool call failed. Check this server in the dashboard.');
    }
  });
  server.setRequestHandler(types.ListPromptsRequestSchema, async () => ({ prompts: [
    ...enabledSkills().map((skill) => ({ name: `skill__${skill.id}`, title: skill.name, description: skill.description })),
    ...await aggregate('prompts', 'listPrompts', 'prompts', (prompt, backend) => ({ ...prompt, name: `${backend.slug}__${prompt.name}` })),
  ] }));
  server.setRequestHandler(types.GetPromptRequestSchema, async (request) => {
    if (request.params.name.startsWith('skill__')) {
      const id = request.params.name.slice(7);
      if (!enabledSkills().some((skill) => skill.id === id)) throw new types.McpError(-32602, 'Skill not found or disabled');
      const skill = skillDetail(id);
      return { description: skill.description, messages: [{ role: 'user', content: { type: 'text', text: skill.text } }] };
    }
    const target = resolve(request.params.name);
    return (await pool.get(target.backend)).getPrompt({ ...request.params, name: target.name }, { timeout: target.backend.timeoutMs });
  });
  server.setRequestHandler(types.ListResourcesRequestSchema, async () => ({ resources: [
    ...enabledSkills().map((skill) => ({ uri: `skill://${skill.id}/SKILL.md`, name: skill.name, description: skill.description, mimeType: 'text/markdown' })),
    ...await aggregate('resources', 'listResources', 'resources', (resource, backend) => ({ ...resource, uri: wrapUri(backend.slug, resource.uri) })),
  ] }));
  server.setRequestHandler(types.ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates:
    await aggregate('resources', 'listResourceTemplates', 'resourceTemplates', (template, backend) => ({ ...template, uriTemplate: wrapUri(backend.slug, template.uriTemplate) })),
  }));
  server.setRequestHandler(types.ReadResourceRequestSchema, async (request) => {
    const skillUri = /^skill:\/\/([^/]+)\/(.+)$/.exec(request.params.uri);
    if (skillUri) {
      const skill = enabledSkills().find((entry) => entry.id === skillUri[1]);
      if (!skill) throw new types.McpError(-32602, 'Skill not found or disabled');
      const file = skillFiles(skill).find((entry) => entry.path === skillUri[2]);
      if (!file) throw new types.McpError(-32602, 'Skill file not found');
      const isText = /\.(md|txt|json|yaml|yml|csv|xml|toml|js|ts|py|sh)$/i.test(file.path);
      return { contents: [{ uri: request.params.uri, mimeType: /\.md$/i.test(file.path) ? 'text/markdown' : isText ? 'text/plain' : 'application/octet-stream',
        ...(isText ? { text: Buffer.from(file.data, 'base64').toString('utf8') } : { blob: file.data }) }] };
    }
    const match = /^giga:\/\/([^/]+)\/([\s\S]+)$/.exec(request.params.uri);
    const backend = match && allowedServers(key).find((entry) => entry.slug === match[1]);
    if (!backend) throw new types.McpError(-32003, 'Resource is not available for this key');
    const result = await (await pool.get(backend)).readResource({ uri: match[2] }, { timeout: backend.timeoutMs });
    return { ...result, contents: result.contents.map((content) => ({ ...content, uri: wrapUri(backend.slug, content.uri) })) };
  });
  return server;
}

async function closeSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  await Promise.allSettled([session.server.close(), session.pool.close()]);
}

function mountMcp(app, sessionAuth) {
  const route = (handler) => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
  app.get('/api/mcp/servers', sessionAuth, (req, res) => res.json({ items: loadConfig().mcpServers.map(publicServer), sessions: sessions.size }));
  app.post('/api/mcp/servers', sessionAuth, route((req, res) => {
    const server = validateServer(req.body);
    if (loadConfig().mcpServers.some((item) => item.slug === server.slug)) throw inputError('MCP slug is already in use', 409);
    updateConfig((config) => config.mcpServers.push(server));
    notifyMcpClients();
    res.status(201).json(publicServer(server));
  }));
  app.put('/api/mcp/servers/:id', sessionAuth, route(async (req, res) => {
    const existing = loadConfig().mcpServers.find((entry) => entry.id === req.params.id);
    if (!existing) throw inputError('MCP server not found', 404);
    if (existing.integrationId && Object.keys(req.body).some((field) => !['name', 'slug', 'enabled', 'timeoutMs'].includes(field))) throw inputError('Use this integration’s setup guide to change account or endpoint settings.');
    const server = validateServer(req.body, existing);
    if (loadConfig().mcpServers.some((item) => item.id !== server.id && item.slug === server.slug)) throw inputError('MCP slug is already in use', 409);
    updateConfig((config) => { config.mcpServers = config.mcpServers.map((entry) => entry.id === server.id ? server : entry); });
    serverHealth.delete(server.id);
    await closeServerConnections(server.id);
    notifyMcpClients();
    res.json(publicServer(server));
  }));
  app.delete('/api/mcp/servers/:id', sessionAuth, route(async (req, res) => {
    if (!loadConfig().mcpServers.some((entry) => entry.id === req.params.id)) throw inputError('MCP server not found', 404);
    updateConfig((config) => { config.mcpServers = config.mcpServers.filter((entry) => entry.id !== req.params.id); });
    await closeServerConnections(req.params.id);
    clearPendingSignIn(req.params.id);
    deleteCredentials(req.params.id);
    serverHealth.delete(req.params.id);
    notifyMcpClients();
    res.json({ ok: true });
  }));
  app.post('/api/mcp/servers/:id/discover', sessionAuth, route(async (req, res) => {
    const server = loadConfig().mcpServers.find((entry) => entry.id === req.params.id);
    if (!server) throw inputError('MCP server not found', 404);
    res.json(await discoverServer(server));
  }));

  app.all('/mcp', gatewayAuth('mcp'), route(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.get('host')) return res.status(403).json({ jsonrpc: '2.0', id: null, error: { code: -32003, message: 'Origin not allowed' } });
    const sessionId = req.headers['mcp-session-id'];
    let session = sessionId && sessions.get(sessionId);
    if (sessionId && (!session || session.keyId !== req.gatewayKey.id)) return res.status(404).json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32000, message: 'Session not found. Reinitialize.' } });
    if (!session) {
      if (req.method !== 'POST' || !types.isInitializeRequest(req.body)) return res.status(400).json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32000, message: 'Initialize an MCP session first' } });
      for (const [id, item] of sessions) if (Date.now() - item.lastAt > SESSION_IDLE_MS) await closeSession(id);
      if (sessions.size >= MAX_SESSIONS) return res.status(429).set('Retry-After', '60').json({ error: 'Too many MCP sessions' });
      const pool = new BackendPool();
      const server = createGatewayServer(req.gatewayKey, pool);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true,
        onsessioninitialized: (id) => sessions.set(id, session), onsessionclosed: (id) => closeSession(id) });
      session = { server, transport, pool, keyId: req.gatewayKey.id, lastAt: Date.now() };
      await server.connect(transport);
      // Server.connect owns onclose; cleanup is installed on the server itself.
      server.onclose = () => {
        const id = transport.sessionId;
        if (id) sessions.delete(id);
        pool.close().catch(() => {});
      };
    }
    session.lastAt = Date.now();
    await session.transport.handleRequest(req, res, req.body);
  }));
}

async function closeAllMcp() {
  await Promise.all([...sessions.keys()].map(closeSession));
  await Promise.all([...sharedMemory.values()].map(async (entry) => closeBackend(await entry.promise.catch(() => null))));
  sharedMemory.clear();
}
async function closeServerConnections(id) {
  serverHealth.delete(id);
  await Promise.all([...sessions.values()].map(async (session) => {
    await session.pool.pending.get(id)?.catch(() => {});
    await closeBackend(session.pool.connections.get(id));
    session.pool.connections.delete(id);
  }));
  const memory = sharedMemory.get(id);
  sharedMemory.delete(id);
  if (memory) await closeBackend(await memory.promise.catch(() => null));
}
async function discoverServer(server) {
  let client, connection;
  try {
    if (server.integrationId === 'memory') client = await new BackendPool().get(server);
    else { connection = await connectBackend(server); client = connection.client; }
    const tools = client.getServerCapabilities()?.tools ? await listAll(client, 'listTools', 'tools', server) : [];
    const snapshot = { state: 'connected', checkedAt: new Date().toISOString(), tools: tools.length, serverInfo: client.getServerVersion() };
    serverHealth.set(server.id, snapshot);
    if (server.integrationId) updateConfig((config) => { const current = config.mcpServers.find((entry) => entry.id === server.id); if (current) current.connection = snapshot; });
    return { ...snapshot, items: tools.map((tool) => qualifyTool(tool, server)) };
  } catch (error) {
    const snapshot = { state: 'error', checkedAt: new Date().toISOString(), error: error.status === 401 ? 'Sign in or add an access token using the setup guide.' : 'Connection test failed. Open the setup guide to check your account, access, and network connection.' };
    serverHealth.set(server.id, snapshot);
    if (server.integrationId) updateConfig((config) => { const current = config.mcpServers.find((entry) => entry.id === server.id); if (current) current.connection = snapshot; });
    throw error;
  } finally { await closeBackend(connection); }
}
async function closeKeySessions(keyId) { await Promise.all([...sessions].filter(([, session]) => session.keyId === keyId).map(([id]) => closeSession(id))); }
function notifyMcpClients() {
  for (const session of sessions.values()) {
    for (const kind of ['tools', 'prompts', 'resources']) session.server.notification({ method: `notifications/${kind}/list_changed` }).catch(() => {});
  }
}
module.exports = { mountMcp, closeAllMcp, closeKeySessions, closeServerConnections, discoverServer, notifyMcpClients, validateServer, createGatewayServer, BackendPool, publicServer };
