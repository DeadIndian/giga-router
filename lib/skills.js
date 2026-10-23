const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');
const { zipSync } = require('fflate');
const { DATA_DIR, loadConfig, updateConfig, writeJson } = require('./storage');
const { inputError } = require('./validation');
const { parseGitHubSource, sanitizeSubpath } = require('./github-source');
const { defaultsEnabled, removedDefaults, markDefaultRemoved, markDefaultAdded, seedDefaultMarketplaces } = require('./marketplace-defaults');
const { readBundle, commitBundle, rollbackBundle } = require('./skill-bundles');

const SKILLS_DIR = path.join(DATA_DIR, 'skills');
const INDEX_DIR = path.join(DATA_DIR, 'marketplace');
const MAX_SKILL_BYTES = 512 * 1024;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 100;
const pendingSources = new Map();
const pendingInstalls = new Map();
const indexCache = new Map();
let onSkillsChanged = () => {};

function parseSkill(content, fallback = '') {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_SKILL_BYTES || content.includes('\0')) throw inputError('SKILL.md must be UTF-8 text smaller than 512 KiB');
  const match = content.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)([\s\S]*)$/);
  let metadata = {};
  if (match) {
    try { metadata = yaml.load(match[1], { schema: yaml.JSON_SCHEMA }) || {}; }
    catch { throw inputError('SKILL.md contains invalid YAML frontmatter'); }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw inputError('Skill frontmatter must be a YAML object');
  }
  const name = typeof metadata.name === 'string' ? metadata.name.trim() : fallback;
  const text = (match ? match[2] : content).trim();
  const heading = text.match(/^#\s+(.+)$/m)?.[1];
  const description = typeof metadata.description === 'string' ? metadata.description.trim() : heading || '';
  if (typeof name !== 'string' || !name || name.length > 120 || ['.', '..'].includes(name) || /[\\/\0\r\n]/.test(name) || !text) throw inputError('A skill needs a safe name (up to 120 characters) and non-empty instructions');
  return { name, description: description.slice(0, 2000), content, text, license: typeof metadata.license === 'string' ? metadata.license : null };
}

async function mapLimit(items, concurrency, mapper) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

async function responseBytes(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) throw inputError('GitHub response exceeds the size limit', 413);
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw inputError('GitHub response exceeds the size limit', 413);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function createGitHubClient(fetcher = fetch) {
  const request = async (endpoint, maxBytes = 1024 * 1024) => {
    const response = await fetcher(`https://api.github.com${endpoint}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Giga-Router',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
      signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      const message = response.status === 404 ? 'GitHub repository, branch, or file not found'
        : [403, 429].includes(response.status) ? 'GitHub rate limit or access denied. Set GITHUB_TOKEN for more requests or private repositories.'
          : `GitHub request failed (${response.status})`;
      throw inputError(message, response.status === 404 ? 404 : 502);
    }
    return JSON.parse((await responseBytes(response, maxBytes)).toString('utf8'));
  };
  return {
    request,
    async blob(source, sha, maxBytes = MAX_BUNDLE_BYTES, filePath) {
      if (source.commit && filePath) {
        const url = `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.commit}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
        const response = await fetcher(url, {
          headers: { 'User-Agent': 'Giga-Router', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
          signal: AbortSignal.timeout(20_000), redirect: 'error',
        });
        if (!response.ok) { await response.body?.cancel(); throw inputError(`Could not download ${filePath} from the pinned GitHub commit`, 502); }
        return responseBytes(response, maxBytes);
      }
      const data = await request(`/repos/${source.owner}/${source.repo}/git/blobs/${encodeURIComponent(sha)}`, Math.ceil(maxBytes * 1.5) + 4096);
      if (data.encoding !== 'base64') throw inputError('GitHub returned an unsupported file encoding', 502);
      const bytes = Buffer.from(data.content, 'base64');
      if (bytes.length > maxBytes) throw inputError('Repository file exceeds the size limit', 413);
      return bytes;
    },
  };
}
const github = createGitHubClient();

