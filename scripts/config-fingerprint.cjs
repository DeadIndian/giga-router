// Executed verbatim inside both the OLD and NEW container; no app imports.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function fingerprint(directory) {
  const configPath = path.join(directory, 'config.json');
  if (!fs.existsSync(configPath)) return 'none';
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const read = name => { const file = path.join(directory, name); return fs.existsSync(file) ? fs.readFileSync(file) : null; };
  const key = read('mcp-credentials.key'), vault = path.join(directory, 'mcp-credentials');
  const records = {};
  if (fs.existsSync(vault)) for (const file of fs.readdirSync(vault).filter(name => name.endsWith('.json')).sort()) {
    const id = file.slice(0, -5), record = JSON.parse(fs.readFileSync(path.join(vault, file), 'utf8'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
    decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    const credentials = JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8'));
    // Refresh tokens can legitimately rotate during traffic. Verify decryption and
    // record continuity, and include static personal access tokens in the hash.
    const { tokens, expiresAt, ...staticCredentials } = credentials;
    records[id] = staticCredentials;
  }
  const stable = { providers: config.providers, activeId: config.activeId, routing: config.routing, skills: config.skills,
    mcpServers: config.mcpServers?.map(({ connection, ...server }) => server),
    accessKeys: config.accessKeys?.map(({ lastUsedAt, ...key }) => key),
    account: read('admin-auth.json')?.toString('utf8') || null, vaultKey: key?.toString('base64') || null, records };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}
module.exports = { fingerprint };
if (!module.parent) console.log(fingerprint(process.env.FINGERPRINT_DATA_DIR || '/app/data'));
