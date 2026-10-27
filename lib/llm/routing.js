// One route plan for execution and the dashboard. Time is an input, not a global policy.
const { inputError } = require('../validation');
const catalog = require('../provider-models.json');
const { buildUpstream } = require('./protocol');
const health = new Map();
const probes = new Set();
const FAIL_COOLDOWN_MS = 60_000;
const TRIP_AFTER = 5;
const TRIP_COOLDOWN_MS = 30 * 60_000;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const clocks = new Map();
const zones = new Map();
const providerSlug = p => p.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || p.id;
function routingOf(cfg) {
  const r = cfg.routing || {};
  return { mode: ['auto', 'manual'].includes(r.mode) ? r.mode : 'auto', autoOrder: Array.isArray(r.autoOrder) ? r.autoOrder : [],
    schedules: Array.isArray(r.schedules) ? r.schedules : [], profiles: Array.isArray(r.profiles) ? r.profiles : [] };
}
function toMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  return !m || +m[1] > 23 || +m[2] > 59 ? null : +m[1] * 60 + +m[2];
}
function validZone(zone) {
  if (zones.has(zone)) return zones.get(zone);
  let valid = false;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); valid = typeof zone === 'string' && !!zone; } catch {}
  if (zones.size >= 64) zones.clear(); zones.set(zone, valid); return valid;
}
function nowInZone(zone = 'UTC', instant = new Date()) {
  if (!clocks.has(zone)) {
    if (clocks.size >= 64) clocks.clear();
    clocks.set(zone, new Intl.DateTimeFormat('en-US', { timeZone: zone || 'UTC', hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' }));
  }
  const parts = clocks.get(zone).formatToParts(instant);
  const get = type => parts.find(part => part.type === type)?.value || '';
  return { minutes: (+get('hour') % 24) * 60 + +get('minute'), day: get('weekday').toLowerCase().slice(0, 3) };
}
function matchSchedule(schedules, instant = new Date()) {
  for (const s of schedules) {
    if (!s?.providerId || !validZone(s.timezone || 'UTC')) continue;
    const start = toMinutes(s.start), end = toMinutes(s.end);
    if (start === null || end === null || start === end) continue;
    const cur = instant?.minutes !== undefined ? instant : nowInZone(s.timezone, instant);
    const overnight = end < start;
    const day = overnight && cur.minutes < end ? DAYS[(DAYS.indexOf(cur.day) + 6) % 7] : cur.day;
    if (s.days?.length && !s.days.includes(day)) continue;
    if (overnight ? cur.minutes >= start || cur.minutes < end : cur.minutes >= start && cur.minutes < end) return s;
  }
  return null;
}
function validSchedule(s) {
  return s && typeof s === 'object' && typeof s.providerId === 'string' && !!s.providerId.trim() &&
    toMinutes(s.start) !== null && toMinutes(s.end) !== null && toMinutes(s.start) !== toMinutes(s.end) &&
    (s.timezone === undefined || validZone(s.timezone)) &&
    (s.days === undefined || (Array.isArray(s.days) && s.days.every(day => DAYS.includes(day)))) &&
    (s.label === undefined || (typeof s.label === 'string' && s.label.length <= 120 && !/[\x00-\x1f\x7f]/.test(s.label))) &&
    (s.fallbackOnFailure === undefined || typeof s.fallbackOnFailure === 'boolean');
}
function scheduleOccurrences(schedule, instant = new Date()) {
  if (!validSchedule(schedule)) throw inputError('Invalid schedule');
  const occurrences = [];
  let active = !!matchSchedule([schedule], instant);
  for (let at = Math.floor(+instant / 60_000) * 60_000 + 60_000; at < +instant + 8 * 86400_000 && occurrences.length < 3; at += 60_000) {
    // Zone validity was established once above. This avoids re-validating it per minute.
    const current = !!matchSchedule([{ ...schedule, timezone: 'UTC' }], nowInZone(schedule.timezone || 'UTC', new Date(at)));
    if (current && !active) occurrences.push(new Date(at).toISOString());
    active = current;
  }
  return { activeNow: !!matchSchedule([schedule], instant), starts: occurrences };
}
function markFailure(id, cooldownMs = FAIL_COOLDOWN_MS, category = 'transient') {
  const old = health.get(id) || {};
  const fails = (old.fails || 0) + 1, at = Date.now();
  health.set(id, { fails, at, category, until: at + cooldownMs, trippedUntil: fails >= TRIP_AFTER ? at + Math.max(cooldownMs, TRIP_COOLDOWN_MS) : old.trippedUntil || 0 });
  return fails >= TRIP_AFTER;
}
const markSuccess = id => health.delete(id);
function markProviderFailure(provider, config, error) {
  markFailure(provider.id, error.cooldownMs, error.category);
  if (!['quota', 'rate_limit', 'credential'].includes(error.category) || !provider.apiKey) return;
  for (const other of config.providers) {
    if (other.id === provider.id || other.apiKey !== provider.apiKey) continue;
    if (new URL(other.baseUrl).origin === new URL(provider.baseUrl).origin) {
      // Entries using the same API account share authentication and quota health.
      health.set(other.id, { ...health.get(provider.id) });
    }
  }
}
const isCooling = (p, now = Date.now()) => now < (health.get(p.id)?.until || 0);
const isTripped = (p, now = Date.now()) => now < (health.get(p.id)?.trippedUntil || 0);
const healthy = (p, now = Date.now()) => !isCooling(p, now) && !isTripped(p, now);
const healthSnapshot = providers => providers.map(p => ({ id: p.id, name: p.name, fails: health.get(p.id)?.fails || 0,
  category: health.get(p.id)?.category || null, cooling: isCooling(p), coolingUntil: isCooling(p) ? health.get(p.id).until : null,
  tripped: isTripped(p), trippedUntil: isTripped(p) ? health.get(p.id).trippedUntil : null }));
function acquireProbe(provider) {
  if (!health.has(provider.id)) return () => {};
  if (probes.has(provider.id)) return null;
  probes.add(provider.id); return () => probes.delete(provider.id);
}
function resolveCandidates(cfg, instant = new Date()) {
  const providers = cfg.providers.filter(p => p.enabled !== false), r = routingOf(cfg);
  const lookup = key => providers.find(p => p.id === key || p.name.toLowerCase() === String(key).toLowerCase());
  const ordered = [...new Set([...r.autoOrder.map(lookup), lookup(cfg.activeId), ...providers].filter(Boolean))];
  if (r.mode === 'manual') return { providers: providers.filter(p => p.id === cfg.activeId), reason: 'manual' };
  const scheduled = matchSchedule(r.schedules, instant);
  const pinned = scheduled && lookup(scheduled.providerId);
  if (pinned) {
    const rest = ordered.filter(p => p.id !== pinned.id);
    if (scheduled.fallbackOnFailure && isTripped(pinned, instant?.minutes !== undefined ? Date.now() : +instant)) {
      return { providers: rest, reason: `schedule:${scheduled.label || pinned.name}:tripped`, scheduled, trippedProvider: pinned };
    }
    return { providers: scheduled.fallbackOnFailure ? [pinned, ...rest] : [pinned], reason: `schedule:${scheduled.label || pinned.name}`, scheduled };
  }
  return { providers: ordered, reason: 'auto' };
}
function capabilities(provider) {
  const model = catalog.providers[provider.catalogId]?.find(m => m.id === provider.defaultModel);
  return { tools: model?.supportsTools, vision: model?.supportsVision, contextWindow: model?.contextWindow, ...provider.capabilities };
}
function planRoute(cfg, intent = {}, instant = new Date()) {
  const r = routingOf(cfg), body = intent.body || {}, now = +instant;
  let result = resolveCandidates(cfg, instant), explicit = false, requirements = {};
  const parts = typeof body.model === 'string' ? body.model.split('/') : [];
  const name = intent.provider || (parts.length > 1 ? parts[0] : '');
  const selected = name && cfg.providers.find(p => p.id === name || p.name.toLowerCase() === String(name).toLowerCase() || providerSlug(p) === name);
  if ((intent.provider && !selected) || selected?.enabled === false) throw inputError('Requested provider is missing or disabled', 404);
  if (selected) {
    const model = parts.length > 1 && parts[0] === name ? parts.slice(1).join('/') : selected.defaultModel;
    result = { providers: [{ ...selected, defaultModel: model }], reason: `provider:${selected.name}` }; explicit = true;
  } else if (parts[0] === 'profile' && parts.length > 1) {
    const profile = r.profiles.find(p => p.id === parts.slice(1).join('/'));
    if (!profile) throw inputError('Routing profile not found', 404);
    result = { providers: profile.providerIds.map(id => cfg.providers.find(p => p.id === id)).filter(p => p && p.enabled !== false), reason: `profile:${profile.id}` };
    requirements = profile.requirements || {};
  }
  let allowFailover = !explicit && (result.reason.startsWith('profile:') || (r.mode === 'auto' && (!result.scheduled || result.scheduled.fallbackOnFailure)));
  if (intent.format === 'responses' && body.previous_response_id) {
    if (!explicit && result.providers.length > 1) throw inputError('Responses follow-ups require a provider alias or x-giga-provider to retain upstream state');
    allowFailover = false;
  }
  const needsVision = (Array.isArray(body.messages) ? body.messages : []).some(m => Array.isArray(m?.content) && m.content.some(c => ['image', 'image_url'].includes(c?.type)));
  const skipped = cfg.providers.filter(p => p.enabled === false).map(p => ({ id: p.id, name: p.name, reason: 'disabled' }));
  const providers = result.providers.filter(p => {
    const cap = capabilities(p); let reason;
    if (intent.format === 'responses' && (p.type !== 'openai' || cap.responses !== true)) reason = 'Responses endpoint is not enabled';
    else if (intent.format === 'count_tokens' && (p.type !== 'anthropic' || cap.countTokens === false)) reason = 'Native token counting is not available';
    else if ((body.tools?.length || requirements.tools) && cap.tools === false) reason = 'Tool calling is not supported';
    else if ((needsVision || requirements.vision) && cap.vision === false) reason = 'Image input is not supported';
    else if (requirements.contextWindow && cap.contextWindow && cap.contextWindow < requirements.contextWindow) reason = 'Context window is too small';
    else if (allowFailover && !healthy(p, now)) reason = isTripped(p, now) ? 'circuit open' : 'cooldown';
    else if (allowFailover && probes.has(p.id)) reason = 'recovery probe in progress';
    if (!reason && intent.format && !['responses', 'count_tokens'].includes(intent.format)) {
      try { buildUpstream(p, body, intent.format); }
      catch (error) { if (error.category === 'capability_mismatch') reason = error.message; else throw error; }
    }
    if (reason) skipped.push({ id: p.id, name: p.name, reason, category: ['circuit open', 'cooldown', 'recovery probe in progress'].includes(reason) ? 'health' : 'capability_mismatch' });
    return !reason;
  });
  return { ...result, providers, skipped, allowFailover, explicit };
}
function publicPlan(plan) {
  return { provider: plan.providers[0]?.name || null, providerId: plan.providers[0]?.id || null, reason: plan.reason,
    scheduled: plan.scheduled || null, tripped: plan.trippedProvider?.name || null, chain: plan.providers.map(p => p.name), skipped: plan.skipped || [] };
}
module.exports = { routingOf, toMinutes, nowInZone, validZone, validSchedule, scheduleOccurrences, matchSchedule, resolveCandidates, planRoute, publicPlan, providerSlug, capabilities,
  health, markFailure, markProviderFailure, markSuccess, healthy, isCooling, isTripped, healthSnapshot, acquireProbe, FAIL_COOLDOWN_MS, TRIP_AFTER, TRIP_COOLDOWN_MS };