async function indexSource(input, client = github) {
  const parsed = parseGitHubSource(input.url, input);
  const base = `/repos/${parsed.owner}/${parsed.repo}`;
  const repo = await client.request(base);
  const ref = parsed.ref || repo.default_branch;
  const commit = await client.request(`${base}/commits/${encodeURIComponent(ref)}`);
  let treeSha = commit.commit.tree.sha;
  // Resolve a directory before asking for a recursive tree, avoiding whole-repo
  // downloads when a source is one small subtree of a large repository.
  for (const segment of parsed.path.split('/').filter(Boolean)) {
    const level = await client.request(`${base}/git/trees/${treeSha}`);
    const directory = level.tree.find((entry) => entry.path === segment && entry.type === 'tree');
    if (!directory) throw inputError(`Directory "${parsed.path}" not found in ${ref}`, 404);
    treeSha = directory.sha;
  }
  const result = await client.request(`${base}/git/trees/${treeSha}?recursive=1`, 15 * 1024 * 1024);
  if (result.truncated) throw inputError('Repository tree is too large. Add a source pointing to its skills directory instead.');
  const tree = result.tree.filter((entry) => entry.type === 'blob' && entry.mode !== '120000' && !entry.path.split('/').some((part) => ['.git', 'node_modules', 'dist', 'build', '__pycache__'].includes(part)))
    .map((entry) => ({ path: parsed.path ? `${parsed.path}/${entry.path}` : entry.path, sha: entry.sha, size: entry.size || 0 }));
  const candidates = tree.filter((entry) => /(^|\/)SKILL\.md$/.test(entry.path));
  if (candidates.length > 1000) throw inputError('This source contains over 1,000 skills. Select a smaller directory.');
  const warnings = [];
  const entries = await mapLimit(candidates, 4, async (entry) => {
    try {
      const bytes = await client.blob({ ...parsed, commit: commit.sha }, entry.sha, MAX_SKILL_BYTES, entry.path);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const skill = parseSkill(content, path.posix.basename(path.posix.dirname(entry.path)) || parsed.repo);
      const directory = path.posix.dirname(entry.path) === '.' ? '' : path.posix.dirname(entry.path);
      return { ...skill, path: directory, sha: entry.sha, sourceUrl: `${parsed.url}/blob/${commit.sha}/${entry.path}`, license: skill.license || repo.license?.spdx_id || null };
    } catch (error) {
      warnings.push(`${entry.path}: ${error.message}`);
      return null;
    }
  });
  if (candidates.length && !entries.some(Boolean)) throw inputError(`No skills could be indexed. ${warnings[0]}`, 502);
  const skills = entries.filter(Boolean);
  for (const skill of skills) {
    const files = bundleEntries({ tree, entries: skills }, skill);
    skill.bundleHash = crypto.createHash('sha256').update(files.map((file) => `${file.path}:${file.sha}`).sort().join('\n')).digest('hex');
  }
  return { source: { ...parsed, ref, commit: commit.sha, name: typeof input.name === 'string' && input.name.trim() || `${parsed.owner}/${parsed.repo}`, license: repo.license?.spdx_id === 'NOASSERTION' ? null : repo.license?.spdx_id || null, indexedAt: new Date().toISOString(), count: skills.length }, tree, entries: skills, warnings: warnings.slice(0, 20) };
}

function bundleEntries(index, skill) {
  const prefix = skill.path ? `${skill.path}/` : '';
  const nested = index.entries.filter((other) => other.path !== skill.path && other.path.startsWith(prefix)).map((other) => `${other.path}/`);
  return index.tree.filter((file) => file.path.startsWith(prefix) && !nested.some((directory) => file.path.startsWith(directory)));
}

function hasUpdate(installed, entry) {
  return !!installed && (installed.bundleHash && entry.bundleHash ? installed.bundleHash !== entry.bundleHash : installed.sha !== entry.sha);
}

function sourceIndex(id) {
  const source = loadConfig().sources.find((entry) => entry.id === id);
  if (!source) throw inputError('Marketplace source not found', 404);
  const file = path.join(INDEX_DIR, `${source.id}.json`);
  if (!fs.existsSync(file)) throw inputError('Source index is unavailable. Refresh this source.', 409);
  const stat = fs.statSync(file);
  const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const cached = indexCache.get(id);
  if (!cached || cached.signature !== signature) {
    if (indexCache.size >= 20) indexCache.delete(indexCache.keys().next().value);
    indexCache.set(id, { signature, index: JSON.parse(fs.readFileSync(file, 'utf8')) });
  }
  return { ...indexCache.get(id).index, source };
}

