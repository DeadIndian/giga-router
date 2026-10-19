const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { MCP_INTEGRATIONS, integrationById } = require('./mcp-catalog');
const { loadConfig, updateConfig, DATA_DIR } = require('./storage');
const { inputError } = require('./validation');
const { readCredentials, writeCredentials, deleteCredentials } = require('./mcp-vault');
const oauth = require('./mcp-oauth');

const connections = new Set();
const filesRoot = path.join(DATA_DIR, 'shared-files');

function setupValues(definition, values = {}, previous = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw inputError('Setup values must be an object.');
  const selected = {};
  for (const field of definition.fields) {
    const value = values[field.name] ?? previous[field.name] ?? field.default ?? '';
    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') throw inputError(`${field.label} must be on or off.`);
    } else if (typeof value !== 'string' || value.length > 1000) throw inputError(`Enter a valid ${field.label.toLowerCase()}.`);
    selected[field.name] = typeof value === 'string' ? value.trim() : value;
    if (field.required && !selected[field.name]) throw inputError(`Enter ${field.label.toLowerCase()} to continue.`);
  }
  if (definition.id === 'supabase' && !/^[a-z0-9-]{5,80}$/.test(selected.projectRef)) throw inputError('Copy the Project ID from your Supabase dashboard address.');
  return selected;
}

function makeServer(definition, body, previous = {}) {
  const method = body.method || previous.authKind || definition.defaultMethod;
  if (!definition.methods.includes(method)) throw inputError('Choose a supported connection method.');
  const values = setupValues(definition, body.values, previous.setupValues);
  const id = previous.id || crypto.randomUUID();
  const server = { id, name: definition.name, slug: definition.id, transport: definition.kind === 'local' ? 'stdio' : 'http',
    enabled: method !== 'oauth', timeoutMs: 30_000, headers: {}, env: {}, integrationId: definition.id,
    authKind: method, setupValues: values, credentialVersion: (previous.credentialVersion || 0) + 1,
    createdAt: previous.createdAt || new Date().toISOString(), connection: { state: method === 'oauth' ? 'awaiting_sign_in' : 'checking' } };
  if (definition.kind === 'hosted') {
    server.url = definition.url;
    if (definition.id === 'github') {
      server.headers['X-MCP-Readonly'] = String(values.readOnly);
      server.oauthScope = 'repo read:org';
    }
    if (definition.id === 'linear') {
      if (values.readOnly) { server.url += '/readonly'; server.oauthScope = 'read'; }
      else server.oauthScope = 'read write';
    }
    if (definition.id === 'supabase') {
      const url = new URL(server.url);
      url.searchParams.set('project_ref', values.projectRef);
      url.searchParams.set('read_only', String(values.readOnly));
      url.searchParams.set('features', 'database,docs');
      server.url = url.toString();
    }
  } else {
    server.command = process.execPath;
    server.args = [require.resolve(`${definition.package}/dist/index.js`)];
    if (definition.id === 'files') {
      const directory = values.folder ? path.resolve(values.folder) : path.join(filesRoot, id);
      if (!values.folder) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) throw inputError('That folder is not available on the router. Leave the box empty to use an easy shared folder.');
      server.args.push(fs.realpathSync(directory));
      server.sharedFolder = !values.folder;
    }
    if (definition.id === 'memory') {
      const directory = path.join(DATA_DIR, 'mcp-memory', id);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      server.env.MEMORY_FILE_PATH = path.join(directory, 'memory.jsonl');
    }
    if (definition.id === 'thinking') server.env.DISABLE_THOUGHT_LOGGING = 'true';
  }
  return server;
}

function requestOrigin(req) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  return `${secure ? 'https' : 'http'}://${req.get('host')}`;
}

function publicClientSetup(req) {
  let site = null, error = null;
  try { site = oauth.callbackOrigin(requestOrigin(req)); } catch (failure) { error = failure.message; }
  return { site, callbackUrl: site ? `${site}/api/mcp/oauth/callback` : null, oauthAvailable: !!site, error };
}

