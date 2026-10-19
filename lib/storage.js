const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
let cached;
let signature;

function fileSignature() {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function loadConfig() {
  const current = fileSignature();
  if (!cached || signature !== current) {
    const config = current ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
    if (config.providers !== undefined && !Array.isArray(config.providers)) {
      throw new Error('Saved configuration has an invalid providers list');
    }
    cached = { ...config, providers: config.providers || [], activeId: config.activeId || null };
    for (const key of ['mcpServers', 'skills', 'sources', 'accessKeys']) {
      if (!Array.isArray(cached[key])) cached[key] = [];
    }
    signature = current;
  }
  // Callers change a snapshot, never the cache: validation failures cannot mutate it.
  return structuredClone(cached);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function saveConfig(config) {
  writeJson(CONFIG_PATH, config);
  cached = structuredClone(config);
  signature = fileSignature();
}

function updateConfig(change) {
  const config = loadConfig();
  const result = change(config);
  saveConfig(config);
  return result;
}

module.exports = { DATA_DIR, CONFIG_PATH, loadConfig, saveConfig, updateConfig, writeJson };