function previewEntry(sourceId, skillPath) {
  const index = sourceIndex(sourceId);
  const entry = index.entries.find((item) => item.path === skillPath);
  if (!entry) throw inputError('Skill not found in this source', 404);
  const installed = loadConfig().skills.find((skill) => skill.sourceId === sourceId && skill.sourcePath === skillPath);
  let changes;
  if (installed) {
    const old = new Map(skillFiles(installed).filter(f => !['giga-router-source.json', 'SOURCE-LICENSE.txt'].includes(f.path)).map(f => {
      const bytes = Buffer.from(f.data, 'base64');
      return [f.path, crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')];
    }));
    const prefix = entry.path ? `${entry.path}/` : '';
    changes = bundleEntries(index, entry).map(f => {
      const name = f.path.slice(prefix.length), hash = old.get(name); old.delete(name);
      return { path: name, status: hash === f.sha ? 'unchanged' : hash ? 'modified' : 'added' };
    }).filter(f => f.status !== 'unchanged');
    changes.push(...[...old.keys()].map(path => ({ path, status: 'removed' })));
  }
  return { ...entry, sourceId, sourceName: index.source.name, commit: index.source.commit, changes,
    locallyEdited: !!installed?.locallyEdited, localContent: installed?.locallyEdited ? skillDetail(installed.id).content : undefined,
    installedId: installed?.id || null, updateAvailable: hasUpdate(installed, entry) };
}

function listMarketplace() {
  const config = loadConfig();
  const installed = new Map(config.skills.map((skill) => [`${skill.sourceId}:${skill.sourcePath}`, skill]));
  return config.sources.flatMap((source) => {
    try {
      const index = sourceIndex(source.id);
      return index.entries.map(({ content, text, ...entry }) => {
        const local = installed.get(`${source.id}:${entry.path}`);
        return { ...entry, sourceId: source.id, sourceName: source.name, installedId: local?.id || null, updateAvailable: hasUpdate(local, entry) };
      });
    } catch { return []; }
  });
}

function skillFiles(skill) {
  return readBundle(skill).files;
}

function skillDetail(id) {
  const skill = loadConfig().skills.find((item) => item.id === id);
  if (!skill) throw inputError('Skill not found', 404);
  const files = skillFiles(skill);
  const entry = files.find((item) => item.path === 'SKILL.md');
  const parsed = parseSkill(Buffer.from(entry.data, 'base64').toString('utf8'), skill.name);
  return { ...skill, content: parsed.content, text: parsed.text, files: files.map((item) => ({ path: item.path, size: Buffer.from(item.data, 'base64').length })) };
}

function persistBundle(skill, files) {
  commitBundle(skill, files);
  onSkillsChanged();
  return skillDetail(skill.id);
}

async function installSkill(sourceId, skillPath, client = github) {
  const original = loadConfig().skills.find(s => s.sourceId === sourceId && s.sourcePath === skillPath);
  const index = sourceIndex(sourceId);
  const entry = previewEntry(sourceId, skillPath);
  const prefix = entry.path ? `${entry.path}/` : '';
  // Exclude other nested skill bundles, while preserving this skill's references,
  // scripts, and assets. Scripts are downloaded as files, never executed.
  const files = bundleEntries(index, entry);
  if (files.length > MAX_FILES || files.reduce((sum, file) => sum + file.size, 0) > MAX_BUNDLE_BYTES) throw inputError('Skill bundle exceeds 100 files or 8 MiB. Add a source for a smaller skill directory.', 413);
  let downloaded = 0;
  const bundle = await mapLimit(files, 4, async (file) => {
    const bytes = await client.blob(index.source, file.sha, MAX_BUNDLE_BYTES, file.path);
    downloaded += bytes.length;
    if (downloaded > MAX_BUNDLE_BYTES) throw inputError('Skill bundle exceeds 8 MiB', 413);
    return { path: sanitizeSubpath(file.path.slice(prefix.length)), data: bytes.toString('base64') };
  });
  if (!bundle.some((file) => file.path === 'SKILL.md')) throw inputError('Selected bundle is missing SKILL.md');
  if (!loadConfig().sources.some((source) => source.id === sourceId)) throw inputError('Source was removed during installation', 409);
  // Preserve repository licensing even when LICENSE lives above the skill directory.
  if (!bundle.some((file) => /^license(?:\.|$)/i.test(file.path)) && index.repositoryLicense?.content) {
    bundle.push({ path: 'SOURCE-LICENSE.txt', data: Buffer.from(index.repositoryLicense.content).toString('base64') });
  } else if (!bundle.some((file) => /^license(?:\.|$)/i.test(file.path))) {
    const licenses = await client.request(`/repos/${index.source.owner}/${index.source.repo}/contents?ref=${index.source.commit}`);
    const license = Array.isArray(licenses) && licenses.find((file) => /^license(?:\.|$)/i.test(file.name) && file.type === 'file');
    if (license) {
      const bytes = await client.blob(index.source, license.sha, 128 * 1024, license.name);
      bundle.push({ path: 'SOURCE-LICENSE.txt', data: bytes.toString('base64') });
    }
  }
  const existing = loadConfig().skills.find((skill) => skill.sourceId === sourceId && skill.sourcePath === skillPath);
  if (JSON.stringify(existing) !== JSON.stringify(original)) throw inputError('Skill changed during download. Review the latest version and retry.', 409);
  if (!loadConfig().sources.some((source) => source.id === sourceId)) throw inputError('Source was removed during installation', 409);
  const now = new Date().toISOString();
  const skill = { id: existing?.id || crypto.randomUUID(), name: entry.name, description: entry.description, enabled: existing?.enabled ?? true,
    sourceId, sourcePath: skillPath, sourceName: index.source.name, sourceUrl: entry.sourceUrl, license: entry.license,
    sha: entry.sha, bundleHash: entry.bundleHash, commit: index.source.commit, installedAt: existing?.installedAt || now, updatedAt: now };
  bundle.push({ path: 'giga-router-source.json', data: Buffer.from(JSON.stringify({ url: skill.sourceUrl, commit: skill.commit, license: skill.license }, null, 2)).toString('base64') });
  parseSkill(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(bundle.find(f => f.path === 'SKILL.md').data, 'base64')), skill.name);
  return persistBundle(skill, bundle);
}