async function saveIntegration(definition, body, services) {
  const previous = loadConfig().mcpServers.find((server) => server.integrationId === definition.id);
  if (connections.has(definition.id)) throw inputError('This connection is being set up. Please wait.', 409);
  connections.add(definition.id);
  try {
    const server = makeServer(definition, body, previous);
    if (loadConfig().mcpServers.some((entry) => entry.slug === server.slug && entry.id !== server.id)) throw inputError('A custom server already uses this name. Rename or remove that server first.');
    if (server.authKind === 'token') {
      if (body.token !== undefined && typeof body.token !== 'string') throw inputError('Paste a token as text.');
      const token = body.token?.trim() || previous?.authKind === 'token' && readCredentials(server.id)?.token;
      if (typeof token !== 'string' || !token || token.length > 4000 || /[\r\n]/.test(token)) throw inputError(`Paste your ${definition.tokenLabel.toLowerCase()} to continue.`);
      writeCredentials(server.id, { token });
    } else if (server.authKind === 'none') deleteCredentials(server.id);
    else if (previous?.authKind !== 'oauth' || previous?.url !== server.url) deleteCredentials(server.id);
    oauth.clearPendingSignIn(server.id);
    if (previous) await services.closeServerConnections(server.id);
    updateConfig((config) => {
      const index = config.mcpServers.findIndex((entry) => entry.id === server.id);
      if (index < 0) config.mcpServers.push(server); else config.mcpServers[index] = server;
    });
    if (server.authKind === 'oauth') return { server: services.publicServer(server), next: 'sign_in' };
    try {
      const discovery = await services.discoverServer(server);
      services.notifyMcpClients();
      return { server: services.publicServer(loadConfig().mcpServers.find((entry) => entry.id === server.id)), next: 'ready', discovery };
    } catch {
      updateConfig((config) => { const current = config.mcpServers.find((entry) => entry.id === server.id); if (current) current.enabled = false; });
      return { server: services.publicServer(loadConfig().mcpServers.find((entry) => entry.id === server.id)), next: 'retry', message: 'Your settings were saved, but the connection test did not finish. Check your token and access, then try again.' };
    }
  } finally { connections.delete(definition.id); }
}

