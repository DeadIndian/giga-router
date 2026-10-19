const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { loadConfig, saveConfig } = require('./storage');

const SNAPSHOT_DIR = path.join(__dirname, '..', 'marketplaces', 'builtin');
const DEFAULT_MARKETPLACES = [
  { id: 'superpowers', name: 'Superpowers', repo: 'obra/superpowers', path: 'skills', description: 'Planning, debugging, code review, testing, and shipping workflows.' },
  { id: 'microsoft', name: 'Microsoft Skills', repo: 'microsoft/skills', path: '.github', description: 'Azure, AI applications, SDKs, and development tools from Microsoft.' },
  { id: 'github-copilot', name: 'GitHub Awesome Copilot', repo: 'github/awesome-copilot', path: 'skills', description: 'Community-maintained engineering, automation, and agent skills from GitHub.' },
  { id: 'expo', name: 'Expo Skills', repo: 'expo/skills', path: 'plugins', description: 'React Native, Expo Router, native UI, and EAS deployment workflows.' },
  { id: 'supabase', name: 'Supabase Agent Skills', repo: 'supabase/agent-skills', path: 'skills', description: 'Supabase development and PostgreSQL performance best practices.' },
  { id: 'everything-claude-code', name: 'Everything Claude Code', repo: 'affaan-m/ECC', path: 'skills', description: 'Reusable coding, architecture, testing, and agent workflow skills.' },
  { id: 'wshobson-agents', name: 'wshobson Agents', repo: 'wshobson/agents', path: 'plugins', description: 'Specialist engineering skills covering backend, frontend, data, and operations.' },
  { id: 'marketing', name: 'Marketing Skills', repo: 'coreyhaines31/marketingskills', path: 'skills', description: 'SEO, conversion, copywriting, analytics, and product growth.' },
  { id: 'claude-engineering', name: 'Claude Skills · Engineering', repo: 'alirezarezvani/claude-skills', path: 'engineering-team', description: 'Architecture, full-stack development, engineering tooling, and code quality.' },
  { id: 'n8n', name: 'n8n Skills', repo: 'czlonkowski/n8n-skills', path: 'skills', description: 'Workflow design, expressions, code nodes, MCP tooling, and self-hosting.' },
].map((entry) => ({ ...entry, url: `https://github.com/${entry.repo}`, ref: 'main' }));

function defaultsEnabled() {
  return !['false', '0', 'off'].includes(String(process.env.GIGA_ROUTER_DEFAULT_MARKETPLACES || '').toLowerCase());
}

function matchingDefault(source, definitions = DEFAULT_MARKETPLACES) {
  const sourcePath = source.path || '';
  return definitions.find((entry) => source.url?.replace(/\/$/, '').toLowerCase() === entry.url.toLowerCase()
    && (!sourcePath || sourcePath === entry.path || entry.path.startsWith(`${sourcePath}/`)) && (!source.ref || source.ref === entry.ref));
}

function removedDefaults(config) {
  return Array.isArray(config.removedDefaultMarketplaces) ? config.removedDefaultMarketplaces : [];
}

function markDefaultRemoved(config, source) {
  const id = source.builtinId || matchingDefault(source)?.id;
  if (id) config.removedDefaultMarketplaces = [...new Set([...removedDefaults(config), id])];
}

function markDefaultAdded(config, source) {
  const definition = matchingDefault(source);
  if (definition) {
    source.builtinId = definition.id;
    config.removedDefaultMarketplaces = removedDefaults(config).filter((id) => id !== definition.id);
  }
}

function seedDefaultMarketplaces({ definitions = DEFAULT_MARKETPLACES, snapshotDir = SNAPSHOT_DIR, enabled = defaultsEnabled() } = {}) {
  if (!enabled) return { added: 0, adopted: 0, repaired: 0 };
  const { writeJson, DATA_DIR } = require('./storage');
  const config = loadConfig();
  const removed = new Set(removedDefaults(config));
  let added = 0, adopted = 0, repaired = 0;
  for (const definition of definitions) {
    if (removed.has(definition.id)) continue;
    const existing = config.sources.find((source) => source.builtinId === definition.id || matchingDefault(source, [definition]));
    if (existing && fs.existsSync(path.join(DATA_DIR, 'marketplace', `${existing.id}.json`))) {
      // A user-refreshed index and a user-chosen name are authoritative. Merely
      // adopt matching existing sources so an upgrade never duplicates them.
      if (!existing.builtinId) { existing.builtinId = definition.id; adopted++; }
      continue;
    }
    const snapshot = JSON.parse(gunzipSync(fs.readFileSync(path.join(snapshotDir, `${definition.id}.json.gz`)), { maxOutputLength: 32 * 1024 * 1024 }).toString('utf8'));
    if (snapshot.source?.url !== definition.url || snapshot.source?.path !== definition.path || snapshot.source?.ref !== definition.ref || !Array.isArray(snapshot.entries) || !snapshot.entries.length || !Array.isArray(snapshot.tree)) {
      throw new Error(`Invalid bundled marketplace: ${definition.id}`);
    }
    const source = { ...snapshot.source, ...(existing || {}), id: existing?.id || `builtin-${definition.id}`, builtinId: definition.id, description: definition.description };
    // Missing indexes are restored from the bundled commit, never from GitHub.
    source.commit = snapshot.source.commit;
    source.indexedAt = snapshot.source.indexedAt;
    source.count = snapshot.entries.length;
    writeJson(path.join(DATA_DIR, 'marketplace', `${source.id}.json`), { ...snapshot, source });
    if (existing) { Object.assign(existing, source); repaired++; } else { config.sources.push(source); added++; }
  }
  if (added || adopted || repaired) saveConfig(config);
  return { added, adopted, repaired };
}

module.exports = { DEFAULT_MARKETPLACES, SNAPSHOT_DIR, defaultsEnabled, matchingDefault, removedDefaults, markDefaultRemoved, markDefaultAdded, seedDefaultMarketplaces };
