const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { DATA_DIR, loadConfig, updateConfig, writeJson } = require('./storage');

const ROUTER_KEY = process.env.ROUTER_KEY || '';
const ADMIN_USER = process.env.user || process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.password || process.env.ADMIN_PASSWORD || 'changeme';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();
const loginFailures = new Map();
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const equal = (a, b) => crypto.timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const cookieOf = (req) => (req.headers.cookie || '').match(/(?:^|;\s*)router_session=([a-f0-9]+)/)?.[1];
const PASSWORD_PATH = path.join(DATA_DIR, 'admin-auth.json');
const scrypt = promisify(crypto.scrypt);
const validPassword = value => typeof value === 'string' && Buffer.byteLength(value) <= 1024;

function savedPassword() {
  try {
    const saved = JSON.parse(fs.readFileSync(PASSWORD_PATH, 'utf8'));
    if (saved.version !== 1 || !/^[a-f0-9]{32}$/.test(saved.salt) || !/^[a-f0-9]{128}$/.test(saved.hash)) throw Error('Invalid saved dashboard password');
    return saved;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function checkPassword(password, saved) {
  if (!validPassword(password)) return false;
  if (!saved) return equal(password, ADMIN_PASSWORD);
  const derived = await scrypt(password, Buffer.from(saved.salt, 'hex'), 64);
  return crypto.timingSafeEqual(derived, Buffer.from(saved.hash, 'hex'));
}

function recordFailure(ip) {
  if (loginFailures.size > 1000) loginFailures.clear();
  const previous = loginFailures.get(ip);
  const count = previous && Date.now() - previous.at < 60_000 ? previous.count + 1 : 1;
  loginFailures.set(ip, { count, at: Date.now(), until: count >= 10 ? Date.now() + 60_000 : 0 });
}

function limitAttempts(req, res, next) {
  if (loginFailures.get(req.socket.remoteAddress)?.until > Date.now()) return res.status(429).set('Retry-After', '60').json({ error: 'Too many attempts. Try again in a minute.' });
  next();
}

function startSession(req, res) {
  for (const [token, expiry] of sessions) if (expiry < Date.now()) sessions.delete(token);
  if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.set('Set-Cookie', `router_session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure}`);
}

function sameOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Request must come from this dashboard' });
    } catch {
      return res.status(403).json({ error: 'Invalid request origin' });
    }
  }
  next();
}

function sessionAuth(req, res, next) {
  const token = cookieOf(req);
  if (!token || (sessions.get(token) || 0) < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: 'Sign in to continue' });
  }
  req.dashboardSession = token;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return sameOrigin(req, res, next);
  next();
}

function isDashboardSession(token) { return !!token && (sessions.get(token) || 0) >= Date.now(); }

function authenticateKey(req) {
  const token = req.headers['x-gateway-key'] || req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (typeof token !== 'string' || !token) return null;
  if (ROUTER_KEY && equal(token, ROUTER_KEY)) return { id: 'environment', name: 'Router key', scopes: ['llm', 'mcp'], serverIds: null };
  const digest = hash(token);
  const key = loadConfig().accessKeys.find((entry) => entry.hash === digest && !entry.revokedAt);
  if (!key) return null;
  if (!key.lastUsedAt || Date.now() - Date.parse(key.lastUsedAt) > 60_000) {
    updateConfig((config) => {
      const saved = config.accessKeys.find((entry) => entry.id === key.id);
      if (saved) saved.lastUsedAt = new Date().toISOString();
    });
  }
  return key;
}

function gatewayAuth(scope) {
  return (req, res, next) => {
    const key = authenticateKey(req);
    if (!key) {
      res.set('WWW-Authenticate', 'Bearer');
      const error = scope === 'mcp'
        ? { jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32001, message: 'Invalid gateway key' } }
        : { type: 'error', error: { type: 'authentication_error', message: 'invalid router key' } };
      return res.status(401).json(error);
    }
    if (!key.scopes.includes(scope)) {
      return res.status(403).json(scope === 'mcp'
        ? { jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32003, message: 'Key does not allow MCP access' } }
        : { type: 'error', error: { type: 'permission_error', message: 'Key does not allow LLM access' } });
    }
    req.gatewayKey = key;
    next();
  };
}

