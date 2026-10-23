const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fingerprint } = require('../scripts/config-fingerprint.cjs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
test('deployment fingerprint excludes traffic but detects changed settings', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-fingerprint-'));
  try {
    const config = { providers: [{ id: 'p', apiKey: 'fixture' }], accessKeys: [{ id: 'k', scopes: ['llm'], lastUsedAt: null }], mcpServers: [{ id: 's', connection: { state: 'unknown' } }] };
    const save = () => fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify(config));
    save(); const before = fingerprint(directory);
    config.accessKeys[0].lastUsedAt = new Date().toISOString(); config.mcpServers[0].connection.state = 'connected'; save(); assert.equal(fingerprint(directory), before);
    config.providers[0].apiKey = 'changed'; save(); assert.notEqual(fingerprint(directory), before);
    config.providers[0].apiKey = 'fixture'; config.accessKeys[0].scopes.push('mcp'); save(); assert.notEqual(fingerprint(directory), before);
    fs.writeFileSync(path.join(directory, 'admin-auth.json'), '{"hash":"fixture-password-hash"}');
    const key = crypto.randomBytes(32); fs.writeFileSync(path.join(directory, 'mcp-credentials.key'), key);
    fs.mkdirSync(path.join(directory, 'mcp-credentials'));
    const saveVault = (access, secret = 'fixture-secret') => {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from('s'));
      const data = Buffer.concat([cipher.update(JSON.stringify({ client: { client_id: 'fixture', client_secret: secret }, tokens: { access_token: access }, expiresAt: new Date().toISOString() })), cipher.final()]);
      fs.writeFileSync(path.join(directory, 'mcp-credentials/s.json'), JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
    };
    saveVault('one'); const withVault = fingerprint(directory);
    saveVault('two'); assert.equal(fingerprint(directory), withVault, 'ordinary OAuth rotation is allowed');
    saveVault('two', 'changed-secret'); assert.notEqual(fingerprint(directory), withVault, 'registration secrets are verified');
    const expression = fs.readFileSync(path.join(__dirname, '../scripts/config-fingerprint.cjs'), 'utf8');
    const executed = execFileSync(process.execPath, ['-e', expression], { env: { ...process.env, FINGERPRINT_DATA_DIR: directory }, encoding: 'utf8' });
    assert.equal(executed.trim(), fingerprint(directory));
    const restored = execFileSync(process.execPath, [path.join(__dirname, '../scripts/verify-restore.cjs'), directory], { encoding: 'utf8' });
    assert.match(restored, /Restore verified/); assert.doesNotMatch(restored, /changed-secret|fixture-password-hash/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