const route = (handler) => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);

function mountSkills(app, sessionAuth, notify = () => {}) {
  onSkillsChanged = notify;
  app.get('/api/skills', sessionAuth, (req, res) => res.json({ items: loadConfig().skills }));
  app.get('/api/skills/:id', sessionAuth, route((req, res) => res.json(skillDetail(req.params.id))));
  app.post('/api/skills/:id/rollback', sessionAuth, route((req, res) => {
    const skill = loadConfig().skills.find(entry => entry.id === req.params.id);
    if (!skill) throw inputError('Skill not found', 404);
    rollbackBundle(skill); onSkillsChanged(); res.json(skillDetail(skill.id));
  }));
  app.post('/api/skills', sessionAuth, route((req, res) => {
    const parsed = parseSkill(req.body.content, typeof req.body.name === 'string' ? req.body.name.trim() : '');
    const now = new Date().toISOString();
    const skill = { id: crypto.randomUUID(), name: parsed.name, description: typeof req.body.description === 'string' && req.body.description.trim() || parsed.description, enabled: true, sourceName: 'Personal', license: parsed.license, installedAt: now, updatedAt: now };
    res.status(201).json(persistBundle(skill, [{ path: 'SKILL.md', data: Buffer.from(parsed.content).toString('base64') }]));
  }));
  app.put('/api/skills/:id', sessionAuth, route((req, res) => {
    const existing = loadConfig().skills.find((skill) => skill.id === req.params.id);
    if (!existing) throw inputError('Skill not found', 404);
    if (req.body.enabled !== undefined && typeof req.body.enabled !== 'boolean') throw inputError('Enabled must be a boolean');
    let skill = { ...existing, updatedAt: new Date().toISOString(), ...(req.body.enabled !== undefined ? { enabled: req.body.enabled } : {}) };
    if (req.body.content !== undefined) {
      const parsed = parseSkill(req.body.content, req.body.name || existing.name);
      skill = { ...skill, name: parsed.name, description: typeof req.body.description === 'string' && req.body.description.trim() || parsed.description, locallyEdited: !!existing.sourceId };
      const files = skillFiles(existing).map((file) => file.path === 'SKILL.md' ? { ...file, data: Buffer.from(parsed.content).toString('base64') } : file);
      return res.json(persistBundle(skill, files));
    }
    updateConfig((config) => { config.skills = config.skills.map((entry) => entry.id === skill.id ? skill : entry); });
    onSkillsChanged();
    res.json(skill);
  }));
  app.delete('/api/skills/:id', sessionAuth, route((req, res) => {
    const skill = loadConfig().skills.find((item) => item.id === req.params.id);
    if (!skill) throw inputError('Skill not found', 404);
    updateConfig((config) => { config.skills = config.skills.filter((item) => item.id !== skill.id); });
    fs.rmSync(path.join(SKILLS_DIR, skill.id), { recursive: true, force: true });
    onSkillsChanged();
    res.json({ ok: true });
  }));
  app.get('/api/skills/:id/download', sessionAuth, route((req, res) => {
    const skill = skillDetail(req.params.id);
    const name = skill.name.replace(/[^a-zA-Z0-9._-]/g, '-');
    const archive = Object.fromEntries(skillFiles(skill).map((file) => [`${name}/${file.path}`, Buffer.from(file.data, 'base64')]));
    res.type('application/zip').attachment(`${name}.zip`).send(Buffer.from(zipSync(archive, { level: 6 })));
  }));
  app.get('/api/marketplace', sessionAuth, (req, res) => {
    const config = loadConfig();
    res.json({ items: listMarketplace(), sources: config.sources, busy: [...pendingSources.keys()], defaultsEnabled: defaultsEnabled(), removedDefaults: removedDefaults(config) });
  });
  app.get('/api/sources', sessionAuth, (req, res) => res.json({ items: loadConfig().sources }));
  app.post('/api/sources', sessionAuth, route(async (req, res) => {
    const parsed = parseGitHubSource(req.body.url, req.body);
    const sourceKey = `${parsed.owner}/${parsed.repo}/${parsed.ref}/${parsed.path}`.toLowerCase();
    if (pendingSources.has(sourceKey)) throw inputError('This repository is already being indexed', 409);
    if (loadConfig().sources.some((source) => `${source.owner}/${source.repo}/${source.ref}/${source.path}`.toLowerCase() === sourceKey)) throw inputError('Source is already added. Refresh it instead.', 409);
    pendingSources.set(sourceKey, true);
    try {
      const index = await indexSource({ ...req.body, ...parsed });
      const duplicate = loadConfig().sources.find((source) => source.url.toLowerCase() === index.source.url.toLowerCase() && source.path === index.source.path && source.ref === index.source.ref);
      if (duplicate) throw inputError('Source is already added. Refresh it instead.', 409);
      const source = { ...index.source, id: crypto.randomUUID() };
      writeJson(path.join(INDEX_DIR, `${source.id}.json`), { ...index, source });
      updateConfig((config) => { markDefaultAdded(config, source); config.sources.push(source); });
      res.status(201).json({ ...source, warnings: index.warnings });
    } finally { pendingSources.delete(sourceKey); }
  }));
  app.post('/api/sources/restore-defaults', sessionAuth, route((req, res) => {
    if (!defaultsEnabled()) throw inputError('Bundled marketplaces are disabled in the server configuration');
    const previous = removedDefaults(loadConfig());
    updateConfig((config) => { config.removedDefaultMarketplaces = []; });
    try { res.json({ ...seedDefaultMarketplaces(), sources: loadConfig().sources }); }
    catch (error) {
      updateConfig((config) => { config.removedDefaultMarketplaces = previous; });
      throw error;
    }
  }));
  app.post('/api/sources/:id/refresh', sessionAuth, route(async (req, res) => {
    const source = loadConfig().sources.find((item) => item.id === req.params.id);
    if (!source) throw inputError('Source not found', 404);
    if (pendingSources.has(source.id)) throw inputError('Source refresh is already running', 409);
    pendingSources.set(source.id, true);
    try {
      const index = await indexSource(source);
      if (!loadConfig().sources.some((item) => item.id === source.id)) throw inputError('Source was removed during refresh', 409);
      const updated = { ...source, ...index.source, id: source.id };
      writeJson(path.join(INDEX_DIR, `${source.id}.json`), { ...index, source: updated });
      updateConfig((config) => { config.sources = config.sources.map((item) => item.id === source.id ? updated : item); });
      res.json({ ...updated, warnings: index.warnings });
    } finally { pendingSources.delete(source.id); }
  }));
  app.delete('/api/sources/:id', sessionAuth, route((req, res) => {
    const source = loadConfig().sources.find((item) => item.id === req.params.id);
    if (!source) throw inputError('Source not found', 404);
    updateConfig((config) => { markDefaultRemoved(config, source); config.sources = config.sources.filter((item) => item.id !== source.id); });
    const file = path.join(INDEX_DIR, `${source.id}.json`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    indexCache.delete(source.id);
    res.json({ ok: true });
  }));
  app.get('/api/marketplace/:sourceId/preview', sessionAuth, route((req, res) => res.json(previewEntry(req.params.sourceId, req.query.path || ''))));
  app.post('/api/marketplace/:sourceId/install', sessionAuth, route(async (req, res) => {
    if (req.body.path !== undefined && typeof req.body.path !== 'string') throw inputError('Skill path must be a string');
    const key = `${req.params.sourceId}:${req.body.path || ''}`;
    if (pendingInstalls.has(key)) throw inputError('This skill is already being installed', 409);
    pendingInstalls.set(key, true);
    try { res.status(201).json(await installSkill(req.params.sourceId, req.body.path || '')); }
    finally { pendingInstalls.delete(key); }
  }));
}

module.exports = { mountSkills, parseSkill, mapLimit, createGitHubClient, indexSource, installSkill, previewEntry, listMarketplace, skillDetail, skillFiles, SKILLS_DIR };