function mountAuth(app, onKeyRevoked = async () => {}) {
  app.post('/api/login', sameOrigin, limitAttempts, async (req, res, next) => {
    try {
      const ip = req.socket.remoteAddress;
      const { user, password } = req.body || {};
      const saved = savedPassword();
      if (typeof user !== 'string' || user.length > 1024 || !equal(user, ADMIN_USER) || !await checkPassword(password, saved)) {
        recordFailure(ip);
        return res.status(401).json({ error: 'Incorrect username or password' });
      }
      if (JSON.stringify(savedPassword()) !== JSON.stringify(saved)) return res.status(409).json({ error: 'Password changed. Sign in again.' });
      loginFailures.delete(ip);
      startSession(req, res);
      res.json({ ok: true });
    } catch (error) { next(error); }
  });
  app.post('/api/account/password', sessionAuth, limitAttempts, async (req, res, next) => {
    try {
      const { currentPassword, newPassword, confirmPassword } = req.body || {};
      if (!validPassword(currentPassword) || !validPassword(newPassword) || newPassword.length < 8) return res.status(400).json({ error: 'Use a new password with at least 8 characters and no more than 1024 bytes.' });
      if (newPassword !== confirmPassword) return res.status(400).json({ error: 'New passwords do not match.' });
      const saved = savedPassword();
      if (!await checkPassword(currentPassword, saved)) {
        recordFailure(req.socket.remoteAddress);
        return res.status(403).json({ error: 'Current password is incorrect.' });
      }
      if (newPassword === currentPassword) return res.status(400).json({ error: 'Choose a different new password.' });
      const salt = crypto.randomBytes(16);
      const derived = await scrypt(newPassword, salt, 64);
      if (!isDashboardSession(req.dashboardSession) || JSON.stringify(savedPassword()) !== JSON.stringify(saved)) return res.status(409).json({ error: 'Password changed. Sign in again before continuing.' });
      writeJson(PASSWORD_PATH, { version: 1, salt: salt.toString('hex'), hash: derived.toString('hex'), changedAt: new Date().toISOString() });
      sessions.clear();
      loginFailures.clear();
      startSession(req, res);
      res.set('Cache-Control', 'no-store').json({ ok: true });
    } catch (error) { next(error); }
  });
  app.post('/api/logout', sameOrigin, (req, res) => {
    sessions.delete(cookieOf(req));
    res.set('Set-Cookie', 'router_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0');
    res.json({ ok: true });
  });
  app.get('/api/access/keys', sessionAuth, (req, res) => res.json({
    environmentKey: { configured: !!ROUTER_KEY, name: 'Router key', scopes: ['llm', 'mcp'] },
    items: loadConfig().accessKeys.map(({ hash: ignored, ...key }) => key),
  }));
  app.get('/api/access/router-key', sessionAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ key: ROUTER_KEY });
  });
  app.post('/api/access/keys', sessionAuth, (req, res) => {
    const { name, scopes, serverIds = null } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || name.length > 100 || !Array.isArray(scopes) || !scopes.length || scopes.some((s) => !['llm', 'mcp'].includes(s))) {
      return res.status(400).json({ error: 'A name and at least one valid scope (llm, mcp) are required' });
    }
    const servers = loadConfig().mcpServers;
    if (serverIds !== null && (!Array.isArray(serverIds) || serverIds.some((id) => !servers.some((s) => s.id === id)))) {
      return res.status(400).json({ error: 'Select existing MCP servers, or allow all servers' });
    }
    const token = `gr_${crypto.randomBytes(32).toString('base64url')}`;
    const key = { id: crypto.randomUUID(), name: name.trim(), hash: hash(token), prefix: token.slice(0, 11), scopes: [...new Set(scopes)], serverIds, createdAt: new Date().toISOString(), lastUsedAt: null };
    updateConfig((config) => config.accessKeys.push(key));
    const { hash: ignored, ...publicKey } = key;
    res.status(201).json({ ...publicKey, key: token });
  });
  app.delete('/api/access/keys/:id', sessionAuth, async (req, res, next) => {
    const key = updateConfig((config) => {
      const item = config.accessKeys.find((entry) => entry.id === req.params.id);
      if (item) item.revokedAt = new Date().toISOString();
      return item;
    });
    if (!key) return res.status(404).json({ error: 'Key not found' });
    try { await onKeyRevoked(key.id); res.json({ ok: true }); } catch (error) { next(error); }
  });
}

module.exports = { sessionAuth, gatewayAuth, mountAuth, sameOrigin, isDashboardSession, ROUTER_KEY };
