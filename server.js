// HTTP composition root. Protocol, routing and transport policies live in lib/llm.
const express = require('express');
const path = require('node:path');
const { loadConfig } = require('./lib/storage');
const { mountAuth, sessionAuth, gatewayAuth } = require('./lib/auth');
const { mountSkills } = require('./lib/skills');
const { seedDefaultMarketplaces } = require('./lib/marketplace-defaults');
const mcp = require('./lib/mcp');
const { mountIntegrations } = require('./lib/mcp-integrations');
const { activitySnapshot } = require('./lib/activity');
const routing = require('./lib/llm/routing');
const protocol = require('./lib/llm/protocol');
const sse = require('./lib/llm/sse');
const proxy = require('./lib/llm/proxy');
const { mountLlmApi } = require('./lib/llm/api');

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'same-origin'); res.set('X-Frame-Options', 'DENY');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store'); next();
});
app.use(express.json({ limit: '20mb' }));
app.get('/api/ping', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
mountAuth(app, mcp.closeKeySessions);
mountSkills(app, sessionAuth, mcp.notifyMcpClients);
mcp.mountMcp(app, sessionAuth);
mountIntegrations(app, sessionAuth, mcp);
mountLlmApi(app, sessionAuth, gatewayAuth);
app.get('/api/overview', sessionAuth, (req, res) => {
  const cfg = loadConfig(); res.json({ providers: cfg.providers.length, mcpServers: cfg.mcpServers.length, skills: cfg.skills.length, sources: cfg.sources.length,
    indexedSkills: cfg.sources.reduce((sum, source) => sum + (source.count || 0), 0), ...activitySnapshot() });
});
app.get('/api/activity', sessionAuth, (req, res) => res.json(activitySnapshot()));
app.use((error, req, res, next) => {
  if (res.destroyed || res.writableEnded) return;
  if (req.path.startsWith('/api/')) return res.status(error.status || 500).json({ error: error.message || 'Request failed' });
  if (req.path === '/mcp') return res.status(error.status || 500).json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32603, message: 'MCP request failed. Check this server in the dashboard.' } });
  const format = req.path.startsWith('/v1/messages') ? 'anthropic' : 'openai';
  const payload = protocol.errorFor(format, error instanceof SyntaxError ? 'Invalid JSON in request or upstream response' : error.message || 'Upstream response failed');
  if (res.headersSent) { if (format === 'anthropic') sse.writeSSE(res, payload); else res.write(sse.encodeSSE(payload)); return res.end(); }
  res.status(error.status || 502).json(payload);
});
app.get('/vendor/feather.js', (req, res) => res.sendFile(require.resolve('feather-icons/dist/feather.min.js')));
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'deny' }));
if (require.main === module) {
  const seeded = seedDefaultMarketplaces();
  if (seeded.added || seeded.adopted || seeded.repaired) console.log(`Marketplace defaults: ${seeded.added} added, ${seeded.adopted} existing, ${seeded.repaired} indexes restored`);
  const listener = app.listen(process.env.PORT || 3002, process.env.HOST || '0.0.0.0', () => console.log(`Giga Router listening on ${listener.address().port}`));
  const stop = async () => {
    const force = setTimeout(() => process.exit(1), 10_000); force.unref(); await mcp.closeAllMcp(); listener.close(() => process.exit(0));
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
// Retained exports support existing clients of the original test interface.
module.exports = { app, closeAllMcp: mcp.closeAllMcp, ...routing, ...protocol, ...sse, HEARTBEAT: proxy.HEARTBEAT, HEARTBEAT_INTERVAL_MS: proxy.HEARTBEAT_INTERVAL_MS };
