// Verify an extracted data backup in a disposable copy, without starting HTTP/MCP.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fingerprint } = require('./config-fingerprint.cjs');
if (!process.argv[2]) { console.error('Usage: node scripts/verify-restore.cjs <extracted-data-backup>'); process.exit(1); }
const source = path.resolve(process.argv[2]);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-restore-'));
try {
  const expected = fingerprint(source);
  if (expected === 'none') throw new Error('Backup has no config.json');
  fs.cpSync(source, directory, { recursive: true });
  process.env.DATA_DIR = directory;
  const { loadConfig } = require('../lib/storage');
  const { readBundle } = require('../lib/skill-bundles');
  const config = loadConfig();
  for (const skill of config.skills) {
    const bundle = readBundle(skill);
    if (!bundle.files.some(file => file.path === 'SKILL.md')) throw new Error('A skill bundle has no SKILL.md');
    if (skill.portablePath) for (const file of bundle.files) {
      if (!fs.readFileSync(path.join(directory, skill.portablePath, file.path)).equals(Buffer.from(file.data, 'base64'))) throw new Error('A portable skill file differs from its manifest');
    }
  }
  if (fingerprint(directory) !== expected) throw new Error('Restored configuration differs from the backup');
  console.log(`Restore verified: ${config.providers.length} providers, ${config.mcpServers.length} MCP settings, ${config.skills.length} skill bundles. Vault records decrypt successfully.`);
} catch (error) { console.error(`Restore verification failed: ${error.message}`); process.exitCode = 1; }
finally { fs.rmSync(directory, { recursive: true, force: true }); }
