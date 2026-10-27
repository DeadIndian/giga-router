const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
function files(directory) { return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : /\.(?:js|cjs)$/.test(entry.name) ? [path.join(directory, entry.name)] : []); }
for (const file of [path.join(root, 'server.js'), ...['lib', 'public', 'site', 'scripts', 'test', 'fixtures'].flatMap(name => files(path.join(root, name)))]) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' }); if (result.status !== 0) process.exit(result.status || 1);
}
const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : 'bash';
const result = spawnSync(bash, ['-n', path.join(__dirname, 'deploy-local.sh')], { stdio: 'inherit' });
if (result.error) console.error('Bash is required for shell syntax checks. Install Git Bash on Windows.', result.error.message);
process.exit(result.status ?? 1);
