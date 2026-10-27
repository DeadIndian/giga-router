const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

test('single-user password changes authenticate, persist, and revoke old dashboard sessions', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-router-auth-'));
  process.env.DATA_DIR = dataDir;
  process.env.user = 'account-user';
  process.env.password = 'original-password';
  process.env.ROUTER_KEY = 'unchanged-gateway-key';
  const express = require('express');
  const { mountAuth } = require('../lib/auth');
  const { saveConfig } = require('../lib/storage');
  saveConfig({ providers: [{ id: 'kept-provider' }], skills: [], mcpServers: [], sources: [], accessKeys: [] });
  const configBefore = fs.readFileSync(path.join(dataDir, 'config.json'));
  const app = express(); app.use(express.json()); mountAuth(app);
  const listener = app.listen(0, '127.0.0.1');
  let child;
  try {
    await once(listener, 'listening');
    let origin = `http://127.0.0.1:${listener.address().port}`;
    const request = (endpoint, body, cookie, headers = {}) => fetch(origin + endpoint, {
      method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000),
    });
    const login = (password) => request('/api/login', { user: 'account-user', password });
    const cookieOf = response => response.headers.get('set-cookie').split(';')[0];
    let cookie = cookieOf(await login('original-password'));
    const otherCookie = cookieOf(await login('original-password'));
    const change = { currentPassword: 'original-password', newPassword: 'new-password-123', confirmPassword: 'new-password-123' };

    await t.test('login and current password are required; cross-origin requests are refused', async () => {
      assert.equal((await request('/api/account/password', change)).status, 401);
      assert.equal((await request('/api/account/password', change, cookie, { Origin: 'https://unrelated.example' })).status, 403);
      assert.equal((await request('/api/account/password', { ...change, currentPassword: 'wrong-password' }, cookie)).status, 403);
      assert.equal(fs.existsSync(path.join(dataDir, 'admin-auth.json')), false);
    });

    await t.test('password confirmation, size, and reuse are validated', async () => {
      for (const newPassword of ['short', 'original-password', 'x'.repeat(1025)]) {
        assert.equal((await request('/api/account/password', { ...change, newPassword, confirmPassword: newPassword }, cookie)).status, 400);
      }
      assert.equal((await request('/api/account/password', { ...change, confirmPassword: 'different-password' }, cookie)).status, 400);
      assert.equal((await login('x'.repeat(1025))).status, 401);
    });

    await t.test('saving stores a salted hash, renews this session, and rejects the old password', async () => {
      const response = await request('/api/account/password', change, cookie);
      assert.equal(response.status, 200); cookie = cookieOf(response);
      assert.equal((await request('/api/access/keys', null, cookie)).status, 200);
      assert.equal((await request('/api/access/keys', null, otherCookie)).status, 401);
      assert.equal((await login('original-password')).status, 401);
      assert.equal((await login('new-password-123')).status, 200);
      const saved = fs.readFileSync(path.join(dataDir, 'admin-auth.json'), 'utf8');
      assert.equal(saved.includes('new-password-123'), false);
      assert.equal(saved.includes('original-password'), false);
      assert.match(JSON.parse(saved).hash, /^[a-f0-9]{128}$/);
      if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dataDir, 'admin-auth.json')).mode & 0o777, 0o600);
      assert.deepEqual(fs.readFileSync(path.join(dataDir, 'config.json')), configBefore);
      assert.equal((await request('/api/access/router-key', null, cookie).then(r => r.json())).key, 'unchanged-gateway-key');
    });

    await t.test('concurrent changes cannot both commit with the same current password', async () => {
      const requests = ['final-password-one', 'final-password-two'].map(newPassword => request('/api/account/password', { currentPassword: 'new-password-123', newPassword, confirmPassword: newPassword }, cookie));
      const responses = await Promise.all(requests);
      assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
      const winner = responses[0].status === 200 ? 'final-password-one' : 'final-password-two';
      cookie = cookieOf(responses.find(r => r.status === 200));
      assert.equal((await login(winner)).status, 200);
      change.newPassword = winner;
    });

    await t.test('a fresh process uses the saved password instead of its environment password', async () => {
      listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve));
      child = spawn(process.execPath, ['-e', `const express=require('express');const app=express();app.use(express.json());require('./lib/auth').mountAuth(app);const server=app.listen(0,'127.0.0.1',()=>console.log(server.address().port));`], {
        cwd: path.join(__dirname, '..'), env: { ...process.env, password: 'different-environment-password' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('Restarted auth server did not start')), 5000);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.stdout.on('data', bytes => { output += bytes; if (output.includes('\n')) { clearTimeout(timeout); resolve(); } });
      });
      origin = `http://127.0.0.1:${Number(output.trim())}`;
      assert.equal((await login(change.newPassword)).status, 200);
      assert.equal((await login('different-environment-password')).status, 401);
      assert.equal((await request('/api/access/keys', null, cookie)).status, 401);
      const freshCookie = cookieOf(await login(change.newPassword));
      for (let i = 0; i < 10; i++) assert.equal((await request('/api/account/password', { ...change, currentPassword: 'wrong-password', newPassword: 'another-password', confirmPassword: 'another-password' }, freshCookie)).status, 403);
      assert.equal((await request('/api/account/password', { ...change, currentPassword: 'wrong-password' }, freshCookie)).status, 429);
    });
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    if (listener.listening) { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
