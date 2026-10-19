const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// Exercise the real helper with fake host commands; never touch production Docker.
function deploy(scenario) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-router-deploy-'));
  try {
    const log = path.join(directory, 'commands.jsonl');
    fs.writeFileSync(path.join(directory, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), scenario = process.env.DEPLOY_TEST_SCENARIO;
fs.appendFileSync(process.env.DEPLOY_TEST_LOG, JSON.stringify(args) + '\\n');
const is = (...prefix) => prefix.every((arg, i) => args[i] === arg);
if (is('compose', 'ps')) console.log(fs.existsSync(process.env.DEPLOY_TEST_MARKER) ? 'new-container' : 'old-container');
else if (is('inspect') && args.includes('{{.Image}}')) console.log('sha256:old-image');
else if (is('image', 'inspect') && scenario === 'missing-image') process.exit(1);
else if (is('image', 'tag') && scenario === 'tag-failure') process.exit(1);
else if (is('compose', 'build') && scenario === 'build-failure') process.exit(1);
else if (is('compose', 'up')) fs.writeFileSync(process.env.DEPLOY_TEST_MARKER, 'recreated');
else if (is('exec') && args.at(-1).includes('const stable=')) console.log(scenario === 'changed-config' && args[1] === 'new-container' ? 'changed' : 'unchanged');
`, { mode: 0o700 });
    const result = spawnSync('bash', [path.join(__dirname, 'scripts/deploy-local.sh')], {
      env: { ...process.env, PATH: directory + path.delimiter + process.env.PATH, DEPLOY_TEST_LOG: log,
        DEPLOY_TEST_MARKER: path.join(directory, 'recreated'), DEPLOY_TEST_SCENARIO: scenario }, encoding: 'utf8',
    });
    const commands = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    return { ...result, commands };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('missing old image or failed rollback tag still backs up and verifies deployment', () => {
  for (const scenario of ['missing-image', 'tag-failure']) {
    const result = deploy(scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /could not be saved for rollback/);
    assert.ok(result.commands.some(args => args[0] === 'exec' && args.at(-1).includes('pre-deployment')));
    assert.equal(result.commands.filter(args => args[0] === 'exec' && args.at(-1).includes('const stable=')).length, 2);
    const up = result.commands.find(args => args[0] === 'compose' && args[1] === 'up');
    assert.ok(up.includes('--no-build')); assert.ok(up.includes('--wait')); assert.equal(up.at(-1), 'llmrouter');
  }
});

test('available rollback image is tagged before building and only the router is recreated', () => {
  const result = deploy('normal');
  assert.equal(result.status, 0, result.stderr);
  const tag = result.commands.findIndex(args => args[0] === 'image' && args[1] === 'tag');
  const build = result.commands.findIndex(args => args[0] === 'compose' && args[1] === 'build');
  const backup = result.commands.findIndex(args => args[0] === 'exec' && args.at(-1).includes('pre-deployment'));
  const up = result.commands.findIndex(args => args[0] === 'compose' && args[1] === 'up');
  assert.ok(tag >= 0 && tag < build && build < backup && backup < up);
  assert.equal(result.commands.some(args => args.includes('down') || args.includes('prune')), false);
});

test('build failure leaves the old container serving; changed saved data is still an error', () => {
  const failedBuild = deploy('build-failure');
  assert.notEqual(failedBuild.status, 0);
  assert.equal(failedBuild.commands.some(args => args[0] === 'compose' && args[1] === 'up'), false);
  const changed = deploy('changed-config');
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /Saved configuration changed during deployment/);
});
