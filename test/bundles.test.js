const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
test('bundle commits are atomic across shape changes, write failures, rollback and restart', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-bundles-'));
  process.env.DATA_DIR = directory;
  const { loadConfig } = require('../lib/storage');
  const { commitBundle, readBundle, rollbackBundle } = require('../lib/skill-bundles');
  const files = name => [{ path: 'SKILL.md', data: Buffer.from('Instructions').toString('base64') }, { path: name, data: Buffer.from(name).toString('base64') }];
  try {
    const first = commitBundle({ id: 'fixture', name: 'Fixture' }, files('references'));
    const second = commitBundle(first, files('references/one.md'));
    const third = commitBundle(second, files('references'));
    assert.equal(readBundle(third).files[1].path, 'references');
    const restored = rollbackBundle(third); assert.equal(readBundle(restored).files[1].path, 'references/one.md');
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (to === path.join(directory, 'config.json')) throw new Error('fixture disk failure'); return rename(from, to); };
    try { assert.throws(() => commitBundle(restored, files('new-file')), /disk failure/); }
    finally { fs.renameSync = rename; }
    assert.equal(loadConfig().skills[0].generation, restored.generation);
    assert.equal(fs.readFileSync(path.join(directory, restored.portablePath, 'references/one.md'), 'utf8'), 'references/one.md');
    const cold = execFileSync(process.execPath, ['-e', 'const s=require("./lib/storage").loadConfig().skills[0];console.log(require("./lib/skill-bundles").readBundle(s).files[1].path)'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
    assert.equal(cold.trim(), 'references/one.md');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
