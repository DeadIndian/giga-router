// Capture the dashboard with temporary configuration and no upstream providers.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { chromium } = require('playwright');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'giga-router-branding-'));
const output = process.env.BRANDING_SCREENSHOT_DIR || path.join(__dirname, '..', 'docs', 'screenshots');
process.env.DATA_DIR = dataDir;
process.env.user = 'preview';
process.env.password = 'preview-password';
process.env.ROUTER_KEY = 'preview-gateway-key';
process.env.GIGA_ROUTER_DEFAULT_MARKETPLACES = 'true';
const { app } = require('../server');
const { seedDefaultMarketplaces } = require('../lib/marketplace-defaults');

async function capture() {
  fs.mkdirSync(output, { recursive: true });
  seedDefaultMarketplaces();
  const listener = app.listen(0, '127.0.0.1');
  let browser;
  try {
    await once(listener, 'listening');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${listener.address().port}`);
    await page.screenshot({ path: path.join(output, 'login.png') });
    await page.getByLabel('Username', { exact: true }).fill('preview');
    await page.getByLabel('Password', { exact: true }).fill('preview-password');
    await page.getByRole('button', { name: 'Open workspace' }).click();
    await page.waitForSelector('#app:not([hidden])');
    await page.screenshot({ path: path.join(output, 'overview.png') });
    await page.locator('nav a[href="#marketplace"]').click();
    await page.waitForSelector('.skill-card');
    await page.screenshot({ path: path.join(output, 'marketplace.png') });
    await page.locator('nav a[href="#mcp"]').click();
    await page.getByRole('button', { name: 'Browse integrations', exact: true }).first().click();
    await page.waitForSelector('.integration-card');
    await page.screenshot({ path: path.join(output, 'integrations.png') });
    await page.locator('nav a[href="#providers"]').click();
    await page.getByRole('button', { name: 'Free APIs', exact: true }).click();
    const groqCard = page.locator('.provider-card').filter({ has: page.getByRole('heading', { name: 'Groq', exact: true }) });
    for (const [label, key] of [['Personal', 'fake-personal-key'], ['Work', 'fake-work-key']]) {
      await groqCard.getByRole('button', { name: /Add (another )?account/ }).click();
      await page.getByLabel('Account label', { exact: true }).fill(label);
      await page.getByLabel('API key', { exact: true }).fill(key);
      await page.getByRole('button', { name: 'Add account', exact: true }).last().click();
      await page.waitForSelector('#editor-dialog:not([open])', { state: 'attached' });
    }
    await groqCard.getByText(/2 accounts added/).waitFor();
    await page.getByLabel('Find a provider or model', { exact: true }).fill('SimpleLLM');
    const simpleCard = page.locator('.provider-card').filter({ has: page.getByRole('heading', { name: 'SimpleLLM', exact: true }) });
    await simpleCard.getByRole('button', { name: 'Add this model', exact: true }).first().click();
    const selected = await page.getByLabel('Model ID', { exact: true }).inputValue();
    if (!selected.startsWith('free-')) throw Error('Model selection was not passed to account setup');
    await page.getByLabel('Model ID', { exact: true }).selectOption('__custom__');
    await page.getByLabel('Custom model ID', { exact: true }).fill('custom-preview-model');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByLabel('Find a provider or model', { exact: true }).fill('DeepSeek');
    if (await page.locator('.provider-card').count() < 3) throw Error('Model search did not find multiple providers');
    await page.getByLabel('Free access', { exact: true }).selectOption('free');
    await page.getByRole('heading', { name: 'Source-listed free access', exact: true }).waitFor({ state: 'hidden' });
    await page.getByLabel('Free access', { exact: true }).selectOption('');
    await page.getByLabel('Find a provider or model', { exact: true }).fill('');
    for (const width of [390, 1024, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 0) throw Error(`Free APIs overflows by ${overflow}px at ${width}px`);
    }
    await page.screenshot({ path: path.join(output, 'free-apis.png') });
    await page.getByRole('button', { name: 'Import API keys', exact: true }).click();
    await page.locator('#provider-import-file').setInputFiles({ name: 'keys.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ source: 'freellmapi', version: 1, keys: [{ platform: 'mistral', label: 'Imported', key: 'fake-import-key' }] })) });
    await page.getByRole('button', { name: 'Preview accounts', exact: true }).click();
    await page.locator('#provider-import-preview').getByText(/Mistral · Imported/).waitFor();
    if ((await page.locator('#provider-import-preview').textContent()).includes('fake-import-key')) throw Error('Import preview exposed API key');
    await page.getByRole('button', { name: 'Import accounts', exact: true }).click();
    await page.waitForSelector('#editor-dialog:not([open])', { state: 'attached' });
    await page.getByRole('button', { name: /^Providers 3$/ }).click();
    await page.locator('tbody tr').filter({ hasText: 'Groq · Personal' }).waitFor();
    await page.locator('tbody tr').filter({ hasText: 'Groq · Work' }).waitFor();
    await page.locator('tbody tr').filter({ hasText: 'Mistral · Imported' }).waitFor();
    for (const section of ['overview', 'providers', 'mcp', 'skills', 'marketplace', 'access']) {
      await page.locator(`nav a[href="#${section}"]`).click();
      for (const width of [390, 1024, 1440]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 0) throw Error(`${section} overflows by ${overflow}px at ${width}px`);
      }
    }
    await page.locator('nav a[href="#access"]').click();
    await page.getByRole('button', { name: 'Change password', exact: true }).click();
    await page.getByLabel('Current password', { exact: true }).fill('preview-password');
    await page.getByLabel('New password', { exact: true }).fill('new-preview-password');
    await page.getByLabel('Confirm new password', { exact: true }).fill('does-not-match');
    await page.getByRole('button', { name: 'Save password', exact: true }).click();
    await page.getByText('New passwords do not match.', { exact: true }).waitFor();
    await page.getByLabel('Confirm new password', { exact: true }).fill('new-preview-password');
    await page.getByRole('button', { name: 'Save password', exact: true }).click();
    await page.waitForSelector('#editor-dialog:not([open])', { state: 'attached' });
    await page.reload();
    await page.waitForSelector('#app:not([hidden])');
    await page.locator('#logout').click();
    await page.getByLabel('Username', { exact: true }).fill('preview');
    await page.getByLabel('Password', { exact: true }).fill('new-preview-password');
    await page.getByRole('button', { name: 'Open workspace' }).click();
    await page.waitForSelector('#app:not([hidden])');
    if (errors.length) throw Error(errors.join('\n'));
    console.log('Dashboard layouts fit at 390, 1024, and 1440px. Free API/model search, tier filtering, model selection, accounts, key imports, and password changes passed without browser errors.');
  } finally {
    await browser?.close();
    listener.closeAllConnections();
    await new Promise(resolve => listener.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

capture().catch(error => { console.error(error); process.exitCode = 1; });