function mountIntegrations(app, sessionAuth, services) {
  const route = (handler) => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
  app.get('/api/mcp/catalog', sessionAuth, (req, res) => {
    const servers = loadConfig().mcpServers;
    const items = MCP_INTEGRATIONS.map((entry) => ({ ...entry, connectedServer: servers.find((server) => server.integrationId === entry.id) ? services.publicServer(servers.find((server) => server.integrationId === entry.id)) : null, settingUp: connections.has(entry.id) }));
    res.json({ items, setup: publicClientSetup(req) });
  });
  app.post('/api/mcp/catalog/:integrationId/connect', sessionAuth, route(async (req, res) => {
    const definition = integrationById(req.params.integrationId);
    if (!definition) throw inputError('Integration not found.', 404);
    res.json(await saveIntegration(definition, req.body || {}, services));
  }));
  app.post('/api/mcp/servers/:id/oauth/start', sessionAuth, route(async (req, res) => {
    const server = loadConfig().mcpServers.find((entry) => entry.id === req.params.id);
    if (!server) throw inputError('Connection not found.', 404);
    let proof = (req.headers.cookie || '').match(/(?:^|;\s*)giga_oauth=([a-f0-9]{64})/)?.[1];
    if (!proof) proof = crypto.randomBytes(32).toString('hex');
    const site = oauth.callbackOrigin(requestOrigin(req));
    if (new URL(site).host !== req.get('host')) throw inputError(`Open ${site} in your browser to use sign-in on this router.`);
    res.append('Set-Cookie', `giga_oauth=${proof}; HttpOnly; SameSite=Lax; Path=/api/mcp; Max-Age=600${site.startsWith('https:') ? '; Secure' : ''}`);
    const result = await oauth.startSignIn(server, { origin: requestOrigin(req), session: req.dashboardSession, browserProof: proof,
      ...(req.body.clientId ? { clientId: req.body.clientId, clientSecret: req.body.clientSecret } : {}) });
    res.json(result);
  }));
  app.get('/api/mcp/oauth/client-metadata/:id', route((req, res) => {
    const metadata = oauth.clientMetadata(req.params.id);
    if (!metadata) return res.sendStatus(404);
    res.json(metadata);
  }));
  app.get('/api/mcp/oauth/callback', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const proof = (req.headers.cookie || '').match(/(?:^|;\s*)giga_oauth=([a-f0-9]{64})/)?.[1];
    try {
      const completed = await oauth.finishSignIn({ state: req.query.state, code: req.query.code, error: req.query.error, issuer: req.query.iss, browserProof: proof });
      res.redirect(`${completed.site}/?mcp_oauth=${encodeURIComponent(completed.serverId)}#mcp`);
    } catch (error) {
      const message = error.status ? error.message : 'We could not finish sign-in. Return to your setup guide and try again.';
      res.status(error.status || 400).type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Giga Router · Sign in</title><style>body{font:16px/1.7 system-ui;background:#17191d;color:#f1f2ed;max-width:560px;margin:10vh auto;padding:24px}a{color:#d5f879}</style><h1>Let’s try that again.</h1><p>${String(message).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}</p><p><a href="/">Return to Giga Router</a>, open MCP servers, and choose your connection’s setup guide.</p></html>`);
    }
  });
  app.post('/api/mcp/servers/:id/check', sessionAuth, route(async (req, res) => {
    const server = loadConfig().mcpServers.find((entry) => entry.id === req.params.id);
    if (!server) throw inputError('Connection not found.', 404);
    try {
      const discovery = await services.discoverServer(server);
      updateConfig((config) => { const current = config.mcpServers.find((entry) => entry.id === server.id); if (current) current.enabled = true; });
      services.notifyMcpClients();
      res.json({ server: services.publicServer(loadConfig().mcpServers.find((entry) => entry.id === server.id)), discovery });
    } catch {
      res.status(400).json({ error: 'The connection test failed. Open the setup guide to sign in again, replace your token, or check service access.' });
    }
  }));
  app.post('/api/mcp/servers/:id/disconnect', sessionAuth, route(async (req, res) => {
    const server = loadConfig().mcpServers.find((entry) => entry.id === req.params.id);
    if (!server) throw inputError('Connection not found.', 404);
    let result;
    if (server.authKind === 'oauth') result = await oauth.disconnectSignIn(server);
    else {
      deleteCredentials(server.id);
      updateConfig((config) => { const current = config.mcpServers.find((entry) => entry.id === server.id); if (current) { current.enabled = false; current.connection = { state: 'disconnected' }; current.credentialVersion = (current.credentialVersion || 0) + 1; } });
      result = { ok: true, note: 'Disconnected. Your setup is kept so you can reconnect later.' };
    }
    await services.closeServerConnections(server.id);
    services.notifyMcpClients();
    res.json(result);
  }));

  const sharedFolder = (id) => {
    const server = loadConfig().mcpServers.find((entry) => entry.id === id);
    if (!server?.sharedFolder || server.integrationId !== 'files') throw inputError('Uploads are available only for a Files connection using its easy shared folder.');
    return path.join(filesRoot, server.id);
  };
  app.get('/api/mcp/servers/:id/files', sessionAuth, route((req, res) => {
    const root = sharedFolder(req.params.id);
    res.json({ items: fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => ({ name: entry.name, size: fs.statSync(path.join(root, entry.name)).size })), folder: root });
  }));
  app.post('/api/mcp/servers/:id/files', sessionAuth, route((req, res) => {
    const root = sharedFolder(req.params.id);
    const { name, data } = req.body || {};
    if (typeof name !== 'string' || !name || name.length > 150 || /[\\/\0]/.test(name) || ['.', '..'].includes(name) || typeof data !== 'string') throw inputError('Choose a file with a normal filename.');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > 8 * 1024 * 1024) throw inputError('Choose a file smaller than 8 MB.');
    const destination = path.join(root, name);
    try { fs.writeFileSync(destination, bytes, { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') throw inputError('A file with this name already exists. Rename your file before uploading.'); throw error; }
    res.status(201).json({ name, size: bytes.length });
  }));
}

module.exports = { mountIntegrations, makeServer, setupValues, saveIntegration, publicClientSetup };
