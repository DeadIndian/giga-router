const crypto = require('node:crypto');
const { loadConfig, saveConfig } = require('../storage');
const { httpUrl, inputError, headerMap, maskedMap } = require('../validation');
const { ROUTER_KEY } = require('../auth');
const { catalog, accountPreset, importAccounts } = require('../provider-catalog');
const routing = require('./routing');
const { proxyRequest, validateRequest } = require('./proxy');
const { routingOf, planRoute, publicPlan, providerSlug, capabilities, validSchedule, nowInZone, matchSchedule, health, healthSnapshot } = routing;
const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
const publicProvider = provider => ({ ...provider, apiKey: provider.apiKey ? '***' : '', headers: maskedMap(provider.headers), slug: providerSlug(provider), effectiveCapabilities: capabilities(provider) });
function validatedProvider(body, previous = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw inputError('Provider must be an object');
  const provider = { ...previous, id: previous.id || crypto.randomUUID() };
  for (const field of ['name', 'type', 'baseUrl', 'defaultModel']) {
    const value = body[field] === undefined ? previous[field] : body[field];
    if (typeof value !== 'string' || !value.trim() || value.length > (field === 'baseUrl' ? 2000 : 256) || /[\x00-\x1f\x7f]/.test(value)) throw inputError('Provider name, format, URL and model must be non-empty single-line strings');
    provider[field] = value.trim();
  }
  if (!['openai', 'anthropic'].includes(provider.type)) throw inputError('Provider type must be openai or anthropic');
  if (httpUrl(provider.baseUrl).search) throw inputError('Provider base URLs must not include a query; use custom headers for credentials');
  if (body.apiKey !== undefined && typeof body.apiKey !== 'string') throw inputError('API key must be a string');
  provider.apiKey = body.apiKey === '***' || body.apiKey === undefined ? previous.apiKey || '' : body.apiKey.trim();
  if (/[\r\n]/.test(provider.apiKey)) throw inputError('API key must be a single-line string');
  provider.headers = headerMap(body.headers, previous.headers);
  if (body.userAgent !== undefined) { if (typeof body.userAgent !== 'string' || /[\r\n]/.test(body.userAgent)) throw inputError('User-Agent must be a single-line string'); provider.userAgent = body.userAgent.trim(); }
  if (body.compat !== undefined) {
    if (!body.compat || typeof body.compat !== 'object' || Array.isArray(body.compat)) throw inputError('Compatibility settings must be an object');
    provider.compat = { ...previous.compat };
    for (const field of ['singleToolCall', 'noReasoningEffortWithTools', 'adaptiveToEnabled']) if (body.compat[field] !== undefined) {
      if (typeof body.compat[field] !== 'boolean') throw inputError('Compatibility settings must be booleans'); provider.compat[field] = body.compat[field];
    }
  }
  if (body.capabilities !== undefined) {
    if (!body.capabilities || typeof body.capabilities !== 'object' || Array.isArray(body.capabilities)) throw inputError('Capabilities must be an object');
    provider.capabilities = { ...previous.capabilities };
    for (const field of ['tools', 'vision', 'responses', 'countTokens']) if (body.capabilities[field] !== undefined) {
      const value = body.capabilities[field]; if (value !== null && typeof value !== 'boolean') throw inputError('Capabilities must be true, false, or null (catalog default)');
      if (value === null) delete provider.capabilities[field]; else provider.capabilities[field] = value;
    }
    if (body.capabilities.contextWindow !== undefined) {
      const value = body.capabilities.contextWindow; if (value !== null && (!Number.isInteger(value) || value < 1)) throw inputError('Context window must be a positive integer or null');
      if (value === null) delete provider.capabilities.contextWindow; else provider.capabilities.contextWindow = value;
    }
  }
  if (body.enabled !== undefined) { if (typeof body.enabled !== 'boolean') throw inputError('Enabled must be a boolean'); provider.enabled = body.enabled; }
  if (body.endpointPath !== undefined) { if (typeof body.endpointPath !== 'string' || /[?#\r\n]/.test(body.endpointPath)) throw inputError('Endpoint path must not contain a query or fragment'); provider.endpointPath = body.endpointPath.trim(); }
  return provider;
}
function addPresetAccount(cfg, preset) {
  const provider = validatedProvider(preset), base = provider.name;
  for (let n = 2; cfg.providers.some(p => providerSlug(p) === providerSlug(provider)); n++) provider.name = `${base} ${n}`;
  provider.catalogId = preset.catalogId; provider.accountLabel = preset.accountLabel;
  cfg.providers.push(provider); if (!cfg.activeId) cfg.activeId = provider.id; return provider;
}
function validateProfiles(profiles, cfg) {
  if (!Array.isArray(profiles) || profiles.length > 50) throw inputError('Use up to 50 routing profiles');
  const ids = new Set();
  return profiles.map(p => {
    if (!p || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(p.id) || ids.has(p.id)) throw inputError('Profiles need unique lowercase IDs');
    ids.add(p.id);
    if (!Array.isArray(p.providerIds) || !p.providerIds.length || p.providerIds.some(id => !cfg.providers.some(provider => provider.id === id))) throw inputError('Profiles need an ordered list of saved provider IDs');
    const requirements = p.requirements || {};
    for (const key of ['tools', 'vision']) if (requirements[key] !== undefined && typeof requirements[key] !== 'boolean') throw inputError('Profile requirements must be booleans');
    if (requirements.contextWindow !== undefined && (!Number.isInteger(requirements.contextWindow) || requirements.contextWindow < 1)) throw inputError('Minimum context must be a positive integer');
    return { id: p.id, providerIds: [...new Set(p.providerIds)], requirements: { ...requirements } };
  });
}
function mountLlmApi(app, sessionAuth, gatewayAuth) {
  app.get('/api/config', sessionAuth, (req, res) => { const cfg = loadConfig(); res.json({ providers: cfg.providers.map(publicProvider), activeId: cfg.activeId, routing: routingOf(cfg), hasRouterKey: !!ROUTER_KEY }); });
  app.get('/api/providers/catalog', sessionAuth, (req, res) => res.json({ items: catalog() }));
  app.post('/api/providers/catalog/:catalogId/accounts', sessionAuth, (req, res) => { const cfg = loadConfig(), provider = addPresetAccount(cfg, accountPreset(req.params.catalogId, req.body)); saveConfig(cfg); res.json(publicProvider(provider)); });
  app.post('/api/providers/import', sessionAuth, (req, res) => {
    if (typeof req.body.apply !== 'boolean') throw inputError('Choose preview or apply');
    const { accounts, skipped } = importAccounts(req.body.document), cfg = loadConfig(), added = [], duplicates = [];
    for (const preset of accounts) {
      if (cfg.providers.some(p => p.baseUrl === preset.baseUrl && p.apiKey === preset.apiKey && p.defaultModel === preset.defaultModel)) duplicates.push({ catalogId: preset.catalogId, accountLabel: preset.accountLabel });
      else added.push(publicProvider(addPresetAccount(cfg, preset)));
    }
    if (req.body.apply && added.length) saveConfig(cfg); res.json({ applied: req.body.apply, items: added, skipped, duplicates });
  });
  app.post('/api/providers', sessionAuth, (req, res) => {
    const cfg = loadConfig(), provider = validatedProvider(req.body);
    if (cfg.providers.some(p => providerSlug(p) === providerSlug(provider))) throw inputError('Provider name is already in use', 409);
    cfg.providers.push(provider); if (!cfg.activeId) cfg.activeId = provider.id; saveConfig(cfg); res.json(publicProvider(provider));
  });
  app.put('/api/providers/:id', sessionAuth, (req, res) => {
    const cfg = loadConfig(), i = cfg.providers.findIndex(p => p.id === req.params.id);
    if (i < 0) throw inputError('Provider not found', 404);
    const provider = validatedProvider(req.body, cfg.providers[i]);
    if (cfg.providers.some(p => p.id !== provider.id && providerSlug(p) === providerSlug(provider))) throw inputError('Provider name is already in use', 409);
    cfg.providers[i] = provider; saveConfig(cfg); health.delete(provider.id); res.json(publicProvider(provider));
  });
  app.delete('/api/providers/:id', sessionAuth, (req, res) => {
    const cfg = loadConfig(); cfg.providers = cfg.providers.filter(p => p.id !== req.params.id); const r = routingOf(cfg);
    r.autoOrder = r.autoOrder.filter(id => cfg.providers.some(p => p.id === id || p.name === id)); r.schedules = r.schedules.filter(s => s.providerId !== req.params.id);
    r.profiles = r.profiles.map(p => ({ ...p, providerIds: p.providerIds.filter(id => id !== req.params.id) })).filter(p => p.providerIds.length);
    if (!cfg.routing?.profiles && !r.profiles.length) delete r.profiles;
    cfg.routing = { ...cfg.routing, ...r }; health.delete(req.params.id); if (cfg.activeId === req.params.id) cfg.activeId = cfg.providers[0]?.id || null; saveConfig(cfg); res.json({ ok: true });
  });
  app.post('/api/providers/:id/test', sessionAuth, route(async (req, res) => {
    const provider = loadConfig().providers.find(p => p.id === req.params.id);
    if (!provider) throw inputError('Provider not found', 404);
    req.headers['x-giga-provider'] = provider.id; req.diagnostic = true;
    req.body = { model: provider.defaultModel, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with OK.' }] };
    await proxyRequest(req, res, provider.type);
  }));
  app.post('/api/providers/:id/reset', sessionAuth, (req, res) => { health.delete(req.params.id); res.json({ ok: true }); });
  app.post('/api/active', sessionAuth, (req, res) => { const cfg = loadConfig(); if (!cfg.providers.some(p => p.id === req.body.id)) throw inputError('Provider not found', 404); cfg.activeId = req.body.id; saveConfig(cfg); res.json({ ok: true, activeId: cfg.activeId }); });
  app.get('/api/routing', sessionAuth, (req, res) => {
    const cfg = loadConfig(); res.json({ ...routingOf(cfg), activeId: cfg.activeId,
      limits: { failCooldownMs: routing.FAIL_COOLDOWN_MS, tripAfter: routing.TRIP_AFTER, tripCooldownMs: routing.TRIP_COOLDOWN_MS },
      effective: publicPlan(planRoute(cfg)), health: healthSnapshot(cfg.providers), serverTime: { ...nowInZone('UTC'), tz: 'UTC' } });
  });
  app.post('/api/routing', sessionAuth, (req, res) => {
    const cfg = loadConfig(), r = routingOf(cfg), { mode, autoOrder, profiles } = req.body;
    if (mode !== undefined) { if (!['auto', 'manual'].includes(mode)) throw inputError('mode must be auto|manual'); r.mode = mode; }
    if (autoOrder !== undefined) { if (!Array.isArray(autoOrder) || autoOrder.some(id => typeof id !== 'string')) throw inputError('autoOrder must be an array of IDs'); r.autoOrder = autoOrder; }
    if (profiles !== undefined) r.profiles = validateProfiles(profiles, cfg);
    cfg.routing = r; saveConfig(cfg); res.json({ ok: true, routing: r });
  });
  app.get('/api/schedules', sessionAuth, (req, res) => {
    const cfg = loadConfig(), instant = new Date();
    res.json(routingOf(cfg).schedules.map(s => ({ ...s, providerName: cfg.providers.find(p => p.id === s.providerId)?.name || '(missing)', activeNow: !!matchSchedule([s], instant) })));
  });
  app.post('/api/schedules/preview', sessionAuth, (req, res) => res.json(routing.scheduleOccurrences(req.body)));
  const saveSchedule = (req, res) => {
    if (!validSchedule(req.body)) throw inputError('Choose a provider, different start/end times, valid weekdays and an IANA timezone');
    const cfg = loadConfig(), r = routingOf(cfg);
    if (!cfg.providers.some(p => p.id === req.body.providerId)) throw inputError('Provider not found', 404);
    const index = req.params.id ? r.schedules.findIndex(s => s.id === req.params.id) : -1;
    if (req.params.id && index < 0) throw inputError('Schedule not found', 404);
    const s = { id: req.params.id || crypto.randomUUID(), providerId: req.body.providerId, start: req.body.start, end: req.body.end, days: req.body.days?.length ? req.body.days : undefined,
      timezone: req.body.timezone || 'Asia/Kolkata', label: req.body.label || '', fallbackOnFailure: !!req.body.fallbackOnFailure };
    if (index < 0) r.schedules.push(s); else r.schedules[index] = s;
    cfg.routing = r; saveConfig(cfg); res.json(s);
  };
  app.post('/api/schedules', sessionAuth, saveSchedule); app.put('/api/schedules/:id', sessionAuth, saveSchedule);
  app.delete('/api/schedules/:id', sessionAuth, (req, res) => { const cfg = loadConfig(), r = routingOf(cfg); r.schedules = r.schedules.filter(s => s.id !== req.params.id); cfg.routing = r; saveConfig(cfg); res.json({ ok: true }); });
  app.get('/api/route-now', sessionAuth, (req, res) => res.json(publicPlan(planRoute(loadConfig(), { provider: req.query.provider, body: { model: req.query.model } }))));
  app.post('/api/route-now', sessionAuth, (req, res) => res.json(publicPlan(planRoute(loadConfig(), { body: req.body, provider: req.headers['x-giga-provider'], format: req.query.format }))));
  app.post('/api/health/reset', sessionAuth, (req, res) => { health.clear(); res.json({ ok: true }); });
  const auth = gatewayAuth('llm');
  app.get('/v1/models', auth, (req, res) => {
    const cfg = loadConfig(); res.json({ object: 'list', data: [...cfg.providers.filter(p => p.enabled !== false).map(p => ({ id: `${providerSlug(p)}/${p.defaultModel}`, object: 'model', created: 0, owned_by: p.name })),
      ...routingOf(cfg).profiles.map(p => ({ id: `profile/${p.id}`, object: 'model', created: 0, owned_by: 'giga-router' }))] });
  });
  for (const [endpoint, format] of [['messages', 'anthropic'], ['chat/completions', 'openai'], ['responses', 'responses']]) app.post(`/v1/${endpoint}`, auth, route((req, res) => proxyRequest(req, res, format)));
  app.post('/v1/messages/count_tokens', auth, route(async (req, res) => {
    validateRequest(req.body, 'count_tokens');
    const plan = planRoute(loadConfig(), { body: req.body, provider: req.headers['x-giga-provider'], format: 'count_tokens' });
    if (plan.providers.length) return proxyRequest(req, res, 'count_tokens');
    const chars = JSON.stringify({ system: req.body.system, messages: req.body.messages, tools: req.body.tools }).length;
    res.json({ input_tokens: Math.max(1, Math.ceil(chars / 3)), estimated: true, method: 'conservative-character-estimate' });
  }));
}
module.exports = { mountLlmApi, validatedProvider, publicProvider };
