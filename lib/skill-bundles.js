// Immutable generations: configuration is the single commit pointer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR, loadConfig, updateConfig, writeJson } = require('./storage');
const { sanitizeSubpath } = require('./github-source');
const { inputError } = require('./validation');
const SKILLS_DIR = path.join(DATA_DIR, 'skills');
function generationRoot(skill, generation = skill.generation) {
  return generation && generation !== 'legacy' ? path.join(SKILLS_DIR, skill.id, 'generations', generation) : path.join(SKILLS_DIR, skill.id);
}
function readBundle(skill) {
  const file = path.join(generationRoot(skill), 'bundle.json');
  if (!fs.existsSync(file)) throw inputError('Installed bundle is missing', 404);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function commitBundle(skill, files) {
  const previous = loadConfig().skills.find(s => s.id === skill.id);
  const generation = crypto.randomUUID(), root = path.join(SKILLS_DIR, skill.id, 'generations');
  const stage = path.join(root, `.stage-${generation}`), destination = path.join(root, generation);
  const next = { ...skill, generation, previousGeneration: previous ? previous.generation || 'legacy' : null,
    portablePath: path.posix.join('skills', skill.id, 'generations', generation, 'files') };
  const seen = new Set(); let total = 0, committed = false;
  try {
    for (const file of files) {
      const relative = sanitizeSubpath(file.path);
      if (!relative || seen.has(relative.toLowerCase())) throw inputError('Invalid or duplicate bundle path');
      seen.add(relative.toLowerCase());
      const bytes = Buffer.from(file.data, 'base64'); total += bytes.length;
      if (total > 9 * 1024 * 1024 || files.length > 102) throw inputError('Skill bundle exceeds the size limit', 413);
      const target = path.join(stage, 'files', relative);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, bytes, { mode: 0o600 });
    }
    if (!seen.has('skill.md')) throw inputError('Bundle needs SKILL.md');
    writeJson(path.join(stage, 'bundle.json'), { files, skill: next, previousSkill: previous || null });
    fs.renameSync(stage, destination);
    updateConfig(cfg => { const i = cfg.skills.findIndex(s => s.id === next.id); if (i < 0) cfg.skills.push(next); else cfg.skills[i] = next; });
    committed = true;
    // A crash before the pointer update leaves an unused generation, never mixed files.
    // Cleanup only our own generation directories; a failed cleanup is harmless.
    try {
      for (const entry of fs.readdirSync(root)) if (entry !== generation && entry !== next.previousGeneration && /^(?:\.stage-)?[a-f0-9-]{36}$/.test(entry)) {
        try { fs.rmSync(path.join(root, entry), { recursive: true, force: true }); } catch {}
      }
    } catch { /* The committed pointer remains valid if cleanup is unavailable. */ }
    return next;
  } finally {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
    if (!committed) { try { fs.rmSync(destination, { recursive: true, force: true }); } catch {} }
  }
}
function rollbackBundle(skill) {
  const current = readBundle(skill), previous = current.previousSkill;
  if (!previous) throw inputError('No previous generation is available', 409);
  return commitBundle({ ...previous, enabled: skill.enabled, updatedAt: new Date().toISOString() }, readBundle(previous).files);
}
module.exports = { SKILLS_DIR, readBundle, commitBundle, rollbackBundle };
