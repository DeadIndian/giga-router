// The encryption key and encrypted records persist in DATA_DIR. New integration
// credentials never enter config.json, browser storage, or log messages.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR, writeJson } = require('./storage');

const VAULT_DIR = path.join(DATA_DIR, 'mcp-credentials');
const KEY_PATH = path.join(DATA_DIR, 'mcp-credentials.key');
let cachedKey;

function key() {
  if (cachedKey) return cachedKey;
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  try { cachedKey = fs.readFileSync(KEY_PATH); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const generated = crypto.randomBytes(32);
    try { fs.writeFileSync(KEY_PATH, generated, { flag: 'wx', mode: 0o600 }); cachedKey = generated; }
    catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; cachedKey = fs.readFileSync(KEY_PATH); }
  }
  if (cachedKey.length !== 32) throw new Error('The MCP credential key is invalid. Restore it from your data-volume backup.');
  return cachedKey;
}

function credentialPath(id) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid MCP credential identifier');
  return path.join(VAULT_DIR, `${id}.json`);
}

function readCredentials(id) {
  const file = credentialPath(id);
  if (!fs.existsSync(file)) return null;
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(record.iv, 'base64'));
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8'));
}

function writeCredentials(id, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(id));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  writeJson(credentialPath(id), { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: bytes.toString('base64') });
}

function deleteCredentials(id) {
  const file = credentialPath(id);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

module.exports = { readCredentials, writeCredentials, deleteCredentials, VAULT_DIR, KEY_PATH };
