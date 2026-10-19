// Release-time refresh of the bundled catalogs. Self-hosted startup is offline;
// this command is explicit, uses public GitHub data, and never installs a skill.
const fs = require('node:fs');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const { DEFAULT_MARKETPLACES, SNAPSHOT_DIR } = require('../lib/marketplace-defaults');
const { indexSource, createGitHubClient } = require('../lib/skills');

async function main() {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const client = createGitHubClient();
  const manifest = { generatedAt: new Date().toISOString(), sources: [] };
  const requested = process.argv.slice(2);
  if (requested.some((id) => !DEFAULT_MARKETPLACES.some((source) => source.id === id))) throw new Error('Unknown marketplace id');
  for (const definition of DEFAULT_MARKETPLACES.filter((source) => !requested.length || requested.includes(source.id))) {
    const index = await indexSource(definition, client);
    if (index.source.license !== 'MIT' || !index.entries.length || index.warnings.length) {
      throw new Error(`${definition.name}: expected a complete MIT-licensed catalog; ${JSON.stringify(index.warnings)}`);
    }
    const root = await client.request(`/repos/${index.source.owner}/${index.source.repo}/contents?ref=${index.source.commit}`);
    const license = root.find((file) => /^license(?:\.|$)/i.test(file.name) && file.type === 'file');
    if (!license) throw new Error(`${definition.name}: repository license file is missing`);
    const licenseText = (await client.blob(index.source, license.sha, 128 * 1024, license.name)).toString('utf8');
    index.repositoryLicense = { path: license.name, content: licenseText };
    const bytes = gzipSync(Buffer.from(JSON.stringify(index)), { level: 9 });
    fs.writeFileSync(path.join(SNAPSHOT_DIR, `${definition.id}.json.gz`), bytes);
    console.log(`${definition.name}: ${index.entries.length} skills, ${Math.ceil(bytes.length / 1024)} KiB, ${index.source.commit.slice(0, 8)}`);
  }
  const { gunzipSync } = require('node:zlib');
  for (const definition of DEFAULT_MARKETPLACES) {
    const bytes = fs.readFileSync(path.join(SNAPSHOT_DIR, `${definition.id}.json.gz`));
    const index = JSON.parse(gunzipSync(bytes).toString('utf8'));
    manifest.sources.push({ id: definition.id, name: definition.name, url: definition.url, path: definition.path, ref: definition.ref,
      commit: index.source.commit, skillCount: index.entries.length, license: index.source.license, compressedBytes: bytes.length });
  }
  fs.writeFileSync(path.join(SNAPSHOT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Bundled ${manifest.sources.length} marketplaces with ${manifest.sources.reduce((count, source) => count + source.skillCount, 0)} skills.`);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
