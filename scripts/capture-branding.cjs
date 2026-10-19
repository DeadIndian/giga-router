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
    for (const section of ['overview', 'providers', 'mcp', 'skills', 'marketplace', 'access']) {
      await page.locator(`nav a[href="#${section}"]`).click();
      for (const width of [390, 1024, 1440]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 0) throw Error(`${section} overflows by ${overflow}px at ${width}px`);
      }
    }
    if (errors.length) throw Error(errors.join('\n'));
    console.log('Captured login, overview, marketplace, and integrations. Six pages fit at 390, 1024, and 1440px without browser errors.');
  } finally {
    await browser?.close();
    listener.closeAllConnections();
    await new Promise(resolve => listener.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

capture().catch(error => { console.error(error); process.exitCode = 1; });
