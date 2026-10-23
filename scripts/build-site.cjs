const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const escapeHtml = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function buildSite({ directory = path.join(root, '_site'), repository = process.env.GITHUB_REPOSITORY || 'DeadIndian/giga-router', siteUrl = process.env.SITE_URL } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Repository must be an owner/repository pair');
  const [owner, project] = repository.split('/');
  const baseUrl = (siteUrl || `https://${owner.toLowerCase()}.github.io${project.toLowerCase() === `${owner.toLowerCase()}.github.io` ? '' : `/${project}`}`).replace(/\/+$/, '');
  if (!['http:', 'https:'].includes(new URL(baseUrl).protocol)) throw new Error('Site URL must use HTTP or HTTPS');
  const replacements = {
    __REPO_URL__: `https://github.com/${repository}`,
    __CLONE_URL__: `https://github.com/${repository}.git`,
    __PROJECT_DIR__: project,
    __SITE_URL__: baseUrl,
    __MIN_NODE__: require('../package.json').engines.node.replace(/^>=/, ''),
  };
  let html = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8');
  for (const [token, value] of Object.entries(replacements)) html = html.replaceAll(token, escapeHtml(value));
  if (/__[A-Z_]+__/.test(html)) throw new Error('Unresolved website template value');
  fs.mkdirSync(path.join(directory, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'index.html'), html);
  for (const file of ['styles.css', 'site.js']) fs.copyFileSync(path.join(root, 'site', file), path.join(directory, file));
  // This is a generated asset, never a second maintained logo source.
  fs.copyFileSync(path.join(root, 'public/favicon.svg'), path.join(directory, 'assets/favicon.svg'));
  fs.writeFileSync(path.join(directory, '.nojekyll'), '');
  fs.writeFileSync(path.join(directory, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${escapeHtml(baseUrl)}/</loc></url></urlset>\n`);
  return { directory, baseUrl };
}

module.exports = { buildSite };
if (require.main === module) {
  const result = buildSite();
  console.log(`Website built in ${result.directory}\nCanonical URL: ${result.baseUrl}/`);
}
